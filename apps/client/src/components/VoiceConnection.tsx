import { voiceMaxBitrate } from '@gusvoice/shared';
import { RoomAudioRenderer, RoomContext } from '@livekit/components-react';
import {
  DisconnectReason,
  type LocalTrackPublication,
  type Participant,
  Room,
  RoomEvent,
  Track,
  type TrackPublication,
} from 'livekit-client';
import { useEffect, useMemo, useRef, useState } from 'react';
import { getAudioSettings, subscribeAudioSettings } from '../audioSettings';
import { startDiag, stopDiagAndUpload } from '../diag';
import { cameraCaptureOptions } from '../cameraSettings';
import { isDesktop, isMobile, pttKeyVk } from '../hotkeys';
import { createMicProcessor } from '../micProcessor';
import { micChainNeeded, micChainSignature } from '../micProcessorRules';
import { applyUserAudio, subscribeUserAudio } from '../localUserAudio';
import { stopNativeShareIfActive } from '../nativeShareSession';
import { onNativeKeyPtt, onNativePtt, setPttKey, setPttMouseButton } from '../nativeStreamAudio';
import { startNativeVoiceService, stopNativeVoiceService } from '../nativeVoiceService';
import { playSound } from '../sounds';
import { useStore, type LiveVoiceState, type VoiceState } from '../store';
import { creditScreenOwners, ownerOf, streamAudioVolume } from '../streamAudioRules';
import { toastError } from '../toast';
import { lostCueDelayMs } from '../voiceCueRules';
import { createStreamCue } from '../streamCue';
import { grabPreview } from '../streamPreviewGrab';
import { createPreviewPublisher } from '../streamPreviewPublisher';
import { getStreamSettings } from '../streamSettings';
import { config } from '../config';
import { diagDecision, getDiagConsent } from '../diagConsent';
import { DiagConsentDialog } from './DiagConsent';
import { api } from '../api';
import { setSelfMuted } from '../voiceSelf';
import { GRACE_MS, touchVoiceSession } from '../voiceSession';

/**
 * Owns a single LiveKit Room instance for the active voice connection. The Room is
 * created once per joined channel (useMemo keyed by channelId) and connected in an
 * effect, so React re-renders never tear down or reconnect the media session.
 * Children render inside the RoomContext so the voice stage / participant list can
 * use LiveKit hooks.
 */
export function VoiceConnection({ children }: { children: React.ReactNode }) {
  const voice = useStore((s) => s.voice)!;
  const currentChannelId = useStore((s) => s.currentChannelId);
  const bootstrap = useStore((s) => s.bootstrap);
  const leaveVoice = useStore((s) => s.leaveVoice);
  const setLiveVoice = useStore((s) => s.setLiveVoice);
  const [state, setState] = useState<string>('connecting');
  // Спрашивать ли про диагностику. Считается ОДИН раз на монтирование: решение человека внутри
  // сессии меняется только через это же окно, а перечитывать хранилище на каждый рендер незачем.
  const [askDiag, setAskDiag] = useState(() => diagDecision(config.diagEnabled, getDiagConsent()) === 'ask');
  // Mic-mute / deafen are GLOBAL intent in the store (persisted) — they survive channel switches,
  // reconnects and app restarts, drive the always-visible bar, and are applied to the live room by the
  // "apply self voice" effect below. The toggles live in voiceSelf.ts so any surface can flip them.
  const selfMuted = useStore((s) => s.selfMuted);
  const selfDeafened = useStore((s) => s.selfDeafened);
  // Live profile — pushed onto our LiveKit participant so voice tiles refresh on a name/avatar edit.
  const userDisplayName = useStore((s) => s.user?.displayName);
  const userAvatarUrl = useStore((s) => s.user?.avatarUrl ?? null);

  const room = useMemo(() => {
    // Apply the user's saved audio prefs (devices + browser DSP) to this session's capture.
    const a = getAudioSettings();
    // Качество берём у КАНАЛА, в который зашли (#101). Комната пересоздаётся на смену канала, так что
    // читать его здесь достаточно. ⚠️ `useStore.getState()`, а не подписка: подписка ре-рендерила бы
    // компонент, а `useMemo` всё равно не пересчитается — вышло бы «настройка вроде читается, а не
    // применяется». Меняется битрейт только перезаходом в канал, и это честно написано в настройках.
    const joinedChannel = useStore.getState().bootstrap?.channels.find((c) => c.id === voice.channelId);
    return new Room({
      disconnectOnPageLeave: false,
      adaptiveStream: false,
      dynacast: false,
      // Route remote audio through a shared AudioContext so per-user volume can exceed 100%
      // (a GainNode, not the [0,1]-capped HTMLMediaElement.volume). See localUserAudio.
      webAudioMix: true,
      // 🔴 #101 — ОБА параметра ниже развёрнуты обратно, и вот почему.
      //
      // Раньше здесь стояло `dtx: false` + потолок 128 кбит/с с комментарием «bandwidth cost is
      // negligible for a self-hosted SFU». Для СЕРВЕРА это правда, и считали именно его. Но платит за
      // битрейт каждый СЛУШАТЕЛЬ: SFU форвардит каждый поток каждому без перекодирования, поэтому
      // входящий трафик слушателя растёт линейно с числом говорящих. Вчетвером на мобильном интернете
      // это уже не пролезало — а `dtx: false` означал, что платим и за тех, кто молчит.
      //
      // DTX (Opus discontinuous transmission) подрезает начала и хвосты слов — из-за этого его когда-то
      // и выключили. Возвращаем осознанно: в канале обычно говорит один, и без DTX за остальных
      // платят все. Если подрезание окажется слышимым — это первое, что нужно откатить.
      publishDefaults: {
        dtx: true,
        // RED (избыточность) оставлен: на мобильном канале с потерями он как раз спасает разборчивость.
        // Стоит примерно вдвое по трафику — это учтено в оценке в настройках канала.
        red: true,
        // Качество — НАСТРОЙКА КАНАЛА (#101), не глобальная константа: у голосового «поболтать» и у
        // канала, где слушают музыку, разная цена. `voiceBitrateOf` подставит умолчание, если канала
        // ещё нет в bootstrap (восстановление сессии при старте) — тогда просто поедет умолчание.
        audioPreset: { maxBitrate: voiceMaxBitrate(joinedChannel?.voiceBitrate) },
      },
      audioCaptureDefaults: {
        // Android FIX (confirmed on-device): force ALL WebRTC audio processing OFF on mobile. The Android
        // System WebView's getUserMedia mic (Samsung; likely other OEMs) MANGLES audio when AEC/AGC/NS are
        // on — "spike then silence" + heavy latency (auto-gain / echo-cancel misbehave, killing sustained
        // speech). Raw mic = clean voice. Trade-off: no echo cancellation, so a user on SPEAKERPHONE may be
        // echoed at the far end — revisit re-enabling ONLY echoCancellation if that bites (AGC was the
        // likely culprit). Neither MODE_IN_COMMUNICATION (removed in MainActivity) nor the noise filter moved it.
        autoGainControl: isMobile() ? false : a.autoGainControl,
        echoCancellation: isMobile() ? false : a.echoCancellation,
        // 'system' = browser/getUserMedia NS. 'rnnoise' runs our own filter (NS off here, applied
        // as a track processor below); 'off' = no suppression at all.
        noiseSuppression: isMobile() ? false : a.noiseFilter === 'system',
        ...(a.inputDeviceId ? { deviceId: a.inputDeviceId } : {}),
      },
      // Camera resolution comes from the user's quality preset (#33; default 720p). The publish side
      // (simulcast off + maintain-resolution + bitrate) is applied per-preset in VoiceChannelView.
      videoCaptureDefaults: {
        ...cameraCaptureOptions(),
        ...(a.cameraDeviceId ? { deviceId: a.cameraDeviceId } : {}),
      },
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [voice.channelId]);

  // Android background voice (#89): hold a microphone foreground service for the whole in-voice lifetime
  // so locking the screen / backgrounding the app can't let the OS (Samsung especially) suspend mic
  // capture and silently drop the call. VoiceConnection stays mounted across channel switches AND the
  // reconnect-grace window, so this starts once on join and stops on leave. No-op off the Android build.
  useEffect(() => {
    startNativeVoiceService();
    return () => {
      stopNativeVoiceService();
    };
  }, []);

  // The Android WebView blocks video autoplay without a user gesture (mediaPlaybackRequiresUserGesture),
  // so remote screen-share / camera <video> elements freeze on the native play-button placeholder (#29).
  // Browsers + desktop WebView2 autoplay fine. On mobile, replay any paused <video> on ANY tap — the tap
  // IS the gesture, so play() is allowed; effectively "tap the placeholder (or anything) to start it".
  useEffect(() => {
    if (!isMobile()) return;
    const unlock = () => {
      for (const v of document.querySelectorAll('video')) {
        if (v.paused) void v.play().catch(() => {});
      }
    };
    document.addEventListener('pointerdown', unlock, true);
    return () => document.removeEventListener('pointerdown', unlock, true);
  }, []);

  useEffect(() => {
    // Reconnect-grace (#11): if the connection drops and LiveKit can't restore it within GRACE_MS, we
    // visually leave the channel but KEEP the persisted session, so a restart within the window rejoins.
    let graceTimer: ReturnType<typeof setTimeout> | null = null;
    // Подсказка «связь потеряна» — на ПОЛОВИНЕ пути до грейса. Отдельный таймер, а не мгновенный
    // звук на `reconnecting`: тот возникает от любого чиха вайфая и почти всегда закрывается за
    // секунду, так что без задержки получилась бы трещотка (особенно у тех, у кого канал похуже).
    let lostTimer: ReturnType<typeof setTimeout> | null = null;
    // ⚠️ «Восстановлена» звучит ТОЛЬКО если звучало «потеряна» — иначе после каждого короткого блипа
    // прилетал бы одинокий бодрый звук на ровном месте, и непонятно, что вообще произошло.
    let lostPlayed = false;
    const clearGrace = () => {
      if (graceTimer) {
        clearTimeout(graceTimer);
        graceTimer = null;
      }
      if (lostTimer) {
        clearTimeout(lostTimer);
        lostTimer = null;
      }
    };
    const onState = (s: string) => {
      setState(s);
      const vs: VoiceState =
        s === 'connected' ? 'connected' : s === 'connecting' ? 'connecting' : s === 'disconnected' ? 'disconnected' : 'reconnecting';
      useStore.getState().setVoiceState(vs);
      if (s === 'connected') {
        clearGrace();
        if (lostPlayed) {
          lostPlayed = false;
          playSound('connectionRestored', voice.channelId);
        }
      } else if ((s === 'reconnecting' || s === 'disconnected') && !graceTimer) {
        lostTimer = setTimeout(() => {
          lostTimer = null;
          lostPlayed = true;
          playSound('connectionLost', voice.channelId);
        }, lostCueDelayMs(GRACE_MS));
        graceTimer = setTimeout(() => {
          graceTimer = null;
          console.warn('[voice] reconnect grace expired — leaving (session kept for restore)');
          // Нас выкинуло из канала — картинка изменилась, и это надо озвучить тем же звуком, что и
          // обычный выход. Сессия сохраняется: по ней сработает авто-возврат, когда сеть вернётся.
          playSound('leave', voice.channelId);
          leaveVoice(true);
        }, GRACE_MS);
      }
    };
    const onDisconnected = (reason?: DisconnectReason) => {
      console.warn('[voice] disconnected; reason =', reason, DisconnectReason[reason ?? 0]);
      if (
        reason === DisconnectReason.CLIENT_INITIATED ||
        reason === DisconnectReason.DUPLICATE_IDENTITY ||
        reason === DisconnectReason.SERVER_SHUTDOWN ||
        reason === DisconnectReason.ROOM_DELETED
      ) {
        clearGrace();
        leaveVoice();
      }
    };

    room.on(RoomEvent.ConnectionStateChanged, onState);
    room.on(RoomEvent.Disconnected, onDisconnected);

    // Mic/deafen are applied by the "apply self voice" effect once the state reaches 'connected'
    // (so the persisted intent survives channel switches and reconnects).
    room.connect(voice.url, voice.token).catch((e) => console.error('[voice] connect failed:', e));

    // Диагностика (#100) живёт ровно столько же, сколько сидение в голосе. Начинать её со старта
    // ПОКАЗА было ошибкой: первый же замер снимался уже с включённым показом, и отделить «сколько
    // добавил показ» от «сколько машина ела и так» было не с чем. Пока показа нет — замеры редкие.
    void startDiag(room);

    return () => {
      clearGrace();
      room.off(RoomEvent.ConnectionStateChanged, onState);
      room.off(RoomEvent.Disconnected, onDisconnected);
      room.disconnect();
      // Уход из канала (или смена канала — `room` пересоздаётся) закрывает сессию и досылает хвост.
      void stopDiagAndUpload();
    };
  }, [room, voice.url, voice.token, leaveVoice]);

  // 🔴 #96: нативную трансляцию гасит уход из канала — и ТОЛЬКО он. Companion-участник привязан к
  // комнате канала, поэтому осиротеть он может ровно в двух случаях: сменили канал (`room`
  // пересоздаётся) или вышли из голоса (этот компонент размонтируется). Оба покрыты cleanup'ом ниже.
  // ⚠️ Раньше этот teardown стоял в `VoiceControls`, а тот живёт в САЙДБАРЕ — переход в личные
  // сообщения подменяет сайдбар целиком, React зовёт cleanup на размонтировании, и трансляция
  // обрывалась у всех зрителей. Здесь компонент живёт ровно столько же, сколько сам голос.
  useEffect(() => {
    return () => {
      void stopNativeShareIfActive();
    };
  }, [room]);

  // Sound cues for voice activity: our own join (once per connection), and other members
  // joining / leaving / starting a screen-share while we're in the channel.
  const joinedRef = useRef(false);
  useEffect(() => {
    // This effect re-runs only when `room` changes — i.e. on a channel SWITCH (the room is useMemo'd by
    // channelId), NOT on a reconnect (same room instance). So reset the guard here: a switch replays the
    // join cue, a reconnect (same room, effect doesn't re-run) keeps it suppressed.
    joinedRef.current = false;
    const onConnected = () => {
      if (joinedRef.current) return; // don't replay on reconnect
      joinedRef.current = true;
      playSound('join', voice.channelId);
    };
    // A native screen-share is a COMPANION participant `<userId>#screen` (separate LiveKit connection),
    // so it fires ParticipantConnected/Disconnected like a real member — but it's not someone joining the
    // channel, it's a stream starting/stopping (cued by 'stream'/'streamStop' on Track(Un)published). Skip
    // it here, else starting a stream plays a phantom join cue and stopping plays a phantom leave cue.
    const onJoin = (p: Participant) => {
      if (p.identity.endsWith('#screen')) return;
      playSound('join', voice.channelId);
    };
    const onLeft = (p: Participant) => {
      if (p.identity.endsWith('#screen')) return;
      playSound('leave', voice.channelId);
    };
    // Звуки показа идут ЧЕРЕЗ СКЛЕЙКУ (#111): при самолечении залипшего показа публикация
    // пересоздаётся, и для всех в канале это выглядит как снятие и публикация трека. Без склейки
    // канал пикал бы «конец стрима» и следом «начало» на каждое лечение. См. `streamCue.ts`.
    const cue = createStreamCue({
      play: (e) => playSound(e, voice.channelId),
      setTimer: (fn, ms) => window.setTimeout(fn, ms),
      clearTimer: (id) => window.clearTimeout(id),
    });
    const onTrack = (pub: TrackPublication, p: Participant) => {
      if (pub.source === Track.Source.ScreenShare) cue.back(p.identity);
    };
    // Mirror of onTrack for stream STOP — plays for EVERYONE, same as start. Gating strictly on the
    // ScreenShare VIDEO source means exactly one cue per stream ending (ScreenShareAudio unpublish is
    // ignored). TrackUnpublished (remote) covers viewers of both paths AND the native streamer's own
    // client (companion "#screen" is remote to them — on disconnect LiveKit unpublishes its tracks with
    // sendUnpublish, firing TrackUnpublished before ParticipantDisconnected). LocalTrackUnpublished
    // covers the WEB streamer's own client (their share is a local track, not remote).
    const onTrackGone = (pub: TrackPublication, p: Participant) => {
      if (pub.source === Track.Source.ScreenShare) cue.gone(p.identity);
    };
    if (room.state === 'connected') onConnected();
    room
      .on(RoomEvent.Connected, onConnected)
      .on(RoomEvent.ParticipantConnected, onJoin)
      .on(RoomEvent.ParticipantDisconnected, onLeft)
      .on(RoomEvent.TrackPublished, onTrack)
      .on(RoomEvent.TrackUnpublished, onTrackGone)
      .on(RoomEvent.LocalTrackUnpublished, onTrackGone);
    return () => {
      room
        .off(RoomEvent.Connected, onConnected)
        .off(RoomEvent.ParticipantConnected, onJoin)
        .off(RoomEvent.ParticipantDisconnected, onLeft)
        .off(RoomEvent.TrackPublished, onTrack)
        .off(RoomEvent.TrackUnpublished, onTrackGone)
        .off(RoomEvent.LocalTrackUnpublished, onTrackGone);
      cue.dispose(); // уходим из канала — отложенные звуки снимаем молча
    };
  }, [room]);

  // Превью показа (#115): пока сидим в канале, раз в несколько секунд отдаём серверу свой кадр,
  // чтобы остальные видели по наведению мышкой, что мы показываем, не заходя сюда.
  //
  // ⚠️ Цикл живёт на КАНАЛЕ, а не на показе. Причина в `streamPreviewPublisher.ts`: «показываю»
  // приходит из двух разных мест, и склейка их здесь была бы третьим местом, которое обязано с ними
  // совпадать. Нет кадра — источник отдаёт `null`, такт пропускается.
  useEffect(() => {
    const channelId = voice.channelId;
    if (!channelId) return;
    const publisher = createPreviewPublisher({
      grab: () => {
        // Веб-путь: локальный трек показа. На десктопе его нет — там кадр приходит из нативного
        // конвейера, и `grabPreview` спрашивает его первым.
        const track = room.localParticipant.getTrackPublication(Track.Source.ScreenShare)?.videoTrack?.mediaStreamTrack;
        return grabPreview(track ?? null);
      },
      send: (image) => api.putStreamPreview(channelId, image),
      enabled: () => getStreamSettings().streamPreview,
      setTimer: (fn, ms) => window.setTimeout(fn, ms),
      clearTimer: (id) => window.clearTimeout(id),
    });
    publisher.start();
    return () => publisher.stop();
  }, [room, voice.channelId]);

  // Push-to-talk: while the configured key (or mouse button) is held, open the mic; release
  // closes it. The binding is a keyboard code (e.g. "Space") OR "Mouse<button>" for a mouse
  // button — side buttons are "Mouse3"/"Mouse4". Settings are read LIVE in the handlers so
  // re-binding or toggling PTT takes effect immediately (no reconnect needed). Never overrides
  // deafen. Listeners always mount; they no-op unless PTT is on and the binding matches.
  useEffect(() => {
    let held = false;
    let releaseTimer: ReturnType<typeof setTimeout> | null = null;
    const clearRelease = () => {
      if (releaseTimer) {
        clearTimeout(releaseTimer);
        releaseTimer = null;
      }
    };
    const start = () => {
      if (held || selfDeafened) return;
      held = true;
      clearRelease(); // re-pressed during the release tail → keep the mic open
      void room.localParticipant.setMicrophoneEnabled(true);
    };
    const end = () => {
      if (!held) return;
      held = false;
      // Keep the mic open for pttReleaseMs so the ends of words aren't clipped.
      const delay = Math.max(0, getAudioSettings().pttReleaseMs);
      clearRelease();
      releaseTimer = setTimeout(() => {
        releaseTimer = null;
        if (!held) void room.localParticipant.setMicrophoneEnabled(false);
      }, delay);
    };
    const keyBinding = (): string | null => {
      const a = getAudioSettings();
      return a.pushToTalk && !a.pttKey.startsWith('Mouse') ? a.pttKey : null;
    };
    const mouseButton = (): number | null => {
      const a = getAudioSettings();
      if (!a.pushToTalk || !a.pttKey.startsWith('Mouse')) return null;
      const n = parseInt(a.pttKey.slice(5), 10);
      return Number.isNaN(n) ? null : n;
    };
    const downKey = (e: KeyboardEvent) => {
      if (e.code !== keyBinding()) return;
      const target = e.target as HTMLElement | null;
      if (target && /^(INPUT|TEXTAREA)$/.test(target.tagName)) return; // don't hijack typing
      start();
    };
    const upKey = (e: KeyboardEvent) => {
      if (e.code === keyBinding()) end();
    };
    const downMouse = (e: MouseEvent) => {
      if (e.button !== mouseButton()) return;
      if (e.button !== 0) e.preventDefault(); // suppress back/forward navigation while held
      start();
    };
    const upMouse = (e: MouseEvent) => {
      if (e.button === mouseButton()) end();
    };
    window.addEventListener('keydown', downKey, true);
    window.addEventListener('keyup', upKey, true);
    window.addEventListener('mousedown', downMouse, true);
    window.addEventListener('mouseup', upMouse, true);

    // Native GLOBAL mouse PTT (desktop): a low-level mouse hook in Rust fires even when GusVoice
    // isn't focused (the user is in a fullscreen game) — the window listeners above only fire when
    // focused. Tell Rust which button is bound (re-syncing on rebind) and route its press/release
    // through the same start/end. When focused both paths fire, but `held` makes the 2nd a no-op.
    const syncNative = () => {
      if (!isDesktop()) return;
      const b = mouseButton();
      setPttMouseButton(b == null ? -1 : b);
      // Keyboard PTT: hand the native hook the bound key's Windows VK (0 = none / mouse binding /
      // unmapped key). Lets a keyboard PTT key open/close the mic even when GusVoice isn't focused.
      const kb = keyBinding();
      setPttKey(kb ? (pttKeyVk(kb) ?? 0) : 0);
    };
    syncNative();
    const unsubNative = isDesktop() ? subscribeAudioSettings(syncNative) : null;
    const teardownNative = isDesktop() ? onNativePtt(start, end) : null;
    const teardownNativeKey = isDesktop() ? onNativeKeyPtt(start, end) : null;

    // WEB (no native global hook): if a held PTT key/button is released while another window is focused,
    // that keyup/mouseup never reaches us → the mic would stick open. Force-release PTT on blur. NOT on
    // desktop — there the native hooks see the release globally, and blur-releasing would kill PTT the
    // instant you tab into a game (the whole point of unfocused PTT).
    const onBlur = () => end();
    if (!isDesktop()) window.addEventListener('blur', onBlur);

    return () => {
      window.removeEventListener('keydown', downKey, true);
      window.removeEventListener('keyup', upKey, true);
      window.removeEventListener('mousedown', downMouse, true);
      window.removeEventListener('mouseup', upMouse, true);
      if (!isDesktop()) window.removeEventListener('blur', onBlur);
      unsubNative?.();
      teardownNative?.();
      teardownNativeKey?.();
      if (isDesktop()) {
        setPttMouseButton(-1); // stop the global hooks from firing PTT while out of voice
        setPttKey(0);
      }
    };
  }, [room, selfDeafened]);

  // Heartbeat the persisted voice session while connected so its timestamp reflects "last alive" — a
  // crash/restart within the grace window then auto-rejoins this exact channel on the next launch (#11).
  useEffect(() => {
    if (state !== 'connected') return;
    touchVoiceSession();
    const id = setInterval(touchVoiceSession, GRACE_MS / 3);
    return () => clearInterval(id);
  }, [state]);

  // Apply our self mute/deafen INTENT to the live room whenever it changes or we (re)connect. Deafen
  // forces the mic off (the mute pref is preserved, so un-deafen restores it); PTT owns the mic while
  // enabled, so we don't force it on then. Also publishes the deafen attribute (a client-only concept
  // LiveKit doesn't track) so peers can show the indicator. If the SFU refuses the publish — a moderator
  // server-muted us — revert to muted and toast.
  //
  // 🔴 **Смену РЕЖИМА тоже надо применить, иначе микрофон остаётся в состоянии от прошлого режима.**
  // Эффект читает `pushToTalk` вживую, но пересчитывается только по своим зависимостям — а режим в них
  // не входит, и переключение в настройках до микрофона не доезжало: выключили PTT — микрофон так и
  // остаётся закрытым (его закрыла клавиша), включили — так и остаётся открытым, то есть рация не
  // работает. Помогал только перезаход в канал, потому что он менял `state` (#104).
  //
  // ⚠️ Реагируем ИМЕННО на смену режима, а не на любое изменение настроек: `subscribeAudioSettings`
  // дёргается на каждый тик ползунка усиления, и дёргать на них `setMicrophoneEnabled` значило бы
  // трогать живой трек десятки раз за перетаскивание.
  useEffect(() => {
    if (state !== 'connected') return;
    const lp = room.localParticipant;
    void lp.setAttributes({ deafened: selfDeafened ? '1' : '' }).catch(() => {});
    const applyOpenMic = () => {
      const micOn = !selfMuted && !selfDeafened;
      lp.setMicrophoneEnabled(micOn).catch((e) => {
        if (micOn) {
          toastError(e, 'Микрофон недоступен — возможно, вас заглушил модератор');
          setSelfMuted(true);
        }
      });
    };
    let ptt = getAudioSettings().pushToTalk;
    if (!ptt) applyOpenMic(); // в режиме рации микрофоном распоряжается клавиша, а не мы
    return subscribeAudioSettings(() => {
      const next = getAudioSettings().pushToTalk;
      if (next === ptt) return;
      ptt = next;
      // Включили рацию — закрываем микрофон: дальше его открывает только клавиша. Клавишу в этот
      // момент никто не держит (человек в настройках), так что речь оборвать нечем.
      if (next) void lp.setMicrophoneEnabled(false).catch(() => {});
      else applyOpenMic();
    });
  }, [room, state, selfMuted, selfDeafened]);

  // Broadcast whether we're in push-to-talk mode. A PTT user's mic is off most of the time (open only
  // while the key is held) — that is NOT a "muted" state, so peers must NOT show the mute badge for it.
  // The muted computations below (and VoiceParticipants) read this attribute. Re-applies on toggle.
  useEffect(() => {
    if (state !== 'connected') return;
    const lp = room.localParticipant;
    const apply = () => void lp.setAttributes({ ptt: getAudioSettings().pushToTalk ? '1' : '' }).catch(() => {});
    apply();
    return subscribeAudioSettings(apply);
  }, [room, state]);

  // Single source of truth for remote audio levels. Apply each user's saved per-user volume
  // (localUserAudio) to every remote participant from here — the one place that's always mounted
  // while in voice — so a volume tweak takes effect from ANY view, not only where a voice tile
  // happens to be rendered. RoomAudioRenderer must NOT also set a non-deafened volume (its prop is
  // undefined unless deafened), or it would re-apply 100% to every track and clobber these gains.
  // Skipped while deafened (RoomAudioRenderer forces 0 then); on un-deafen this re-runs and restores.
  useEffect(() => {
    if (selfDeafened) return;
    const reapply = () => {
      for (const p of room.remoteParticipants.values()) applyUserAudio(p);
    };
    reapply();
    const unsub = subscribeUserAudio(reapply);
    room
      .on(RoomEvent.TrackSubscribed, reapply)
      .on(RoomEvent.TrackPublished, reapply)
      .on(RoomEvent.ParticipantConnected, reapply);
    return () => {
      unsub();
      room
        .off(RoomEvent.TrackSubscribed, reapply)
        .off(RoomEvent.TrackPublished, reapply)
        .off(RoomEvent.ParticipantConnected, reapply);
    };
  }, [room, selfDeafened]);

  // ЕДИНСТВЕННОЕ место, где звучит чужое стрим-аудио (#71).
  //
  // Раньше это правило жило в сцене голосового канала — и работало, только пока сцена на экране.
  // Стоило уйти читать текстовый канал (голос при этом остаётся), как сцена размонтировалась, а
  // `applyUserAudio` выше продолжал дёргаться на каждом TrackPublished и включал звук чужого
  // стрима на полную, хотя стрим никто не открывал. Здесь же — место, смонтированное всегда, пока
  // вы в голосе, ровно как для пользовательских громкостей выше.
  //
  // `clearWatchedStreams` при размонтировании сцены гарантирует дефолт: не смотрю — не слышу.
  useEffect(() => {
    const apply = () => {
      const { watchedStreams, mutedStreams, streamVolumes } = useStore.getState();
      for (const p of room.remoteParticipants.values()) {
        for (const pub of p.trackPublications.values()) {
          if (pub.source !== Track.Source.ScreenShareAudio) continue;
          // 🔴 На звук ЗАКРЫТОГО стрима не подписываемся вовсе. Раньше подписка была
          // автоматической, трек успевал заиграть — и только потом приходило событие, по которому
          // мы ставили громкость в ноль. Между этим слышался короткий всплеск чужого звука при
          // КАЖДОМ старте стрима (репорт с живого). Глушить после подписки поздно по определению:
          // громкость применяется к уже играющему треку. Заодно не тянем аудио, которое не слушаем.
          const watched = watchedStreams.some((w) => w === p.identity || ownerOf(w) === p.identity);
          const sub = pub as { setSubscribed?: (s: boolean) => void; isSubscribed?: boolean };
          if (typeof sub.setSubscribed === 'function' && sub.isSubscribed !== watched) {
            try {
              sub.setSubscribed(watched);
            } catch {
              /* подписка — best-effort, звук важнее падения дерева */
            }
          }
          // Открытый, но приглушённый стрим подписку СОХРАНЯЕТ: иначе снятие «мьюта» ждало бы
          // переподписку, и звук возвращался бы с заметной задержкой.
          if (!watched) continue;
          const t = pub.track as { setVolume?: (v: number) => void } | undefined;
          if (typeof t?.setVolume !== 'function') continue;
          const vol = streamAudioVolume(p.identity, watchedStreams, mutedStreams, (id) => streamVolumes[id] ?? 1);
          try {
            t.setVolume(vol);
          } catch {
            /* never crash the tree over a volume tweak */
          }
        }
      }
    };
    apply();
    // Подписка на стор целиком, без селектора: перебор десятка участников стоит гораздо меньше,
    // чем риск пропустить изменение из-за неточного селектора — а пропуск здесь слышен.
    const unsub = useStore.subscribe(apply);
    room
      .on(RoomEvent.TrackSubscribed, apply)
      .on(RoomEvent.TrackPublished, apply)
      .on(RoomEvent.TrackUnmuted, apply)
      .on(RoomEvent.ParticipantConnected, apply);
    return () => {
      unsub();
      room
        .off(RoomEvent.TrackSubscribed, apply)
        .off(RoomEvent.TrackPublished, apply)
        .off(RoomEvent.TrackUnmuted, apply)
        .off(RoomEvent.ParticipantConnected, apply);
    };
  }, [room]);

  // Apply the unified mic-processing chain (input gain → neural filter → noise gate) to the published
  // mic. The chain is only attached when the user changed something from the cheap defaults; input
  // gain + gate threshold update live in-chain, and only a change of "shape" (filter / needed)
  // rebuilds. Fail-safe: any error falls back to stopProcessor() → the raw mic, so the default voice
  // path can never regress.
  useEffect(() => {
    let appliedSig: string | null = null;
    const apply = async (pub: LocalTrackPublication) => {
      if (pub.source !== Track.Source.Microphone) return;
      const track = pub.audioTrack;
      if (!track) return;
      const s = getAudioSettings();
      appliedSig = micChainSignature(s);
      if (!micChainNeeded(s)) {
        await track.stopProcessor().catch(() => {}); // raw mic; no-op if none
        return;
      }
      try {
        await track.setProcessor(await createMicProcessor());
      } catch (e) {
        console.warn('[voice] mic chain failed; using raw mic:', e);
        await track.stopProcessor().catch(() => {});
      }
    };
    const reapply = () => {
      const pub = room.localParticipant.getTrackPublication(Track.Source.Microphone);
      if (pub) void apply(pub);
    };
    const onPublished = (pub: LocalTrackPublication) => void apply(pub);
    room.on(RoomEvent.LocalTrackPublished, onPublished);
    reapply();
    // Rebuild only when the chain's shape changes; live gain/gate updates are handled inside the chain.
    const unsub = subscribeAudioSettings((s) => {
      if (micChainSignature(s) !== appliedSig) reapply();
    });
    return () => {
      room.off(RoomEvent.LocalTrackPublished, onPublished);
      unsub();
    };
  }, [room]);

  // Apply audio-DEVICE + capture changes to the LIVE room without a rejoin. The Room snapshots the
  // saved devices/DSP at creation (the useMemo above); when the user picks a different mic/speakers/
  // camera in Settings while connected, switch the active devices in place. switchActiveDevice
  // re-acquires the active track with the new device AND re-applies our DSP processor chain (LiveKit
  // restarts the processor on the fresh track — verified in livekit-client), so the unified mic chain
  // survives the swap with no extra work here. The browser-DSP getUserMedia constraints (echo / AGC)
  // aren't device ids, so re-capture the mic via restartTrack for those (passing the full current
  // constraint set, incl. system noise-suppression, so none is dropped). noiseFilter (rnnoise/
  // deepfilter/gain/gate) is owned by the mic-chain effect above — left out here to avoid racing it.
  useEffect(() => {
    if (state !== 'connected') return;
    let prev = getAudioSettings();
    const unsub = subscribeAudioSettings((s) => {
      if (s.inputDeviceId !== prev.inputDeviceId) {
        void room.switchActiveDevice('audioinput', s.inputDeviceId || 'default').catch((e) =>
          console.warn('[voice] mic device switch failed:', e),
        );
      }
      if (s.outputDeviceId !== prev.outputDeviceId) {
        void room.switchActiveDevice('audiooutput', s.outputDeviceId || 'default').catch(() => {});
      }
      if (s.cameraDeviceId !== prev.cameraDeviceId) {
        void room.switchActiveDevice('videoinput', s.cameraDeviceId || 'default').catch(() => {});
      }
      // Browser-DSP toggles (echo cancellation / auto gain) — re-capture the mic to apply them. Skip
      // when the device also changed this tick: switchActiveDevice already re-captured with current settings.
      const dspChanged = s.echoCancellation !== prev.echoCancellation || s.autoGainControl !== prev.autoGainControl;
      if (dspChanged && s.inputDeviceId === prev.inputDeviceId) {
        const track = room.localParticipant.getTrackPublication(Track.Source.Microphone)?.audioTrack;
        if (track) {
          void track
            .restartTrack({
              echoCancellation: s.echoCancellation,
              autoGainControl: s.autoGainControl,
              noiseSuppression: s.noiseFilter === 'system',
              ...(s.inputDeviceId ? { deviceId: { exact: s.inputDeviceId } } : {}),
            })
            .catch((e) => console.warn('[voice] mic re-capture failed:', e));
        }
      }
      prev = s;
    });
    return unsub;
  }, [room, state]);

  // Push the live profile (display name / avatar) onto our LiveKit participant so the voice tiles —
  // ours AND every peer's view of us — refresh the instant the user saves, with no rejoin. The token
  // only snapshots name/metadata at join; canUpdateOwnMetadata (granted server-side) lets us override
  // it live. Preserve the metadata's `priority` flag (set from PRIORITY_SPEAKER at join) when we
  // rewrite avatarUrl, and only call the setters when something actually changed (avoids redundant
  // signaling on every reconnect).
  useEffect(() => {
    if (state !== 'connected') return;
    const lp = room.localParticipant;
    if (userDisplayName != null && lp.name !== userDisplayName) void lp.setName(userDisplayName).catch(() => {});
    let priority = false;
    try {
      priority = JSON.parse(lp.metadata || '{}').priority === true;
    } catch {
      /* metadata may be empty/non-JSON on a fresh participant */
    }
    const nextMeta = JSON.stringify({ avatarUrl: userAvatarUrl, priority });
    if (lp.metadata !== nextMeta) void lp.setMetadata(nextMeta).catch(() => {});
  }, [room, state, userDisplayName, userAvatarUrl]);

  // Mirror the joined channel's LIVE voice state (speaking / mute / deafen / screen-share) into the
  // store so the channel sidebar — which lives outside the RoomContext — reflects it instantly,
  // instead of waiting for the presence service's periodic reconcile.
  useEffect(() => {
    // Speaking ring — LOCAL audio-level VAD, the way TS6/Discord do it.
    //
    // We deliberately do NOT use LiveKit's `participant.isSpeaking` / ActiveSpeakersChanged: that flag
    // is computed by the SFU over a smoothed percentile window and pushed back over signaling, so even
    // your OWN ring lags your voice by a round-trip and blinks in word gaps (no server tuning fixes that
    // — it's architectural). Instead we measure each track's level locally with a Web-Audio analyser:
    //   • own ring  = level of our PUBLISHED mic track (post gain/filter/gate — exactly what friends hear),
    //   • each peer = level of their received audio.
    // Detection is instant on attack; we shape the release ourselves (hysteresis + hold).
    //
    // Level = TIME-DOMAIN RMS (signal energy, 0..1): near-zero when idle, clearly higher on speech.
    // (A frequency-bin average — LiveKit's calculateVolume — inflated idle noise via its hot dB window,
    // so the ring stuck "on"; a raw time-domain PEAK was too twitchy. RMS over the whole ~21ms window
    // is both quiet-at-idle and smooth.) Idle ≈ 0.002–0.01, speech ≈ 0.03–0.15. Tune via gvVad debug.
    // Calibrated from real captures (time-domain RMS): idle ≈ 0.005–0.006, speech spikes 0.04–0.2 with
    // between-syllable dips to ~0.005–0.009. OPEN sits well above idle; CLOSE stays above idle but low
    // enough to ride small dips; HOLD bridges longer word/sentence pauses without lingering at silence.
    const OPEN = 0.015; // cross this to START speaking
    const CLOSE = 0.01; // stay-speaking floor (hysteresis kills boundary chatter; still > idle 0.006)
    const HOLD = 500; // ms to keep the ring on after the level drops — bridges gaps between words
    const TICK = 50; // ms poll (20 Hz) — smooth and cheap; store only updates on actual change
    // Re-read each tick so `localStorage.gvVad='1'` takes effect live, without rejoining the call.
    const readDebug = () => {
      try {
        return localStorage.getItem('gvVad') === '1';
      } catch {
        return false;
      }
    };

    let ctx: AudioContext | null = null;
    const getCtx = () => {
      if (!ctx) ctx = new AudioContext();
      if (ctx.state === 'suspended') void ctx.resume().catch(() => {});
      return ctx;
    };

    type Mon = {
      track: MediaStreamTrack;
      analyser: AnalyserNode;
      src: MediaStreamAudioSourceNode;
      el: HTMLAudioElement | null; // remote-track keep-alive sink (see attach)
      buf: Uint8Array<ArrayBuffer>;
      lastAbove: number;
      open: boolean;
    };
    const mons = new Map<string, Mon>();

    const detach = (id: string) => {
      const m = mons.get(id);
      if (!m) return;
      try {
        m.src.disconnect();
        m.analyser.disconnect();
        if (m.el) {
          m.el.pause();
          m.el.srcObject = null;
        }
      } catch {
        /* node already torn down */
      }
      mons.delete(id);
    };

    const attach = (id: string, track: MediaStreamTrack | null, isLocal: boolean) => {
      if (!track) {
        detach(id);
        return;
      }
      const prev = mons.get(id);
      if (prev) {
        if (prev.track === track) return; // already monitoring this exact track
        detach(id);
      }
      try {
        const c = getCtx();
        const stream = new MediaStream([track]);
        // Some browsers starve a REMOTE WebRTC track that has no media-element sink, so its analyser
        // reads silence (peers' rings never lit). A muted <audio> sink keeps samples flowing. Local
        // getUserMedia tracks don't need it. (webAudioMix plays the audible copy; this one is silent.)
        let el: HTMLAudioElement | null = null;
        if (!isLocal) {
          el = new Audio();
          el.muted = true;
          el.autoplay = true;
          el.srcObject = stream;
          void el.play().catch(() => {});
        }
        const src = c.createMediaStreamSource(stream);
        const analyser = c.createAnalyser();
        analyser.fftSize = 1024; // ~21ms window @48kHz; we read its time-domain waveform for RMS
        src.connect(analyser);
        mons.set(id, {
          track,
          analyser,
          src,
          el,
          buf: new Uint8Array(analyser.fftSize),
          lastAbove: 0,
          open: false,
        });
      } catch (e) {
        console.warn('[voice] speaking-VAD analyser failed for', id, e);
      }
    };

    // (Re)point analysers at the current published/subscribed mic tracks.
    const sync = () => {
      const lp = room.localParticipant;
      const localTrack = lp.isMicrophoneEnabled
        ? (lp.getTrackPublication(Track.Source.Microphone)?.track?.mediaStreamTrack ?? null)
        : null;
      attach(lp.identity, localTrack, true);
      const keep = new Set<string>([lp.identity]);
      for (const p of room.remoteParticipants.values()) {
        keep.add(p.identity);
        const pub = p.getTrackPublication(Track.Source.Microphone);
        const t = pub?.isSubscribed && !pub.isMuted ? (pub.track?.mediaStreamTrack ?? null) : null;
        attach(p.identity, t, false);
      }
      for (const id of [...mons.keys()]) if (!keep.has(id)) detach(id);
    };

    // Time-domain RMS in 0..1 — actual signal energy over the window (byte 128 = silence midpoint).
    const levelOf = (m: Mon) => {
      m.analyser.getByteTimeDomainData(m.buf);
      let sum = 0;
      for (let i = 0; i < m.buf.length; i++) {
        const v = (m.buf[i] - 128) / 128;
        sum += v * v;
      }
      return Math.sqrt(sum / m.buf.length);
    };

    let prev: Record<string, LiveVoiceState> = {};
    const sameState = (a: LiveVoiceState, b: LiveVoiceState) =>
      a.speaking === b.speaking && a.muted === b.muted && a.deafened === b.deafened && a.screensharing === b.screensharing;
    const changed = (next: Record<string, LiveVoiceState>) => {
      const ak = Object.keys(prev);
      const bk = Object.keys(next);
      if (ak.length !== bk.length) return true;
      for (const k of bk) {
        const p = prev[k];
        if (!p || !sameState(p, next[k])) return true;
      }
      return false;
    };

    let dbgN = 0;
    const tick = () => {
      const now = Date.now();
      const DEBUG = readDebug();
      const next: Record<string, LiveVoiceState> = {};
      const dbg: Record<string, string> = {};
      for (const p of [room.localParticipant, ...room.remoteParticipants.values()]) {
        const micOn = p.isMicrophoneEnabled;
        let speaking = false;
        const m = mons.get(p.identity);
        if (micOn && m) {
          const lvl = levelOf(m);
          if (lvl >= (m.open ? CLOSE : OPEN)) {
            m.open = true;
            m.lastAbove = now;
          } else {
            m.open = false;
          }
          speaking = now - m.lastAbove < HOLD;
          if (DEBUG) dbg[p.name || p.identity] = `${lvl.toFixed(3)}${speaking ? ' ●' : ''}`;
        } else if (micOn) {
          // No analyser yet (e.g. analyser-init failed) — degrade gracefully to the server flag.
          speaking = p.isSpeaking;
          if (DEBUG) dbg[p.name || p.identity] = `no-analyser isSpeaking=${p.isSpeaking}`;
        }
        const deafened = p.attributes?.deafened === '1';
        next[p.identity] = {
          // The ring must NEVER light for a muted or deafened member. `micOn` already covers open-mic
          // self-mute (muted ⇒ !micOn), but deafen doesn't force the mic off in PTT mode (the mic stays
          // key-gated) and the `deafened` attribute can also arrive a tick before the track reports muted
          // — so gate on !deafened too, else a deafened member briefly/keys up with a green ring.
          speaking: speaking && micOn && !deafened,
          // PTT users are mic-off between key-presses — that's idle, not muted. Only flag muted for a
          // deliberate mic-off (open-mic self-mute). Server-mute is a separate presence signal.
          muted: !micOn && p.attributes?.ptt !== '1',
          deafened,
          screensharing: p.isScreenShareEnabled,
        };
      }
      // Нативный показ публикует спутник «<id>#screen» — без переноса флага значок показа пропадал,
      // стоило зайти в канал к показывающему (и вместе с ним пропадала цель для превью, #115).
      // Правило и разбор — в `streamAudioRules.ts`.
      creditScreenOwners(next);
      if (DEBUG && ++dbgN % 6 === 0) console.log('[gvVad]', ctx?.state, `open≥${OPEN}`, dbg);
      if (changed(next)) {
        prev = next;
        setLiveVoice(next);
      }
    };

    sync();
    tick();
    const timer = setInterval(tick, TICK);
    const onChange = () => sync();
    room
      .on(RoomEvent.TrackSubscribed, onChange)
      .on(RoomEvent.TrackUnsubscribed, onChange)
      .on(RoomEvent.TrackMuted, onChange)
      .on(RoomEvent.TrackUnmuted, onChange)
      .on(RoomEvent.LocalTrackPublished, onChange)
      .on(RoomEvent.LocalTrackUnpublished, onChange)
      .on(RoomEvent.ParticipantConnected, onChange)
      .on(RoomEvent.ParticipantDisconnected, onChange)
      .on(RoomEvent.ConnectionStateChanged, onChange);
    return () => {
      clearInterval(timer);
      room
        .off(RoomEvent.TrackSubscribed, onChange)
        .off(RoomEvent.TrackUnsubscribed, onChange)
        .off(RoomEvent.TrackMuted, onChange)
        .off(RoomEvent.TrackUnmuted, onChange)
        .off(RoomEvent.LocalTrackPublished, onChange)
        .off(RoomEvent.LocalTrackUnpublished, onChange)
        .off(RoomEvent.ParticipantConnected, onChange)
        .off(RoomEvent.ParticipantDisconnected, onChange)
        .off(RoomEvent.ConnectionStateChanged, onChange);
      for (const id of [...mons.keys()]) detach(id);
      ctx?.close().catch(() => {});
      setLiveVoice({});
    };
  }, [room, setLiveVoice]);

  void currentChannelId;

  // The in-voice UI (connection panel + screen-share/disconnect) now lives in the sidebar's VoicePanel,
  // above the SelfVoiceBar (Discord-style). This component just owns the Room + its RoomContext, which —
  // because MainLayout wraps the sidebar too — reaches that panel.
  return (
    <RoomContext.Provider value={room}>
      {/* Deafen forces all remote tracks to 0 here; otherwise volume is left undefined so this
          renderer never overrides the per-user gains applied in the effect above. */}
      <RoomAudioRenderer volume={selfDeafened ? 0 : undefined} />
      {/* Согласие на диагностику (#113) — спрашиваем ровно здесь: человек только что вошёл в
          голосовой канал, то есть в тот момент, когда польза от сбора очевидна и объяснима одной
          фразой. Вопрос задаётся один раз; «нет» окончательно. */}
      {askDiag && (
        <DiagConsentDialog
          onDecide={() => {
            setAskDiag(false);
            // Согласился уже ПОСЛЕ входа в канал — сбор при входе не стартовал, потому что ответа
            // ещё не было. Заводим сейчас, иначе разрешение подействовало бы только со следующего
            // захода, и человек решил бы, что кнопка ничего не делает.
            void startDiag(room);
          }}
        />
      )}
      {children}
    </RoomContext.Provider>
  );
}
