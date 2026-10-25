import type {
  Attachment,
  ConvGone,
  ConvMessage,
  ConvPinsResponse,
  ConvScheduledResponse,
  ConvSummary,
  DmChannel,
  Message,
} from '@gusvoice/shared';
import type { Api } from './api';
import { isFeedOnScreen } from './channelRules';
import {
  applyEdited,
  applyList,
  applyMessage,
  applyPage,
  applyPins,
  applyRemoved,
  applyScheduled,
  applySent,
  applySummary,
  bufferEvent,
  convCursor,
  drainPlan,
  dropPins,
  dropScheduled,
  emptyConvState,
  eventDecision,
  isConvLeft,
  lacksPeerRead,
  nextUnread,
  readKeyFor,
  clampReadKey,
  seenFlushDelay,
  remoteDraftDecision,
  seedUnread,
  summariesToDms,
  applyViaPage,
  isHomeDownError,
  viaSendable,
  draftTextForServer,
  trimWindow,
  updateDrafts,
  withPeerRead,
  type ConvChangeEvent,
  type ConvState,
} from './convSyncRules';
import { afterKeyCursor, dayStart, firstOfDay, openAction, trimPlan, type FeedPlace } from './feedWindowRules';
import { hydrateState, type ConvCacheRecord } from './convCacheRules';
import { sendErrorText } from './outgoingRules';
import {
  afterFailure,
  afterReconnect,
  manualRetry,
  newOutboxItem,
  nextToSend,
  restoreItem,
  type OutboxItem,
  type OutboxRef,
} from './outboxRules';

/**
 * ЛС, этап 2 (шаг 2а): обвязка режима бесед — сеть, стор, таймеры. Правила — `convSyncRules.ts`, контракт —
 * `docs/dm/STAGE2.md`.
 *
 * Интерфейс по-прежнему читает `dms`, `dmMessages`, `unreadDms` (контракт `DmSidebar`/`DmChatView` не меняется в 2а):
 * здесь они наполняются из состояния бесед. Действия стора (`selectDm`, `loadDms`, …) в режиме бесед зовут сюда, а
 * старый путь `/api/dm*` остаётся нетронутым для соседей, старых коробок и устройств с выключенным переключателем.
 */

/** Поля стора, которые трогает режим бесед (структурно — чтобы не импортировать стор и не замыкать круг модулей). */
export interface ConvHost {
  conv: ConvState;
  convActive: boolean;
  dms: DmChannel[];
  dmMessages: Record<string, Message[]>;
  unreadDms: string[];
  historyFailed: string[];
  currentDmId: string | null;
  view: 'server' | 'dm';
  mobilePane: 'list' | 'content';
  /** Исходящие бесед по беседе (шаг 2в, `outboxRules.ts`). */
  outbox: Record<string, OutboxItem[]>;
  drafts: Record<string, { text: string; replyToId: string | null }>;
  /** Где человек ушёл из беседы, если не снизу (шаг 2г) — туда она и откроется. Пишется в кеш на диске. Нет поля —
   *  места не помнятся. */
  places?: Record<string, FeedPlace>;
  /** Беседы, чей черновик ещё не записан на сервер (Р7): пришедший с другого устройства его не затирает. В кеше. */
  draftDirty?: string[];
  /** Счётчик черновиков, пришедших с другого устройства (Р7): открытая лента по его смене кладёт текст в поле. */
  draftRev?: Record<string, number>;
}
type Get = () => ConvHost;
type Set = (partial: Partial<ConvHost> | ((s: ConvHost) => Partial<ConvHost>)) => void;

/**
 * Всё, что действия бесед берут из окружения: сеть, часы, таймеры, «сеть вернулась», вид телефона, метка визита. Стор
 * передаёт настоящее (`convDeps.ts`), тест — подменённое: модуль не тянет `api → config` (тот читает `window` и
 * `import.meta.env` при загрузке), поэтому догонку, очередь и гонки можно прогнать в Node без браузера.
 */
export interface ConvDeps {
  api: Pick<Api, 'convList' | 'convSync' | 'convHistory' | 'convDirect' | 'convSend' | 'convUpload' | 'convRead'> &
    Partial<Pick<Api, 'convDraft' | 'convDelete' | 'convSetUnreadMark' | 'convSaved'>>;
  now: () => number;
  setTimeout: (fn: () => void, ms: number) => unknown;
  clearTimeout: (timer: unknown) => void;
  /** Подписка на «сеть вернулась» (`online` окна): очередь исходящих не ждёт следующего `ready` шлюза. */
  onOnline: (fn: () => void) => void;
  isMobile: () => boolean;
  /** Метка визита беседы — черта «Новые сообщения» (`channelPrefs.markChannelSeen`). */
  markChannelSeen: (convId: string, at: number) => void;
  /** Окно ленты (шаг 2г; в клиенте всегда `true`): «прочитано» — только до загруженного. Нет — окна нет (тесты). */
  windowed?: () => boolean;
  /** Сервер хранит черновики (Р7, признак `conv3`). Нет — черновик живёт только на устройстве, как раньше. */
  draftsOnServer?: () => boolean;
  /** Метка этого устройства (одна на загрузку страницы): своё эхо черновика не применяется. */
  draftDevice?: string;
  /**
   * Сервер шлёт «прочитано собеседником» (Р6, ✓✓, признак `conv4`): сводку без `peerReadKey` (кеш, снятый до его
   * обновления) перечитать списком. Нет — без перечитки: такие сводки дают только ✓.
   */
  peerReadsOnServer?: () => boolean;
  /**
   * У устройства нет сети (`navigator.onLine === false`): временная неудача отправки — сразу «не отправлено», без минуты
   * повторов (`outboxRules.afterFailure`, 05.10). Нет — судим только по шлюзу.
   */
  deviceOffline?: () => boolean;
  /**
   * Прогресс загрузки вложений строки «в пути» (07.10, `uploadProgress.ts`): мимо стора — события идут десятками в
   * секунду. Зависимостью, а не импортом: стор грузит харнесс тестов с перечнем разрешённых модулей. Нет — без кольца.
   */
  uploadProgress?: UploadProgressSink;
  /**
   * «Прочитано» по видимому (G09, `readByView.ts`): отметка — не дальше того, что лента сообщила увиденным (`convSeen`),
   * а не до последнего загруженного. Нет — как раньше, до загруженного.
   */
  readByView?: () => boolean;
}

/** Куда идёт прогресс загрузки строки «в пути» (`uploadProgress.ts`). */
export interface UploadProgressSink {
  progress: (key: string, index: number, loaded: number, total: number) => void;
  done: (key: string, index: number) => void;
  clear: (key: string) => void;
}

let boundProgress: UploadProgressSink | null = null;
/**
 * Привязать прогресс загрузки к кольцам (`main.tsx`, 07.10). Не импортом и не из `store.ts`: их обоих грузят харнессы
 * тестов с перечнем разрешённых модулей. Не привязано (тесты, харнессы) — без колец, отправка та же.
 */
export function bindUploadProgress(sink: UploadProgressSink | null): void {
  boundProgress = sink;
}

/**
 * Э5 (#141, `fedm5`): «мой дом лежит — пишу через инстанс собеседника». Привязка из `main.tsx` (`fedVia.ts`) — не импортом, как
 * `bindUploadProgress`: стор грузят харнессы тестов с перечнем разрешённых модулей. Не привязано — отправка и история прежние.
 */
export interface FedViaHooks {
  /** Дом недоступен и у беседы есть действующая долгая сессия: текст идёт в обход. */
  active: (convId: string) => boolean;
  /** Долгая сессия беседы есть (дом мог лечь, а мы ещё не знаем) — провалившуюся отправку можно повторить в обход. */
  canTry: (convId: string) => boolean;
  /** Запрос к дому не дошёл — проверить дом (проба) и показать плашку. */
  homeFailed: () => void;
  /** Текст в обход дома по долгой сессии (+ запись в очередь отчёта). */
  send: (
    convId: string,
    body: { clientId: string; content: string; replyToId: string | null; silent?: true; noPreview?: true },
    timeoutMs: number,
  ) => Promise<ConvMessage>;
  /** Последняя порция истории беседы у инстанса собеседника (пока дом недоступен). */
  history: (convId: string) => Promise<ConvMessage[]>;
}
let boundVia: FedViaHooks | null = null;
export function bindFedVia(h: FedViaHooks | null): void {
  boundVia = h;
}

/** Отмену загрузки сделал сам человек (XHR `abort`, `uploadProgress.uploadAborted`): строку не помечать «не отправлено». */
function aborted(e: unknown): boolean {
  return (e as { aborted?: boolean } | null)?.aborted === true || (e as { name?: string } | null)?.name === 'AbortError';
}

const HISTORY_PAGE = 50;
/** Первая порция ленты из кеша (или после смены токена): покрывает весь кешированный хвост — ссылки обновятся все. */
const STALE_PAGE = 100;
const RETRY_MS = [2_000, 5_000, 15_000, 30_000];
/** Черновик на сервер — после паузы в наборе (Р7), но не реже раза в `DRAFT_MAX_WAIT_MS`; погашенный — сразу. */
const DRAFT_SAVE_MS = 2_000;
const DRAFT_MAX_WAIT_MS = 10_000;
/**
 * Запись черновика не удалась (сеть, лимит) — повтор ровно через столько: предел набора `DRAFT_MAX_WAIT_MS` на него не
 * действует. Ещё раньше — на `ready` и следующей букве.
 */
const DRAFT_RETRY_MS = 15_000;
/** Без шлюза — догонка раз в столько (прокси режет WebSocket: событий нет вовсе, а список и ленты должны жить). */
const POLL_MS = 30_000;
/**
 * Отправка без ответа дольше этого — не дошла, связи нет (05.10): зависший запрос (сеть пропала посреди него) держал строку
 * «в пути» минутами. Повтор тем же id безопасен — сервер узнаёт его и вернёт то же сообщение.
 */
const SEND_TIMEOUT_MS = 15_000;

function screenIdOf(s: ConvHost, mobile: boolean): string | null {
  if (!s.currentDmId) return null;
  const on = isFeedOnScreen({
    id: s.currentDmId,
    currentId: s.currentDmId,
    mobile,
    mobilePane: s.mobilePane,
    kind: 'dm',
    view: s.view,
  });
  return on ? s.currentDmId : null;
}

function listOf(s: ConvHost, convId: string): ConvMessage[] | undefined {
  return s.dmMessages[convId] as ConvMessage[] | undefined;
}

/** Вложение из ответа загрузки → ссылка на него в отправке (id + подсказки клиента). */
export function toOutboxRef(a: Attachment): OutboxRef {
  return {
    id: a.id as string,
    width: a.width ?? null,
    height: a.height ?? null,
    waveform: a.waveform ?? null,
    durationMs: a.durationMs ?? null,
  };
}

export function createConvActions(set: Set, get: Get, deps: ConvDeps) {
  // Таймеры и часы — из `deps` (тест крутит время сам); имена прежние, чтобы тело читалось как обычный код.
  const { api, now, setTimeout, clearTimeout, onOnline, isMobile, markChannelSeen, windowed = () => false } = deps;
  const { draftsOnServer = () => false, draftDevice = 'device', peerReadsOnServer = () => false } = deps;
  const { deviceOffline = () => false } = deps;
  const noProgress: UploadProgressSink = { progress: () => {}, done: () => {}, clear: () => {} };
  /** Читается на каждом событии: привязка (`bindUploadProgress`) может прийти позже создания стора. */
  const progress: UploadProgressSink = {
    progress: (k, i, l, t) => (deps.uploadProgress ?? boundProgress ?? noProgress).progress(k, i, l, t),
    done: (k, i) => (deps.uploadProgress ?? boundProgress ?? noProgress).done(k, i),
    clear: (k) => (deps.uploadProgress ?? boundProgress ?? noProgress).clear(k),
  };
  const onScreenId = (s: ConvHost) => screenIdOf(s, isMobile());

  /** «Прочитано» по видимому (G09): последний ключ, который лента показала человеку (`convSeen`), и пакеты отметки. */
  const seenKeys = new Map<string, number>();
  const seenTimers = new Map<string, unknown>();

  // Одна догонка за раз; повторный запрос во время идущей — ещё один круг после неё.
  let running: Promise<void> | null = null;
  let again = false;
  let retry: unknown = null;
  let retryStep = 0;
  // Поколение: сброс (выход, смена инстанса) обрывает идущую догонку — её ответы уже не про нас.
  let gen = 0;
  /* Шлюз (`sockets`): события идут, только пока он `up` (после `ready`). `down` — оборвался или не подключился: окно в
     памяти уже не «живое», а список и ленты догоняем сами — сразу и раз в `POLL_MS`. До первого исхода — `unknown`. */
  let gateway: 'unknown' | 'up' | 'down' = 'unknown';
  let poll: unknown = null;
  /* Р6: список ради `peerReadKey` уже перечитан в этом поколении (`refreshPeerRead`) — второй раз не просим: сервер,
     объявивший `conv4` и всё равно не приславший поле, иначе гонял бы список на каждой догонке. */
  let peerReadRefreshed = false;

  /**
   * Ответ (или отказ) запроса, пришедший после сброса, — уже не про нынешнее состояние: вместо него отказ с меткой
   * `switched`, как у `api.switchedAway` (тосты его глотают, вызывающий дальше не идёт). Без этого история прежнего
   * аккаунта или инстанса ложилась в новый стор (Codex, 01.10: `openLatest` и порции ленты после await).
   */
  async function sameGen<T>(request: Promise<T>): Promise<T> {
    const myGen = gen;
    const superseded = () => Object.assign(new Error('беседы сброшены'), { switched: true as const });
    let res: T;
    try {
      res = await request;
    } catch (e) {
      throw myGen === gen ? e : superseded();
    }
    if (myGen !== gen) throw superseded();
    return res;
  }

  /** Записать состояние бесед и вывести из него то, что читает интерфейс. */
  function commit(
    conv: ConvState,
    lists?: Record<string, ConvMessage[] | undefined>,
    unreadDms?: string[],
    fromServer = true,
  ): void {
    set((s) => {
      let dmMessages = s.dmMessages;
      if (lists) {
        dmMessages = { ...s.dmMessages };
        for (const [id, list] of Object.entries(lists)) {
          if (list) dmMessages[id] = list;
          else delete dmMessages[id];
        }
      }
      return {
        conv,
        dms: summariesToDms(conv.summaries),
        dmMessages,
        ...(unreadDms ? { unreadDms } : {}),
        ...(fromServer ? remoteDrafts(s, conv) : {}),
      };
    });
  }

  /**
   * Черновики из сводок, пришедших с сервера (Р7): по `convSyncRules.remoteDraftDecision`, только изменившиеся сводки.
   * 🔴 Не при подъёме из кеша (`commit(…, false)`): сводка там могла отстать от черновика (эхо своей записи ещё не
   * пришло), а метка устройства после перезагрузки другая — старый текст лёг бы поверх нового.
   */
  function remoteDrafts(s: ConvHost, next: ConvState): Partial<ConvHost> {
    if (!draftsOnServer() || next.summaries === s.conv.summaries) return {};
    let drafts = s.drafts;
    let rev = s.draftRev ?? {};
    const dirty = s.draftDirty ?? [];
    for (const [id, sum] of Object.entries(next.summaries)) {
      if (sum === s.conv.summaries[id]) continue;
      const d = remoteDraftDecision({ remote: sum.draft, local: drafts[id], dirty: dirty.includes(id), device: draftDevice });
      if (!d.apply) continue;
      drafts = updateDrafts(drafts, id, d.draft?.text ?? '', d.draft?.replyToId ?? null);
      rev = { ...rev, [id]: (rev[id] ?? 0) + 1 };
    }
    return drafts === s.drafts ? {} : { drafts, draftRev: rev };
  }

  /** Сводка из события или догонки: применить по правилу свежести; ушедшая беседа уносит свою ленту. */
  function takeSummary(
    conv: ConvState,
    lists: Record<string, ConvMessage[] | undefined>,
    unread: string[],
    s: ConvEventSummary,
    P: number,
  ): { conv: ConvState; unread: string[] } {
    const r = applySummary(conv, s, P);
    if (r.dropped) {
      lists[r.dropped] = undefined;
      // Закреплённые (С2) и отложенные (С4) ушедшей беседы — туда же: показывать их больше негде.
      return { conv: dropScheduled(dropPins(r.state, r.dropped), r.dropped), unread: unread.filter((x) => x !== r.dropped) };
    }
    const applied = r.state.summaries[s.id];
    const before = conv.summaries[s.id];
    /* «Прочитано» с другого моего устройства (или пока этого не было в сети): сдвинуть метку визита, как старый путь
       по `read.dm` (`store.applyRemoteRead`), — иначе черта «Новые сообщения» встанет над уже прочитанным и лента при
       открытии прыгнет вверх. Только для беседы НЕ на глазах: под читающим черта не исчезает. */
    if (
      applied &&
      before &&
      applied !== before &&
      applied.unread === 0 &&
      applied.lastReadKey > before.lastReadKey &&
      onScreenId(get()) !== s.id
    ) {
      markChannelSeen(s.id, Date.parse(applied.lastMessageAt ?? applied.createdAt) || now());
    }
    // Погасить — только по применённой сводке с «0»; зажигает только новое чужое (при приёме события).
    return { conv: r.state, unread: applied && applied.unread === 0 ? unread.filter((x) => x !== s.id) : unread };
  }

  function takeMessage(
    conv: ConvState,
    lists: Record<string, ConvMessage[] | undefined>,
    m: ConvEventMessage,
    P: number,
  ): ConvState {
    const s = get();
    const cur = m.conversationId in lists ? lists[m.conversationId] : listOf(s, m.conversationId);
    const r = applyMessage(conv, cur, m, P);
    if (r.list !== undefined || m.conversationId in lists) lists[m.conversationId] = r.list;
    return r.state;
  }

  /**
   * Применить событие (номер уже проверен). `pins` (С2) — мой список закреплённых этой беседы целиком: у удаления и правки
   * закреплённого он идёт отдельным событием следом за событием о сообщении. `scheduled` (С4) — мой список отложенных
   * целиком: ушедшее отложенное приходит обычным новым сообщением, а следом — список без него.
   */
  function applyEvent(conv: ConvState, lists: Record<string, ConvMessage[] | undefined>, unread: string[], ev: ConvChangeEvent) {
    const r = takeSummary(conv, lists, unread, ev.conversation, ev.pts);
    let next = r.conv;
    if (ev.message) next = takeMessage(next, lists, ev.message, ev.pts);
    if (ev.pins && !isConvLeft(ev.conversation)) next = applyPins(next, ev.conversation.id, ev.pins, ev.pts);
    if (ev.scheduled && !isConvLeft(ev.conversation)) next = applyScheduled(next, ev.conversation.id, ev.scheduled, ev.pts);
    return { conv: { ...next, pts: ev.pts }, unread: r.unread };
  }

  async function syncOnce(myGen: number): Promise<void> {
    const start = get().conv;
    if (start.pts === null) {
      const res = await api.convList();
      if (myGen !== gen) return;
      const conv = applyList(get().conv, res);
      commit(conv, undefined, seedUnread(conv.summaries, onScreenId(get())));
    } else {
      let since = start.pts;
      for (;;) {
        const res = await api.convSync(since);
        if (myGen !== gen) return;
        if (res.reset) {
          await resetAll(myGen);
          break;
        }
        let conv = get().conv;
        const lists: Record<string, ConvMessage[] | undefined> = {};
        let unread = [...get().unreadDms];
        const screen = onScreenId(get());
        for (const s of res.conversations) {
          const r = takeSummary(conv, lists, unread, s, res.pts);
          conv = r.conv;
          unread = r.unread;
          // Догонка: непрочитанное зажигается, как при загрузке списка (кроме беседы на экране). Уведомлений нет.
          if (!isConvLeft(s)) unread = nextUnread(unread, s, s.id !== screen);
        }
        for (const m of res.messages) conv = takeMessage(conv, lists, m, res.pts);
        // Закреплённые (С2): полные списки бесед, где в этой порции журнала менялся мой закреп (у ушедшей — не нужен).
        for (const p of res.pins ?? []) if (conv.summaries[p.conversationId]) conv = applyPins(conv, p.conversationId, p.pins, res.pts);
        // Отложенные (С4): полные списки бесед, где в этой порции журнала менялись мои отложенные (у ушедшей — не нужен).
        for (const q of res.scheduled ?? []) {
          if (conv.summaries[q.conversationId]) conv = applyScheduled(conv, q.conversationId, q.items, res.pts);
        }
        commit({ ...conv, pts: Math.max(conv.pts ?? 0, res.pts) }, lists, unread);
        since = res.pts;
        if (!res.more) break;
      }
      // Р6: сводки из кеша, снятые до обновления сервера, — без ✓✓. Сбой не держит догонку: повтор на следующей.
      if (myGen === gen) await refreshPeerRead(myGen).catch(() => {});
    }
    if (myGen !== gen) return;
    // Буфер — синхронно, вместе с переходом в «живое»: между ними не вклинится ни одно событие.
    const conv0 = get().conv;
    const plan = drainPlan(conv0.pts ?? 0, conv0.buffer);
    let conv: ConvState = { ...conv0, buffer: plan.rest };
    const lists: Record<string, ConvMessage[] | undefined> = {};
    let unread = [...get().unreadDms];
    for (const ev of plan.apply) {
      const r = applyEvent(conv, lists, unread, ev);
      conv = r.conv;
      unread = r.unread;
    }
    if (plan.gap) {
      commit({ ...conv, phase: 'syncing' }, lists, unread);
      again = true;
      return;
    }
    // Без шлюза событий нет: догнали, но «живой» лента не станет — открытие окна сходит за свежей порцией (шаг 2г).
    commit({ ...conv, phase: gateway === 'up' ? 'live' : 'idle' }, lists, unread);
  }

  /** Журнал обрезан (или сервер моложе клиента): список с нуля, ленты — заново, открытая — сразу. */
  async function resetAll(myGen: number): Promise<void> {
    const res = await api.convList();
    if (myGen !== gen) return;
    const prev = get().conv;
    const conv = applyList({ ...emptyConvState(), phase: prev.phase, buffer: prev.buffer, gone: prev.gone }, res);
    const drop: Record<string, undefined> = {};
    for (const id of Object.keys(get().dmMessages)) drop[id] = undefined;
    commit(conv, drop, seedUnread(conv.summaries, onScreenId(get())));
    const open = get().currentDmId;
    if (open) await openLatest(open).catch(() => {});
  }

  /**
   * Р6, ✓✓: у сервера `conv4`, а в памяти есть сводка без `peerReadKey` — снята до его обновления (кеш на диске);
   * догонка приносит только задетые беседы, и в остальных до первого события стояла бы одна галочка. Перечитываем список
   * и дописываем ТОЛЬКО это поле (`withPeerRead`): номер журнала и прочее в сводках ведут догонка и события. Идёт внутри
   * догонки — пришедшие тем временем события ждут в буфере. Один раз за поколение; сбой — флаг не ставится, повтор на
   * следующей догонке.
   */
  async function refreshPeerRead(myGen: number): Promise<void> {
    if (peerReadRefreshed || !peerReadsOnServer() || !lacksPeerRead(get().conv.summaries)) return;
    const res = await api.convList();
    if (myGen !== gen) return;
    peerReadRefreshed = true;
    const conv = withPeerRead(get().conv, res.conversations);
    // Сводки поменялись только полем ✓✓: черновики из них не разбираем (`fromServer = false`), непрочитанное — то же.
    if (conv !== get().conv) commit(conv, undefined, undefined, false);
  }

  function scheduleRetry(): void {
    if (retry) return;
    const ms = RETRY_MS[Math.min(retryStep, RETRY_MS.length - 1)];
    retryStep++;
    retry = setTimeout(() => {
      retry = null;
      void runSync();
    }, ms);
  }

  /**
   * `force` — нужен ещё один круг, даже если догонка уже идёт: переподключение шлюза или дыра в номерах (идущая могла
   * снять снимок раньше потерянного). Без `force` (список для интерфейса) — просто дождаться идущей.
   */
  function runSync(force = true): Promise<void> {
    if (!get().convActive) return Promise.resolve();
    if (running) {
      if (force) again = true;
      return running;
    }
    const myGen = gen;
    let run: Promise<void> | undefined;
    run = (async () => {
      try {
        do {
          again = false;
          set((s) => ({ conv: { ...s.conv, phase: 'syncing' } }));
          await syncOnce(myGen);
        } while (again && myGen === gen);
        retryStep = 0;
      } catch {
        // Сеть или сервер: события копятся в буфере, догонка повторится сама (и на следующем `ready`).
        if (myGen === gen) scheduleRetry();
      } finally {
        // Сброс посреди догонки уже отпустил её (`convReset`) — новую, начатую после, не трогаем.
        if (running === run) running = null;
      }
    })();
    running = run;
    return run;
  }

  /** Шлюза нет — следующая догонка через `POLL_MS`; вернулся шлюз или сброс — опрос гаснет сам. */
  function schedulePoll(): void {
    if (poll !== null || gateway !== 'down') return;
    const myGen = gen;
    poll = setTimeout(() => {
      poll = null;
      if (myGen !== gen || gateway !== 'down' || !get().convActive) return;
      void runSync(false).then(() => {
        if (myGen === gen) schedulePoll();
      });
    }, POLL_MS);
  }

  /** Последняя порция беседы (открытие, перечитка). «Прочитано» — после ответа и только если беседа на экране. */
  async function openLatest(convId: string): Promise<void> {
    const stale = !!get().conv.windows[convId]?.stale;
    const res = await sameGen(api.convHistory(convId, { limit: stale ? STALE_PAGE : HISTORY_PAGE }));
    const s = get();
    // Хвост дописан к старому окну — длинное окно режется сверху, как после подгрузки нового.
    const r = fit(applyPage(s.conv, listOf(s, convId), convId, res, 'latest'), convId, 'newer');
    commit(r.state, { [convId]: r.list });
  }

  /** Окно ЗАМЕНЯЕТСЯ порцией (шаг 2г): открытие у непрочитанного, переход к сообщению, возврат на место. */
  async function openJump(convId: string, q: { after?: string; around?: string; date?: string }): Promise<void> {
    const res = await sameGen(api.convHistory(convId, { ...q, limit: HISTORY_PAGE }));
    const s = get();
    const r = applyPage(s.conv, listOf(s, convId), convId, res, 'jump');
    commit(r.state, { [convId]: r.list });
  }

  /** Лента не растёт с историей (шаг 2г): после подгрузки отрезается дальний от человека край. */
  function fit(r: { state: ConvState; list: ConvMessage[] }, convId: string, loaded: 'older' | 'newer') {
    // Без окна (переключатель выключен) лента прежняя: подгрузки вниз у неё нет, обрезка унесла бы последние сообщения.
    if (!windowed()) return r;
    const t = trimPlan(r.list.length, loaded);
    return t ? trimWindow(r.state, r.list, convId, t.side, t.count) : r;
  }

  // ─── Исходящие (шаг 2в) ───────────────────────────────────────────────────────────────────────────────────────
  const sending = new Set<string>();
  const pumpTimers = new Map<string, unknown>();
  /**
   * «Отменить отправку» (07.10, Telegram 1.24/2.35/6.22): загрузка строки обрывается (`AbortController` → XHR `abort`).
   * Ключ — id отправки строки; живёт, пока строка в `pump`.
   */
  const uploads = new Map<string, AbortController>();
  /** Отменённые, когда файлы уже ушли и летел сам запрос отправки: сервер мог сообщение принять — тогда убрать у обоих. */
  const cancelledInFlight = new Set<string>();

  function hasItem(convId: string, key: string): boolean {
    return !!get().outbox[convId]?.some((x) => x.key === key);
  }

  function setItems(convId: string, fn: (list: OutboxItem[]) => OutboxItem[]): void {
    set((s) => {
      const next = fn(s.outbox[convId] ?? []);
      const outbox = { ...s.outbox };
      if (next.length) outbox[convId] = next;
      else delete outbox[convId];
      return { outbox };
    });
  }

  function patchItem(convId: string, key: string, fn: (it: OutboxItem) => OutboxItem): void {
    setItems(convId, (list) => list.map((x) => (x.key === key ? fn(x) : x)));
  }

  function schedulePump(convId: string, ms: number): void {
    if (pumpTimers.has(convId)) return;
    pumpTimers.set(
      convId,
      setTimeout(() => {
        pumpTimers.delete(convId);
        void pump(convId);
      }, ms),
    );
  }

  /** Слать голову очереди беседы; по завершении — следующую. Одна отправка на беседу за раз: порядок строгий. */
  async function pump(convId: string): Promise<void> {
    if (sending.has(convId) || !get().convActive) return;
    const { item, waitMs } = nextToSend(get().outbox[convId] ?? [], now());
    if (!item) {
      if (waitMs) schedulePump(convId, waitMs);
      return;
    }
    sending.add(convId);
    const myGen = gen;
    // Без `AbortController` в окружении (харнесс тестов) — без обрыва загрузки: отмену видно по пропавшей строке.
    const ctrl = typeof AbortController === 'function' ? new AbortController() : null;
    if (ctrl) uploads.set(item.key, ctrl);
    try {
      const uploaded = [...item.uploaded];
      for (let i = 0; i < item.fileNames.length; i++) {
        if (uploaded[i]) continue;
        const file = item.files[i];
        // Файла нет — строка пришла с диска после перезапуска, а загрузиться он не успел: выбрать заново.
        if (!file) throw Object.assign(new Error('файл не загрузился — прикрепите его снова'), { status: 400 });
        // Прогресс — мимо стора (`uploadProgress.ts`): кольцо у файла в строке «в пути», отмена — `outboxDiscard`.
        const ref = toOutboxRef(
          await api.convUpload(convId, file, {
            signal: ctrl?.signal,
            onProgress: (loaded, total) => progress.progress(item.key, i, loaded, total),
          }),
        );
        uploaded[i] = ref;
        progress.done(item.key, i);
        if (myGen !== gen) return;
        const done = [...uploaded];
        patchItem(convId, item.key, (x) => ({ ...x, uploaded: done }));
      }
      // Отменили между файлами или сразу после последнего — сообщения нет и не будет.
      if (ctrl?.signal.aborted || !hasItem(convId, item.key)) throw Object.assign(new Error('отменено'), { aborted: true });
      const sendBody: Parameters<Api['convSend']>[1] = {
          clientId: item.key,
          content: item.content,
          // «Как файлы» (G48) — подсказка `asFile` у каждого вложения; сервер оставит её только у картинок и видео.
          attachments: (item.asFile === true ? (uploaded as OutboxRef[]).map((r) => ({ ...r, asFile: true as const })) : uploaded).map((r, i) => {
            if (!r) return r;
            const sp = item.spoilers?.includes(i) ? { ...r, spoiler: true as const } : r;
            // Одноразовое фото/видео (`ttlmedia1`, #226): `once` и таймер — у единственного файла строки.
            return item.onceTtl !== undefined ? { ...sp, once: true as const, ...(item.onceTtl > 0 ? { onceTtl: item.onceTtl } : {}) } : sp;
          }) as OutboxRef[],
          replyToId: item.replyToId,
          // «Без звука» (С3) — поле только у таких: обычная отправка уходит прежним телом.
          ...(item.silent === true ? { silent: true } : {}),
          // «Без превью» (G19) — так же только у таких.
          ...(item.noPreview === true ? { noPreview: true } : {}),
          // «Подпись над медиа» (G48) — так же только у таких.
          ...(item.captionAbove === true ? { captionAbove: true } : {}),
          // Цитата фрагмента (G55, `quote1`) — так же только у таких.
          ...(item.replyQuote && item.replyToId ? { replyQuote: item.replyQuote } : {}),
      };
      const msg = await sendBoth(convId, item, sendBody);
      if (myGen !== gen) return;
      setItems(convId, (list) => list.filter((x) => x.key !== item.key));
      progress.clear(item.key);
      if (cancelledInFlight.delete(item.key)) {
        // «Отменить отправку», пока летел запрос: сервер сообщение принял — убираем его у обоих, в ленту не кладём.
        // Сервер не дал удалить (сбой, нет метода) — честно показываем: у собеседника сообщение есть.
        if (api.convDelete) {
          api.convDelete(convId, msg.id, 'both').then(
            () => {
              if (myGen === gen) removeSent(convId, msg.id);
            },
            () => {
              if (myGen === gen) afterSend(convId, msg);
            },
          );
        } else afterSend(convId, msg);
      } else afterSend(convId, msg);
    } catch (e) {
      if (myGen !== gen) return;
      progress.clear(item.key);
      // Отменил сам человек: строки уже нет — «не отправлено» не ставим, очередь идёт дальше.
      if (aborted(e) || !hasItem(convId, item.key)) cancelledInFlight.delete(item.key);
      else failItem(convId, item, e);
    } finally {
      uploads.delete(item.key);
      // Сброс посреди отправки уже снял замки, и новая отправка той же беседы могла взять свой — его не трогаем.
      if (myGen === gen) sending.delete(convId);
    }
    if (myGen === gen) void pump(convId);
  }

  /**
   * Отправка строки: дом, а если он недоступен и строка — только текст, то через инстанс собеседника (Э5, `fedm5`, привязка
   * `bindFedVia`). Путь в обход открыт, пока дом лежит (`via.active`), либо открывается самим провалом отправки (`isHomeDownError`:
   * запрос не дошёл, молчание, 502–504) при уже сохранённой долгой сессии беседы. Отказ дома другим кодом — дом жив, обхода нет.
   */
  async function sendBoth(convId: string, item: OutboxItem, body: Parameters<Api['convSend']>[1]) {
    const via = boundVia;
    if (!via || !viaSendable(item)) return api.convSend(convId, body, SEND_TIMEOUT_MS);
    const viaBody = {
      clientId: body.clientId,
      content: body.content,
      replyToId: body.replyToId ?? null,
      ...(body.silent ? { silent: true as const } : {}),
      ...(body.noPreview ? { noPreview: true as const } : {}),
    };
    if (via.active(convId)) return via.send(convId, viaBody, SEND_TIMEOUT_MS);
    try {
      return await api.convSend(convId, body, SEND_TIMEOUT_MS);
    } catch (e) {
      if (!isHomeDownError(e) || deviceOffline() || !via.canTry(convId)) throw e;
      via.homeFailed();
      return via.send(convId, viaBody, SEND_TIMEOUT_MS);
    }
  }

  /** Неудача попытки отправки — по правилам очереди (`outboxRules.afterFailure`). */
  function failItem(convId: string, item: OutboxItem, e: unknown): void {
    const why = sendErrorText(e);
    /* Связи нет (шлюз оборван, у устройства нет сети, сервер молчал `SEND_TIMEOUT_MS`) — «не отправлено» сразу, уйдёт само,
       когда связь вернётся (05.10). */
    const offline = gateway === 'down' || deviceOffline() || (e as { timeout?: boolean }).timeout === true;
    // Ушёл в другой инстанс, пока запрос летел, — строка не про этот инстанс (как `outgoingRules.sendErrorText`).
    if (why === null) setItems(convId, (list) => list.filter((x) => x.key !== item.key));
    else patchItem(convId, item.key, (x) => afterFailure(x, (e as { status?: number }).status, why, now(), offline));
  }

  /** Своё сообщение, отменённое уже на сервере, — убрать из ленты (как `convAfterDelete`). */
  function removeSent(convId: string, messageId: string): void {
    const s = get();
    const r = applyRemoved(s.conv, listOf(s, convId), messageId);
    commit(r.state, r.list ? { [convId]: r.list } : undefined);
  }

  function pumpAll(): void {
    for (const convId of Object.keys(get().outbox)) void pump(convId);
  }

  /** Связь вернулась (`online`, `ready` шлюза): не ушедшее из-за связи — снова в очередь (`outboxRules.afterReconnect`). */
  function reviveOutbox(): void {
    for (const [convId, list] of Object.entries(get().outbox)) {
      const next = afterReconnect(list);
      if (next !== list) setItems(convId, () => [...next]);
    }
  }

  /** Своё сообщение из ответа отправки — сразу в ленту и наверх списка (событие придёт следом и уточнит). */
  function afterSend(convId: string, m: ConvMessage): void {
    const s = get();
    const r = applySent(s.conv, listOf(s, convId), m);
    const summary = r.state.summaries[convId];
    const conv =
      summary && (!summary.lastMessageAt || Date.parse(m.createdAt) > Date.parse(summary.lastMessageAt))
        ? { ...r.state, summaries: { ...r.state.summaries, [convId]: { ...summary, lastMessageAt: m.createdAt } } }
        : r.state;
    commit(conv, r.list ? { [convId]: r.list } : undefined);
  }

  // ─── Черновики на сервер (Р7) ──────────────────────────────────────────────────────────────────────────────────
  const draftTimers = new Map<string, unknown>();
  const draftFirstDirty = new Map<string, number>();
  const draftInFlight = new Set<string>();
  const draftAgain = new Set<string>();

  function draftsSync(): boolean {
    return !!api.convDraft && draftsOnServer() && get().convActive;
  }

  function setDraftDirty(convId: string, on: boolean): void {
    set((s) => {
      const has = !!s.draftDirty?.includes(convId);
      if (has === on) return s;
      return { draftDirty: on ? [...(s.draftDirty ?? []), convId] : (s.draftDirty ?? []).filter((x) => x !== convId) };
    });
  }

  /** Один таймер записи на беседу: новый заменяет прежний. */
  function armDraftTimer(convId: string, wait: number): void {
    const t = draftTimers.get(convId);
    if (t !== undefined) clearTimeout(t);
    draftTimers.set(
      convId,
      setTimeout(() => {
        draftTimers.delete(convId);
        void saveDraftNow(convId, false);
      }, wait),
    );
  }

  /** Набор: записать через `ms` после последней буквы, но не позже `DRAFT_MAX_WAIT_MS` от первой незаписанной. */
  function scheduleDraftSave(convId: string, ms: number): void {
    const t0 = now();
    const first = draftFirstDirty.get(convId) ?? t0;
    draftFirstDirty.set(convId, first);
    armDraftTimer(convId, Math.min(ms, Math.max(0, first + DRAFT_MAX_WAIT_MS - t0)));
  }

  /** Одна запись черновика беседы за раз (порядок записей = порядок набора); набрали ещё, пока шла, — следующим кругом. */
  async function saveDraftNow(convId: string, keepalive: boolean): Promise<void> {
    const t = draftTimers.get(convId);
    if (t !== undefined) {
      clearTimeout(t);
      draftTimers.delete(convId);
    }
    if (!draftsSync() || !get().draftDirty?.includes(convId)) return;
    if (draftInFlight.has(convId)) {
      draftAgain.add(convId);
      return;
    }
    draftFirstDirty.delete(convId);
    const sent = get().drafts[convId] ?? null;
    draftInFlight.add(convId);
    const myGen = gen;
    try {
      await sameGen(
        api.convDraft!(convId, { text: draftTextForServer(sent?.text ?? ''), replyToId: sent?.replyToId ?? null, device: draftDevice }, keepalive),
      );
      const cur = get().drafts[convId] ?? null;
      // Не меняли, пока шла запись, — на сервере то же, что здесь; меняли — запишем ещё раз.
      if (cur === sent || (!!cur && !!sent && cur.text === sent.text && cur.replyToId === sent.replyToId)) {
        setDraftDirty(convId, false);
      } else draftAgain.add(convId);
    } catch (e) {
      if (myGen !== gen) return;
      const status = (e as { status?: number }).status;
      // Беседы нет или запрос негоден — записать не выйдет никогда: черновик остаётся только на этом устройстве.
      if (status === 400 || status === 403 || status === 404) setDraftDirty(convId, false);
      // Временный отказ — повтор ровно через `DRAFT_RETRY_MS`: предел набора (`DRAFT_MAX_WAIT_MS`) его не сокращает.
      else armDraftTimer(convId, DRAFT_RETRY_MS);
    } finally {
      if (myGen === gen) {
        draftInFlight.delete(convId);
        if (draftAgain.delete(convId)) void saveDraftNow(convId, false);
      }
    }
  }

  function saveDirtyDrafts(keepalive: boolean): void {
    for (const id of get().draftDirty ?? []) void saveDraftNow(id, keepalive);
  }

  // Сеть вернулась — очередь не ждёт следующего `ready` шлюза; не ушедшее из-за связи уходит само.
  onOnline(() => {
    reviveOutbox();
    pumpAll();
  });

  return {
    /** Начать с чистого листа (выход, смена инстанса): идущая догонка обрывается. */
    convReset: () => {
      gen++;
      again = false;
      gateway = 'unknown';
      peerReadRefreshed = false;
      if (poll !== null) clearTimeout(poll);
      poll = null;
      // Идущая догонка — про прежний инстанс или человека: её ответы отбросит поколение, а новая не должна её ждать.
      running = null;
      for (const t of pumpTimers.values()) clearTimeout(t);
      pumpTimers.clear();
      sending.clear();
      // Загрузки прежнего инстанса или человека — оборвать: их строк больше нет.
      for (const c of uploads.values()) c.abort();
      uploads.clear();
      cancelledInFlight.clear();
      seenKeys.clear();
      for (const t of seenTimers.values()) clearTimeout(t);
      seenTimers.clear();
      if (retry) clearTimeout(retry);
      retry = null;
      retryStep = 0;
      for (const t of draftTimers.values()) clearTimeout(t);
      draftTimers.clear();
      draftFirstDirty.clear();
      draftInFlight.clear();
      draftAgain.clear();
      set({ conv: emptyConvState(), outbox: {}, drafts: {}, places: {}, draftDirty: [], draftRev: {} });
    },

    /**
     * Первый кадр из кеша на диске (шаг 2б): список и хвосты лент — до сети, номер журнала — с которого догонять.
     * Только до первой загрузки: поверх уже живого состояния старый снимок не кладём.
     */
    convHydrate: (rec: ConvCacheRecord) => {
      const s = get();
      if (s.conv.pts !== null) return;
      const { conv, messages } = hydrateState(rec);
      commit(conv, messages, seedUnread(conv.summaries, onScreenId(s)), false);
      if (rec.drafts && Object.keys(rec.drafts).length) set({ drafts: rec.drafts });
      // Не записанные на сервер до перезапуска (Р7) — уйдут после `ready`, а пришедшее их не затрёт.
      if (rec.draftDirty?.length) set({ draftDirty: rec.draftDirty });
      if (rec.places && Object.keys(rec.places).length) set({ places: rec.places });
      // Исходящие, не ушедшие до перезапуска: с загруженными файлами — уходят сами тем же id (дубля не будет).
      const outbox: Record<string, OutboxItem[]> = {};
      for (const p of rec.outbox ?? []) (outbox[p.convId] ??= []).push(restoreItem(p));
      if (Object.keys(outbox).length) {
        set({ outbox });
        pumpAll();
      }
    },

    /**
     * Токен сменился на этом устройстве (смена пароля, «выйти везде», подтверждение почты): ссылки на закрытые файлы
     * выданы под прежнее поколение и погасли. Ленты выбрасываем, открытую — перечитываем порцией, которая заменит её.
     */
    convTokenChanged: () => {
      const s = get();
      if (!s.convActive) return;
      const open = s.currentDmId;
      const drop: Record<string, undefined> = {};
      const windows = { ...s.conv.windows };
      for (const id of Object.keys(s.dmMessages)) {
        if (id === open) continue;
        drop[id] = undefined;
        delete windows[id];
      }
      if (open && windows[open]) windows[open] = { ...windows[open], stale: true };
      // Закреплённые (С2) — тоже: миниатюра в них — ссылка того же поколения. Открытая лента попросит список заново.
      commit(dropPins({ ...s.conv, windows }), drop);
      if (open) void openLatest(open).catch(() => {});
    },

    /**
     * Шлюз сказал `ready` (первое подключение и каждое переподключение) — догнать всё, что было без нас.
     * ⚠️ Всегда с ещё одним кругом, даже если догонка уже идёт (например, список запросила лента до подключения шлюза):
     * снимок, снятый ДО `identify`, не видит событий между собой и регистрацией соединения — их принесёт этот круг.
     */
    convOnReady: () => {
      gateway = 'up';
      if (poll !== null) clearTimeout(poll);
      poll = null;
      return runSync().then(() => {
        reviveOutbox();
        pumpAll();
        // Черновики, не записанные без сети или до перезапуска (Р7).
        saveDirtyDrafts(false);
      });
    },

    /**
     * Шлюз оборвался или не подключился (`sockets.onclose`). События больше не идут: «живое» окно в памяти таким не
     * считается, а список и ленты догоняем сами — сразу и раз в `POLL_MS`, пока `ready` не вернёт поток. 🔴 Без этого
     * за прокси, режущим WebSocket, список из кеша не обновлялся вовсе: догонка шла только по `ready`. Повторные обрывы
     * попыток переподключения ничего не добавляют — опрос уже идёт.
     */
    convOnGatewayLost: () => {
      gateway = 'down';
      if (!get().convActive) return;
      if (get().conv.phase === 'live') set((s) => ({ conv: { ...s.conv, phase: 'idle' } }));
      if (poll !== null) return;
      void runSync(false);
      schedulePoll();
    },

    /**
     * Живое событие. `light` — новое чужое сообщение, на которое человек не смотрит (`dmIncomingDecision.countUnread`):
     * зажигаем сразу, при приёме, — событие может полежать в буфере догонки.
     */
    convOnChange: (ev: ConvChangeEvent, light: boolean) => {
      const s = get();
      if (!s.convActive) return;
      if (light && !isConvLeft(ev.conversation) && ev.conversation.unread > 0 && !s.unreadDms.includes(ev.conversation.id)) {
        set((x) => ({ unreadDms: [...x.unreadDms, ev.conversation.id] }));
      }
      const conv = get().conv;
      const d = eventDecision(conv, ev.pts);
      if (d === 'skip') return;
      if (d === 'buffer' || d === 'gap') {
        set((x) => ({ conv: { ...x.conv, buffer: bufferEvent(x.conv.buffer, ev), ...(d === 'gap' ? { phase: 'syncing' as const } : {}) } }));
        if (d === 'gap') void runSync();
        return;
      }
      const lists: Record<string, ConvMessage[] | undefined> = {};
      const r = applyEvent(conv, lists, [...get().unreadDms], ev);
      commit(r.conv, lists, r.unread);
    },

    /** Список бесед: из памяти, если он уже есть, иначе — догонка (она же загрузит его). */
    convEnsureList: async () => {
      if (get().conv.pts === null) await runSync(false);
      // Шлюза нет — открытый список догоняем сразу, не дожидаясь опроса (старый путь перечитывал его при каждом открытии).
      else if (gateway === 'down') void runSync(false);
    },

    /**
     * Открыть беседу (шаг 2г, `feedWindowRules.openAction`): у первого непрочитанного, на месте, где человек ушёл, или
     * последние; окно в памяти при живой догонке — без запроса. «Прочитано» — после, и только если беседа на экране.
     * Сбой без ленты — ошибка с «Повторить».
     */
    convOpen: async (convId: string) => {
      const myGen = gen;
      const s0 = get();
      const hadList = !!s0.dmMessages[convId];
      set((s) => (s.historyFailed.includes(convId) ? { historyFailed: s.historyFailed.filter((x) => x !== convId) } : s));
      const summary = s0.conv.summaries[convId];
      const win = s0.conv.windows[convId];
      const list = listOf(s0, convId);
      const place = s0.places?.[convId] ?? null;
      // Без окна (переключатель выключен) — как раньше: последние сообщения. Иначе открытие у непрочитанного дало бы
      // кусок из середины, а прежняя лента не умеет подгружать вниз.
      const action: ReturnType<typeof openAction> = !windowed()
        ? { fetch: 'latest' }
        : openAction({
        unread: summary?.unread ?? 0,
        lastReadKey: summary?.lastReadKey ?? 0,
        place,
        live: s0.conv.phase === 'live',
        window:
          win && list
            ? {
                stale: !!win.stale,
                atTail: !win.hasMoreAfter,
                firstKey: list[0]?.sortKey ?? null,
                hasMoreBefore: win.hasMoreBefore,
                hasPlace: !!place && list.some((m) => m.id === place.messageId),
              }
            : null,
          });
      const fetch =
        action.fetch === 'none'
          ? Promise.resolve()
          : action.fetch === 'after'
            ? openJump(convId, { after: afterKeyCursor(action.key) })
            : action.fetch === 'around'
              ? openJump(convId, { around: action.messageId }).catch((e: { status?: number }) => {
                  // Сообщения места больше нет (удалили) — место забываем, открываем последние.
                  if (e?.status !== 404 || myGen !== gen) throw e;
                  set((s) => {
                    const { [convId]: _gone, ...places } = s.places ?? {};
                    return { places };
                  });
                  return openLatest(convId);
                })
              : openLatest(convId);
      // После сброса (выход, другой инстанс) — ни «Повторить», ни «прочитано»: беседа уже не отсюда.
      const load = fetch
        .catch(() => {
          if (myGen === gen && !get().dmMessages[convId]) set((s) => ({ historyFailed: [...s.historyFailed, convId] }));
        })
        .then(() => {
          if (myGen === gen && onScreenId(get()) === convId) convReadNow(convId);
        });
      if (!hadList) await load;
    },

    /**
     * Э5: дом недоступен — свежая порция истории беседы у инстанса собеседника (`FedViaHooks.history`) сводится с окном
     * (`applyViaPage`: номера `pts` чужие — в окно не пишутся, добавляются лишь неизвестные сообщения). Тихо: нет привязки, обход
     * закрыт, окна нет или запрос не дошёл — ничего не меняется. Вернулся ли дом, решает проба (`fedVia.ts`).
     */
    convViaRefresh: async (convId: string): Promise<void> => {
      const via = boundVia;
      if (!via || !via.active(convId)) return;
      const myGen = gen;
      let msgs: ConvMessage[];
      try {
        msgs = await via.history(convId);
      } catch {
        return;
      }
      if (myGen !== gen) return;
      const s = get();
      const r = applyViaPage(s.conv, listOf(s, convId), convId, msgs);
      if (r.list && r.state !== s.conv) commit(r.state, { [convId]: r.list });
    },

    /** Порция старше первой в ленте (длинное окно режется снизу). `true` — выше есть ещё. */
    convLoadOlder: async (convId: string): Promise<boolean> => {
      const list = listOf(get(), convId);
      const first = list?.[0];
      if (!first) return false;
      const res = await sameGen(api.convHistory(convId, { before: convCursor(first), limit: HISTORY_PAGE }));
      const s = get();
      /* 🔴 Окно сменилось, пока шёл запрос (02.10, стенд 2г: подгрузка началась на окне из кеша, ответ пришёл после
         свежей порции «вокруг места»; так же — переход к цитате, обрезка края встречной подгрузкой): порция «старше
         прежнего первого» к новому окну не примыкает, приклеенная — дала бы дыру и беспорядок. Выбрасываем: прокрутка
         попросит снова от нового края. */
      if (listOf(s, convId)?.[0]?.id !== first.id) return !!s.conv.windows[convId]?.hasMoreBefore;
      const r = fit(applyPage(s.conv, listOf(s, convId), convId, res, 'older'), convId, 'older');
      commit(r.state, { [convId]: r.list });
      return res.hasMoreBefore;
    },

    /**
     * Порция новее последней в ленте (шаг 2г: окно не у хвоста — открыли у непрочитанного, перешли к цитате).
     * Длинное окно режется сверху. Подтянутое на экране — прочитано. `true` — ниже есть ещё.
     */
    convLoadNewer: async (convId: string): Promise<boolean> => {
      const list = listOf(get(), convId);
      const last = list?.[list.length - 1];
      if (!last) return false;
      const res = await sameGen(api.convHistory(convId, { after: convCursor(last), limit: HISTORY_PAGE }));
      const s = get();
      // Окно сменилось, пока шёл запрос, — порция к нему не примыкает (как у `convLoadOlder`).
      const now = listOf(s, convId);
      if (now?.[now.length - 1]?.id !== last.id) return !!s.conv.windows[convId]?.hasMoreAfter;
      const r = fit(applyPage(s.conv, listOf(s, convId), convId, res, 'newer'), convId, 'newer');
      commit(r.state, { [convId]: r.list });
      if (onScreenId(get()) === convId) convReadNow(convId);
      return res.hasMoreAfter;
    },

    /**
     * Перейти к сообщению (цитата, «назад»): есть в окне — сразу, нет — окно заменяется его окрестностью. `false` —
     * сообщения для меня больше нет (удалили).
     */
    convJumpTo: async (convId: string, messageId: string): Promise<boolean> => {
      if (listOf(get(), convId)?.some((m) => m.id === messageId)) return true;
      try {
        await openJump(convId, { around: messageId });
      } catch (e) {
        if ((e as { status?: number }).status === 404) return false;
        throw e;
      }
      return !!listOf(get(), convId)?.some((m) => m.id === messageId);
    },

    /**
     * «Перейти к дате» (G25, `search1`): окно заменяется окрестностью первого сообщения дня `day` (начало дня по часам
     * устройства); ответ — id этого сообщения (дня позже последнего — последнее), `null` — беседа пуста.
     */
    convJumpToDate: async (convId: string, day: Date): Promise<string | null> => {
      await openJump(convId, { date: dayStart(day).toISOString() });
      return firstOfDay(listOf(get(), convId) ?? [], day);
    },

    /** «Вниз» из окна не у хвоста: последние сообщения (на экране — прочитаны). Окно у хвоста — запроса нет. */
    convJumpLatest: async (convId: string): Promise<void> => {
      const win = get().conv.windows[convId];
      if (win && !win.hasMoreAfter && !win.stale) return;
      await openLatest(convId);
      if (onScreenId(get()) === convId) convReadNow(convId);
    },

    /** Запомнить место в беседе (`null` — человек ушёл снизу: открывать последние). */
    convSetPlace: (convId: string, place: FeedPlace | null) =>
      set((s) => {
        const cur = s.places?.[convId];
        if (!place) {
          if (!cur) return s;
          const { [convId]: _old, ...places } = s.places ?? {};
          return { places };
        }
        if (cur && cur.messageId === place.messageId && cur.offset === place.offset) return s;
        return { places: { ...s.places, [convId]: place } };
      }),

    /** Открыть или создать беседу с человеком; вернуть её id. */
    convOpenWith: async (userId: string | { instanceId: string; homeUserId: string }): Promise<string> => {
      const res = await sameGen(api.convDirect(userId));
      const conv = get().conv;
      // Номера у ответа нет: сводку берём, только если беседы в списке ещё нет (дальше её ведут события).
      if ('kind' in res && !conv.summaries[res.id]) {
        const r = applySummary(conv, res as ConvSummary, 0);
        commit(r.state);
      }
      return res.id;
    },

    /**
     * «Избранное» (08.10, `saved1`): найти беседу с самим собой или завести; вернуть её id. Сводка из ответа кладётся в
     * список, если её там ещё нет (дальше беседу ведут события); нет ручки у зависимостей — пусто.
     */
    convOpenSaved: async (): Promise<string> => {
      if (!api.convSaved) return '';
      const res = await sameGen(api.convSaved());
      const conv = get().conv;
      if ('kind' in res && !conv.summaries[res.id]) commit(applySummary(conv, res as ConvSummary, 0).state);
      return res.id;
    },

    /**
     * Сводка из ответа ручки группы (07.10, `groups1`: создать, добавить, переименовать…): беседы ещё нет в списке —
     * положить без номера (дальше её ведут события); есть — не трогать, событие с номером уже в пути.
     */
    convAdopt: (summary: ConvSummary) => {
      const conv = get().conv;
      if (conv.summaries[summary.id]) return;
      commit(applySummary(conv, summary, 0).state);
    },

    /** Своё сообщение из ответа отправки (голосовое — мимо очереди). */
    convAfterSend: (convId: string, m: ConvMessage) => afterSend(convId, m),

    /**
     * Черновик на ЭТОМ устройстве изменился (`store.setDraft`, Р7): пометить незаписанным и записать на сервер после
     * паузы в наборе; погашенный (отправили, стёрли) — сразу, чтобы на других устройствах он не висел рядом с
     * отправленным. Сервер без `conv3` — ничего: черновик живёт только здесь.
     */
    convDraftChanged: (convId: string) => {
      if (!draftsSync()) return;
      setDraftDirty(convId, true);
      scheduleDraftSave(convId, get().drafts[convId] ? DRAFT_SAVE_MS : 0);
    },

    /** Записать незаписанные черновики сейчас (фон, выгрузка, переход в другой инстанс); `keepalive` — переживёт закрытие. */
    convFlushDrafts: (keepalive = false) => saveDirtyDrafts(keepalive),

    /**
     * Поставить сообщение в очередь беседы: строка «в пути» — сразу, отправка — по порядку, с автоповтором. `silent` —
     * «Отправить без звука» (С3; зовущий проверил признак `conv8`).
     */
    outboxEnqueue: (
      convId: string,
      input: {
        key: string;
        content: string;
        files: File[];
        replyToId: string | null;
        silent?: boolean;
        asFile?: boolean;
        noPreview?: boolean;
        spoilers?: number[];
        onceTtl?: number;
        captionAbove?: boolean;
        replyQuote?: { text: string; offset: number } | null;
      },
    ) => {
      setItems(convId, (list) => [...list, newOutboxItem(convId, input, now())]);
      void pump(convId);
    },
    outboxRetry: (convId: string, key: string) => {
      patchItem(convId, key, manualRetry);
      const t = pumpTimers.get(convId);
      if (t) {
        clearTimeout(t);
        pumpTimers.delete(convId);
      }
      void pump(convId);
    },
    /**
     * «Удалить» неотправленное и «Отменить отправку» отправляемого (07.10): строка уходит сразу; идёт загрузка — обрывается
     * (сообщения не будет), уже летит сам запрос отправки — по ответу сообщение убирается у обоих (`pump`).
     */
    outboxDiscard: (convId: string, key: string) => {
      const live = uploads.get(key);
      if (live) {
        cancelledInFlight.add(key);
        live.abort();
      }
      progress.clear(key);
      setItems(convId, (list) => list.filter((x) => x.key !== key));
      void pump(convId);
    },

    convAfterEdit: (convId: string, m: ConvMessage) => {
      const s = get();
      const list = applyEdited(listOf(s, convId), m);
      if (list) commit(s.conv, { [convId]: list });
    },

    convAfterDelete: (convId: string, messageId: string) => {
      const s = get();
      const r = applyRemoved(s.conv, listOf(s, convId), messageId);
      commit(r.state, r.list ? { [convId]: r.list } : undefined);
    },

    /**
     * Ответ пересылки (`api.convForward`, признак `conv5`) — в беседу-получатель, одной записью: новые сообщения — как
     * свои отправленные (`applySent`, дубль события по id не ляжет второй раз), `gone` из ответа на повтор — как удалённые.
     * Время беседы — по самому позднему из пачки, чтобы она поднялась в списке сразу, не дожидаясь события.
     */
    convAfterForward: (convId: string, messages: readonly (ConvMessage | ConvGone)[]) => {
      const s = get();
      let state = s.conv;
      let list = listOf(s, convId);
      let latest: string | null = null;
      for (const m of messages) {
        const r = 'gone' in m ? applyRemoved(state, list, m.id) : applySent(state, list, m);
        state = r.state;
        list = r.list;
        if (!('gone' in m) && (!latest || Date.parse(m.createdAt) > Date.parse(latest))) latest = m.createdAt;
      }
      const summary = state.summaries[convId];
      if (summary && latest && (!summary.lastMessageAt || Date.parse(latest) > Date.parse(summary.lastMessageAt))) {
        state = { ...state, summaries: { ...state.summaries, [convId]: { ...summary, lastMessageAt: latest } } };
      }
      commit(state, list ? { [convId]: list } : undefined);
    },

    /** Удалил пачкой сам (`api.convDeleteMany`, 204): убрать все и запомнить навсегда — одной записью. */
    convAfterDeleteMany: (convId: string, messageIds: readonly string[]) => {
      const s = get();
      let state = s.conv;
      let list = listOf(s, convId);
      for (const id of messageIds) {
        const r = applyRemoved(state, list, id);
        state = r.state;
        list = r.list;
      }
      commit(state, list ? { [convId]: list } : undefined);
    },

    /**
     * Мой список закреплённых беседы из ответа ручки (С2, раунд 12 порция 7): загрузка при открытии (`api.convPins`),
     * закрепить (`convPin`), открепить (`convUnpin`). Берётся по свежести номера (`applyPins`): ответ, опоздавший за
     * событием новее, ничего не откатывает. Остальное состояние бесед не трогается — список бесед не пересобирается.
     */
    convSetPins: (convId: string, res: Pick<ConvPinsResponse, 'pts' | 'pins'>) =>
      set((s) => {
        const conv = applyPins(s.conv, convId, res.pins, res.pts);
        return conv === s.conv ? s : { conv };
      }),

    /**
     * Мой список отложенных беседы из ответа ручки (С4, раунд 12 порция 8): загрузка при открытии вида «Отложенные»
     * (`api.convScheduled`), создание, правка, перенос, удаление и «отправить сейчас». По свежести номера
     * (`applyScheduled`), как закреп: ответ, опоздавший за событием новее, ничего не откатывает.
     */
    convSetScheduled: (convId: string, res: Pick<ConvScheduledResponse, 'pts' | 'items'>) =>
      set((s) => {
        const conv = applyScheduled(s.conv, convId, res.items, res.pts);
        return conv === s.conv ? s : { conv };
      }),

    /** «Прочитано до» последнего сообщения ленты (или сводки); с `readByView` — не дальше увиденного (`convSeen`). */
    convReadNow: (convId: string) => convReadNow(convId),

    /**
     * Лента показала человеку сообщение с ключом `key` (G09, `MessagePane.onSeen`; лента сама проверила, что он смотрит —
     * `readByView.canMarkRead`). Отметка «прочитано» — сразу, если это последнее сообщение беседы, иначе пакетом через
     * `READ_BATCH_MS` (срок не продлевается, как у Telegram Android). Беседа не на экране — не считается.
     */
    convSeen: (convId: string, key: number) => {
      const prev = seenKeys.get(convId);
      if (prev !== undefined && key <= prev) return;
      if (onScreenId(get()) !== convId) return;
      clearUnreadMark(convId);
      seenKeys.set(convId, key);
      const summary = get().conv.summaries[convId];
      if (summary && key <= summary.lastReadKey) return;
      const delay = seenFlushDelay(key, summary?.lastMessage?.sortKey);
      const pending = seenTimers.get(convId);
      if (delay === 0) {
        if (pending !== undefined) clearTimeout(pending);
        seenTimers.delete(convId);
        convReadNow(convId);
        return;
      }
      if (pending !== undefined) return;
      seenTimers.set(
        convId,
        setTimeout(() => {
          seenTimers.delete(convId);
          convReadNow(convId);
        }, delay),
      );
    },
  };

  /**
   * Любое чтение снимает пометку «непрочитанным» (G04, 07.10, `conv13`; Telegram 03·1.1.10): у себя сразу, на сервере —
   * ручкой пометки (сам `POST /read` снимает её тоже, но «прочитано до» могло не сдвинуться — тогда его не шлём вовсе).
   */
  function clearUnreadMark(convId: string): void {
    const s = get();
    const summary = s.conv.summaries[convId];
    if (summary?.markedUnread !== true) return;
    commit({ ...s.conv, summaries: { ...s.conv.summaries, [convId]: { ...summary, markedUnread: false } } });
    void deps.api.convSetUnreadMark?.(convId, false).catch(() => {});
  }

  function convReadNow(convId: string): void {
    clearUnreadMark(convId);
    const s = get();
    const summary = s.conv.summaries[convId];
    if (deps.readByView?.()) {
      readSeen(convId);
      return;
    }
    /* 🔴 Окно ленты (шаг 2г): прочитано только то, что загружено. Беседа открывается у первого непрочитанного, и
       последнее сообщение сводки (запасной ключ, пока ленты нет) отметило бы прочитанными все 120 при самом открытии —
       черта «Новые» уехала бы в конец, а «Вниз» потерял бы счётчик. Счётчик тогда ведёт сервер (событием). */
    const win = windowed();
    const key = readKeyFor(listOf(s, convId), win ? undefined : summary);
    if (win) {
      if (s.unreadDms.includes(convId)) set((x) => ({ unreadDms: x.unreadDms.filter((id) => id !== convId) }));
    } else if (summary && summary.unread > 0) {
      // Сводку гасим сразу (сервер скажет то же событием); свежесть не трогаем — событие её перепишет.
      commit({ ...s.conv, summaries: { ...s.conv.summaries, [convId]: { ...summary, unread: 0 } } }, undefined,
        s.unreadDms.filter((x) => x !== convId));
    }
    if (key === null || (summary && key <= summary.lastReadKey)) return;
    void api.convRead(convId, key).catch(() => {});
  }

  /**
   * «Прочитано» по видимому (G09): до увиденного лентой, но не дальше загруженного. Дочитали до последнего сообщения
   * беседы — гасим непрочитанное сразу (уведомления ОС убирает `DmChatView`, увидев ноль); не до конца — счётчик ведёт сервер (событие `conv.change`
   * после отметки несёт остаток непрочитанного).
   */
  function readSeen(convId: string): void {
    const s = get();
    const summary = s.conv.summaries[convId];
    const key = clampReadKey(readKeyFor(listOf(s, convId), windowed() ? undefined : summary), seenKeys.get(convId));
    if (key === null) return;
    const end = summary?.lastMessage?.sortKey;
    if (end !== undefined && key >= end) {
      if (summary && summary.unread > 0)
        commit({ ...s.conv, summaries: { ...s.conv.summaries, [convId]: { ...summary, unread: 0 } } }, undefined,
          s.unreadDms.filter((x) => x !== convId));
      else if (s.unreadDms.includes(convId)) set((x) => ({ unreadDms: x.unreadDms.filter((id) => id !== convId) }));
    }
    if (summary && key <= summary.lastReadKey) return;
    void api.convRead(convId, key).catch(() => {});
  }
}

type ConvEventSummary = ConvChangeEvent['conversation'];
type ConvEventMessage = NonNullable<ConvChangeEvent['message']>;

export type ConvActions = ReturnType<typeof createConvActions>;
