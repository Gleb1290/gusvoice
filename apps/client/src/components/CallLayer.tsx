/**
 * Звонки 1:1 в ЛС (08.10, #211, С5, `calls1`) — экран звонка, полоса над лентой, медиа и звонок-рингтон.
 *
 * Как Telegram: входящий — карточка с аватаром, именем, «звонит вам…» и двумя круглыми кнопками «Отклонить» (красная) /
 * «Ответить» (зелёная) — tdesktop `calls_panel.cpp`, Android `VoIPFragment`; сижу в голосовом канале — «Выйти из канала и
 * ответить» (Р-9, одна линия). Идёт разговор — та же карточка со счётчиком, «Микрофон» и «Завершить»; свернуть — полоса
 * над лентой (tdesktop `calls_top_bar.cpp`): имя, счётчик, микрофон, положить трубку; по ней можно ходить по беседам, не
 * теряя звонок. На телефоне карточка — во весь экран. Медиа — своя `Room` LiveKit на звонок (как `VoiceConnection`, но
 * только микрофон и звук собеседника).
 *
 * Видео (`calls2`, tdesktop `calls_panel.cpp` / `calls_video_bubble.cpp`, Android `VoIPFragment`): «Камера», на телефоне
 * «Повернуть» (фронт / тыл), на ПК «Экран»; видео собеседника — на весь экран звонка, своё — превью в углу (перетаскивается,
 * прилипает к углу), до ответа — в карточке под статусом. Публикация — как в голосовом канале (`cameraSettings`,
 * `streamSettings`).
 */
import { CALL_PING_MS } from '@gusvoice/shared';
import { Room, RoomEvent, Track, createLocalAudioTrack, type LocalAudioTrack, type LocalVideoTrack, type RemoteTrack } from 'livekit-client';
import { useEffect, useRef, useState } from 'react';
import { pushBackHandler } from '../androidBack';
import { getAudioSettings } from '../audioSettings';
import { cameraCaptureOptions, cameraPublishOptions } from '../cameraSettings';
import { CALL_DEVICE, useCall } from '../callStore';
import { callStatusText, callViewFor, previewCorner, serverCallVideo, type CallView, type PreviewCorner } from '../callView';
import { isMobile } from '../hotkeys';
import {
  callAudioSupported,
  onCallAudioChanged,
  readCallAudio,
  selectCallRoute,
  speakerPress,
  startCallAudio,
  stopCallAudio,
  type CallAudioState,
  type CallRoute,
} from '../nativeCallAudio';
import { usePhoneLayout } from '../phoneLayout';
import { useStore } from '../store';
import { captureOptions, getStreamSettings, publishOptions, webScreenSettings } from '../streamSettings';
import { toastError } from '../toast';
import { Avatar } from './Avatar';
import { BottomSheet, SheetRow } from './BottomSheet';
import { Icon } from './Icon';

function useCallView(): CallView {
  const call = useCall((s) => s.call);
  const me = useStore((s) => s.user?.id);
  return callViewFor(call, me, CALL_DEVICE);
}

/** Счётчик разговора: перерисовка раз в секунду, пока звонок идёт. */
function useElapsed(answeredAt: string | undefined): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!answeredAt) return;
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, [answeredAt]);
  return answeredAt ? now - Date.parse(answeredAt) : 0;
}

// ─── Звонок-рингтон и гудки (синтез, без вшитых файлов — правило `sounds.ts`) ─────────────────────────────────────────

let ringCtx: AudioContext | null = null;
function ringPattern(kind: 'incoming' | 'outgoing'): () => void {
  // Телефон: свой контекст на каждый звонок, закрывается вместе с рингтоном. Он рождается ДО микрофона, а значит с
  // `USAGE_MEDIA`, и на Android открывает общий MMAP-поток громкого динамика (AAudio): звук звонка, открытый, пока этот
  // поток жив, подсаживается в него же и уходит в громкий (`useCallMedia`). ПК — общий контекст, как раньше.
  const own = isMobile();
  let ac: AudioContext;
  try {
    ac = own ? new AudioContext() : (ringCtx ??= new AudioContext());
  } catch {
    return () => {};
  }
  void ac.resume().catch(() => {});
  const beep = () => {
    const t0 = ac.currentTime;
    const gain = ac.createGain();
    gain.connect(ac.destination);
    // Входящий — две ноты по кругу, как телефонный звонок; исходящий — длинный гудок 425 Гц (гудок вызова).
    const notes = kind === 'incoming' ? [784, 659, 784, 659] : [425];
    const step = kind === 'incoming' ? 0.18 : 1.0;
    gain.gain.setValueAtTime(0, t0);
    notes.forEach((f, i) => {
      const o = ac.createOscillator();
      o.type = 'sine';
      o.frequency.value = f;
      o.connect(gain);
      o.start(t0 + i * step);
      o.stop(t0 + (i + 1) * step);
    });
    const len = notes.length * step;
    gain.gain.linearRampToValueAtTime(kind === 'incoming' ? 0.18 : 0.12, t0 + 0.02);
    gain.gain.setValueAtTime(kind === 'incoming' ? 0.18 : 0.12, t0 + len - 0.03);
    gain.gain.linearRampToValueAtTime(0, t0 + len);
  };
  beep();
  const t = setInterval(beep, kind === 'incoming' ? 2000 : 4000);
  return () => {
    clearInterval(t);
    if (own) void ac.close().catch(() => {});
  };
}

// ─── Медиа звонка ────────────────────────────────────────────────────────────────────────────────────────────────────

/** Показ экрана из этой среды возможен: ПК с `getDisplayMedia` (на телефоне кнопки нет — как у Telegram Android). */
function screenShareSupported(phone: boolean): boolean {
  return !phone && !isMobile() && typeof navigator !== 'undefined' && typeof navigator.mediaDevices?.getDisplayMedia === 'function';
}

/** Камеру можно перевернуть (фронт / тыл): телефон и браузер знает ограничение `facingMode`. */
function facingSupported(phone: boolean): boolean {
  try {
    return (phone || isMobile()) && !!navigator.mediaDevices?.getSupportedConstraints?.().facingMode;
  } catch {
    return false;
  }
}

/**
 * Вывод звука разговора на Android (кнопка «Динамик»; Telegram `VoIPFragment` / `VoIPService`): пока звонок идёт (вызов или
 * разговор), нативная сторона держит звук (`CallAudio.kt`), по окончании возвращает прежнее. Вне приложения Android и в старом APK
 * без моста — `null` (кнопки нет). Включили камеру, пока звук у уха, — на громкий (Telegram `switchToSpeaker`).
 */
function useCallAudio(live: boolean): CallAudioState | null {
  const camera = useCall((s) => s.camera);
  const [state, setState] = useState<CallAudioState | null>(null);
  useEffect(() => {
    if (!live || !callAudioSupported()) {
      setState(null);
      return;
    }
    startCallAudio(useCall.getState().camera);
    setState(readCallAudio());
    const off = onCallAudioChanged(() => setState(readCallAudio()));
    return () => {
      off();
      stopCallAudio();
    };
  }, [live]);
  useEffect(() => {
    if (live && camera && readCallAudio()?.route === 'earpiece') selectCallRoute('speaker');
  }, [live, camera]);
  return live ? state : null;
}

const ROUTE_ICON: Record<CallRoute, RoundIcon> = { speaker: 'volume', earpiece: 'phone', wired: 'headphones', bluetooth: 'bluetooth' };
const ROUTE_LABEL: Record<CallRoute, string> = { speaker: 'Динамик', earpiece: 'Телефон', wired: 'Наушники', bluetooth: 'Bluetooth' };

/** Лист выбора вывода (Telegram `toggleSpeakerphoneOrShowRouteSheet`: «Динамик / Телефон / Bluetooth»). */
function CallRouteSheet({ audio, onClose }: { audio: CallAudioState; onClose: () => void }) {
  return (
    <BottomSheet title="Вывод звука" onClose={onClose}>
      {audio.devices.map((d) => (
        <SheetRow
          key={d.kind}
          icon={ROUTE_ICON[d.kind]}
          label={d.kind === 'bluetooth' && d.name ? d.name : ROUTE_LABEL[d.kind]}
          meta={d.kind === audio.route ? <Icon name="check" size={20} /> : undefined}
          onClick={() => {
            selectCallRoute(d.kind);
            onClose();
          }}
        />
      ))}
    </BottomSheet>
  );
}

/**
 * Android: контекст, через который играет звук собеседника (`useCallMedia`): `'playback'` — поток AudioTrack, не MMAP, с
 * назначением, взятым в момент создания (после микрофона — VOICE_COMMUNICATION). Нет WebAudio — `undefined`, SDK заведёт свой.
 */
function callPlaybackContext(): AudioContext | undefined {
  try {
    const ac = new AudioContext({ latencyHint: 'playback' });
    void ac.resume().catch(() => {});
    return ac;
  } catch {
    return undefined;
  }
}

function useCallMedia(): void {
  const join = useCall((s) => s.join);
  const muted = useCall((s) => s.muted);
  const camera = useCall((s) => s.camera);
  const screen = useCall((s) => s.screen);
  const facing = useCall((s) => s.facing);
  const [room, setRoom] = useState<Room | null>(null);
  const [ready, setReady] = useState(false);

  useEffect(() => {
    if (!join) return;
    const a = getAudioSettings();
    // Приложение Android: эхоподавление ВКЛЮЧЕНО, усиление и шумодав — нет. Режим связи (`MODE_IN_COMMUNICATION`) Chromium
    // ставит ТОЛЬКО когда у входного потока есть платформенный эхоподавитель (`audio_manager_android.cc`, эффект ECHO_CANCELLER),
    // и только тогда выходные потоки рождаются с `USAGE_VOICE_COMMUNICATION`; без него звук звонка — `USAGE_MEDIA`, такой поток
    // всегда в громком динамике, и «Динамик» / «у уха» (`CallAudio.kt`) его не касаются. Усиление и шумодав остаются выключенными:
    // с ними микрофон на Samsung уходил во «всплеск и тишину» (`VoiceConnection.tsx`, `audioCaptureDefaults`; `MainActivity.kt`).
    const mobile = isMobile();
    const capture = {
      autoGainControl: mobile ? false : a.autoGainControl,
      echoCancellation: mobile ? true : a.echoCancellation,
      noiseSuppression: mobile ? false : a.noiseFilter !== 'off',
      ...(a.inputDeviceId ? { deviceId: a.inputDeviceId } : {}),
    };
    // Android: звук собеседника играет НАШ WebAudio-контекст `latencyHint: 'playback'`, созданный после микрофона (`webAudioMix`;
    // `<audio>` SDK остаётся немым — без него удалённый звук в WebAudio не течёт). Почему так (замер S20, Chromium 154):
    //  • назначение (`usage`) выходного потока Chromium берёт в момент создания: до микрофона — MEDIA, после — VOICE_COMMUNICATION;
    //  • поток с малой задержкой (обычный `<audio>` звонка, контекст по умолчанию) AAudio подсаживает в уже открытый общий
    //    MMAP-поток (его открыл рингтон / контекст SDK до микрофона) — и просьба VOICE_COMMUNICATION теряется: громкий динамик;
    //  • `'playback'` в MMAP не ходит никогда (AudioTrack с VOICE_COMMUNICATION — слушается «Динамик» / «у уха»), а простаивающий
    //    поток Chromium переиспользует только в пределах своего класса задержки — рингтон (`ringPattern`) другого класса.
    // Свой контекст подставляется в настройку до `connect`, иначе SDK при подключении заведёт свой (до микрофона).
    const mix: { audioContext?: AudioContext } = {};
    const r = new Room({
      ...(mobile ? { webAudioMix: mix as { audioContext: AudioContext } } : {}),
      disconnectOnPageLeave: false,
      adaptiveStream: false,
      // `stopMicTrackOnMute: false` (так и по умолчанию, держим явно): выключенный микрофон — дорожка остаётся открытой
      // (только `enabled = false`), иначе закрытый вход снял бы режим связи и звук ушёл бы в громкий.
      publishDefaults: { dtx: true, red: true, stopMicTrackOnMute: false },
      audioCaptureDefaults: capture,
    });
    const els = new Set<HTMLMediaElement>();
    // Звонок кончился, пока комната подключалась (отклонили, отменили): обрыв подключения — наш, не ошибка.
    let gone = false;
    // Android: микрофон открываем СРАЗУ, подключаемся — только после него (и после контекста звука выше), так что ни один
    // выходной поток звонка не рождается раньше режима связи. Звонок, начатый с выключенным микрофоном, держит дорожку
    // открытой и публикует её заглушённой. ПК и веб — как раньше (подключение сразу, микрофон после него).
    let mic: LocalAudioTrack | null = null;
    const micOpen: Promise<void> = mobile
      ? createLocalAudioTrack(capture).then(
          (t) => {
            if (gone) t.stop();
            else mic = t;
          },
          (e: unknown) => {
            if (gone) return;
            console.error('[call] microphone open failed:', e);
            toastError(e, 'Звонок: не удалось подключить звук');
          },
        )
      : Promise.resolve();
    const attachAudio = (track: RemoteTrack) => {
      const el = track.attach();
      el.dataset.gvCall = '1';
      document.body.appendChild(el);
      els.add(el);
    };
    const here = () => useCall.getState().setConnected(r.remoteParticipants.size > 0);
    // Видео собеседника: показ экрана важнее камеры (tdesktop показывает то, что пришло, — у нас одно окно).
    const pickRemote = () => {
      let cam: RemoteTrack | null = null;
      let scr: RemoteTrack | null = null;
      for (const p of r.remoteParticipants.values()) {
        for (const pub of p.videoTrackPublications.values()) {
          if (!pub.track || pub.isMuted) continue;
          if (pub.source === Track.Source.ScreenShare) scr = pub.track;
          else if (pub.source === Track.Source.Camera) cam = pub.track;
        }
      }
      useCall.getState().setVideoTracks({ remoteVideo: scr ?? cam, remoteScreen: !!scr });
    };
    // SDK шлёт «отписались» ДО того, как убрал публикацию из своих списков, — пересчитываем после него.
    const pickRemoteSoon = () => setTimeout(pickRemote, 0);
    const pickLocal = () => {
      const t = r.localParticipant.getTrackPublication(Track.Source.Camera)?.videoTrack as LocalVideoTrack | undefined;
      useCall.getState().setVideoTracks({ localVideo: t && !t.isMuted ? t : null });
    };
    r.on(RoomEvent.TrackSubscribed, (track: RemoteTrack) => {
      if (track.kind !== 'audio') return pickRemote();
      attachAudio(track);
    });
    r.on(RoomEvent.TrackUnsubscribed, (track: RemoteTrack) => {
      if (track.kind !== 'audio') return void pickRemoteSoon();
      for (const el of track.detach()) {
        el.remove();
        els.delete(el);
      }
    });
    r.on(RoomEvent.TrackUnpublished, pickRemoteSoon);
    r.on(RoomEvent.TrackMuted, () => (pickRemote(), pickLocal()));
    r.on(RoomEvent.TrackUnmuted, () => (pickRemote(), pickLocal()));
    r.on(RoomEvent.LocalTrackPublished, pickLocal);
    r.on(RoomEvent.LocalTrackUnpublished, (pub) => {
      pickLocal();
      // Показ остановили кнопкой браузера «Закрыть доступ» — кнопка «Экран» гаснет.
      if (pub.source === Track.Source.ScreenShare) useCall.getState().setScreen(false);
    });
    r.on(RoomEvent.ParticipantConnected, here);
    r.on(RoomEvent.ParticipantDisconnected, () => (here(), pickRemoteSoon()));
    void (async () => {
      try {
        // Android: микрофон (режим связи) → контекст звука собеседника → подключение. Микрофон не открылся — всё равно
        // подключаемся: слышать собеседника важнее.
        if (mobile) {
          await micOpen;
          if (gone) return;
          mix.audioContext = callPlaybackContext();
        }
        await r.connect(join.url, join.token);
        here();
        pickRemote();
        if (!mobile) {
          setReady(true);
          await r.localParticipant.setMicrophoneEnabled(!useCall.getState().muted);
          return;
        }
        // Android: публикуем уже открытую дорожку (микрофон выключен — заглушённой). «Готово» — после публикации: иначе
        // слежение за `muted` ниже успело бы открыть вторую дорожку. Не открылась — то же слежение попробует ещё раз.
        try {
          const t = mic as LocalAudioTrack | null;
          if (t && !gone) {
            if (useCall.getState().muted) await t.mute();
            await r.localParticipant.publishTrack(t);
          }
        } finally {
          if (!gone) setReady(true);
        }
      } catch (e) {
        if (gone) return;
        console.error('[call] connect failed:', e);
        toastError(e, 'Звонок: не удалось подключить звук');
      }
    })();
    setRoom(r);
    return () => {
      gone = true;
      setRoom(null);
      setReady(false);
      void r.disconnect();
      // Свой контекст звука собеседника SDK не закрывает (`webAudioMix` с контекстом снаружи).
      void mix.audioContext?.close().catch(() => {});
      // Неопубликованную дорожку `disconnect` не закрывает (микрофон открыли, а подключиться не успели).
      (mic as LocalAudioTrack | null)?.stop();
      for (const el of els) el.remove();
      useCall.getState().setConnected(false);
      useCall.getState().setVideoTracks({ localVideo: null, remoteVideo: null, remoteScreen: false });
    };
  }, [join]);

  useEffect(() => {
    if (room && ready) void room.localParticipant.setMicrophoneEnabled(!muted).catch(() => {});
  }, [room, ready, muted]);

  // Камера (`calls2`): включить / выключить; смена фронт ↔ тыл на живой камере — перезапуск дорожки без новой публикации
  // (как `VoiceChannelView.MobileCallBar.flipCamera`).
  useEffect(() => {
    if (!room || !ready) return;
    const lp = room.localParticipant;
    const pickLocal = () => {
      const t = lp.getTrackPublication(Track.Source.Camera)?.videoTrack as LocalVideoTrack | undefined;
      useCall.getState().setVideoTracks({ localVideo: t && !t.isMuted ? t : null });
    };
    if (!camera) {
      if (lp.isCameraEnabled) void lp.setCameraEnabled(false).then(pickLocal, () => {});
      return;
    }
    const live = lp.getTrackPublication(Track.Source.Camera)?.videoTrack as LocalVideoTrack | undefined;
    if (lp.isCameraEnabled && live) {
      void live.restartTrack({ facingMode: facing, ...cameraCaptureOptions() }).then(pickLocal, (e) => toastError(e, 'Камера недоступна'));
      return;
    }
    void lp
      .setCameraEnabled(true, { facingMode: facing, ...cameraCaptureOptions() }, cameraPublishOptions())
      .then(() => {
        pickLocal();
        const id = useCall.getState().call?.id;
        if (id) void useCall.getState().ping(id, true).catch(() => {});
      })
      .catch((e) => {
        useCall.getState().setCamera(false);
        toastError(e, 'Камера недоступна');
      });
  }, [room, ready, camera, facing]);

  // Показ экрана с ПК (`calls2`): то же качество, что у показа в голосовом канале (`VoiceControls.startShare`), без звука.
  useEffect(() => {
    if (!room || !ready) return;
    const lp = room.localParticipant;
    if (screen === lp.isScreenShareEnabled) return;
    if (!screen) {
      void lp.setScreenShareEnabled(false).catch(() => {});
      return;
    }
    const s = { ...webScreenSettings(getStreamSettings()), audio: false };
    void lp
      .setScreenShareEnabled(true, captureOptions(s), publishOptions(s))
      .then(() => {
        const id = useCall.getState().call?.id;
        if (id) void useCall.getState().ping(id, true).catch(() => {});
      })
      .catch((e: unknown) => {
        useCall.getState().setScreen(false);
        const n = (e as DOMException)?.name;
        // Закрыли окно выбора — не ошибка.
        if (n !== 'NotAllowedError' && n !== 'AbortError') toastError(e, 'Не удалось начать показ экрана');
      });
  }, [room, ready, screen]);
}

/** Знак жизни серверу, пока звонок ведёт это устройство; сервер звонка не знает — кладём трубку у себя. */
function useCallPing(view: CallView, callId: string | undefined): void {
  const on = view === 'outgoing' || view === 'active';
  useEffect(() => {
    if (!on || !callId) return;
    const t = setInterval(() => {
      const { camera, screen } = useCall.getState();
      useCall.getState().ping(callId, camera || screen).catch((e: { status?: number }) => {
        const cur = useCall.getState().call;
        if (e?.status === 404 && cur?.id === callId) useCall.getState().apply({ ...cur, phase: 'ended', reason: 'disconnect' });
      });
    }, CALL_PING_MS);
    return () => clearInterval(t);
  }, [on, callId]);
}

// ─── Разметка ────────────────────────────────────────────────────────────────────────────────────────────────────────

type RoundIcon = 'phone' | 'mic' | 'mic-off' | 'camera' | 'camera-off' | 'screen-share' | 'camera-flip' | 'volume' | 'headphones' | 'bluetooth';

function RoundBtn(p: { kind: 'accept' | 'decline' | 'plain'; icon: RoundIcon; label: string; on?: boolean; onClick: () => void }) {
  return (
    <div className="call-act">
      <button
        type="button"
        className={`call-round ${p.kind}${p.on ? ' on' : ''}`}
        aria-label={p.label}
        aria-pressed={p.kind === 'plain' ? !!p.on : undefined}
        onClick={p.onClick}
      >
        <Icon name={p.icon} size={26} />
      </button>
      <span className="call-act-label">{p.label}</span>
    </div>
  );
}

/** Видеодорожка LiveKit в `<video>`: прикрепить при появлении, открепить при смене и уходе. */
function TrackVideo({ track, className }: { track: RemoteTrack | LocalVideoTrack; className: string }) {
  const ref = useRef<HTMLVideoElement>(null);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    track.attach(el);
    return () => {
      track.detach(el);
    };
  }, [track]);
  return <video ref={ref} className={className} autoPlay playsInline muted />;
}

/**
 * Своё превью в углу экрана звонка (tdesktop `calls_video_bubble.cpp`): по умолчанию — правый нижний угол, перетаскивается
 * мышью или пальцем и прилипает к ближайшему углу (`previewCorner`). Фронтальная камера — зеркально, как в зеркале.
 */
function CallPreview({ track, mirror }: { track: LocalVideoTrack; mirror: boolean }) {
  const [corner, setCorner] = useState<PreviewCorner>('br');
  const drag = useRef<{ x: number; y: number; id: number } | null>(null);
  const onDown = (e: React.PointerEvent<HTMLDivElement>) => {
    drag.current = { x: e.clientX, y: e.clientY, id: e.pointerId };
    e.currentTarget.setPointerCapture(e.pointerId);
    e.currentTarget.classList.add('dragging');
  };
  const onMove = (e: React.PointerEvent<HTMLDivElement>) => {
    const d = drag.current;
    if (!d || d.id !== e.pointerId) return;
    e.currentTarget.style.translate = `${e.clientX - d.x}px ${e.clientY - d.y}px`;
  };
  const onUp = (e: React.PointerEvent<HTMLDivElement>) => {
    const d = drag.current;
    if (!d || d.id !== e.pointerId) return;
    drag.current = null;
    const el = e.currentTarget;
    const box = el.parentElement?.getBoundingClientRect();
    const r = el.getBoundingClientRect();
    el.classList.remove('dragging');
    el.style.translate = '';
    if (box) setCorner(previewCorner(r.left + r.width / 2 - box.left, r.top + r.height / 2 - box.top, box.width, box.height));
  };
  return (
    <div
      className={`call-preview ${corner}`}
      onPointerDown={onDown}
      onPointerMove={onMove}
      onPointerUp={onUp}
      onPointerCancel={onUp}
      aria-label="Ваша камера"
      role="img"
    >
      <TrackVideo track={track} className={mirror ? 'mirror' : ''} />
    </div>
  );
}

/** Экран звонка: входящий, вызов, разговор, «звонок завершён». На ПК — карточка по центру, на телефоне — весь экран. */
export function CallLayer() {
  const view = useCallView();
  const call = useCall((s) => s.call);
  const peer = useCall((s) => s.peer);
  const muted = useCall((s) => s.muted);
  const connected = useCall((s) => s.connected);
  const expanded = useCall((s) => s.expanded);
  const ended = useCall((s) => s.ended);
  const camera = useCall((s) => s.camera);
  const screen = useCall((s) => s.screen);
  const facing = useCall((s) => s.facing);
  const localVideo = useCall((s) => s.localVideo);
  const remoteVideo = useCall((s) => s.remoteVideo);
  const remoteScreen = useCall((s) => s.remoteScreen);
  const videoOn = useStore((s) => serverCallVideo(s.serverFeatures));
  const inVoice = useStore((s) => !!s.voice);
  const phone = usePhoneLayout();
  const elapsed = useElapsed(view === 'active' ? call?.answeredAt : undefined);
  useCallMedia();
  useCallPing(view, call?.id);
  const audio = useCallAudio(!ended && (view === 'outgoing' || view === 'active'));
  const [routeSheet, setRouteSheet] = useState(false);

  // Звонит у собеседника — рингтон; звоню я — гудки вызова. Молчим, как только что-то изменилось.
  useEffect(() => {
    if (view !== 'incoming' && view !== 'outgoing') return;
    return ringPattern(view);
  }, [view]);

  // «Назад» Android на развёрнутом экране звонка — «Свернуть» (шеврон), а не уход из приложения (эмулятор B3, Telegram Android).
  const minimizable = !!peer && expanded && !ended && (view === 'outgoing' || view === 'active');
  useEffect(() => {
    if (!minimizable) return;
    return pushBackHandler(() => {
      useCall.getState().setExpanded(false);
      return true;
    });
  }, [minimizable]);

  if (!peer || (view === 'none' && !ended) || view === 'elsewhere') return null;
  // Входящий показываем всегда; свой вызов и разговор — пока карточка развёрнута.
  if (view !== 'incoming' && !expanded && !ended) return null;
  const status = callStatusText(view, { connected, elapsedMs: elapsed, ended });
  const s = useCall.getState();
  const live = !ended && (view === 'outgoing' || view === 'active');
  const remote = live && view === 'active' ? remoteVideo : null;
  const self = live ? localVideo : null;
  // tdesktop `refreshOutgoingPreviewInBody`: пока не ответили, своя камера — в теле карточки под статусом; в разговоре —
  // превью в углу, а карточка ПК растёт до окна звонка tdesktop (720×540), чтобы было куда показывать видео.
  const selfInBody = !!self && view === 'outgoing';
  const big = !!remote || (!!self && view === 'active');
  const ringing = !ended && (view === 'incoming' || view === 'outgoing');
  const press = audio ? speakerPress(audio) : null;
  const acts = 2 + (press ? 1 : 0) + (videoOn ? 1 : 0) + (videoOn && screenShareSupported(phone) ? 1 : 0) + (videoOn && camera && facingSupported(phone) ? 1 : 0);

  return (
    <div className={`call-scrim${phone ? ' phone' : ''}`}>
      <div
        className={`call-screen${big ? ' video' : ''}${remote ? ' remote' : ''}`}
        role="dialog"
        aria-modal="true"
        aria-label={`Звонок: ${peer.name}`}
      >
        {remote && <TrackVideo track={remote} className={`call-remote${remoteScreen ? ' fit' : ''}`} />}
        {view !== 'incoming' && !ended && (
          <button type="button" className="call-min" title="Свернуть" aria-label="Свернуть" onClick={() => s.setExpanded(false)}>
            <Icon name="chevron-down" size={20} />
          </button>
        )}
        {!remote && (
          <div className={`call-ava${ringing ? ' ringing' : ''}`}>
            <Avatar url={peer.avatarUrl} name={peer.name} size={phone ? 135 : 96} />
          </div>
        )}
        <div className="call-name">{peer.name}</div>
        <div className="call-status" aria-live="polite">
          {status}
        </div>
        {selfInBody && self && (
          <div className="call-preview body" aria-label="Ваша камера" role="img">
            <TrackVideo track={self} className={facing === 'user' ? 'mirror' : ''} />
          </div>
        )}
        {!selfInBody && self && <CallPreview track={self} mirror={facing === 'user'} />}
        {!ended && (
          <div className={`call-acts${acts > 3 ? ' many' : ''}`}>
            {view === 'incoming' ? (
              <>
                <RoundBtn kind="decline" icon="phone" label="Отклонить" onClick={() => void s.decline()} />
                <RoundBtn kind="accept" icon="phone" label={inVoice ? 'Выйти из канала и ответить' : 'Ответить'} onClick={() => void s.answer()} />
              </>
            ) : (
              <>
                {videoOn && (
                  <RoundBtn kind="plain" icon={camera ? 'camera' : 'camera-off'} label="Камера" on={camera} onClick={() => s.setCamera(!camera)} />
                )}
                {videoOn && camera && facingSupported(phone) && (
                  <RoundBtn kind="plain" icon="camera-flip" label="Повернуть" onClick={() => s.flipCamera()} />
                )}
                {videoOn && screenShareSupported(phone) && (
                  <RoundBtn kind="plain" icon="screen-share" label="Экран" on={screen} onClick={() => s.setScreen(!screen)} />
                )}
                {audio && press && (
                  <RoundBtn
                    kind="plain"
                    icon={audio.route === 'bluetooth' || audio.route === 'wired' ? ROUTE_ICON[audio.route] : 'volume'}
                    label="Динамик"
                    on={audio.route === 'speaker'}
                    onClick={() => ('sheet' in press ? setRouteSheet(true) : selectCallRoute(press.to))}
                  />
                )}
                <RoundBtn kind="plain" icon={muted ? 'mic-off' : 'mic'} label={muted ? 'Включить микрофон' : 'Микрофон'} on={muted} onClick={() => s.setMuted(!muted)} />
                <RoundBtn kind="decline" icon="phone" label={view === 'outgoing' ? 'Отменить' : 'Завершить'} onClick={() => void s.hangup()} />
              </>
            )}
          </div>
        )}
      </div>
      {routeSheet && audio && press && 'sheet' in press && <CallRouteSheet audio={audio} onClose={() => setRouteSheet(false)} />}
    </div>
  );
}

/** Полоса видна над всем экраном телефона — класс корня `gv-callbar`: по нему CSS сдвигает вниз приложение, кнопки шапки и окна. */
export const CALLBAR_ROOT_CLASS = 'gv-callbar';

/**
 * Полоса идущего звонка (tdesktop `calls_top_bar.cpp`): видна, пока карточка свёрнута. ПК — над лентой беседы/канала (в `.content`).
 *
 * `top` — телефон (callbar D2, 08.10; Telegram Android `FragmentContextView`): одна полоса над ЛЮБЫМ экраном — список бесед,
 * серверы, профиль, беседа, настройки; нажатие — развернуть. Раньше она жила в `.content`, а тот в режиме списка скрыт, и к идущему
 * звонку можно было вернуться только через беседу. Полоса фиксирована под строкой состояния, место под неё — `CALLBAR_ROOT_CLASS`.
 */
export function CallBar({ top = false }: { top?: boolean }) {
  const view = useCallView();
  const call = useCall((s) => s.call);
  const peer = useCall((s) => s.peer);
  const muted = useCall((s) => s.muted);
  const connected = useCall((s) => s.connected);
  const expanded = useCall((s) => s.expanded);
  const elapsed = useElapsed(view === 'active' ? call?.answeredAt : undefined);
  const shown = !!peer && !expanded && (view === 'outgoing' || view === 'active');
  useEffect(() => {
    if (!top || !shown) return;
    const root = document.documentElement;
    root.classList.add(CALLBAR_ROOT_CLASS);
    return () => root.classList.remove(CALLBAR_ROOT_CLASS);
  }, [top, shown]);
  if (!peer || !shown) return null;
  const s = useCall.getState();
  return (
    <div className={`call-bar${top ? ' call-bar-top' : ''}`} role="region" aria-label="Идёт звонок">
      <button
        type="button"
        className={`call-bar-btn${muted ? ' on' : ''}`}
        title={muted ? 'Включить микрофон' : 'Выключить микрофон'}
        aria-pressed={muted}
        onClick={() => s.setMuted(!muted)}
      >
        <Icon name={muted ? 'mic-off' : 'mic'} size={18} />
      </button>
      <button type="button" className="call-bar-who" title="Развернуть звонок" onClick={() => s.setExpanded(true)}>
        <b>{peer.name}</b>
        <span>{callStatusText(view, { connected, elapsedMs: elapsed })}</span>
      </button>
      <button type="button" className="call-bar-btn hang" title="Завершить звонок" aria-label="Завершить звонок" onClick={() => void s.hangup()}>
        <Icon name="phone" size={18} />
      </button>
    </div>
  );
}
