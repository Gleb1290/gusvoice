import { useLocalParticipant, useRoomContext } from '@livekit/components-react';
import { markDiag, setDiagSharing } from '../diag';
import { Track } from 'livekit-client';
import { useEffect, useRef, useState } from 'react';
import { comboFromEvent, comboFromMouse, comboToKeyPacked, getHotkeys, isDesktop, isMobile, mouseButtonOf, subscribeHotkeys } from '../hotkeys';
import {
  nativeStreamAudioAvailable,
  onNativeKeyHotkey,
  onNativeMouseHotkey,
  setHotkeyKeys,
  setHotkeyMouseMask,
  startNativeStreamAudio,
} from '../nativeStreamAudio';
import { api } from '../api';
import { gvForegroundWindow, gvScreenShareStart, nativeScreenShareAvailable } from '../nativeScreenShare';
import {
  hasNativeAudio,
  markNativeSharing,
  setNativeAudioStop,
  stopNativeAudio,
  stopNativeShare,
} from '../nativeShareSession';
import { toggleOverlayEnabled } from '../overlaySettings';
import { playSound } from '../sounds';
import { useStore } from '../store';
import {
  bitrateFor,
  buildNativeShareConfig,
  captureOptions,
  getStreamSettings,
  publishOptions,
  RES_OPTIONS,
} from '../streamSettings';
import { toast, toastError } from '../toast';
import { toggleSelfDeafen, toggleSelfMute } from '../voiceSelf';
import { Icon } from './Icon';
import { ScreenShareDialog } from './ScreenShareDialog';
import { SoundboardPicker } from './SoundboardPicker';
import { StreamDebugPanel } from './StreamDebugPanel';

// Set once getDisplayMedia on this machine fails to start a system-audio source (common in WebView2 and
// with some audio drivers). Subsequent shares then skip audio so the screen share itself never fails.
// Module-level so it survives re-renders; resets on reload.
let screenAudioBroken = false;

/**
 * Mic / deafen / screen-share controls. Deafen mutes incoming audio (handled by the
 * RoomAudioRenderer volume in VoiceConnection) and also mutes the mic, restoring it
 * on un-deafen — Discord-style. The screen-share button carries a quality popover
 * (resolution / fps / codec) that applies the saved gv_stream prefs on publish.
 */
export function VoiceControls({ screenOnly = false, wide = false }: { screenOnly?: boolean; wide?: boolean }) {
  const { localParticipant, isScreenShareEnabled } = useLocalParticipant();
  const room = useRoomContext();
  const [shareDialogOpen, setShareDialogOpen] = useState(false);
  // Прямоугольник кнопки саундборда: панель раскрывается от него и сама выбирает сторону.
  const [sbAnchor, setSbAnchor] = useState<DOMRect | null>(null);
  // Stream debug numbers, opened from the green «live» indicator while sharing.
  const [debugOpen, setDebugOpen] = useState(false);
  // Native screen-share (Plan B): our own picker dialog + a companion participant publishing the
  // capture from Rust. `nativeSharing` tracks that companion (separate from the main participant's
  // isScreenShareEnabled, which stays false for the native path).
  // ⚠️ И флаг, и teardown системного звука живут ВНЕ компонента (`nativeShareSession.ts`): этот
  // компонент сидит в сайдбаре и размонтируется при переходе в ЛС, а трансляция — нет (#96).
  const nativeSharing = useStore((s) => s.nativeSharing);

  // Mic / deafen are GLOBAL intent (voiceSelf.ts → store, persisted); VoiceConnection's "apply self
  // voice" effect pushes the intent onto the live room (incl. the server-mute revert). So these toggles
  // just flip the intent — they work whether or not you're in voice, matching the always-visible bar.
  const selfMuted = useStore((s) => s.selfMuted);
  const selfDeafened = useStore((s) => s.selfDeafened);
  // Саундборд: канал, в котором сижу голосом, и позиция каталога — из общего снимка, без запроса.
  const voiceChannelId = useStore((s) => s.voice?.channelId);
  const sbEntry = useStore((s) => {
    const sid = s.bootstrap?.server.id;
    const eco = sid ? s.economy[sid] : undefined;
    return eco?.enabled ? eco.shop?.find((e) => e.item === 'soundboard') : undefined;
  });
  const toggleMic = toggleSelfMute;
  const toggleDeafen = toggleSelfDeafen;

  // Start the share with the user's saved quality (resolution / fps / codec / bitrate).
  async function startShare() {
    const s = getStreamSettings();
    const isCancel = (e: unknown) => {
      const n = (e as DOMException)?.name;
      return n === 'NotAllowedError' || n === 'AbortError'; // user dismissed the OS picker — not an error
    };
    const start = (audio: boolean) =>
      localParticipant.setScreenShareEnabled(true, captureOptions({ ...s, audio }), publishOptions({ ...s, audio }));

    // DESKTOP: share VIDEO ONLY (getDisplayMedia audio echoes our own voices and often won't start in
    // WebView2), and stream system audio NATIVELY — WASAPI capture that excludes GusVoice's voices.
    if (isDesktop() && s.audio && nativeStreamAudioAvailable()) {
      try {
        await start(false);
        playSound('stream', useStore.getState().voice?.channelId);
      } catch (e) {
        if (!isCancel(e)) toastError(e, 'Не удалось начать показ экрана');
        return;
      }
      try {
        setNativeAudioStop(await startNativeStreamAudio(room));
      } catch (e) {
        toast('info', 'Системный звук стрима не подключён', String((e as Error)?.message ?? e));
      }
      return;
    }

    // Skip audio if this machine has already proven it can't start an audio source (WebView2 / some drivers).
    const wantAudio = s.audio && !screenAudioBroken;
    try {
      await start(wantAudio);
      playSound('stream', useStore.getState().voice?.channelId);
      // Diagnose silent streams: audio was requested but the source returned no audio track. Chromium
      // captures audio only for a whole screen ("share system audio") or a browser tab — never a window.
      if (wantAudio && !localParticipant.getTrackPublication(Track.Source.ScreenShareAudio)) {
        toast(
          'info',
          'Звук стрима не захвачен',
          'Системный звук передаётся только при выборе «Весь экран» (отметьте «Поделиться звуком системы») или вкладки браузера. У отдельного окна приложения звука нет — выберите весь экран.',
        );
      }
    } catch (e) {
      if (isCancel(e)) return;
      // "Could not start audio source" (NotReadableError) and friends kill the WHOLE share. If we asked
      // for audio, retry video-only so the stream still starts, and remember it for next time.
      if (!wantAudio) {
        toastError(e, 'Не удалось начать показ экрана');
        return;
      }
      screenAudioBroken = true;
      try {
        await start(false);
        playSound('stream', useStore.getState().voice?.channelId);
        toast('info', 'Показ экрана без звука', 'Источник системного звука не запустился на этом устройстве — стрим идёт без него.');
      } catch (e2) {
        if (isCancel(e2)) return;
        if ((e2 as DOMException)?.name === 'InvalidStateError') {
          toast('error', 'Нажмите «Показать экран» ещё раз', 'Запустим без системного звука.');
          return;
        }
        toastError(e2, 'Не удалось начать показ экрана');
      }
    }
  }

  // Native path: mint a companion token, start the Rust capture/publish, and (optionally) the existing
  // WASAPI system-audio capture on the main participant. Called by the picker dialog's "Начать".
  async function startNativeShare({ sourceId, isWindow }: { sourceId: string; isWindow: boolean }) {
    const channelId = useStore.getState().voice?.channelId;
    if (!channelId) throw new Error('Вы не в голосовом канале');
    const s = getStreamSettings();
    const { url, token } = await api.voiceScreenToken(channelId);
    // Сборка конфига — чистая функция в `streamSettings.ts`: здесь её не доказать тестом, а ошибка
    // в проводе «настройка → Rust» молча вернула бы человеку выключенное им (см. её комментарий).
    await gvScreenShareStart(buildNativeShareConfig({ url, token, sourceId, isWindow, settings: s }));
    markNativeSharing();
    setShareDialogOpen(false);
    // Диагностика (#100) идёт БЕЗ спроса и с момента входа в голос (см. `VoiceConnection`): опция
    // «включите сбор» тут не работает — баг ломает Alt+Tab, и человек, у которого он воспроизводится,
    // до окна приложения может просто не дойти, ни чтобы включить заранее, ни чтобы отметить потом.
    // Здесь только помечаем начало ФАЗЫ показа и его настройки: без фоновых замеров «до» цифры
    // показа не с чем сравнивать, а без настроек качества их не с чем соотнести.
    {
      setDiagSharing({
        source: isWindow ? 'window' : 'screen',
        resolution: s.resolution,
        fps: s.fps,
        codec: s.codec,
        maxBitrate: bitrateFor(s),
        audio: s.audio,
        // 🔴 Состояние переключателей. Мы выпустили два и НЕ записывали, в каком они положении, —
        // из-за этого нельзя было ответить на прямой вопрос «помог ли фикс»: у человека пропала
        // беда, а сам ли он выключил или починилось, неизвестно. Уже спотыкались на этом с #100.
        wgcWindow: s.wgcWindow,
        layers: s.layers,
      });
    }
    // No explicit 'stream' cue here: the companion `#screen` is a SEPARATE participant, so its
    // ScreenShare track fires TrackPublished on our own client too, and VoiceConnection's onTrack
    // already plays the cue. Playing it here as well doubled the sound. (The web path keeps its
    // explicit cue — there the share is the main participant's own track = LocalTrackPublished,
    // which onTrack does not fire on.)
    if (s.audio && nativeStreamAudioAvailable()) {
      try {
        // Window share → capture ONLY that window's process-tree audio; full-screen → everything minus us.
        setNativeAudioStop(await startNativeStreamAudio(room, isWindow ? { sourceId } : undefined));
      } catch (e) {
        toast('info', 'Системный звук стрима не подключён', String((e as Error)?.message ?? e));
      }
    }
  }

  // CAMERA-AS-STREAM (picker's «Камеры» tab): publish a webcam / capture card as a regular STREAM.
  // The video goes on the MAIN participant with source ScreenShare — so viewers get the usual stream
  // card, and stopping rides the existing isScreenShareEnabled path (setScreenShareEnabled(false)
  // unpublishes ScreenShare + ScreenShareAudio by source and stops the tracks → camera released).
  // Audio (if enabled) = the DEVICE'S OWN audio input, matched by groupId (capture cards expose one) —
  // raw, no echo-cancel/NS/AGC; the native system-audio capture is deliberately NOT used here.
  async function startCameraShare({ deviceId }: { deviceId: string }) {
    const s = getStreamSettings();
    const dims = RES_OPTIONS.find((r) => r.value === s.resolution)!;
    const stream = await navigator.mediaDevices.getUserMedia({
      video: {
        deviceId: { exact: deviceId },
        width: { ideal: dims.width },
        height: { ideal: dims.height },
        frameRate: { ideal: s.fps },
      },
    });
    const video = stream.getVideoTracks()[0];
    if (!video) throw new Error('Камера не вернула видео');
    try {
      video.contentHint = s.mode; // 'detail' | 'motion' — same semantics as the screen paths
    } catch {
      /* contentHint unsupported — cosmetic */
    }
    await localParticipant.publishTrack(video, {
      ...publishOptions(s),
      source: Track.Source.ScreenShare,
      name: 'camera-stream',
    });
    // Local start cue (viewers get theirs via TrackPublished in VoiceConnection.onTrack).
    playSound('stream', useStore.getState().voice?.channelId);
    setShareDialogOpen(false);
    if (s.audio) {
      try {
        const devices = await navigator.mediaDevices.enumerateDevices();
        const cam = devices.find((d) => d.kind === 'videoinput' && d.deviceId === deviceId);
        const audioDev = cam?.groupId
          ? devices.find((d) => d.kind === 'audioinput' && d.groupId === cam.groupId)
          : undefined;
        if (audioDev) {
          const astream = await navigator.mediaDevices.getUserMedia({
            audio: {
              deviceId: { exact: audioDev.deviceId },
              echoCancellation: false,
              noiseSuppression: false,
              autoGainControl: false,
            },
          });
          const atrack = astream.getAudioTracks()[0];
          if (atrack) {
            await localParticipant.publishTrack(atrack, {
              source: Track.Source.ScreenShareAudio,
              name: 'camera-audio',
              dtx: false,
              red: false,
            });
          }
        }
      } catch {
        toast('info', 'Звук устройства не подключён', 'Стрим камеры идёт без звука');
      }
    }
  }

  async function toggleScreen() {
    if (nativeSharing) {
      await stopNativeShare();
      return;
    }
    if (isScreenShareEnabled) {
      await stopNativeAudio();
      await localParticipant.setScreenShareEnabled(false);
      return;
    }
    // Desktop with the native commands available → our own picker. Web → getDisplayMedia.
    if (nativeScreenShareAvailable()) {
      setShareDialogOpen(true);
      return;
    }
    await startShare();
  }

  // Mute/unmute the OUTGOING stream audio (the system sound you broadcast) without stopping the share —
  // separate from your mic. Both the web share (getDisplayMedia audio) and the desktop native WASAPI
  // capture publish it as ScreenShareAudio on our own participant, so one handle covers both paths.
  async function toggleStreamAudio() {
    const track = localParticipant.getTrackPublication(Track.Source.ScreenShareAudio)?.track;
    if (!track) return;
    if (track.isMuted) await track.unmute();
    else await track.mute();
  }

  // HOTKEY path (vs the toolbar button, which opens the picker): grab the window currently in FRONT
  // and stream it straight away — no picker. If GusVoice itself is focused (nothing else to stream) or
  // we can't resolve a foreground window, fall back to the picker. Toggling while already sharing stops.
  // Web has no native path → the picker (getDisplayMedia). The native keyboard hook fires while GusVoice
  // is UNFOCUSED (e.g. mid-game), so the foreground is the game — exactly what you want to stream.
  async function quickShareFocused() {
    if (nativeSharing) {
      await stopNativeShare();
      return;
    }
    if (isScreenShareEnabled) {
      await stopNativeAudio();
      await localParticipant.setScreenShareEnabled(false);
      return;
    }
    if (!nativeScreenShareAvailable()) {
      await startShare();
      return;
    }
    const fg = await gvForegroundWindow();
    if (!fg || fg.isSelf) {
      setShareDialogOpen(true); // GusVoice (or nothing) in front → let the user pick
      return;
    }
    try {
      await startNativeShare({ sourceId: fg.id, isWindow: true });
    } catch (e) {
      toast('info', 'Не удалось начать стрим окна', String((e as Error)?.message ?? e));
    }
  }

  // 🔴 #96: teardown нативной трансляции при уходе из канала переехал в `VoiceConnection`. Здесь его
  // держать НЕЛЬЗЯ: этот компонент размонтируется при переходе в ЛС (сайдбар подменяется целиком), а
  // React зовёт cleanup и на размонтировании — трансляция обрывалась у всех зрителей.

  // If the share ends some other way (the OS "stop sharing" bar, track error), tear down native audio too.
  useEffect(() => {
    if (!isScreenShareEnabled && hasNativeAudio()) void stopNativeAudio();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isScreenShareEnabled]);

  // NOTE: no "sharing your screen" indicator to hide — the native screen-share path captures via
  // libwebrtc (Rust), never getDisplayMedia, so WebView2 shows neither the picker plate nor the
  // indicator (and the old share-indicator hider, which could glitch Explorer, no longer runs).

  // Hotkeys (mute / deafen / screen-share). Both paths call the LATEST handlers via a ref.
  // Hotkeys use quickShareFocused (stream the focused window, no picker); the toolbar button keeps toggleScreen (picker).
  const actionsRef = useRef({ toggleMic, toggleDeafen, quickShareFocused });
  actionsRef.current = { toggleMic, toggleDeafen, quickShareFocused };
  // A single physical press can reach BOTH the focused window path and the unfocused native hook. Fire
  // each combo's action at most once per ~80ms so an overlap can't double-toggle. Keyed by combo so
  // pressing different hotkeys in quick succession never blocks one another.
  const lastFireRef = useRef<Record<string, number>>({});

  // FOCUSED path — window keydown/mousedown, fire only while GusVoice has focus. Runs on ALL platforms:
  // on desktop the native low-level hooks below cover the UNFOCUSED case, but the native KEYBOARD hook
  // does NOT fire while GusVoice itself is focused (#37), so THIS focused path is what makes keyboard
  // hotkeys work when the app is in front. Mouse stays native-only on desktop (skip mousedown there) so a
  // focused mouse press can't toggle twice; the dedup guard covers any residual overlap. Bindings read
  // fresh each press. NOTE: a hotkey key pressed while typing in a text field types the char (input guard
  // below) rather than firing — intentional, so bindings don't hijack chat.
  useEffect(() => {
    const dedupeFire = (combo: string, action: () => void) => {
      const now = performance.now();
      if (now - (lastFireRef.current[combo] ?? 0) < 80) return;
      lastFireRef.current[combo] = now;
      action();
    };
    // Map a combo (keyboard or mouse) to its action; preventDefault on a hit. Returns whether it fired.
    const fire = (combo: string | null, e: Event): boolean => {
      if (!combo) return false;
      const hk = getHotkeys();
      const action =
        combo === hk.mute ? actionsRef.current.toggleMic
        : combo === hk.deafen ? actionsRef.current.toggleDeafen
        : combo === hk.screenShare ? actionsRef.current.quickShareFocused
        : combo === hk.overlayToggle ? toggleOverlayEnabled
        // ⚠️ Метку нужно продублировать и ЗДЕСЬ. Нативный хук — не единственный путь: пока окно
        // GusVoice в фокусе, работает именно этот, оконный. Забыл — и хоткей молчал ровно тогда,
        // когда человек сидит в приложении и смотрит чужой показ.
        : combo === hk.diagMark ? markDiag
        : null;
      if (!action) return false;
      e.preventDefault();
      dedupeFire(combo, () => void action());
      return true;
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.repeat) return;
      // Don't fire while a dialog is open (the settings tab is where you re-bind these) or while typing.
      if (useStore.getState().settingsOpen) return;
      const el = e.target as HTMLElement | null;
      if (el && (/^(INPUT|TEXTAREA|SELECT)$/.test(el.tagName) || el.isContentEditable)) return;
      fire(comboFromEvent(e), e);
    };
    const onMouse = (e: MouseEvent) => {
      if (useStore.getState().settingsOpen) return; // don't fire while re-binding in settings
      fire(comboFromMouse(e), e); // preventDefault on a hit also suppresses back/forward nav of side buttons
    };
    window.addEventListener('keydown', onKey, true);
    if (!isDesktop()) window.addEventListener('mousedown', onMouse, true);
    return () => {
      window.removeEventListener('keydown', onKey, true);
      if (!isDesktop()) window.removeEventListener('mousedown', onMouse, true);
    };
  }, []);

  // DESKTOP (Tauri): hotkeys fire even when GusVoice is NOT focused (e.g. mid-game) via native
  // low-level hooks that OBSERVE input and pass it through — a bound key/button still works in every
  // other app. (Previously keyboard combos went through the global-shortcut plugin = Win32
  // RegisterHotKey, which EXCLUSIVELY grabs the key: bind Numpad `+` and it stopped typing everywhere,
  // #37.) Keyboard combos now ride the WH_KEYBOARD_LL hook (hotkey_key.rs), mouse-button combos the
  // WH_MOUSE_LL hook (the same one PTT uses). Both re-apply live on re-bind. NOTE: mute/deafen work
  // unfocused; starting a screen share may need focus (getDisplayMedia wants a user gesture).
  useEffect(() => {
    if (!isDesktop()) return;
    let cancelled = false;
    const dedupeFire = (combo: string, action: () => void) => {
      const now = performance.now();
      if (now - (lastFireRef.current[combo] ?? 0) < 80) return;
      lastFireRef.current[combo] = now;
      action();
    };
    const boundCombos = (): string[] => {
      const hk = getHotkeys();
      return [hk.mute, hk.deafen, hk.screenShare, hk.overlayToggle, hk.diagMark];
    };
    const actionFor = (combo: string): (() => void) | null => {
      const hk = getHotkeys();
      if (combo === hk.mute) return () => void actionsRef.current.toggleMic();
      if (combo === hk.deafen) return () => void actionsRef.current.toggleDeafen();
      if (combo === hk.screenShare) return () => void actionsRef.current.quickShareFocused();
      if (combo === hk.overlayToggle) return () => toggleOverlayEnabled();
      // Метка «сломалось» в отчёте показа. Работает поверх игры — в отличие от кнопки в окне, до
      // которой при отказавшем Alt+Tab не добраться. Вне показа markDiag сам ничего не делает.
      if (combo === hk.diagMark) return () => markDiag();
      return null;
    };
    // Native KEYBOARD hook: hand it the packed VK of each keyboard binding; route a reported press back
    // to its action by re-packing the current bindings (so live re-binds resolve correctly).
    const applyKeys = () => {
      const keys: number[] = [];
      for (const combo of boundCombos()) {
        const packed = comboToKeyPacked(combo);
        if (packed != null) keys.push(packed);
      }
      setHotkeyKeys(keys);
    };
    const onKeyDown = (packed: number) => {
      for (const combo of boundCombos()) {
        if (comboToKeyPacked(combo) === packed) {
          const fn = actionFor(combo);
          if (fn) dedupeFire(combo, fn);
          return;
        }
      }
    };
    // Native MOUSE hook: which buttons to watch + route a press to its action.
    const applyMouse = () => {
      let mask = 0;
      for (const combo of boundCombos()) {
        const b = mouseButtonOf(combo);
        if (b != null && b >= 0 && b < 32) mask |= 1 << b;
      }
      setHotkeyMouseMask(mask);
    };
    const onMouseDown = (button: number) => {
      const combo = `Mouse${button}`;
      const fn = actionFor(combo);
      if (fn) dedupeFire(combo, fn);
    };
    const apply = () => {
      if (cancelled) return;
      applyKeys();
      applyMouse();
    };
    const teardownNativeMouse = onNativeMouseHotkey(onMouseDown, () => {}); // toggles fire on press only
    const teardownNativeKey = onNativeKeyHotkey(onKeyDown);
    apply();
    const unsub = subscribeHotkeys(apply); // re-apply live on re-bind
    return () => {
      cancelled = true;
      unsub();
      teardownNativeMouse();
      teardownNativeKey();
      setHotkeyMouseMask(0); // stop the native hooks from firing while out of voice
      setHotkeyKeys([]);
    };
  }, []);

  // Icons follow the INTENDED state (store), never the transient live track flag (which reads false for a
  // beat while the room reconnects on a channel switch — the #5 flash).
  const micOff = selfMuted;
  // "Sharing" = web getDisplayMedia share OR an active native companion share.
  const sharing = isScreenShareEnabled || nativeSharing;
  // The outgoing stream-audio track (published as ScreenShareAudio on us). Present only when the share
  // carries system sound — its mute toggle appears next to the share button. `isMuted` stays reactive
  // because useLocalParticipant re-renders on the local participant's TrackMuted/TrackUnmuted events.
  const streamAudioPub = localParticipant.getTrackPublication(Track.Source.ScreenShareAudio);
  const streamAudioMuted = streamAudioPub?.isMuted ?? false;

  /**
   * Кнопка саундборда (#21) — ОДНО объявление на обе раскладки дока.
   *
   * 🔴 **Раньше она жила только в ветке «не показываю экран», и на время показа исчезала совсем**
   * (найдено 05.09). Ветка `wide && sharing` рисует свою группу — живой индикатор, глушение
   * звука стрима и большая кнопка «Завершить стрим», — и саундборда там просто не было. Стример
   * теряет кнопку ровно тогда, когда канал на него и смотрит.
   * ⚠️ Тот же класс ошибки, что весь этот день: правило посчитано в одном месте и не применено в
   * соседнем. Поэтому кнопка теперь ОДНА и подставляется в обе ветки, а не копируется.
   *
   * 🔴 Кнопки нет, пока не сидишь в голосе: стрелять некуда, и она вела бы в гарантированный отказ.
   * ⚠️ И нет, пока владелец не включил экономику ИЛИ снял позицию с продажи. Не ради тайны: без
   * монет у саундборда нет тормоза, ради которого он и ждал экономику.
   */
  const soundboardButton =
    sbEntry?.enabled && voiceChannelId ? (
      <span className="sb-wrap">
        {sbAnchor && (
          <SoundboardPicker channelId={voiceChannelId} anchor={sbAnchor} onClose={() => setSbAnchor(null)} />
        )}
        <button
          type="button"
          className={`ctl sb-btn-dock ${sbAnchor ? 'on' : ''}`}
          title="Саундборд"
          onMouseDown={(e) => e.stopPropagation()}
          onClick={(e) => {
            /**
             * 🔴 **Замер СНАЧАЛА, обновление состояния потом** (#127). Раньше здесь стояло
             * `setSbAnchor((v) => v ? null : e.currentTarget.getBoundingClientRect())` — и это
             * роняло весь интерфейс: React обнуляет `currentTarget` сразу после выхода из
             * обработчика, а обновляющую функцию зовёт ПОЗЖЕ, уже на отрисовке.
             * ⚠️ Падало «иногда» и оттого выглядело необъяснимо: если у фибера нет других
             * ожидающих обновлений, React считает новое состояние ЖАДНО — прямо внутри обработчика,
             * где событие ещё живо. Стоит рядом прилететь любому другому обновлению (сокет, чужой
             * ререндер дока) — жадный путь отключается, и обращение уходит в `null`.
             * ⇒ Правило: внутри обновляющей функции события НЕТ. Всё нужное снимаем заранее.
             */
            const rect = e.currentTarget.getBoundingClientRect();
            setSbAnchor((v) => (v ? null : rect));
          }}
        >
          {/* 🔴 НЕ «volume»: во время показа рядом стоит глушение звука стрима, и оно рисует ровно тот
              же динамик — две одинаковые иконки в соседних клетках. Замечено на стенде вместе с
              переносом «Завершить стрим» на свою строку. */}
          <Icon name="music" size={wide ? 18 : 20} />
        </button>
      </span>
    ) : null;

  return (
    <div className="voice-controls">
      {/* Mic/deafen live in the always-visible SelfVoiceBar; the in-call dock passes `screenOnly` to
          avoid a second copy of them (it keeps only the screen-share). Hotkeys are a separate effect. */}
      {!screenOnly && (
        <>
          <button
            type="button"
            className={`ctl ${micOff ? 'off' : ''}`}
            title={micOff ? 'Включить микрофон' : 'Выключить микрофон'}
            onClick={toggleMic}
          >
            <Icon name={micOff ? 'mic-off' : 'mic'} size={20} />
          </button>
          <button
            type="button"
            className={`ctl ${selfDeafened ? 'off' : ''}`}
            title={selfDeafened ? 'Включить звук' : 'Заглушить звук (деафен)'}
            onClick={toggleDeafen}
          >
            <Icon name={selfDeafened ? 'headphones-off' : 'headphones'} size={20} />
          </button>
        </>
      )}
      {/* Screen-share is desktop-only: Android WebView has no getDisplayMedia and the native
          capture path is Windows-only, so the button is hidden on the mobile build. */}
      {!isMobile() &&
        (wide && sharing ? (
          // Sidebar panel WHILE sharing: shrink the big toggle to a compact green "live" indicator
          // (icon only) + the mute button, and give the STOP action its own big, unmistakable button.
          <div className="ss-group wide sharing">
            <button
              type="button"
              className={`ss-live ${debugOpen ? 'on' : ''}`}
              title="Идёт показ экрана — нажми, чтобы посмотреть цифры"
              aria-label="Отладка стрима"
              aria-expanded={debugOpen}
              onClick={() => setDebugOpen((v) => !v)}
            >
              <Icon name="screen-share" size={18} />
            </button>
            {debugOpen && <StreamDebugPanel native={nativeSharing} onClose={() => setDebugOpen(false)} />}
            {streamAudioPub && (
              <button
                type="button"
                className={`ctl ss-mini ${streamAudioMuted ? 'off' : ''}`}
                title={streamAudioMuted ? 'Включить звук стрима' : 'Заглушить звук стрима'}
                onClick={toggleStreamAudio}
              >
                <Icon name={streamAudioMuted ? 'volume-off' : 'volume'} size={18} />
              </button>
            )}
            {/* Во время показа кнопка стоит рядом с глушением — до большой «Завершить стрим», чтобы
                случайный промах по краю не обрывал показ. */}
            {soundboardButton}
            <button type="button" className="ctl ss-btn ss-stop" title="Завершить показ экрана" onClick={toggleScreen}>
              <Icon name="close" size={16} />
              <span className="ss-label">Завершить стрим</span>
            </button>
          </div>
        ) : (
          <>
            <div className={`ss-group ${wide ? 'wide' : ''}`}>
              <button
                type="button"
                className={`ctl ss-btn ${sharing ? 'on' : ''}`}
                title={sharing ? 'Остановить показ экрана' : 'Показать экран'}
                onClick={toggleScreen}
              >
                <Icon name="screen-share" size={wide ? 18 : 20} />
                {wide && <span className="ss-label">{sharing ? 'Идёт показ экрана' : 'Показать экран'}</span>}
              </button>
              {soundboardButton}
            </div>
            {/* Mute the OUTGOING stream sound (compact dock, non-wide): only while a share with audio is live. */}
            {sharing && streamAudioPub && (
              <button
                type="button"
                className={`ctl ${streamAudioMuted ? 'off' : ''}`}
                title={streamAudioMuted ? 'Включить звук стрима' : 'Заглушить звук стрима'}
                onClick={toggleStreamAudio}
              >
                <Icon name={streamAudioMuted ? 'volume-off' : 'volume'} size={wide ? 18 : 20} />
              </button>
            )}
          </>
        ))}
      {shareDialogOpen && (
        <ScreenShareDialog
          onClose={() => setShareDialogOpen(false)}
          onStart={startNativeShare}
          onStartCamera={startCameraShare}
        />
      )}
    </div>
  );
}
