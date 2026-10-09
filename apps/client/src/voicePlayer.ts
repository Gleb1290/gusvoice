import { useCallback, useRef, useSyncExternalStore } from 'react';
import { api } from './api';
import {
  getVoiceSpeed,
  nextVoiceKey,
  nextVoiceKeyWhere,
  prevVoiceKey,
  shouldReportListened,
  subscribeVoiceSpeed,
  voiceHeardKey,
  voiceUnheard,
} from './voicePlayback';

/**
 * Один плеер голосовых на всё приложение (07.10, #211, решение владельца: «плеер поверх ленты, как в Telegram»).
 *
 * Раньше `<audio>` жил внутри пузыря: пузырь ушёл из окна ленты или человек открыл другую беседу — звук обрывался.
 * Теперь звук играет здесь, в одном элементе вне React, а пузырь (`VoiceMessage`) и полоса под шапкой (`VoiceTopBar`)
 * только показывают его состояние и управляют им. Одно играющее за раз — само собой: элемент один.
 *
 * Правила (порядок автоперехода, «прослушано», ключ точки) — чистые функции в `voicePlayback.ts`.
 */

/** Откуда голосовое — нужно полосе (подпись, переход к сообщению) и отметке «прослушано». Нет — запись перед отправкой. */
export interface VoiceSource {
  /** Лента: id беседы ЛС или канала (то же, что `feedId` у `MessagePane` и `channelId` у сообщения). */
  conversationId: string;
  messageId: string;
  /** Моё ли сообщение: своё я не «прослушиваю» — точка у него означает «собеседник не слушал». */
  mine: boolean;
  /** `ConvMessage.voiceListened`; нет (каналы, сервер без `voice1`) — ни точек, ни вызовов. */
  listened: boolean | undefined;
  /** Имя отправителя (как в шапке пузыря) и время сообщения — подпись полосы плеера. */
  author?: string;
  createdAt?: string;
  /**
   * «Прослушать один раз» (`Attachment.once`, `voice3`, G54): чужое такое голосовое, сошедшее с плеера (дослушано, закрыто,
   * сменено другим), сервер удаляет (`api.convOnceSpent`); в автопереход оно не попадает — само не стартует.
   */
  once?: boolean;
}

/** Где человек был, когда запустил: по нему клик по полосе из другой беседы открывает ту ленту. */
export interface VoicePlace {
  view: 'dm' | 'server';
  serverId: string | null;
}

export interface VoiceTrack {
  /** Ключ дорожки: `сообщение:вложение` у ленты, `local:url` у записи перед отправкой. Он же `data-voice` пузыря. */
  key: string;
  url: string;
  durationMs: number;
  source?: VoiceSource;
  place?: VoicePlace;
}

export interface VoicePlayerState {
  track: VoiceTrack | null;
  playing: boolean;
  /** Позиция текущей дорожки, мс. */
  at: number;
  /** Позиции, выставленные перемоткой у НЕ играющих пузырей: с них они и начнут. */
  seekAt: ReadonlyMap<string, number>;
  /** «Прослушал в этом сеансе» (`voiceHeardKey`): точка гаснет сразу, не дожидаясь события сервера. */
  heard: ReadonlySet<string>;
}

let state: VoicePlayerState = { track: null, playing: false, at: 0, seekAt: new Map(), heard: new Set() };
const listeners = new Set<() => void>();
let audio: HTMLAudioElement | null = null;
/** Пузыри ленты, которые хоть раз показывались: по ним автопереход находит следующее, даже если пузыря уже нет в DOM. */
const known = new Map<string, VoiceTrack>();
/** Порядок голосовых ленты на момент запуска — на случай, когда играющий пузырь ушёл из DOM (виртуализация, другая беседа). */
let order: string[] = [];
/** Переход к сообщению, заказанный полосой из другой беседы: лента с этим id выполнит его, когда откроется. */
let pendingJump: { feedId: string; messageId: string } | null = null;
/**
 * Серия «только непрослушанные» (G84, Telegram Android `MediaController.voiceMessagesPlaylistUnread`): нажато чужое
 * непрослушанное — автопереход идёт только по непрослушанным чужим; нажато прослушанное или своё — по всем подряд.
 */
let unreadOnly = false;

function set(patch: Partial<VoicePlayerState>): void {
  state = { ...state, ...patch };
  for (const fn of listeners) fn();
}

export function subscribeVoicePlayer(fn: () => void): () => void {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

export function getVoicePlayerState(): VoicePlayerState {
  return state;
}

export function useVoicePlayer(): VoicePlayerState {
  return useSyncExternalStore(subscribeVoicePlayer, getVoicePlayerState, getVoicePlayerState);
}

/** Что видит один пузырь. Отдельная выборка: тиканье играющего не перерисовывает остальные голосовые ленты. */
export interface VoiceBubbleView {
  current: boolean;
  playing: boolean;
  at: number;
  heard: boolean;
}

export function useVoiceBubble(key: string, heardKey: string | null): VoiceBubbleView {
  const last = useRef<VoiceBubbleView | null>(null);
  const read = useCallback((): VoiceBubbleView => {
    const current = state.track?.key === key;
    const v: VoiceBubbleView = {
      current,
      playing: current && state.playing,
      at: current ? state.at : (state.seekAt.get(key) ?? 0),
      heard: heardKey !== null && state.heard.has(heardKey),
    };
    const p = last.current;
    if (p && p.current === v.current && p.playing === v.playing && p.at === v.at && p.heard === v.heard) return p;
    last.current = v;
    return v;
  }, [key, heardKey]);
  return useSyncExternalStore(subscribeVoicePlayer, read, read);
}

/** Системный плеер (G64): медиаклавиши, шторка Android, панель Windows — `navigator.mediaSession`. */
function session(): MediaSession | null {
  return typeof navigator !== 'undefined' && 'mediaSession' in navigator ? navigator.mediaSession : null;
}

let sessionWired = false;
function wireSession(): void {
  const ms = session();
  if (!ms || sessionWired) return;
  sessionWired = true;
  const on = (action: MediaSessionAction, fn: MediaSessionActionHandler) => {
    try {
      ms.setActionHandler(action, fn);
    } catch {
      /* действие не поддерживается этим браузером */
    }
  };
  on('play', () => {
    if (!state.playing) toggleCurrentVoice();
  });
  on('pause', () => {
    if (state.playing) audio?.pause();
  });
  on('previoustrack', () => skipVoice(-1));
  on('nexttrack', () => skipVoice(1));
  on('stop', () => closeVoice());
  on('seekto', (d) => {
    if (state.track && typeof d.seekTime === 'number') seekVoice(state.track.key, d.seekTime);
  });
}

/** Подпись в системном плеере: автор и «Голосовое сообщение» (как уведомление Telegram о голосовом). */
function updateSession(track: VoiceTrack | null): void {
  const ms = session();
  if (!ms) return;
  wireSession();
  if (!track) {
    ms.metadata = null;
    ms.playbackState = 'none';
    return;
  }
  try {
    ms.metadata = new MediaMetadata({
      title: 'Голосовое сообщение',
      artist: track.source?.author ?? '',
    });
  } catch {
    /* MediaMetadata нет — клавиши всё равно работают */
  }
}

function el(): HTMLAudioElement {
  if (audio) return audio;
  const a = new Audio();
  a.preload = 'metadata';
  a.addEventListener('play', () => {
    set({ playing: true });
    const ms = session();
    if (ms) ms.playbackState = 'playing';
  });
  a.addEventListener('pause', () => {
    set({ playing: false });
    const ms = session();
    if (ms) ms.playbackState = 'paused';
  });
  a.addEventListener('timeupdate', () => {
    if (state.track) set({ at: a.currentTime * 1000 });
  });
  a.addEventListener('ended', onEnded);
  // Скорость одна на все голосовые: смена в пузыре или в полосе подхватывается играющим сразу.
  subscribeVoiceSpeed((s) => {
    a.playbackRate = s;
  });
  audio = a;
  return a;
}

/** Пузырь показался — запомнить дорожку для автоперехода (данные дорожки не меняются, перезапись безвредна). */
export function rememberVoice(track: VoiceTrack): void {
  if (track.source) known.set(track.key, track);
}

/** Голосовые ленты в DOM сверху вниз: корень — лента играющего (`.messages`); закрепы, отложенные и композер не входят. */
function feedOrder(key: string): string[] | null {
  const mine = [...document.querySelectorAll<HTMLElement>('.messages .voice-msg[data-voice]')].find((n) => n.dataset.voice === key);
  const root = mine?.closest('.messages');
  if (!root) return null;
  return [...root.querySelectorAll<HTMLElement>('.voice-msg[data-voice]')].map((n) => n.dataset.voice ?? '');
}

function reportListened(src: VoiceSource | undefined): void {
  if (!src) return;
  const k = voiceHeardKey(src.conversationId, src.messageId);
  if (!shouldReportListened(src.mine, src.listened, state.heard.has(k))) return;
  set({ heard: new Set(state.heard).add(k) });
  void api.convListened(src.conversationId, src.messageId).catch(() => {
    const heard = new Set(state.heard);
    heard.delete(k);
    set({ heard });
  });
}

/** Одноразовые, о которых сервер уже знает (повтор ручки безвреден, но лишний). */
const spentOnce = new Set<string>();

/** Дорожка сходит с плеера: чужое одноразовое — «прослушано», файл у сервера уходит (Telegram: view-once после закрытия). */
function leaveTrack(track: VoiceTrack | null): void {
  const src = track?.source;
  if (!src?.once || src.mine) return;
  const k = voiceHeardKey(src.conversationId, src.messageId);
  if (spentOnce.has(k)) return;
  spentOnce.add(k);
  void api.convOnceSpent(src.conversationId, src.messageId).catch(() => spentOnce.delete(k));
}

/**
 * Кружок (`RoundVideo`, `circles1`, G68) играет своим `<video>` в пузыре, мимо общего `Audio`, но «прослушано» и «один раз» у
 * него те же: старт со звуком — `markHeard`, конец или уход — `spendOnce`; а голосовое на это время встаёт (`pauseVoice`).
 */
export function markHeard(src: VoiceSource): void {
  reportListened(src);
}
export function spendOnce(src: VoiceSource): void {
  leaveTrack({ key: `once:${src.conversationId}:${src.messageId}`, url: '', durationMs: 0, source: src });
}
export function pauseVoice(): void {
  if (audio && state.playing) audio.pause();
}

function start(track: VoiceTrack): void {
  if (state.track && state.track.key !== track.key) leaveTrack(state.track);
  const a = el();
  const seekAt = new Map(state.seekAt);
  const from = seekAt.get(track.key) ?? 0;
  seekAt.delete(track.key);
  if (state.track?.key !== track.key) {
    a.src = track.url;
    if (track.source) order = feedOrder(track.key) ?? [track.key];
  }
  set({ track, at: from, seekAt });
  updateSession(track);
  if (from > 0) {
    try {
      a.currentTime = from / 1000;
    } catch {
      /* метаданных ещё нет — начнём с начала */
    }
  }
  a.playbackRate = getVoiceSpeed();
  void a.play().catch(() => set({ playing: false }));
  // «Прослушано» — со старта, как у Telegram (AD-01): один раз, чужое голосовое с точкой.
  reportListened(track.source);
}

/** Кнопка ▶/⏸ пузыря: своё играет — пауза; на паузе — дальше; чужое — переключиться на это. */
export function toggleVoice(track: VoiceTrack): void {
  rememberVoice(track);
  if (state.track?.key !== track.key) {
    // Нажали другое голосовое — серия строится от него (Android: непрослушанное → только непрослушанные чужие).
    const src = track.source;
    unreadOnly =
      !!src && !src.mine && voiceUnheard(src.listened, state.heard.has(voiceHeardKey(src.conversationId, src.messageId)));
  }
  if (state.track?.key === track.key && audio) {
    if (state.playing) audio.pause();
    else {
      audio.playbackRate = getVoiceSpeed();
      void audio.play().catch(() => set({ playing: false }));
    }
    return;
  }
  start(track);
}

/** ▶/⏸ полосы — над тем, что сейчас загружено. */
export function toggleCurrentVoice(): void {
  if (state.track) toggleVoice(state.track);
}

/** Перемотка (секунды). Играющее — сразу; другое — запомнить, с этого места оно и начнёт. */
export function seekVoice(key: string, sec: number): void {
  if (!Number.isFinite(sec)) return;
  if (state.track?.key === key && audio) {
    audio.currentTime = sec;
    set({ at: sec * 1000 });
    return;
  }
  set({ seekAt: new Map(state.seekAt).set(key, sec * 1000) });
}

/** Крестик полосы и конец серии: звук стоп, полоса уходит. */
export function closeVoice(): void {
  leaveTrack(state.track);
  if (audio) {
    audio.pause();
    audio.removeAttribute('src');
    audio.load();
  }
  order = [];
  unreadOnly = false;
  set({ track: null, playing: false, at: 0 });
  updateSession(null);
}

/** Непрослушанное чужое — для серии «только непрослушанные». */
function unheardForeign(key: string): boolean {
  const src = known.get(key)?.source;
  return !!src && !src.mine && voiceUnheard(src.listened, state.heard.has(voiceHeardKey(src.conversationId, src.messageId)));
}

/** Соседи играющего в ленте: есть ли «предыдущее» и «следующее» (кнопки полосы на компьютере). */
export function voiceNeighbors(): { prev: boolean; next: boolean } {
  const cur = state.track;
  if (!cur?.source) return { prev: false, next: false };
  const list = feedOrder(cur.key) ?? order;
  const p = prevVoiceKey(list, cur.key);
  const n = nextVoiceKey(list, cur.key);
  return { prev: !!p && known.has(p), next: !!n && known.has(n) };
}

/**
 * «Предыдущее» / «следующее» полосы плеера и медиаклавиш (Telegram Desktop `Media::Player::Widget`: `_previousTrack`,
 * `_nextTrack`): по всем голосовым ленты подряд, без фильтра непрослушанных — серия становится обычной.
 */
export function skipVoice(dir: -1 | 1): void {
  const cur = state.track;
  if (!cur?.source) return;
  const fresh = feedOrder(cur.key);
  if (fresh) order = fresh;
  const key = dir < 0 ? prevVoiceKey(order, cur.key) : nextVoiceKey(order, cur.key);
  const target = key ? known.get(key) : undefined;
  if (!target) return;
  unreadOnly = false;
  start({ ...target, place: cur.place });
}

/** Пузырь без ленты (запись перед отправкой) ушёл с экрана — его звук останавливается, как раньше. */
export function releaseLocalVoice(key: string): void {
  if (state.track?.key === key && !state.track.source) closeVoice();
}

function onEnded(): void {
  const cur = state.track;
  if (!cur?.source) {
    closeVoice();
    return;
  }
  // Автопереход (AD-03): следующее голосовое той же ленты. Пузырь на экране — порядок свежий, из DOM; нет — запомненный.
  const fresh = feedOrder(cur.key);
  if (fresh) order = fresh;
  // Одноразовое (`voice3`) само не стартует: его слушают только нажатием.
  const notOnce = (k: string) => !known.get(k)?.source?.once;
  const nextKey = nextVoiceKeyWhere(order, cur.key, (k) => notOnce(k) && (!unreadOnly || unheardForeign(k)));
  const next = nextKey ? known.get(nextKey) : undefined;
  if (!next) {
    closeVoice();
    return;
  }
  start({ ...next, place: cur.place });
}

/** Полоса из другой беседы: открыть её ленту и перейти к сообщению — ленту с этим id ждёт заказ. */
export function requestVoiceJump(feedId: string, messageId: string): void {
  pendingJump = { feedId, messageId };
}

/** Лента открылась — забрать свой заказ перехода (один раз). */
export function takeVoiceJump(feedId: string | undefined): string | null {
  if (!feedId || pendingJump?.feedId !== feedId) return null;
  const id = pendingJump.messageId;
  pendingJump = null;
  return id;
}
