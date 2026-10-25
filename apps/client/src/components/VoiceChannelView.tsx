import type { Channel } from '@gusvoice/shared';
import {
  type TrackReference,
  useLocalParticipant,
  useParticipants,
  useRoomContext,
  useTracks,
  VideoTrack,
} from '@livekit/components-react';
import {
  type LocalVideoTrack,
  type Participant,
  type RemoteTrackPublication,
  type RemoteVideoTrack,
  RoomEvent,
  Track,
  VideoQuality,
} from 'livekit-client';
import { api } from '../api';
import { useEffect, useRef, useState } from 'react';
import { isMobile } from '../hotkeys';
import {
  CAMERA_PRESET_ORDER,
  CAMERA_PRESETS,
  type CameraPreset,
  cameraCaptureOptions,
  cameraPublishOptions,
  getCameraPreset,
  setCameraPreset,
} from '../cameraSettings';
import { useNameResolver, useVoiceName } from '../memberName';
import { ensureEconomy } from '../economyClient';
import { useStore } from '../store';
import { ownerOf } from '../streamAudioRules';
import { isInPip, streamsInView } from '../streamPipRules';
import { canSnapshotStream, streamCardCycle } from '../streamCardRules';
import { toast, toastError } from '../toast';
import { TIP_HOLD_MS, tipInteraction, type TipInteraction } from '../tipMode';
import { useAltHeld, useTip } from '../tipGesture';
import { toggleSelfDeafen, toggleSelfMute } from '../voiceSelf';
import { Avatar } from './Avatar';
import { CrownMark, crownGlow, useIsCrowned } from './Crown';
import { useAnimatedAvatarUrl } from '../avatarAnimation';
import { BottomSheet, SheetRow } from './BottomSheet';
import { Goose } from './Goose';
import { ChannelGlyph, Icon } from './Icon';
import { useUserMenu, type UserMenuTarget } from './UserContextMenu';
import { avatarFromMetadata, useLiveSpeaking, useParticipantFlags } from './VoiceParticipants';
import { useUserAudio } from '../localUserAudio';
import { StreamTipFeed } from './StreamTipFeed';
import { StreamVolumeControl, useStreamVolumePop } from './StreamVolumeControl';
import { removeFromStreamPip, StreamPipButton, StreamPipStub } from './StreamPipView';
import { PENDING_WATCH_TIMEOUT_MS, matchPendingWatch } from '../pendingWatch';
import { STREAM_VIEW_GRACE_MS } from '../streamCue';
import { createWatchGrace, type WatchGrace } from '../watchGrace';
import {
  layerChoices,
  resolutionText,
  setStreamQuality,
  shownPref,
  stepDrop,
  STREAM_QUALITY_HINT,
  STREAM_QUALITY_LABEL,
  streamHasLayers,
  useStreamQuality,
  wantedLayer,
  type DropTracker,
  type StreamQualityPref,
} from '../streamQuality';
import { isWindowCovered } from '../windowCovered';
import { reportBadPicture, useBadPictureAvailable } from '../badPicture';
import { ContextMenu, MenuItem, MenuSection, type MenuPos } from './ContextMenu';
import { fitStageGrid, stageAvatarSize, STAGE_SCROLLBAR_PX, STAGE_GRID_HYSTERESIS_PX, type StageGridLayout } from '../stageGridRules';
import { setHideNoVideo, useHideNoVideo } from '../stageViewPrefs';
import { setStageLayout, useStageLayout } from '../stageLayoutPrefs';
import { effectiveStageLayout, isOneBigLayout, type StageLayout } from '../stageLayoutRules';
import { useStageSpeaker } from '../useStageSpeaker';
import { StageLayoutPicker } from './StageLayoutPicker';
import { usePhoneLayout } from '../phoneLayout';
import { stageHasVideo } from '../stageAutoShowRules';
import { useStageAutoShow } from '../useStageAutoShow';
import { applyStageOrder, isDefaultStageOrder, personTileKey, streamTileKey, type StageOrderMode } from '../stageOrderRules';
import { saveStageOrder, useStageOrder } from '../stageOrderPrefs';
import { useStageDrag } from '../useStageDrag';

// `ownerOf` живёт в `streamAudioRules` — там же, где правило громкости стрима. Держать здесь вторую
// копию значило бы дать им разъехаться, а именно расхождение двух мест и дало баг #71.

// Idle stream previews show a SNAPSHOT, not a live feed. Rendering a live <VideoTrack> for every
// unwatched stream keeps the browser decoding each one at full resolution non-stop (adaptiveStream is
// off) — and the streamer would even decode their OWN outgoing companion "#screen" stream. That full-res
// decode of every stream is what makes shares lag, worst on big scene changes. Instead we briefly
// subscribe, grab one frame, unsubscribe, and refresh on an interval (see StreamCard).
const SNAPSHOT_MAX_W = 480; // downscale previews — a thumbnail needs no more
// Частота заходов (`SNAPSHOT_EVERY_MS`, `PREVIEW_EVERY_MS`) и выбор «превью или поток» — в
// `streamCardRules.ts`, под тестами без React и LiveKit.

// Poll a publication until its remote video track is live (subscription just requested it) or we give up.
async function waitForVideoTrack(pub: RemoteTrackPublication, timeoutMs: number): Promise<RemoteVideoTrack | null> {
  const start = performance.now();
  while (performance.now() - start < timeoutMs) {
    const t = pub.videoTrack;
    if (t) return t as RemoteVideoTrack;
    await new Promise((r) => window.setTimeout(r, 120));
  }
  return (pub.videoTrack as RemoteVideoTrack | undefined) ?? null;
}

// Draw one decoded frame of a remote screen-share to an offscreen canvas and return a downscaled JPEG
// data URL. Attaches to a throwaway <video>, waits for a frame (requestVideoFrameCallback if available),
// snapshots, then detaches. Best-effort: returns null if no frame arrives in time.
async function captureTrackSnapshot(track: RemoteVideoTrack, maxW: number): Promise<string | null> {
  const video = document.createElement('video');
  video.muted = true;
  video.playsInline = true;
  track.attach(video);
  try {
    await video.play().catch(() => {});
    await new Promise<void>((resolve) => {
      let done = false;
      const finish = () => {
        if (done) return;
        done = true;
        resolve();
      };
      const rvfc = (video as HTMLVideoElement & { requestVideoFrameCallback?: (cb: () => void) => number }).requestVideoFrameCallback;
      if (rvfc) rvfc.call(video, () => finish());
      else video.addEventListener('loadeddata', finish, { once: true });
      window.setTimeout(finish, 3000);
    });
    const vw = video.videoWidth;
    const vh = video.videoHeight;
    if (!vw || !vh) return null;
    const w = Math.min(maxW, vw);
    const h = Math.max(1, Math.round((vh * w) / vw));
    const canvas = document.createElement('canvas');
    canvas.width = w;
    canvas.height = h;
    const ctx = canvas.getContext('2d');
    if (!ctx) return null;
    ctx.drawImage(video, 0, 0, w, h);
    return canvas.toDataURL('image/jpeg', 0.6);
  } catch {
    return null;
  } finally {
    track.detach(video);
    video.srcObject = null;
  }
}

// Fullscreen that also works on mobile: Element.requestFullscreen is unsupported on iOS Safari and
// flaky in the Android WebView, so fall back to a CSS full-viewport overlay (.pseudo-fs) there (#29).
function useFocusFullscreen() {
  const ref = useRef<HTMLDivElement>(null);
  const [pseudo, setPseudo] = useState(false);
  const toggle = () => {
    const el = ref.current;
    if (!el) return;
    if (document.fullscreenElement) {
      void document.exitFullscreen();
      return;
    }
    if (pseudo) {
      setPseudo(false);
      return;
    }
    const req = el.requestFullscreen?.bind(el);
    if (req && !isMobile()) req().catch(() => setPseudo(true));
    else setPseudo(true);
  };
  return { ref, pseudo, toggle };
}

/**
 * Кнопки поверх видео — только по наведению (10.10, как у Discord): показывает их CSS (`:hover` /
 * `:focus-within` у `.screen-viewer`), а на касании, где наведения нет, — тап по кадру (`.ctl-on`).
 * `hold` держит их открытыми, пока открыто окно громкости или меню качества: иначе ряд погас бы под
 * открытым окном, стоит указателю уйти на него.
 */
function useControlsReveal(hold: boolean) {
  const [tapped, setTapped] = useState(false);
  const onClick = (e: React.MouseEvent) => {
    if (!window.matchMedia?.('(hover: none)').matches) return;
    if ((e.target as Element).closest('.screen-controls')) return;
    setTapped((v) => !v);
  };
  return { revealClass: tapped || hold ? ' ctl-on' : '', onClick };
}

/**
 * Сетка сцены «под окно» (10.10): меряет контейнер (ResizeObserver) и раскладывает `count` плиток
 * чистым `fitStageGrid` — все влезают без прокрутки. Зазор берём из стиля самой сетки, чтобы
 * число в коде не разъехалось с CSS.
 */
function useFitGrid(count: number, enabled: boolean) {
  const ref = useRef<HTMLDivElement>(null);
  const previous = useRef<{ count: number; cols: number } | null>(null);
  const [box, setBox] = useState<{ w: number; h: number; gap: number } | null>(null);
  useEffect(() => {
    const el = ref.current;
    if (!enabled || !el || typeof ResizeObserver === 'undefined') return;
    const measure = () => {
      const cs = getComputedStyle(el);
      const px = (value: string) => parseFloat(value) || 0;
      const padX = px(cs.paddingLeft) + px(cs.paddingRight) + px(cs.borderLeftWidth) + px(cs.borderRightWidth);
      const padY = px(cs.paddingTop) + px(cs.paddingBottom) + px(cs.borderTopWidth) + px(cs.borderBottomWidth);
      const gap = parseFloat(cs.columnGap) || 0;
      // clientWidth менялся вместе с полосой и замыкал ResizeObserver в петлю.
      // Рамка с полосой стабильна; zoom переводит экранные px обратно в CSS px.
      const rect = el.getBoundingClientRect();
      const zoom = px(getComputedStyle(document.documentElement).zoom) || 1;
      const w = Math.max(0, Math.floor(rect.width / zoom - padX - STAGE_SCROLLBAR_PX) - 1);
      const h = Math.max(0, Math.floor(rect.height / zoom - padY) - 1);
      setBox((b) => (b && b.w === w && b.h === h && b.gap === gap ? b : { w, h, gap }));
    };
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => ro.disconnect();
  }, [enabled]);
  const layout: StageGridLayout | null = enabled && box ? fitStageGrid({
    width: box.w, height: box.h, count, gap: box.gap,
    prevCols: previous.current?.count === count ? previous.current.cols : undefined,
    hysteresisPx: STAGE_GRID_HYSTERESIS_PX,
  }) : null;
  useEffect(() => {
    previous.current = layout ? { count, cols: layout.cols } : null;
  }, [enabled, count, layout?.cols]);
  const fits = !!(layout && box && layout.rows * layout.tileH + Math.max(0, layout.rows - 1) * box.gap <= box.h);
  return { ref, layout, fits };
}

/** Нижняя граница ширины открытого показа в сетке просмотра, px (≈ 90 px высоты — ещё различимы картинка и подпись). */
export const WATCH_TILE_MIN_W = 160;
/** Колонок в сетке просмотра по умолчанию (прежнее поведение CSS: `.stage-watch-grid.count-2…4` и больше). */
const WATCH_DEFAULT_COLS = 2;
/** Другое число колонок берём, только если крупнее прежнего хотя бы на столько (не прыгать из-за пикселей). */
const WATCH_GAIN = 1.1;

export type StageWatchInput = {
  /** Ширина и высота сетки открытых показов (рамка за вычетом отступов), px. */
  width: number;
  height: number;
  /** Сколько показов открыто. */
  count: number;
  gap: number;
  aspect?: number;
  minTileW?: number;
};

export type StageWatchLayout = {
  cols: number;
  /** `true` — все показы не влезают даже в нижней границе: ряды фиксированной высоты `rowH`, сетка прокручивается. */
  scroll: boolean;
  /** Высота ряда при прокрутке, px. */
  rowH: number;
};

/**
 * Сетка ОТКРЫТЫХ показов (#217, узкое окно 760–1100 px и телефон): прежний CSS всегда делил на две колонки с рядами
 * `1fr`, и при 5–7 показах под полосами карточек и людей ряды сжимались до лент 3:1. Здесь — тот же перебор колонок,
 * что у `fitStageGrid` (берём самую крупную картинку 16:9, как у видеозвонков Telegram и Discord), но с мёртвой зоной:
 * `null` = оставить прежние две колонки CSS (там, где они и так почти оптимальны — широкие окна не меняются).
 * Живёт здесь, а не в `stageGridRules.ts`: сцену грузят тесты с описанным перечнем импортов. Источник идеи — Telegram Desktop `calls/group/calls_group_viewport.cpp` (перебор разбиений, выбор с наименьшими чёрными полями; код не копировался).
 * Не влезают даже в `WATCH_TILE_MIN_W` — ряды фиксированной высоты и прокрутка вместо лент.
 */
export function fitWatchGrid(input: StageWatchInput): StageWatchLayout | null {
  const n = Math.max(0, Math.floor(input.count));
  const W = Math.max(0, input.width);
  const H = Math.max(0, input.height);
  if (n < 2 || W <= 0 || H <= 0) return null;
  const aspect = input.aspect && input.aspect > 0 ? input.aspect : 16 / 9;
  const minW = input.minTileW ?? WATCH_TILE_MIN_W;
  const gap = Math.max(0, input.gap);
  const score = (cols: number) => {
    const rows = Math.ceil(n / cols);
    const cellW = (W - gap * (cols - 1)) / cols;
    const cellH = (H - gap * (rows - 1)) / rows;
    return Math.min(cellW, cellH * aspect);
  };
  const dflt = Math.min(n, WATCH_DEFAULT_COLS);
  let best = dflt;
  for (let cols = 1; cols <= n; cols++) if (score(cols) > score(best)) best = cols;
  const bestScore = score(best);
  if (bestScore < minW) {
    // Ни одна раскладка не даёт картинку минимальной ширины: колонок столько, сколько вмещает ширина, ряды — по 16:9, остальное — прокрутка.
    const cols = Math.max(1, Math.min(n, Math.floor((W + gap) / (minW + gap))));
    const cellW = (W - gap * (cols - 1)) / cols;
    return { cols, scroll: true, rowH: Math.max(1, Math.floor(cellW / aspect)) };
  }
  if (best === dflt || bestScore < score(dflt) * WATCH_GAIN) return null;
  return { cols: best, scroll: false, rowH: 0 };
}

/**
 * Сетка открытых показов (#217): меряет `.stage-watch-grid` и просит у `fitWatchGrid` число колонок. `null` — оставить
 * колонки CSS (широкие окна не меняются); иначе колонки/ряды ставятся переменными `--watch-cols` / `--watch-row`
 * и атрибутом `data-fit` (`cols` — все влезают, `scroll` — ряды фиксированной высоты и прокрутка).
 */
function useWatchFit(ref: React.RefObject<HTMLDivElement>, count: number) {
  const [box, setBox] = useState<{ w: number; h: number; gap: number } | null>(null);
  const present = count > 1;
  useEffect(() => {
    const el = ref.current;
    if (!present || !el || typeof ResizeObserver === 'undefined') return;
    const measure = () => {
      const cs = getComputedStyle(el);
      const px = (value: string) => parseFloat(value) || 0;
      const rect = el.getBoundingClientRect();
      const unzoom = 1 / (px(getComputedStyle(document.documentElement).zoom) || 1);
      // Рамка с полосой прокрутки стабильна — размер сетки от её содержимого не зависит.
      const w = Math.max(0, Math.floor(rect.width * unzoom - px(cs.paddingLeft) - px(cs.paddingRight)));
      const h = Math.max(0, Math.floor(rect.height * unzoom - px(cs.paddingTop) - px(cs.paddingBottom)));
      const gap = parseFloat(cs.columnGap) || 0;
      setBox((b) => (b && b.w === w && b.h === h && b.gap === gap ? b : { w, h, gap }));
    };
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => ro.disconnect();
  }, [present, ref]);
  const layout: StageWatchLayout | null = present && box ? fitWatchGrid({ width: box.w, height: box.h, count, gap: box.gap }) : null;
  if (!layout) return {};
  return {
    'data-fit': layout.scroll ? 'scroll' : 'cols',
    style: { ['--watch-cols']: layout.cols, ['--watch-row']: `${layout.rowH}px` } as React.CSSProperties,
  };
}

/** Full viewer for a single screen-share: the video + fullscreen / audio-mute / close controls. */
function ScreenViewer({
  track,
  hasAudio,
  audioMuted,
  volume,
  viewers,
  onToggleAudio,
  onVolume,
  onClose,
  stageKey,
}: {
  /** Ключ для перетаскивания в сетке открытых показов (16.10); развёрнутый на весь экран не тащится. */
  stageKey?: string;
  track: TrackReference;
  hasAudio: boolean;
  audioMuted: boolean;
  volume: number;
  viewers: { id: string; name: string; avatarUrl: string | null }[];
  onToggleAudio: () => void;
  onVolume: (v: number) => void;
  onClose: () => void;
}) {
  const { ref, pseudo, toggle } = useFocusFullscreen();
  const nameOf = useNameResolver();
  // Стрим может ехать со спутника `<id>#screen` — ник ищем по ВЛАДЕЛЬЦУ (#73).
  const name = nameOf(ownerOf(track.participant.identity), track.participant.name || track.participant.identity);

  /**
   * Качество показа (#191). Применяет его `VoiceConnection` — здесь только выбор и честный ответ, есть ли
   * из чего выбирать: у показывающего слои могут быть выключены, и тогда пункты неактивны с объяснением.
   * Что реально приходит, читаем из статистики приёма, пока меню открыто: слой меняет сервер, и число
   * в подписи — единственное доказательство, что выбор сработал.
   */
  const qualityPref = useStreamQuality();
  const pubForQuality = track.publication as RemoteTrackPublication | undefined;
  const layered = streamHasLayers(pubForQuality);
  // Пункты — из НАСТОЯЩИХ слоёв трека (разбор 24.09): у показа в H.264 от старых версий слоёв два,
  // и пункт «Среднее» там ничего не менял. Слои есть, а описания нет (не должно случаться) —
  // остаются «Высокое» и «Экономное» без разрешения.
  const described = layerChoices(pubForQuality?.trackInfo);
  const choices = described.length
    ? described
    : layered
      ? [
          { pref: 'high' as const, label: STREAM_QUALITY_HINT.high },
          { pref: 'low' as const, label: STREAM_QUALITY_HINT.low },
        ]
      : [];
  const checked = shownPref(qualityPref, choices);
  const menuItems: { pref: StreamQualityPref; sub: string }[] = [
    { pref: 'auto', sub: STREAM_QUALITY_HINT.auto },
    ...choices.map((c) => ({ pref: c.pref, sub: c.label })),
  ];
  const [qualityMenu, setQualityMenu] = useState<MenuPos | null>(null);
  const [receiving, setReceiving] = useState<string | null>(null);
  // «Плохая картинка» (06.10, #207): отметка момента + статистика приёма — `badPicture.ts`.
  const badPicture = useBadPictureAvailable();
  useEffect(() => {
    if (!qualityMenu) return;
    let alive = true;
    const read = async () => {
      try {
        const t = pubForQuality?.videoTrack as RemoteVideoTrack | undefined;
        const st = await t?.getReceiverStats();
        if (alive) setReceiving(resolutionText(st?.frameWidth, st?.frameHeight));
      } catch {
        /* статистики нет — подписи не будет */
      }
    };
    void read();
    const id = window.setInterval(() => void read(), 1500);
    return () => {
      alive = false;
      window.clearInterval(id);
    };
  }, [qualityMenu, pubForQuality]);

  /**
   * «Вас скинуло на слой ниже» (#191, 24.09). Сервер понижает слой зрителю, которому
   * не хватает скорости, молча — человек видит мыло и не понимает, у кого беда. Замер раз в 3 с,
   * решение — чистый `stepDrop` (там же, почему сравниваем с лучшим кадром, а не с объявленным).
   * Окно не видно — не меряем: тогда мы сами просим нижний слой, и говорить некому.
   */
  const dropRef = useRef<DropTracker | null>(null);
  const qualityPrefRef = useRef(qualityPref);
  qualityPrefRef.current = qualityPref;
  useEffect(() => {
    const pub = pubForQuality;
    if (!pub) return;
    dropRef.current = null;
    let alive = true;
    const sample = async () => {
      const hidden = isWindowCovered() || document.visibilityState === 'hidden';
      if (hidden) {
        dropRef.current = null;
        return;
      }
      const layer = wantedLayer(qualityPrefRef.current, { windowHidden: false, watched: true });
      let st: { frameWidth?: number; frameHeight?: number } | undefined;
      try {
        st = await (pub.videoTrack as RemoteVideoTrack | undefined)?.getReceiverStats();
      } catch {
        return; // статистики нет — молчим, а не гадаем
      }
      if (!alive) return;
      const { next, notify } = stepDrop(dropRef.current, {
        key: `${pub.trackSid}|${layer}`,
        w: st?.frameWidth,
        h: st?.frameHeight,
        now: Date.now(),
      });
      dropRef.current = next;
      if (notify) {
        toast(
          'warn',
          'Качество показа снижено',
          `${name}: сейчас приходит ${st?.frameWidth}×${st?.frameHeight} вместо ${next.bestW}×${next.bestH}. Не хватает скорости соединения — у вас или у показывающего.`,
        );
      }
    };
    const id = window.setInterval(() => void sample(), 3000);
    return () => {
      alive = false;
      window.clearInterval(id);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pubForQuality]);

  // Watching = full live subscription. StreamCard's snapshot mode leaves streams UNsubscribed, so
  // re-subscribe here (and hold it while open) — otherwise <VideoTrack> would have no track to attach.
  const watchSid = (track.publication as RemoteTrackPublication | undefined)?.trackSid;
  useEffect(() => {
    const pub = track.publication as RemoteTrackPublication | undefined;
    try {
      pub?.setSubscribed?.(true);
    } catch {
      /* ignore */
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [watchSid]);

  const volPop = useStreamVolumePop();
  const reveal = useControlsReveal(volPop.open || !!qualityMenu);
  // Показ открыт в окошке «картинка в картинке» (#222/#223): здесь вместо кадра — заглушка с «Вернуть».
  const pipStreams = useStore((s) => s.pipStreams);
  const inPip = isInPip(track.participant.identity, pipStreams);

  return (
    <div
      className={`screen-viewer${pseudo ? ' pseudo-fs' : ''}${reveal.revealClass}`}
      ref={ref}
      data-stage-key={pseudo ? undefined : stageKey}
      onClick={reveal.onClick}
    >
      {inPip ? <StreamPipStub id={track.participant.identity} /> : <VideoTrack trackRef={track} className="screen-video" />}
      {/* Подсказки «кто кого» — иначе при открытом стриме о типах в канале не узнать вовсе. */}
      <StreamTipFeed />
      <div className="screen-controls">
        <span className="screen-title">
          <Icon name="screen-share" size={16} /> <span className="screen-title-text">{name}</span>
        </span>
        {viewers.length > 0 && (
          <span className="screen-viewers" tabIndex={0} title={`Смотрят: ${viewers.map((v) => v.name).join(', ')}`}>
            <span className="sv-stack">
              {viewers.slice(0, 3).map((v) => (
                <Avatar key={v.id} url={v.avatarUrl} name={v.name} size={20} fallback="icon" />
              ))}
            </span>
            <span className="sv-count">{viewers.length}</span>
            <span className="sv-tip">
              <span className="sv-tip-head">Смотрят · {viewers.length}</span>
              {viewers.map((v) => (
                <span key={v.id} className="sv-tip-row">
                  <Avatar url={v.avatarUrl} name={v.name} size={18} fallback="icon" />
                  {v.name}
                </span>
              ))}
            </span>
          </span>
        )}
        <span className="screen-spacer" />
        {hasAudio && (
          <StreamVolumeControl
            pop={volPop}
            muted={audioMuted}
            volume={volume}
            onToggleAudio={onToggleAudio}
            onVolume={onVolume}
          />
        )}
        {!track.participant.isLocal && (
          <button
            type="button"
            className="ctl"
            title={`Качество показа: ${STREAM_QUALITY_LABEL[qualityPref]}`}
            aria-haspopup="menu"
            onClick={(e) => {
              const r = e.currentTarget.getBoundingClientRect();
              setQualityMenu({ x: r.left, y: r.top });
            }}
          >
            <Icon name="settings" size={18} />
          </button>
        )}
        {!track.participant.isLocal && <StreamPipButton track={track} />}
        <button type="button" className="ctl" title="На весь экран" onClick={toggle}>
          <Icon name="maximize" size={18} />
        </button>
        <button
          type="button"
          className="ctl"
          title="Закрыть стрим"
          onClick={() => {
            // Закрыл показ на сцене — он уходит и из окошка (последний — окошко закрывается): «закрыть» значит «не смотрю».
            if (inPip) removeFromStreamPip(track.participant.identity);
            onClose();
          }}
        >
          <Icon name="close" size={18} />
        </button>
      </div>
      {qualityMenu && (
        <ContextMenu pos={qualityMenu} onClose={() => setQualityMenu(null)} width={250}>
          <MenuSection>Качество показа</MenuSection>
          {menuItems.map(({ pref: q, sub }) => (
            <MenuItem
              key={q}
              icon={q === checked ? 'check' : undefined}
              label={STREAM_QUALITY_LABEL[q]}
              sub={sub}
              active={q === checked}
              onClick={() => {
                setStreamQuality(q);
                setQualityMenu(null);
              }}
            />
          ))}
          {choices.length === 0 && <MenuSection>Показывающий шлёт один слой — понизить нельзя</MenuSection>}
          {receiving && <MenuSection>Сейчас приходит {receiving}</MenuSection>}
          {badPicture && (
            <MenuItem
              icon="activity"
              label="Плохая картинка"
              sub="отметить момент: уйдёт статистика приёма"
              onClick={() => {
                setQualityMenu(null);
                void reportBadPicture(pubForQuality, track.participant.identity, qualityPref);
              }}
            />
          )}
        </ContextMenu>
      )}
    </div>
  );
}

// A screen-share offered as a tile. For a REMOTE stream (someone else's, or our own native companion
// "#screen") it shows a periodic still, so an unwatched preview never decodes the full stream non-stop.
// A LOCAL web share stays live (it's our own capture, no decode cost). Audio is never played here; you
// only hear the one you open.
//
// 🔴 Сначала — готовое превью показа (#115), а НЕ подписка на поток (#207, 25.09). Телеметрия
// показала: снимок с живого потока раз в минуту будил у показывающего ВСЕ три слоя (сервер сначала
// отдаёт верхний, просьба о нижнем приходила уже после подписки) — три сеанса NVENC и опорные кадры
// на 4–5 секунд. С dynacast в остальное время кодировщик спит, и этот рывок раз в минуту совпал с
// микрофризами мыши у показывающего. Картинку #115 он отдаёт и так, кодировщик она не трогает.
// Снимок с потока остаётся запасным путём (человек выключил отдачу превью), и тогда нижний слой
// просим СРАЗУ после подписки. Сам заход (порядок «превью → поток») — `streamCardCycle` в
// `streamCardRules.ts`; здесь только настоящие LiveKit, сеть и таймер.
function StreamCard({
  trackRef,
  name,
  onWatch,
  stageKey,
}: {
  trackRef: TrackReference;
  name: string;
  onWatch: () => void;
  /** Ключ в порядке сетки сцены (`streamTileKey`) — по нему плитку находит перетаскивание. */
  stageKey?: string;
}) {
  const pub = trackRef.publication as RemoteTrackPublication | undefined;
  const canSnapshot = canSnapshotStream(trackRef.participant.isLocal, pub);
  const [snapshot, setSnapshot] = useState<string | null>(null);
  const sid = pub?.trackSid;
  const channelId = useStore((s) => s.voice?.channelId);
  const ownerId = ownerOf(trackRef.participant.identity);

  useEffect(() => {
    if (!canSnapshot || !pub) return;
    let cancelled = false;
    let timer: number | undefined;
    const cycle = (): Promise<void> =>
      streamCardCycle({
        channelId,
        ownerId,
        cancelled: () => cancelled,
        getPreview: (ch, owner) => api.getStreamPreview(ch, owner),
        setSnapshot: (url) => setSnapshot(url),
        setSubscribed: (on) => pub.setSubscribed(on),
        requestLow: () => pub.setVideoQuality(VideoQuality.LOW),
        waitTrack: () => waitForVideoTrack(pub, 4000),
        capture: (track) => captureTrackSnapshot(track, SNAPSHOT_MAX_W),
        next: (ms) => {
          timer = window.setTimeout(() => void cycle(), ms);
        },
      });
    void cycle();
    return () => {
      cancelled = true;
      if (timer) clearTimeout(timer);
      try {
        pub.setSubscribed(false);
      } catch {
        /* ignore */
      }
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sid, canSnapshot, channelId, ownerId]);

  return (
    <button
      type="button"
      className="stream-card"
      data-stage-key={stageKey}
      onClick={onWatch}
      title={`${name} — смотреть трансляцию`}
    >
      <span className="stream-card-preview">
        {canSnapshot ? (
          snapshot ? (
            <img src={snapshot} className="stream-card-video" alt="" />
          ) : (
            <span className="stream-card-loading">Загрузка превью…</span>
          )
        ) : (
          <VideoTrack trackRef={trackRef} className="stream-card-video" />
        )}
        <span className="stream-card-live">
          <span className="live-dot" /> LIVE
        </span>
        <span className="stream-card-overlay">
          <span className="stream-card-play">
            <Icon name="signal" size={16} /> Смотреть
          </span>
        </span>
      </span>
      <span className="stream-card-foot">
        <Icon name="screen-share" size={15} />
        <span className="stream-card-title">{name}</span>
      </span>
    </button>
  );
}

// Focused view of one participant's camera (opened by the "expand" button on a camera tile, #28).
// Reuses the screen-viewer chrome; fullscreen falls back to a CSS overlay on mobile (useFocusFullscreen).
function CameraViewer({ track, onClose }: { track: TrackReference; onClose: () => void }) {
  const { ref, pseudo, toggle } = useFocusFullscreen();
  const voiceNameOf = useVoiceName();
  const name = voiceNameOf(track.participant);
  const reveal = useControlsReveal(false);
  return (
    <div className={`screen-viewer${pseudo ? ' pseudo-fs' : ''}${reveal.revealClass}`} ref={ref} onClick={reveal.onClick}>
      <VideoTrack trackRef={track} className="screen-video" />
      {/* Подсказки «кто кого» — иначе при открытом стриме о типах в канале не узнать вовсе. */}
      <StreamTipFeed />
      <div className="screen-controls">
        <span className="screen-title">
          <Icon name="camera" size={16} /> <span className="screen-title-text">{name}</span>
        </span>
        <span className="screen-spacer" />
        <button type="button" className="ctl" title="На весь экран" onClick={toggle}>
          <Icon name="maximize" size={18} />
        </button>
        <button type="button" className="ctl" title="Закрыть" onClick={onClose}>
          <Icon name="close" size={18} />
        </button>
      </div>
    </div>
  );
}

// One participant on the stage: their camera if it's on, otherwise their avatar — with a
// speaking ring, name and mic/deafen badges.
/**
 * Подсказка «Удерживайте» на плитках телефона — НЕ постоянная подпись, а разовое обучение (12.10). У Telegram и Discord на
 * плитках подписей нет, но жест «удержать карточку — типнуть» скрыт и без намёка не находится. Поэтому надпись висит
 * `TIP_HOLD_HINT_MS` один раз на устройство (первое появление чужих плиток при включённой экономике) и гаснет навсегда, когда
 * человек сам типнул удержанием. Жест (`tipMode.ts`, `TIP_HOLD_MS`) и экономика не тронуты; пояснение остаётся в `title` плитки.
 * Хранилище — здесь, а не в `tipMode.ts`: тест сцены подменяет тот модуль закрытым перечнем.
 */
const TIP_HOLD_HINT_KEY = 'gv_tip_hold_hint_seen';
const TIP_HOLD_HINT_MS = 6000;
function tipHoldHintPending(): boolean {
  try {
    return window.localStorage.getItem(TIP_HOLD_HINT_KEY) !== '1';
  } catch {
    return true;
  }
}
function markTipHoldHintSeen(): void {
  try {
    window.localStorage.setItem(TIP_HOLD_HINT_KEY, '1');
  } catch {
    /* приватный режим — подсказка вернётся после перезагрузки, на работу жеста это не влияет */
  }
}

function StageTile({
  p,
  camera,
  channelId,
  openMenu,
  onExpand,
  tipMode,
  holdHint,
  tipBusy,
  onTip,
  onTipHoldStart,
  onTipHoldEnd,
  avatarSize = 92,
  stageKey,
}: {
  p: Participant;
  camera?: TrackReference;
  channelId: string | null;
  openMenu: (e: React.MouseEvent, target: UserMenuTarget) => void;
  onExpand: () => void;
  tipMode: TipInteraction;
  /** Разовая подсказка «Удерживайте» (`tipHoldHintPending`): телефон, первое появление плиток на устройстве. */
  holdHint: boolean;
  tipBusy: boolean;
  onTip: () => void;
  onTipHoldStart: (e: React.PointerEvent<HTMLDivElement>) => void;
  onTipHoldEnd: () => void;
  /** Размер аватарки без камеры; в сетке «под окно» — от высоты плитки (`stageAvatarSize`). */
  avatarSize?: number;
  /** Ключ в порядке сетки сцены (`personTileKey`) — по нему плитку находит перетаскивание. */
  stageKey?: string;
}) {
  const speaking = useLiveSpeaking(p.identity);
  const { micMuted, deafened, screenSharing } = useParticipantFlags(p);
  const { muted: locallyMuted } = useUserAudio(p.identity);
  const serverMuted = useStore(
    (s) => (channelId ? s.presence[channelId]?.find((x) => x.userId === p.identity)?.serverMuted : false) ?? false,
  );
  const generalId = useStore((s) => s.bootstrap?.channels?.find((c) => c.id === channelId)?.generalUserId);
  // Плитка рисует ОДНОГО человека, поэтому здесь хук по месту уместен.
  const crownServerId = useStore((s) => s.bootstrap?.server.id);
  const crowned = useIsCrowned(p.identity, crownServerId);
  const animatedOf = useAnimatedAvatarUrl();
  const voiceNameOf = useVoiceName();
  // Ник из ростера поверх имени в LiveKit-токене (оно вшито на 4 часа и смены ника не знает, #73).
  const name = voiceNameOf(p);
  const target: UserMenuTarget = {
    userId: p.identity,
    name,
    avatarUrl: avatarFromMetadata(p.metadata),
    participant: p,
    voiceChannelId: channelId,
    serverMuted,
  };
  const canTip = !p.isLocal && tipMode !== 'none';
  return (
    <div
      className={`stage-tile ${speaking ? 'speaking' : ''} ${camera ? 'has-cam' : ''}`}
      data-stage-key={stageKey}
      onContextMenu={p.isLocal ? undefined : (e) => openMenu(e, target)}
      onPointerDown={canTip && tipMode === 'hold' ? onTipHoldStart : undefined}
      onPointerUp={canTip && tipMode === 'hold' ? onTipHoldEnd : undefined}
      onPointerCancel={canTip && tipMode === 'hold' ? onTipHoldEnd : undefined}
      onPointerLeave={canTip && tipMode === 'hold' ? onTipHoldEnd : undefined}
      title={canTip && tipMode === 'hold' ? 'Удерживайте карточку, чтобы типнуть' : undefined}
    >
      {camera ? (
        <VideoTrack trackRef={camera} className="stage-cam" />
      ) : (
        <Avatar
          url={avatarFromMetadata(p.metadata)}
          animatedUrl={animatedOf(p.identity)}
          name={name}
          size={avatarSize}
          fallback="icon"
        />
      )}
      {/* Корона крупнее, чем в списке: плитка большая, и мелкий значок на ней теряется. */}
      {crowned && <CrownMark size={22} />}
      {camera && (
        <button
          type="button"
          className="stage-expand"
          title="Развернуть камеру"
          onClick={(e) => {
            e.stopPropagation();
            onExpand();
          }}
        >
          <Icon name="maximize" size={16} />
        </button>
      )}
      {canTip && tipMode === 'button' && (
        <button
          type="button"
          className="stage-tip"
          disabled={tipBusy}
          aria-label={`Типнуть ${name}`}
          onClick={(e) => {
            e.stopPropagation();
            onTip();
          }}
        >
          {tipBusy ? '…' : 'Тип'}
        </button>
      )}
      {canTip && tipMode === 'hold' && holdHint && <span className="stage-tip-hold" aria-hidden="true">Удерживайте</span>}
      <div className="stage-meta">
        {deafened ? (
          <Icon name="headphones-off" size={14} />
        ) : micMuted ? (
          <Icon name="mic-off" size={14} />
        ) : null}
        {screenSharing ? <Icon name="screen-share" size={14} /> : null}
        {!p.isLocal && locallyMuted ? (
          <span title="Заглушён только для вас">
            <Icon name="volume-off" size={14} />
          </span>
        ) : null}
        {generalId === p.identity ? <Icon name="shield" size={13} /> : null}
        <span className={`stage-name${crownGlow(crowned)}`}>
          {name}
          {p.isLocal ? ' (вы)' : ''}
        </span>
      </div>
    </div>
  );
}

/** Плитки в порядке `order`; `keys[i]` — ключ плитки `nodes[i]`. Ключи React у плиток свои, стабильные. */
function byStageKey(order: readonly string[], keys: readonly string[], nodes: readonly React.ReactNode[]): React.ReactNode[] {
  const at = new Map(keys.map((k, i) => [k, i]));
  return order.flatMap((k) => {
    const i = at.get(k);
    return i === undefined ? [] : [nodes[i]];
  });
}

/** Ключи карточек показов: два показа одного владельца (браузерный и нативный спутник) — второй под своим identity. */
function screenStageKeys(list: readonly TrackReference[]): string[] {
  const keys: string[] = [];
  for (const s of list) {
    const k = streamTileKey(s.participant.identity);
    keys.push(keys.includes(k) ? `s:${s.participant.identity}` : k);
  }
  return keys;
}

/**
 * Перетаскивание в контейнере режима просмотра показа (16.10): тот же `useStageDrag`, свой контейнер и
 * свой сохранённый порядок (канал + `mode`). `shown` — порядок показа с учётом наведения.
 * `ordered` — раскладка, где порядок живёт (ПК, режим просмотра): на телефоне и в узком окне те же
 * контейнеры рисуются в порядке по умолчанию. `enabled` — можно ли тянуть прямо сейчас (Alt-режим чаевых
 * жест забирает, но порядок при этом не скачет).
 */
function useStageModeDrag(channelId: string | null, mode: StageOrderMode, keys: readonly string[], ordered: boolean, enabled: boolean) {
  const ref = useRef<HTMLDivElement>(null);
  const saved = useStageOrder(channelId, mode);
  const applied = ordered ? applyStageOrder(keys, saved) : [...keys];
  const drag = useStageDrag({
    enabled: ordered && enabled && !!channelId,
    gridRef: ref,
    order: applied,
    onCommit: (order) => {
      if (!channelId) return;
      // Ничего не меняли и раньше не запоминали — записи нет (и «Сбросить» не появится зря).
      if (!saved && isDefaultStageOrder(keys, order)) return;
      saveStageOrder(channelId, mode, order);
    },
  });
  const shown = drag.preview ? applyStageOrder(keys, drag.preview) : applied;
  return { ref, drag, shown };
}

// Stage for the channel you're connected to. All media is SFU-forwarded (no P2P). Streams show as
// invite cards; everyone else appears as a capped avatar/camera tile so nobody fills the space.
function VoiceStage() {
  // onlySubscribed:false → keep a reference for streams StreamCard has UNsubscribed for snapshot mode
  // (default true would drop them the moment they unsubscribe, unmounting the very card that manages it).
  const screens = useTracks([{ source: Track.Source.ScreenShare, withPlaceholder: false }], {
    onlySubscribed: false,
  }) as TrackReference[];
  const screenAudios = useTracks([{ source: Track.Source.ScreenShareAudio, withPlaceholder: false }]);
  // Only LIVE, unmuted cameras count. A stopped/muted camera keeps its publication, and rendering its
  // dead <VideoTrack> leaves a BLACK rectangle instead of falling back to the avatar (#26).
  const cameras = (useTracks([{ source: Track.Source.Camera, withPlaceholder: false }]) as TrackReference[]).filter(
    (t) => !t.publication?.isMuted,
  );
  const participants = useParticipants();
  const room = useRoomContext();
  const channelId = useStore((s) => s.voice?.channelId ?? null);
  const serverId = useStore((s) => s.bootstrap?.server.id ?? null);
  const nameOf = useNameResolver();
  const { open: openUserMenu, menu: userMenu } = useUserMenu();
  // 🔴 Снимок берём из стора, своей копии и своего опроса тут БОЛЬШЕ НЕТ: раньше оверлей и чип в
  // шапке опрашивали сервер порознь, и после типа оверлей перечитывал себя, а чип — нет.
  const economy = useStore((s) => (serverId ? s.economy[serverId] : undefined));
  const tipHoldTimer = useRef<number | null>(null);
  const mobile = isMobile();
  // Alt и отправка — общие с сайдбаром (`tipGesture.ts`): жест живёт в двух местах сразу.
  const altHeld = useAltHeld(economy?.enabled === true && !mobile);
  const { tip: sendTip, busyId: tipBusyId } = useTip();
  const activeTipMode = tipInteraction(economy?.enabled === true, altHeld, mobile);

  // Экономика посерверная. Право типнуть остаётся за сервером: кулдаун и суточные пределы клиент
  // не угадывает, он решает только доступность самого жеста.
  useEffect(() => {
    if (serverId) ensureEconomy(serverId);
  }, [serverId]);

  useEffect(
    () => () => {
      if (tipHoldTimer.current !== null) window.clearTimeout(tipHoldTimer.current);
    },
    [],
  );

  const tip = (userId: string, name: string) => {
    if (!channelId) return;
    void sendTip(channelId, userId, name);
  };

  /* Подсказка «Удерживайте» — разово на устройство, а не подпись на каждой плитке навсегда. */
  const [holdHint, setHoldHint] = useState(false);

  const clearTipHold = () => {
    if (tipHoldTimer.current === null) return;
    window.clearTimeout(tipHoldTimer.current);
    tipHoldTimer.current = null;
  };

  const startTipHold = (e: React.PointerEvent<HTMLDivElement>, userId: string, name: string) => {
    if (activeTipMode !== 'hold' || tipBusyId || (e.target as Element).closest('button')) return;
    e.preventDefault();
    clearTipHold();
    tipHoldTimer.current = window.setTimeout(() => {
      tipHoldTimer.current = null;
      setHoldHint(false);
      markTipHoldHintSeen();
      void tip(userId, name);
    }, TIP_HOLD_MS);
  };
  // Several streams can be open at once (keyed by participant identity — one screen-share per person).
  // Mute + volume are per-stream and personal, volumes persisted.
  //
  // 🔴 Живёт в СТОРЕ, не в этом компоненте (#71). Сцена размонтируется, стоит уйти читать текстовый
  // канал, — а голос при этом продолжается. Пока состояние и его применение жили здесь, уходящий
  // со сцены человек уносил с собой правило «неоткрытый стрим молчит», и звук чужого стрима
  // включался сам. Здесь теперь только НАМЕРЕНИЕ; к трекам его применяет `VoiceConnection`.
  const watchedIds = useStore((s) => s.watchedStreams);
  const mutedIds = useStore((s) => s.mutedStreams);
  const volumes = useStore((s) => s.streamVolumes);
  const watch = useStore((s) => s.watchStream);
  const unwatch = useStore((s) => s.unwatchStream);
  const toggleMute = useStore((s) => s.toggleStreamMute);
  const setVolume = useStore((s) => s.setStreamVolume);
  const clearWatched = useStore((s) => s.clearWatchedStreams);
  // Намерение «зайти и смотреть», оставленное карточкой наведения (клик по кадру).
  const pendingWatch = useStore((s) => s.pendingWatch);
  const clearPendingWatch = useStore((s) => s.clearPendingWatch);
  const voiceChannelId = useStore((s) => s.voice?.channelId ?? null);
  // The camera expanded into a focused viewer (the tile "expand" button), by participant identity (#28).
  const [focusCamId, setFocusCamId] = useState<string | null>(null);
  const volOf = (id: string) => volumes[id] ?? 1;

  // Ушли со сцены — закрыли все стримы. Без этого «открытый» стрим оставался бы слышен из
  // текстового канала: ровно тот баг, ради которого состояние переехало в стор.
  useEffect(() => clearWatched, [clearWatched]);

  // Stop watching streams that ended (publisher stopped sharing or left) — НО НЕ СРАЗУ.
  //
  // 🔴 #111. При самолечении залипшего показа публикация пересоздаётся, и трек пропадает примерно
  // на секунду. Мгновенное «снять просмотр» на такое моргание закрывало бы показ ВСЕМ зрителям, и
  // каждому пришлось бы открывать его заново — то есть лечение у одного человека било бы по всему
  // каналу. Ждём грейс: вернулся — ничего не произошло; не вернулся — закрываем, как и раньше.
  //
  // ⚠️ Картинка исчезает СРАЗУ и без нас: плитки строятся из живых треков. Отсрочка держит только
  // НАМЕРЕНИЕ смотреть, поэтому ничего лишнего на экране за эти секунды не появляется.
  //
  // Само правило живёт в `watchGrace.ts` и покрыто тестами; здесь остаётся только проводка.
  const liveIds = screens.map((s) => s.participant.identity).join(',');
  const watchedKey = watchedIds.join(',');
  // Менеджер создаётся ОДИН раз и замкнул бы на себе первый `unwatch`, поэтому ходим через ссылку
  // на актуальный.
  const unwatchRef = useRef(unwatch);
  unwatchRef.current = unwatch;
  const graceRef = useRef<WatchGrace | null>(null);
  if (graceRef.current === null) {
    graceRef.current = createWatchGrace({
      drop: (id) => unwatchRef.current(id),
      setTimer: (fn, ms) => window.setTimeout(fn, ms),
      clearTimer: (t) => window.clearTimeout(t),
      graceMs: STREAM_VIEW_GRACE_MS,
    });
  }
  useEffect(() => {
    graceRef.current?.reconcile(
      watchedIds,
      screens.map((s) => s.participant.identity),
    );
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [liveIds, watchedKey]);

  // Уходим со сцены — снимаем отложенное. Иначе таймер выстрелит в уже размонтированном дереве.
  useEffect(() => {
    const grace = graceRef.current;
    return () => grace?.dispose();
  }, []);

  /**
   * «Зайти и смотреть» — подбираем намерение, оставленное кликом по кадру в карточке наведения.
   *
   * Открыть показ в момент клика было нельзя: трека ещё не было, а идентификатор зависит от того,
   * показывает человек нативно (спутник `<id>#screen`) или из браузера. Здесь трек уже перед нами.
   *
   * ⚠️ Ждём с ограничением: показ мог закончиться, пока мы подключались. Молчание в этом случае
   * читалось бы как «кнопка не работает», поэтому говорим вслух — но БЕЗ выдуманной причины:
   * со стороны зрителя «закончил показ» и «не доехало» не различить.
   */
  useEffect(() => {
    if (!pendingWatch) return;
    const id = matchPendingWatch(
      pendingWatch,
      voiceChannelId,
      screens.map((s) => s.participant.identity),
    );
    if (id !== null) {
      openStream(id);
      clearPendingWatch();
      return;
    }
    // Срок отсчитывается от МОМЕНТА КЛИКА, а не от этого прогона: эффект перезапускается на каждое
    // изменение состава треков, и таймер, заведённый заново, никогда бы не дошёл до конца.
    const left = Math.max(0, PENDING_WATCH_TIMEOUT_MS - (Date.now() - pendingWatch.at));
    const t = window.setTimeout(() => {
      clearPendingWatch();
      toast('info', 'Показ не открылся', 'Возможно, он уже закончился');
    }, left);
    return () => window.clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pendingWatch, liveIds, voiceChannelId]);

  // Drop the focused camera if that participant turned their camera off or left.
  const camIdsKey = cameras.map((c) => c.participant.identity).join(',');
  useEffect(() => {
    setFocusCamId((id) => (id && cameras.some((c) => c.participant.identity === id) ? id : null));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [camIdsKey]);

  // Громкость стрим-аудио здесь БОЛЬШЕ НЕ ВЫСТАВЛЯЕТСЯ — этим заведует `VoiceConnection`, который
  // смонтирован всегда, пока вы в голосе (#71). Сцена лишь меняет намерение (открыт/заглушен/
  // громкость) в сторе, а он подписан на стор и применяет.

  // Tell the room which streams I have OPEN (publisher identities) via a participant attribute, so
  // everyone can see who's watching each stream. LiveKit syncs attributes to all peers — no backend.
  const watchingKey = watchedIds.join(',');
  useEffect(() => {
    room.localParticipant.setAttributes({ watching: watchingKey }).catch(() => {});
  }, [room, watchingKey]);

  // Re-render the viewer chips whenever anyone's attributes change (or they join / leave).
  const [, bumpAttrs] = useState(0);
  useEffect(() => {
    const bump = () => bumpAttrs((t) => t + 1);
    room
      .on(RoomEvent.ParticipantAttributesChanged, bump)
      .on(RoomEvent.ParticipantConnected, bump)
      .on(RoomEvent.ParticipantDisconnected, bump);
    return () => {
      room
        .off(RoomEvent.ParticipantAttributesChanged, bump)
        .off(RoomEvent.ParticipantConnected, bump)
        .off(RoomEvent.ParticipantDisconnected, bump);
    };
  }, [room]);

  // Viewers of a stream = participants whose `watching` attribute includes its publisher's identity.
  const viewersOf = (publisherId: string) =>
    participants
      .filter((p) => (p.attributes?.watching ?? '').split(',').filter(Boolean).includes(publisherId))
      .map((p) => ({ id: p.identity, name: nameOf(p.identity, p.name || p.identity), avatarUrl: avatarFromMetadata(p.metadata) }));

  const audioIds = new Set(screenAudios.map((a) => a.participant.identity));
  // Показ в окошке «картинка в картинке» (#222) на сцене остаётся открытым — с заглушкой вместо кадра, а не
  // карточкой: карточка раз в минуту переподписывается на снимок и гасила бы поток в окошке.
  const pipStreams = useStore((s) => s.pipStreams);
  const inViewIds = streamsInView(watchedIds, pipStreams);
  const watchedScreens = inViewIds
    .map((id) => screens.find((s) => s.participant.identity === id))
    .filter((s): s is TrackReference => !!s);
  const camByIdentity = new Map(cameras.map((c) => [c.participant.identity, c]));
  const focusCam = focusCamId ? camByIdentity.get(focusCamId) : undefined;

  // 🔴 Вид сцены (#221, 16.10, как раскладки Google Meet): Авто / Сетка / Фокус / Сбоку / Говорящий — один выбор на
  // всё (`stageLayoutPrefs.ts`), правила — `stageLayoutRules.ts`. На телефоне «Сетка»/«Сбоку» действуют как «Авто».
  // ⚠️ «Телефон» — по ширине (`usePhoneLayout`, граница 760 px, как у мобильных стилей), а не только `isMobile()`:
  // тот истинен лишь в приложении, а мобильные стили `.app.m-content .stage-tile` перебивают сетку «под окно».
  const phoneLayout = usePhoneLayout();
  const viewLayout = effectiveStageLayout(useStageLayout(), mobile || phoneLayout);
  const oneBig = isOneBigLayout(viewLayout);
  // 🔴 Показы сами не открываются ни в одном виде (владелец 21.10, отменяет автооткрытие «Фокуса»/«Сбоку» как у Meet,
  // R248): смотреть начинают только кликом — как в Discord. В «Фокусе»/«Сбоку» без выбранного крупно тот, кто говорит.
  const unwatchedScreens = screens.filter((s) => !inViewIds.includes(s.participant.identity));
  const hasManual = watchedScreens.length > 0 || !!focusCam;
  // Нечего показать крупно (нет показов или все закрыты) — в режимах «один крупно» крупно тот, кто говорит; себя — никогда.
  const others = participants.filter((p) => !p.isLocal && !p.identity.endsWith('#screen')).map((p) => p.identity);
  // Следим за говорящим и пока крупно показ: закрыл его — крупно сразу тот, кто говорит (или говорил последним), а не первый по списку.
  const speakerId = useStageSpeaker(others, oneBig);
  const bigPerson = speakerId && !hasManual ? participants.find((p) => p.identity === speakerId) : undefined;
  const watching = hasManual || !!bigPerson;

  /** Открыть показ: в «Сетке» — переход в «Фокус» на нём; в режимах «один крупно» он заменяет крупное. */
  const openStream = (id: string) => {
    if (viewLayout === 'grid') {
      setStageLayout('focus');
    } else if (oneBig) {
      for (const w of watchedIds) if (w !== id) unwatch(w);
      setFocusCamId(null);
    }
    watch(id);
  };
  /** Камера крупно (кнопка «развернуть» на плитке) — те же правила, что у показа. */
  const openCamera = (id: string) => {
    if (viewLayout === 'grid') {
      setStageLayout('focus');
    } else if (oneBig) {
      for (const w of watchedIds) unwatch(w);
    }
    setFocusCamId(id);
  };

  // Смена вида: в «Сетку» — закрыть открытое (там все плитки равные, показ — карточкой); в «один крупно» — оставить одно.
  const prevLayoutRef = useRef(viewLayout);
  useEffect(() => {
    const was = prevLayoutRef.current;
    prevLayoutRef.current = viewLayout;
    if (was === viewLayout) return;
    if (viewLayout === 'grid') {
      clearWatched();
      setFocusCamId(null);
    } else if (viewLayout === 'speaker') {
      // Открытое (кликом — других нет) остаётся крупно одно.
      for (const w of watchedIds.slice(1)) unwatch(w);
      if (watchedIds.length > 0) setFocusCamId(null);
    } else if (isOneBigLayout(viewLayout) && watchedIds.length > 0) {
      for (const w of watchedIds.slice(1)) unwatch(w);
      setFocusCamId(null);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [viewLayout]);

  // «Скрыть участников без видео» (как у Discord): видео — это камера; показ экрана у человека без
  // камеры остаётся своей карточкой, а его плитка с аватаркой прячется. Видовая настройка — локально.
  const hideNoVideo = useHideNoVideo();
  useStageAutoShow({ room, channelId, hideNoVideo, hasVideo: stageHasVideo(screens, cameras) });
  // Спутники нативного показа ("<id>#screen") плиткой не рисуются — их видео идёт карточкой показа
  // под именем владельца; аватаркой второй раз они появляться не должны.
  const allPeople = participants.filter(
    (p) => !p.identity.endsWith('#screen') && (!hideNoVideo || camByIdentity.has(p.identity)),
  );
  const hiddenCount = participants.filter((p) => !p.identity.endsWith('#screen')).length - allPeople.length;
  // Крупный говорящий в полосе второй раз не рисуется.
  const people = bigPerson ? allPeople.filter((p) => p.identity !== bigPerson.identity) : allPeople;
  // Срок разовой подсказки идёт, только пока на сцене есть чья-то плитка, на которой её видно (своя не типается).
  const hasTipTargets = allPeople.some((p) => !p.isLocal);
  useEffect(() => {
    if (activeTipMode !== 'hold' || !hasTipTargets || !tipHoldHintPending()) return;
    setHoldHint(true);
    const t = window.setTimeout(() => {
      setHoldHint(false);
      markTipHoldHintSeen();
    }, TIP_HOLD_HINT_MS);
    return () => {
      window.clearTimeout(t);
      setHoldHint(false);
    };
  }, [activeTipMode, hasTipTargets]);

  // 🔴 Сетка «под окно» (10.10, жалоба «ничего не помещается»): без просмотра стрима все плитки —
  // карточки показов, камеры и люди без видео — ОДНОЙ сеткой одного размера 16:9, и все влезают без
  // прокрутки (`fitStageGrid`, как у Discord / Meet). При просмотре стрима или камеры в фокусе —
  // прежняя раскладка (вьюверы сверху, полосы снизу), на телефоне — прежняя сетка в две колонки 3:4.
  // ⚠️ «Телефон» — по ширине (`usePhoneLayout` выше), не только `isMobile()` (замерено на стенде: плитки 67×119 и 2×89).
  // «Сетка» (#221) — это та же сетка «под окно», только открытый показ её не сменяет (клик ведёт в «Фокус»).
  const fit = !watching && !mobile && !phoneLayout;
  const gridCount = unwatchedScreens.length + people.length;
  const { ref: gridRef, layout, fits } = useFitGrid(gridCount, fit);
  const gridStyle =
    layout && layout.tileW > 0
      ? ({ ['--tile-w']: `${layout.tileW}px`, ['--tile-h']: `${layout.tileH}px`, ['--tile-cols']: layout.cols, overflowY: fits ? 'hidden' : 'auto' } as React.CSSProperties)
      : undefined;
  const tileAvatar = layout && layout.tileH > 0 ? stageAvatarSize(layout.tileH) : 92;

  // Ключи плиток для порядка, расставленного перетаскиванием (12.10). Два показа одного владельца
  // (браузерный и нативный спутник) получили бы один ключ — второй тогда идёт под своим identity.
  const streamKeys = screenStageKeys(unwatchedScreens);
  const personKeys = people.map((p) => personTileKey(p.identity));
  const defaultKeys = [...streamKeys, ...personKeys];
  // Порядок свой у каждой ширины окна: ключ хранилища — канал + число колонок сетки.
  const gridCols = layout?.cols ?? 0;
  // ⚠️ Объявлены ДО жеста сетки: порядок хуков стабилен, а жест сетки остаётся последним вызовом `useStageDrag`.
  // Режим просмотра показа (16.10, решение владельца): тот же жест в трёх контейнерах — сетка открытых
  // показов, полоса карточек и полоса людей; порядок у каждого свой (`StageOrderMode`), сетку «под окно» не трогает.
  const watchDragOn = watching && !mobile && !phoneLayout;
  const tipFree = activeTipMode === 'none';
  const watchKeys = screenStageKeys(watchedScreens);
  // «Сбоку» (#221) — колонка справа со своими ключами порядка (`side-*`); «Фокус»/«Говорящий» делят полосы и ключи режима
  // просмотра. Экземпляр жеста у полосы один на оба вида (меняется только ключ): контейнер тот же, порядок хуков стабилен.
  const side = viewLayout === 'side' && watching;
  const watchDnd = useStageModeDrag(channelId, 'watch-streams', watchKeys, watchDragOn, tipFree && watchedScreens.length > 1);
  const watchFit = useWatchFit(watchDnd.ref, watchedScreens.length);
  const cardsDnd = useStageModeDrag(channelId, side ? 'side-cards' : 'watch-cards', streamKeys, watchDragOn, tipFree && unwatchedScreens.length > 1);
  const peopleDnd = useStageModeDrag(channelId, side ? 'side-people' : 'watch-people', personKeys, watchDragOn, tipFree && people.length > 1);
  const savedOrder = useStageOrder(channelId, gridCols);
  const appliedOrder = applyStageOrder(defaultKeys, savedOrder);
  const drag = useStageDrag({
    // Только сетка «под окно» на ПК и не в режиме чаевых: удержание там уже занято под тип.
    enabled: fit && !!channelId && gridCols > 0 && activeTipMode === 'none',
    gridRef,
    order: appliedOrder,
    onCommit: (order) => {
      if (!channelId || gridCols <= 0) return;
      // Ничего не меняли и раньше не запоминали — записи нет (и пункт «Сбросить» не появится зря).
      if (!savedOrder && isDefaultStageOrder(defaultKeys, order)) return;
      saveStageOrder(channelId, gridCols, order);
    },
  });
  const shownOrder = drag.preview ? applyStageOrder(defaultKeys, drag.preview) : appliedOrder;

  const streamCards = unwatchedScreens.map((s, i) => (
    <StreamCard
      key={s.publication?.trackSid}
      stageKey={streamKeys[i]}
      trackRef={s}
      name={nameOf(ownerOf(s.participant.identity), s.participant.name || s.participant.identity)}
      onWatch={() => openStream(s.participant.identity)}
    />
  ));
  const tiles = people.map((p, i) => (
    <StageTile
      key={p.sid || p.identity}
      stageKey={personKeys[i]}
      p={p}
      camera={camByIdentity.get(p.identity)}
      channelId={channelId}
      openMenu={openUserMenu}
      onExpand={() => openCamera(p.identity)}
      tipMode={activeTipMode}
      holdHint={holdHint}
      tipBusy={tipBusyId === p.identity}
      onTip={() => void tip(p.identity, nameOf(p.identity, p.name || p.identity))}
      onTipHoldStart={(e) => startTipHold(e, p.identity, nameOf(p.identity, p.name || p.identity))}
      onTipHoldEnd={clearTipHold}
      avatarSize={fit ? tileAvatar : 92}
    />
  ));
  // Открытые показы и камера в фокусе — тоже видео (15.10: при двух открытых показах плашка писала «Видео ни у кого нет»):
  // тогда только «Скрыто участников без видео».
  const videoShown = watchedScreens.length > 0 || !!focusCam;
  const emptyHint =
    gridCount === 0 && hiddenCount > 0 ? (
      <div className="stage-empty-hint">
        {videoShown ? 'Скрыто участников без видео' : 'Видео ни у кого нет. Участников без видео'}: {hiddenCount}.{' '}
        <button type="button" className="link" onClick={() => setHideNoVideo(false)}>
          Показать
        </button>
      </div>
    ) : null;

  if (fit) {
    return (
      <div className="voice-stage fit">
        {activeTipMode !== 'none' && economy && (
          <span className="voice-tip-balance" aria-live="polite">
            Тип · {economy.wallet.balance} {economy.currencyName}
          </span>
        )}
        <div className="stage-grid stage-dnd" ref={gridRef} style={gridStyle} onPointerDown={drag.onPointerDown}>
          {/* Гнездо — первым, чтобы соседи, переезжая, шли поверх него. */}
          {drag.dragging && <div className="stage-drag-nest" ref={drag.nestRef} aria-hidden="true" />}
          {byStageKey(shownOrder, defaultKeys, [...streamCards, ...tiles])}
          {emptyHint}
        </div>
        {userMenu}
      </div>
    );
  }

  // Крупное: камера в фокусе, открытые показы или (режимы «один крупно», #221) говорящий человек — его плитка во всю площадь.
  const big = (
    <>
      {focusCam && (
        <div className="stage-watch-grid count-1">
          <CameraViewer track={focusCam} onClose={() => setFocusCamId(null)} />
        </div>
      )}
      {watchedScreens.length > 0 && (
        <div
          className={`stage-watch-grid${watchDragOn ? ' stage-dnd' : ''} count-${Math.min(watchedScreens.length, 4)}`}
          ref={watchDnd.ref}
          onPointerDown={watchDnd.drag.onPointerDown}
          {...watchFit}
        >
          {watchDnd.drag.dragging && <div className="stage-drag-nest" ref={watchDnd.drag.nestRef} aria-hidden="true" />}
          {byStageKey(watchDnd.shown, watchKeys, watchedScreens.map((s, i) => {
            const id = s.participant.identity;
            return (
              <ScreenViewer
                key={s.publication?.trackSid}
                stageKey={watchKeys[i]}
                track={s}
                hasAudio={audioIds.has(ownerOf(id)) || audioIds.has(id)}
                audioMuted={mutedIds.includes(id)}
                volume={volOf(id)}
                viewers={viewersOf(id)}
                onToggleAudio={() => toggleMute(id)}
                onVolume={(v) => setVolume(id, v)}
                onClose={() => unwatch(id)}
              />
            );
          }))}
        </div>
      )}
      {bigPerson && (
        <div className="stage-watch-grid count-1 stage-big-person">
          <StageTile
            key={bigPerson.sid || bigPerson.identity}
            p={bigPerson}
            camera={camByIdentity.get(bigPerson.identity)}
            channelId={channelId}
            openMenu={openUserMenu}
            onExpand={() => openCamera(bigPerson.identity)}
            tipMode={activeTipMode}
            holdHint={holdHint}
            tipBusy={tipBusyId === bigPerson.identity}
            onTip={() => void tip(bigPerson.identity, nameOf(bigPerson.identity, bigPerson.name || bigPerson.identity))}
            onTipHoldStart={(e) => startTipHold(e, bigPerson.identity, nameOf(bigPerson.identity, bigPerson.name || bigPerson.identity))}
            onTipHoldEnd={clearTipHold}
            avatarSize={128}
          />
        </div>
      )}
    </>
  );
  // Остальные: закрытые показы и люди — полосами снизу, а в «Сбоку» колонкой справа (каждая со своей прокруткой).
  const rest = (
    <>
      {unwatchedScreens.length > 0 && (
        <div className={`stage-streams${watchDragOn ? ' stage-dnd' : ''}`} ref={cardsDnd.ref} onPointerDown={cardsDnd.drag.onPointerDown}>
          {cardsDnd.drag.dragging && <div className="stage-drag-nest" ref={cardsDnd.drag.nestRef} aria-hidden="true" />}
          {byStageKey(cardsDnd.shown, streamKeys, streamCards)}
        </div>
      )}
      <div className={`stage-people${watchDragOn ? ' stage-dnd' : ''}`} ref={peopleDnd.ref} onPointerDown={peopleDnd.drag.onPointerDown}>
        {peopleDnd.drag.dragging && <div className="stage-drag-nest" ref={peopleDnd.drag.nestRef} aria-hidden="true" />}
        {byStageKey(peopleDnd.shown, personKeys, tiles)}
        {emptyHint}
      </div>
    </>
  );

  return (
    <div className={`voice-stage${watching ? ' watching' : ''}${side ? ' side' : ''}`}>
      {/* Пилюля баланса — признак Alt-режима ПК; на телефоне режима нет (удержание карточки доступно всегда), постоянная пилюля лежала поверх плиток. */}
      {activeTipMode === 'button' && economy && (
        <span className="voice-tip-balance" aria-live="polite">
          Тип · {economy.wallet.balance} {economy.currencyName}
        </span>
      )}
      {side ? (
        <>
          <div className="stage-main">{big}</div>
          <div className="stage-side">{rest}</div>
        </>
      ) : (
        <>
          {big}
          {rest}
        </>
      )}
      {userMenu}
    </div>
  );
}

// Mobile in-call control bar (design-step8 B1): the 60dp Микрофон / Звук / Камера / Отключиться row at
// the bottom of the voice stage. On mobile the content pane has no self-bar (it lives in the channel
// list), so this is where you mute / deafen / toggle camera / hang up while looking at the call.
function MobileCallBar() {
  const { localParticipant, isCameraEnabled } = useLocalParticipant();
  const selfMuted = useStore((s) => s.selfMuted);
  const selfDeafened = useStore((s) => s.selfDeafened);
  const leaveVoice = useStore((s) => s.leaveVoice);
  // Which camera the phone uses; flipping re-publishes with the opposite facingMode (#27).
  const [facing, setFacing] = useState<'user' | 'environment'>('user');
  // Camera quality preset (#33) — long-press the camera button to change it. Persisted in localStorage.
  const [preset, setPreset] = useState<CameraPreset>(() => getCameraPreset());
  const [qualityOpen, setQualityOpen] = useState(false);
  const lpTimer = useRef<number | null>(null);
  const lpFired = useRef(false);

  const toggleCamera = () => {
    if (isCameraEnabled) {
      void localParticipant.setCameraEnabled(false).catch((e) => toastError(e, 'Камера недоступна'));
    } else {
      void localParticipant
        .setCameraEnabled(true, { facingMode: facing, ...cameraCaptureOptions(preset) }, cameraPublishOptions(preset))
        .catch((e) => toastError(e, 'Камера недоступна'));
    }
  };
  const flipCamera = () => {
    // setCameraEnabled(true, …) on an already-on camera is a no-op (it won't re-apply constraints), so
    // restart the LIVE camera track with the opposite facingMode — re-acquires getUserMedia +
    // replaceTrack in place (no re-publish). (#27)
    const track = localParticipant.getTrackPublication(Track.Source.Camera)?.videoTrack as
      | LocalVideoTrack
      | undefined;
    if (!track) return;
    const next = facing === 'user' ? 'environment' : 'user';
    setFacing(next);
    void track
      .restartTrack({ facingMode: next, ...cameraCaptureOptions(preset) })
      .catch((e) => toastError(e, 'Камера недоступна'));
  };
  // Switching preset while the camera is live needs a re-publish (bitrate lives on the publication, not
  // the track), so toggle off→on with the new options; otherwise it just applies on the next enable.
  const applyPreset = (p: CameraPreset) => {
    setPreset(p);
    setCameraPreset(p);
    setQualityOpen(false);
    if (!isCameraEnabled) return;
    void (async () => {
      try {
        await localParticipant.setCameraEnabled(false);
        await localParticipant.setCameraEnabled(true, { facingMode: facing, ...cameraCaptureOptions(p) }, cameraPublishOptions(p));
      } catch (e) {
        toastError(e, 'Камера недоступна');
      }
    })();
  };
  // One button, two gestures: short tap toggles the camera, long-press opens the quality sheet.
  const camDown = () => {
    lpFired.current = false;
    lpTimer.current = window.setTimeout(() => {
      lpFired.current = true;
      setQualityOpen(true);
    }, 500);
  };
  const camUp = () => {
    if (lpTimer.current) {
      clearTimeout(lpTimer.current);
      lpTimer.current = null;
    }
  };
  const camClick = () => {
    if (lpFired.current) {
      lpFired.current = false;
      return;
    }
    toggleCamera();
  };
  return (
    <div className="voice-call-bar">
      <button
        type="button"
        className={`call-btn ${selfMuted ? 'off' : ''}`}
        title={selfMuted ? 'Включить микрофон' : 'Выключить микрофон'}
        onClick={toggleSelfMute}
      >
        <Icon name={selfMuted ? 'mic-off' : 'mic'} size={26} />
      </button>
      <button
        type="button"
        className={`call-btn ${selfDeafened ? 'off' : ''}`}
        title={selfDeafened ? 'Включить звук' : 'Заглушить звук'}
        onClick={toggleSelfDeafen}
      >
        <Icon name={selfDeafened ? 'headphones-off' : 'headphones'} size={26} />
      </button>
      <button
        type="button"
        className={`call-btn ${isCameraEnabled ? 'on' : ''}`}
        title={isCameraEnabled ? 'Выключить камеру (удерж. — качество)' : 'Включить камеру (удерж. — качество)'}
        onPointerDown={camDown}
        onPointerUp={camUp}
        onPointerLeave={camUp}
        onContextMenu={(e) => e.preventDefault()}
        onClick={camClick}
      >
        <Icon name={isCameraEnabled ? 'camera' : 'camera-off'} size={26} />
      </button>
      {isCameraEnabled && (
        <button type="button" className="call-btn" title="Перевернуть камеру" onClick={flipCamera}>
          <Icon name="camera-flip" size={26} />
        </button>
      )}
      <button type="button" className="call-btn leave" title="Отключиться" onClick={() => leaveVoice()}>
        <Icon name="leave" size={26} />
      </button>
      {qualityOpen && (
        <BottomSheet title="Качество камеры" subtitle="Держится, пока не сменишь" onClose={() => setQualityOpen(false)}>
          {CAMERA_PRESET_ORDER.map((p) => (
            <SheetRow
              key={p}
              icon="camera"
              label={
                <>
                  {CAMERA_PRESETS[p].label}
                  <span className="cam-preset-sub">{CAMERA_PRESETS[p].sub}</span>
                </>
              }
              meta={p === preset ? <Icon name="check" size={18} /> : undefined}
              onClick={() => applyPreset(p)}
            />
          ))}
        </BottomSheet>
      )}
    </div>
  );
}

// Шапка голосового канала, в который вошли. Отдельным компонентом: видовая настройка сцены (её хуки)
// нужна только подключённому — экран «не в канале» её не трогает.
function ConnectedVoiceHeader({ channel }: { channel: Channel }) {
  const hideNoVideo = useHideNoVideo();
  const phoneLayout = usePhoneLayout();
  const phone = isMobile() || phoneLayout;
  return (
    <div className="voice-header">
      <ChannelGlyph c={channel} size={18} />
      <span>{channel.name}</span>
      {/* Видовые настройки сцены справа в шапке: вид сцены (#221, как раскладки Google Meet) — и на телефоне (там три
          режима; место под «участники», лежащие поверх шапки, держит `.voice-header-tools`), и «Скрыть участников без
          видео» (10.10, как «Show Non-Video Participants» у Discord) — только на ПК. */}
      <div className="voice-header-tools">
        <StageLayoutPicker phone={phone} />
        {!phone && (
          <button
            type="button"
            className={`topbar-btn voice-header-tool${hideNoVideo ? ' active' : ''}`}
            aria-pressed={hideNoVideo}
            title={hideNoVideo ? 'Показать участников без видео' : 'Скрыть участников без видео'}
            aria-label="Скрыть участников без видео"
            onClick={() => setHideNoVideo(!hideNoVideo)}
          >
            <Icon name="camera-off" size={18} />
          </button>
        )}
      </div>
    </div>
  );
}

export function VoiceChannelView({ channel, connected }: { channel: Channel; connected?: boolean }) {
  const joinVoice = useStore((s) => s.joinVoice);
  const presenceMap = useStore((s) => s.presence);
  const participants = presenceMap[channel.id] ?? [];

  if (connected) {
    return (
      <div className="voice-view connected">
        <ConnectedVoiceHeader channel={channel} />
        <VoiceStage />
        {/* The stage tiles (+ the channel sidebar's presence list) already show everyone in the call, so
            the desktop no longer renders a third redundant roster below the stage. Mobile still needs the
            in-call control bar (mute / deafen / camera / hang up) — there's no self-bar on the phone. */}
        {isMobile() && <MobileCallBar />}
      </div>
    );
  }

  const voiceIsEmpty = participants.length === 0;

  // B11: в канале, куда ещё не вошли (или после обрыва), шапка тоже несёт название — раньше она была пустой.
  return (
    <div className="voice-view">
      <div className="voice-header">
        <ChannelGlyph c={channel} size={18} />
        <span>{channel.name}</span>
      </div>
      <div className="voice-idle-body">
        <div className="empty-goose">
          <Goose pose={voiceIsEmpty ? 'nap' : 'honk'} size={132} />
          <div className="eg-title">{voiceIsEmpty ? 'В голосовом канале пока никого' : 'В голосовом канале уже есть люди'}</div>
          <div className="eg-sub">
            {!voiceIsEmpty
              ? `${participants.length} уже на связи — присоединяйтесь.`
              : 'Зайдите первым — разбудите гуся.'}
          </div>
          <button className="join-voice" onClick={() => joinVoice(channel.id).catch((e: Error) => toastError(e))}>
            Присоединиться к {channel.name}
          </button>
        </div>
      </div>
    </div>
  );
}
