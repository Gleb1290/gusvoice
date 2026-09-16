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
} from 'livekit-client';
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
import { useNameResolver } from '../memberName';
import { ensureEconomy } from '../economyClient';
import { useStore } from '../store';
import { MAX_STREAM_VOLUME, ownerOf } from '../streamAudioRules';
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
import { PENDING_WATCH_TIMEOUT_MS, matchPendingWatch } from '../pendingWatch';
import { STREAM_VIEW_GRACE_MS } from '../streamCue';
import { createWatchGrace, type WatchGrace } from '../watchGrace';

// `ownerOf` живёт в `streamAudioRules` — там же, где правило громкости стрима. Держать здесь вторую
// копию значило бы дать им разъехаться, а именно расхождение двух мест и дало баг #71.

// Idle stream previews show a SNAPSHOT, not a live feed. Rendering a live <VideoTrack> for every
// unwatched stream keeps the browser decoding each one at full resolution non-stop (adaptiveStream is
// off) — and the streamer would even decode their OWN outgoing companion "#screen" stream. That full-res
// decode of every stream is what makes shares lag, worst on big scene changes. Instead we briefly
// subscribe, grab one frame, unsubscribe, and refresh on an interval (see StreamCard).
const SNAPSHOT_MAX_W = 480; // downscale previews — a thumbnail needs no more
const SNAPSHOT_EVERY_MS = 60_000; // refresh cadence (a fresh still every minute)

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
}: {
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

  return (
    <div className={`screen-viewer${pseudo ? ' pseudo-fs' : ''}`} ref={ref}>
      <VideoTrack trackRef={track} className="screen-video" />
      {/* Подсказки «кто кого» — иначе при открытом стриме о типах в канале не узнать вовсе. */}
      <StreamTipFeed />
      <div className="screen-controls">
        <span className="screen-title">
          <Icon name="screen-share" size={16} /> {name}
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
          <span className="screen-audio">
            <button
              type="button"
              className={`ctl ${audioMuted ? 'off' : ''}`}
              title={audioMuted ? 'Включить звук стрима' : 'Заглушить звук стрима (только для вас)'}
              onClick={onToggleAudio}
            >
              <Icon name={audioMuted ? 'headphones-off' : 'volume'} size={18} />
            </button>
            {/* Ползунок доходит до 200 % (#130): у показывающего бывает тихий источник, и 100 % —
                это не наш выбор, а потолок громкости элемента воспроизведения. Выше единицы звук
                идёт через узел усиления Web Audio (`webAudioMix` у комнаты). Заливка помечается
                отдельным цветом от 100 % и выше: усиление слышно на плохом источнике, и человек
                должен видеть, что он уже НЕ на обычной громкости. */}
            <input
              type="range"
              className={`stream-vol${!audioMuted && volume > 1 ? ' boost' : ''}`}
              min={0}
              max={MAX_STREAM_VOLUME}
              step={0.02}
              value={audioMuted ? 0 : volume}
              // ⚠️ `--p` — ДОЛЯ хода ползунка, а не громкость: заливка рисуется градиентом по ней.
              // Забыть поделить на потолок значило бы, что заливка убегает вперёд ручки.
              style={{ ['--p']: (audioMuted ? 0 : volume) / MAX_STREAM_VOLUME } as React.CSSProperties}
              title={
                volume > 1 && !audioMuted
                  ? `Громкость стрима: ${Math.round(volume * 100)}% — усиление`
                  : `Громкость стрима: ${Math.round((audioMuted ? 0 : volume) * 100)}%`
              }
              onChange={(e) => onVolume(Number(e.target.value))}
            />
          </span>
        )}
        <button type="button" className="ctl" title="На весь экран" onClick={toggle}>
          <Icon name="maximize" size={18} />
        </button>
        <button type="button" className="ctl" title="Закрыть стрим" onClick={onClose}>
          <Icon name="close" size={18} />
        </button>
      </div>
    </div>
  );
}

// A screen-share offered as a tile. For a REMOTE stream (someone else's, or our own native companion
// "#screen") it shows a periodic SNAPSHOT — subscribe briefly, grab a frame, unsubscribe, refresh every
// minute — so an unwatched preview never decodes the full stream non-stop. A LOCAL web share stays live
// (it's our own capture, no decode cost). Audio is never played here; you only hear the one you open.
function StreamCard({ trackRef, name, onWatch }: { trackRef: TrackReference; name: string; onWatch: () => void }) {
  const pub = trackRef.publication as RemoteTrackPublication | undefined;
  const canSnapshot = !trackRef.participant.isLocal && typeof pub?.setSubscribed === 'function';
  const [snapshot, setSnapshot] = useState<string | null>(null);
  const sid = pub?.trackSid;

  useEffect(() => {
    if (!canSnapshot || !pub) return;
    let cancelled = false;
    let timer: number | undefined;
    const cycle = async () => {
      if (cancelled) return;
      try {
        pub.setSubscribed(true);
        const track = await waitForVideoTrack(pub, 4000);
        if (cancelled) return;
        if (track) {
          const url = await captureTrackSnapshot(track, SNAPSHOT_MAX_W);
          if (!cancelled && url) setSnapshot(url);
        }
      } catch {
        /* keep the previous snapshot */
      } finally {
        if (!cancelled) {
          pub.setSubscribed(false);
          timer = window.setTimeout(() => void cycle(), SNAPSHOT_EVERY_MS);
        }
      }
    };
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
  }, [sid, canSnapshot]);

  return (
    <button type="button" className="stream-card" onClick={onWatch} title={`${name} — смотреть трансляцию`}>
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
  const nameOf = useNameResolver();
  const name = nameOf(track.participant.identity, track.participant.name || track.participant.identity);
  return (
    <div className={`screen-viewer${pseudo ? ' pseudo-fs' : ''}`} ref={ref}>
      <VideoTrack trackRef={track} className="screen-video" />
      {/* Подсказки «кто кого» — иначе при открытом стриме о типах в канале не узнать вовсе. */}
      <StreamTipFeed />
      <div className="screen-controls">
        <span className="screen-title">
          <Icon name="camera" size={16} /> {name}
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
function StageTile({
  p,
  camera,
  channelId,
  openMenu,
  onExpand,
  tipMode,
  tipBusy,
  onTip,
  onTipHoldStart,
  onTipHoldEnd,
}: {
  p: Participant;
  camera?: TrackReference;
  channelId: string | null;
  openMenu: (e: React.MouseEvent, target: UserMenuTarget) => void;
  onExpand: () => void;
  tipMode: TipInteraction;
  tipBusy: boolean;
  onTip: () => void;
  onTipHoldStart: (e: React.PointerEvent<HTMLDivElement>) => void;
  onTipHoldEnd: () => void;
}) {
  const speaking = useLiveSpeaking(p.identity);
  const { micMuted, deafened, screenSharing } = useParticipantFlags(p);
  const { muted: locallyMuted } = useUserAudio(p.identity);
  const serverMuted = useStore(
    (s) => (channelId ? s.presence[channelId]?.find((x) => x.userId === p.identity)?.serverMuted : false) ?? false,
  );
  const generalId = useStore((s) => s.bootstrap?.channels.find((c) => c.id === channelId)?.generalUserId);
  // Плитка рисует ОДНОГО человека, поэтому здесь хук по месту уместен.
  const crownServerId = useStore((s) => s.bootstrap?.server.id);
  const crowned = useIsCrowned(p.identity, crownServerId);
  const animatedOf = useAnimatedAvatarUrl();
  const nameOf = useNameResolver();
  // Ник из ростера поверх имени в LiveKit-токене (оно вшито на 4 часа и смены ника не знает, #73).
  const name = nameOf(p.identity, p.name || p.identity);
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
          size={92}
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
      {canTip && tipMode === 'hold' && <span className="stage-tip-hold" aria-hidden="true">Удерживайте</span>}
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
      watch(id);
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
  const watchedScreens = watchedIds
    .map((id) => screens.find((s) => s.participant.identity === id))
    .filter((s): s is TrackReference => !!s);
  const unwatchedScreens = screens.filter((s) => !watchedIds.includes(s.participant.identity));
  const camByIdentity = new Map(cameras.map((c) => [c.participant.identity, c]));
  const focusCam = focusCamId ? camByIdentity.get(focusCamId) : undefined;

  return (
    <div className={`voice-stage${watchedScreens.length > 0 || focusCam ? ' watching' : ''}`}>
      {activeTipMode !== 'none' && economy && (
        <span className="voice-tip-balance" aria-live="polite">
          Тип · {economy.wallet.balance} {economy.currencyName}
        </span>
      )}
      {focusCam && (
        <div className="stage-watch-grid count-1">
          <CameraViewer track={focusCam} onClose={() => setFocusCamId(null)} />
        </div>
      )}
      {watchedScreens.length > 0 && (
        <div className={`stage-watch-grid count-${Math.min(watchedScreens.length, 4)}`}>
          {watchedScreens.map((s) => {
            const id = s.participant.identity;
            return (
              <ScreenViewer
                key={s.publication?.trackSid}
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
          })}
        </div>
      )}
      {unwatchedScreens.length > 0 && (
        <div className="stage-streams">
          {unwatchedScreens.map((s) => (
            <StreamCard
              key={s.publication?.trackSid}
              trackRef={s}
              name={nameOf(ownerOf(s.participant.identity), s.participant.name || s.participant.identity)}
              onWatch={() => watch(s.participant.identity)}
            />
          ))}
        </div>
      )}
      <div className="stage-people">
        {/* Hide native screen-share companion participants ("<id>#screen") — their video is shown via
            the screen grid above (labelled with the owner's name); they must not also show as avatars. */}
        {participants
          .filter((p) => !p.identity.endsWith('#screen'))
          .map((p) => (
            <StageTile
              key={p.sid || p.identity}
              p={p}
              camera={camByIdentity.get(p.identity)}
              channelId={channelId}
              openMenu={openUserMenu}
              onExpand={() => setFocusCamId(p.identity)}
              tipMode={activeTipMode}
              tipBusy={tipBusyId === p.identity}
              onTip={() => void tip(p.identity, nameOf(p.identity, p.name || p.identity))}
              onTipHoldStart={(e) => startTipHold(e, p.identity, nameOf(p.identity, p.name || p.identity))}
              onTipHoldEnd={clearTipHold}
            />
          ))}
      </div>
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
    <div className="call-bar">
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

export function VoiceChannelView({ channel, connected }: { channel: Channel; connected?: boolean }) {
  const joinVoice = useStore((s) => s.joinVoice);
  const presenceMap = useStore((s) => s.presence);
  const participants = presenceMap[channel.id] ?? [];

  if (connected) {
    return (
      <div className="voice-view connected">
        <div className="voice-header">
          <ChannelGlyph c={channel} size={18} />
          <span>{channel.name}</span>
        </div>
        <VoiceStage />
        {/* The stage tiles (+ the channel sidebar's presence list) already show everyone in the call, so
            the desktop no longer renders a third redundant roster below the stage. Mobile still needs the
            in-call control bar (mute / deafen / camera / hang up) — there's no self-bar on the phone. */}
        {isMobile() && <MobileCallBar />}
      </div>
    );
  }

  const voiceIsEmpty = participants.length === 0;

  return (
    <div className="voice-view center">
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
  );
}
