import { useLocalParticipant, useRoomContext } from '@livekit/components-react';
import { markDiag, setDiagSharing } from '../diag';
import { createLocalScreenTracks, Track, VideoPreset, type LocalTrack, type TrackPublishOptions } from 'livekit-client';
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
import {
  gvForegroundWindow,
  gvScreenShareStart,
  gvScreenSources,
  nativeScreenShareAvailable,
} from '../nativeScreenShare';
import {
  getNativeSource,
  hasNativeAudio,
  markNativeSharing,
  setNativeAudio,
  stopNativeAudio,
  stopNativeShare,
  switchNativeShare,
} from '../nativeShareSession';
import { sameNativeSource, type NativeSource } from '../nativeShareCore';
import { shareSwitchErrorText } from '../shareErrorText';
import type { CurrentShare } from '../screenShareDialogRules';
import { toggleOverlayEnabled } from '../overlaySettings';
import { playSound } from '../sounds';
import { useStore, voiceApiOf, voiceIsHere } from '../store';
import {
  bitrateFor,
  buildNativeShareConfig,
  getStreamSettings,
  publishOptions,
  RES_OPTIONS,
  webCaptureOptions,
  webScreenSettings,
  webShareLayers,
  type StreamSettings,
} from '../streamSettings';
import { toast, toastError } from '../toast';
import { toggleSelfDeafen, toggleSelfMute } from '../voiceSelf';
import { Icon } from './Icon';
import { ScreenShareDialog, type ShareSwitchTarget } from './ScreenShareDialog';
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
/**
 * Опции публикации показа ИЗ БРАУЗЕРА вместе со слоями качества (#191, 24.09): полный, средний на
 * полной частоте кадров и экономный. Без `webShareLayers` SDK давал показу ровно один запасной слой
 * (половина, 3 к/с), и зрителю выбирать было между полным и слайд-шоу. Лестница — в `streamSettings`.
 */
function shareOptions(s: StreamSettings): TrackPublishOptions {
  const layers = webShareLayers(s);
  if (!layers.length) return publishOptions(s);
  return {
    ...publishOptions(s),
    screenShareSimulcastLayers: layers.map((l) => new VideoPreset(l.width, l.height, l.maxBitrate, l.maxFramerate)),
  };
}

export function VoiceControls({ screenOnly = false, wide = false }: { screenOnly?: boolean; wide?: boolean }) {
  const { localParticipant, isScreenShareEnabled } = useLocalParticipant();
  const room = useRoomContext();
  const [shareDialogOpen, setShareDialogOpen] = useState(false);
  // Окно смены источника идущего показа (#237) — тот же `ScreenShareDialog` в режиме `switch`. `current` снимается
  // при открытии: пока окно открыто, источник меняется только им самим.
  const [switchDialog, setSwitchDialog] = useState<{ current: CurrentShare | null } | null>(null);
  // Смена идёт: вторая (хоткей поверх кнопки, дребезг) не должна гнаться с первой за один и тот же захват.
  const switchBusyRef = useRef(false);
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
  // Голос на ДРУГОМ инстансе (смотрим дом, 01.10) — саундборда нет: его цена и каталог из экономики открытого
  // сервера, а выстрел ушёл бы не в тот инстанс.
  const voiceChannelId = useStore((s) => (voiceIsHere(s.voice) ? s.voice?.channelId : undefined));
  const sbEntry = useStore((s) => {
    const sid = s.bootstrap?.server.id;
    const eco = sid ? s.economy[sid] : undefined;
    return eco?.enabled ? eco.shop?.find((e) => e.item === 'soundboard') : undefined;
  });
  const toggleMic = toggleSelfMute;
  const toggleDeafen = toggleSelfDeafen;

  // Start the share with the user's saved quality (resolution / fps / codec / bitrate).
  async function startShare() {
    // Показ экрана из браузера — H.264 даже при выбранном VP9 (06.10): SDK для VP9 ломает слои (`webScreenSettings`).
    const s = webScreenSettings(getStreamSettings());
    const isCancel = (e: unknown) => {
      const n = (e as DOMException)?.name;
      return n === 'NotAllowedError' || n === 'AbortError'; // user dismissed the OS picker — not an error
    };
    const start = (audio: boolean) =>
      // #237: и при старте `surfaceSwitching: 'include'` — Chrome даёт свою кнопку «Показывать эту вкладку вместо» (решение владельца Р5).
      localParticipant.setScreenShareEnabled(true, webCaptureOptions({ ...s, audio }), shareOptions({ ...s, audio }));

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
        setNativeAudio(await startNativeStreamAudio(room));
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
    // Токен показа — у инстанса ГОЛОСА: пока на экране другой, активный `api` ушёл бы туда с чужим id канала.
    const { url, token } = await voiceApiOf(useStore.getState().voice).voiceScreenToken(channelId);
    // Сборка конфига — чистая функция в `streamSettings.ts`: здесь её не доказать тестом, а ошибка
    // в проводе «настройка → Rust» молча вернула бы человеку выключенное им (см. её комментарий).
    await gvScreenShareStart(buildNativeShareConfig({ url, token, sourceId, isWindow, settings: s }));
    markNativeSharing({ sourceId, isWindow });
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
        // «Родное» — 0: битрейт по настоящему размеру источника считает Rust, он — в срезах (`enc.cfg`).
        maxBitrate: s.resolution === 'native' ? 0 : bitrateFor(s),
        audio: s.audio,
        // 🔴 Состояние переключателей. Мы выпустили два и НЕ записывали, в каком они положении, —
        // из-за этого нельзя было ответить на прямой вопрос «помог ли фикс»: у человека пропала
        // беда, а сам ли он выключил или починилось, неизвестно. Уже спотыкались на этом с #100.
        wgcWindow: s.wgcWindow,
        layers: s.layers,
        cursor: s.cursor !== false,
        // 06.10 (#207): режим и «Максимальное качество» — тоже переключатели, от которых зависит картинка.
        mode: s.mode,
        maxQuality: s.maxQuality === true,
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
        setNativeAudio(await startNativeStreamAudio(room, isWindow ? { sourceId } : undefined));
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
    const saved = getStreamSettings();
    // «Родное» у камеры — 1080p (06.10): «родного» размера у камеры нет, без пожелания она отдаёт 640×480.
    const s: StreamSettings = saved.resolution === 'native' ? { ...saved, resolution: '1080' } : saved;
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
      ...shareOptions(s),
      source: Track.Source.ScreenShare,
      name: 'camera-stream',
    });
    // Local start cue (viewers get theirs via TrackPublished in VoiceConnection.onTrack).
    playSound('stream', useStore.getState().voice?.channelId);
    setShareDialogOpen(false);
    if (s.audio) {
      try {
        const atrack = await openCameraAudio(deviceId);
        if (atrack) {
          await localParticipant.publishTrack(atrack, {
            source: Track.Source.ScreenShareAudio,
            name: 'camera-audio',
            dtx: false,
            red: false,
          });
        }
      } catch {
        toast('info', 'Звук устройства не подключён', 'Стрим камеры идёт без звука');
      }
    }
  }

  // Звук самого устройства камеры (тот же groupId; у капчур-карт он есть) — без эхоподавления/шумодава/АРУ.
  // Один код на старт показа камеры и на смену камеры (#237).
  async function openCameraAudio(deviceId: string): Promise<MediaStreamTrack | null> {
    const devices = await navigator.mediaDevices.enumerateDevices();
    const cam = devices.find((d) => d.kind === 'videoinput' && d.deviceId === deviceId);
    const audioDev = cam?.groupId ? devices.find((d) => d.kind === 'audioinput' && d.groupId === cam.groupId) : undefined;
    if (!audioDev) return null;
    const astream = await navigator.mediaDevices.getUserMedia({
      audio: {
        deviceId: { exact: audioDev.deviceId },
        echoCancellation: false,
        noiseSuppression: false,
        autoGainControl: false,
      },
    });
    return astream.getAudioTracks()[0] ?? null;
  }

  // ─── Смена окна/экрана/камеры на лету (#237) ───

  /** Идёт ли показ камеры (вкладка «Камеры»): публикация ScreenShare на основном участнике с именем `camera-stream`. */
  function isCameraShare(): boolean {
    return localParticipant.getTrackPublication(Track.Source.ScreenShare)?.trackName === 'camera-stream';
  }

  /**
   * Нативный показ: сменить окно/экран, не останавливая показ. Порядок (видео → звук), ошибки звука и
   * обновление «текущего источника» — в `nativeShareCore.switchTo`. Отказ видео бросается наружу: окно
   * смены остаётся открытым с текстом, показ идёт по-старому.
   * `label` — имя окна для тоста «Показываю: …» (хоткей «окно в фокусе»); без него — «Показ переключён».
   */
  async function switchNativeSource(target: NativeSource, label?: string): Promise<void> {
    if (switchBusyRef.current) throw new Error('смена уже идёт');
    switchBusyRef.current = true;
    try {
      const s = getStreamSettings();
      const wantAudio = s.audio && nativeStreamAudioAvailable();
      const r = await switchNativeShare(target, {
        wantAudio,
        startAudio: wantAudio
          ? async () => {
              setNativeAudio(await startNativeStreamAudio(room, target.isWindow ? { sourceId: target.sourceId } : undefined));
            }
          : null,
      });
      if (r.outcome === 'same') return;
      if (r.outcome === 'republished') {
        toast('info', label ? `Показываю: ${label}` : 'Показ переключён', 'Картинка у зрителей обновится через секунду');
      } else {
        toast('info', label ? `Показываю: ${label}` : 'Показ переключён');
      }
      if (r.audio === 'failed') {
        toast('info', 'Звук стрима не переключился', 'Показ идёт без звука');
      }
    } finally {
      switchBusyRef.current = false;
    }
  }

  /** Показ камеры: другая камера под тем же треком (`sid` у зрителей тот же), звук устройства — по той же развилке, что у браузера. */
  async function switchCamera({ deviceId }: { deviceId: string }): Promise<void> {
    const video = localParticipant.getTrackPublication(Track.Source.ScreenShare)?.videoTrack;
    if (!video) throw new Error('показ не идёт');
    const saved = getStreamSettings();
    const s: StreamSettings = saved.resolution === 'native' ? { ...saved, resolution: '1080' } : saved;
    const dims = RES_OPTIONS.find((r) => r.value === s.resolution)!;
    const stream = await navigator.mediaDevices.getUserMedia({
      video: {
        deviceId: { exact: deviceId },
        width: { ideal: dims.width },
        height: { ideal: dims.height },
        frameRate: { ideal: s.fps },
      },
    });
    const track = stream.getVideoTracks()[0];
    if (!track) throw new Error('Камера не вернула видео');
    try {
      track.contentHint = s.mode;
    } catch {
      /* contentHint unsupported — cosmetic */
    }
    try {
      // userProvidedTrack:false — SDK сам погасит СТАРУЮ камеру (иначе она осталась бы занятой).
      await video.replaceTrack(track, { userProvidedTrack: false });
    } catch (e) {
      track.stop();
      throw e;
    }
    try {
      const atrack = s.audio ? await openCameraAudio(deviceId) : null;
      const apub = localParticipant.getTrackPublication(Track.Source.ScreenShareAudio);
      if (atrack && apub?.audioTrack) {
        await apub.audioTrack.replaceTrack(atrack, { userProvidedTrack: false });
      } else if (atrack) {
        await localParticipant.publishTrack(atrack, { source: Track.Source.ScreenShareAudio, name: 'camera-audio', dtx: false, red: false });
      } else if (apub?.track) {
        await localParticipant.unpublishTrack(apub.track, true);
      }
    } catch {
      toast('info', 'Звук устройства не переключился', 'Стрим камеры идёт без звука');
    }
    toast('info', 'Камера переключена');
  }

  /**
   * Показ из браузера: новый выбор в окне браузера (жест пользователя — это нажатие кнопки) и
   * `replaceTrack` под тем же опубликованным треком: `sid` и подписки зрителей остаются.
   * 🔴 `userProvidedTrack: false` обязателен: по умолчанию SDK считает трек «пользовательским» и СТАРЫЙ
   * захват не гасит — в Chrome осталась бы вторая полоска «идёт показ», а новый не погас бы на «Завершить».
   * Обёртку `LocalTrack` из `createLocalScreenTracks` НЕ останавливаем: её `mediaStreamTrack` теперь у
   * опубликованного трека, `stop()` оборвал бы показ. Отмена выбора в окне браузера — тишина.
   */
  async function switchWebShare(): Promise<void> {
    const video = localParticipant.getTrackPublication(Track.Source.ScreenShare)?.videoTrack;
    if (!video || switchBusyRef.current) return;
    switchBusyRef.current = true;
    let fresh: LocalTrack[] = [];
    try {
      const s = webScreenSettings(getStreamSettings());
      const apub = localParticipant.getTrackPublication(Track.Source.ScreenShareAudio);
      // Звук через WASAPI (десктоп, `startShare` выше) идёт мимо браузерного захвата — его не трогаем.
      const nativeAudio = hasNativeAudio() || (isDesktop() && s.audio && nativeStreamAudioAvailable());
      const wantAudio = s.audio && !screenAudioBroken && !nativeAudio;
      try {
        fresh = await createLocalScreenTracks(webCaptureOptions({ ...s, audio: wantAudio }));
      } catch (e) {
        const n = (e as DOMException)?.name;
        if (n === 'NotAllowedError' || n === 'AbortError') return; // закрыли окно выбора — показ идёт как шёл
        toastError(e, 'Не удалось сменить окно или экран');
        return;
      }
      const nv = fresh.find((t) => t.kind === Track.Kind.Video);
      const na = fresh.find((t) => t.kind === Track.Kind.Audio);
      if (!nv) {
        fresh.forEach((t) => t.stop());
        toast('error', 'Не удалось сменить окно или экран', 'Браузер не вернул картинку');
        return;
      }
      try {
        await video.replaceTrack(nv.mediaStreamTrack, { userProvidedTrack: false });
      } catch (e) {
        fresh.forEach((t) => t.stop());
        toastError(e, 'Не удалось сменить окно или экран');
        return;
      }
      if (!nativeAudio) {
        try {
          if (na && apub?.audioTrack) {
            await apub.audioTrack.replaceTrack(na.mediaStreamTrack, { userProvidedTrack: false });
          } else if (na) {
            await localParticipant.publishTrack(na, { source: Track.Source.ScreenShareAudio, dtx: false, red: false });
          } else if (apub?.track) {
            await localParticipant.unpublishTrack(apub.track, true);
          }
        } catch {
          toast('info', 'Звук стрима не переключился', 'Показ идёт без звука');
        }
        if (wantAudio && !na) {
          toast(
            'info',
            'Звук стрима не захвачен',
            'Системный звук передаётся только при выборе «Весь экран» (отметьте «Поделиться звуком системы») или вкладки браузера. У отдельного окна приложения звука нет.',
          );
        }
      }
      toast('info', 'Показ переключён');
    } finally {
      switchBusyRef.current = false;
    }
  }

  /** Кнопка «Сменить окно или экран»: нативный показ и камера — окно выбора в режиме смены, браузер — свой выбор браузера. */
  async function openSwitch() {
    if (nativeSharing) {
      setSwitchDialog({ current: getNativeSource() });
      return;
    }
    if (isCameraShare()) {
      const dev = localParticipant.getTrackPublication(Track.Source.ScreenShare)?.videoTrack?.mediaStreamTrack.getSettings().deviceId;
      setSwitchDialog({ current: dev ? { deviceId: dev } : null });
      return;
    }
    await switchWebShare();
  }

  async function onSwitchTarget(target: ShareSwitchTarget): Promise<void> {
    if ('deviceId' in target) await switchCamera(target);
    else await switchNativeSource(target);
    setSwitchDialog(null);
  }

  /**
   * Хоткей «Показывать окно в фокусе» (#237, решение владельца 27.10): ВО ВРЕМЯ нативного показа переключает
   * источник на окно переднего плана, не отрывая от игры. Вне показа — ничего, только тост «Сначала начните
   * показ»: запуск показа окна в фокусе уже делает хоткей «Демонстрация экрана», второй запускающий хоткей
   * путал бы (а у Discord/OBS «сменить сцену» вне эфира ничего не включает). Окно GusVoice (и оверлей — тот же
   * процесс), рабочий стол и панель задач в источник не берутся.
   */
  async function showFocusedWindow() {
    if (!nativeSharing) {
      if (isScreenShareEnabled && isCameraShare()) {
        toast('info', 'Показ камеры', 'Сменить камеру на окно в фокусе нельзя — завершите показ и начните заново');
      } else {
        toast('info', 'Сначала начните показ');
      }
      return;
    }
    const fg = await gvForegroundWindow();
    if (!fg || fg.isSelf) {
      toast('info', 'Показ не изменён', 'В фокусе окно GusVoice — переключитесь на то окно, которое хотите показать');
      return;
    }
    if (fg.isShell) {
      toast('info', 'Это окно не показать', 'Рабочий стол и панель задач в показ не берутся');
      return;
    }
    if (sameNativeSource(getNativeSource(), { sourceId: fg.id, isWindow: true })) {
      toast('info', 'Это окно уже показывается');
      return;
    }
    // Имя окна и проверка, что оно вообще снимается: рабочий стол и панель задач живут в explorer.exe и
    // в список окон не попадают. Список (с превью) дорог — зовём только когда оболочка не отдала заголовок
    // или это explorer.exe.
    let title = fg.title?.trim() || '';
    if (!title || fg.exe === 'explorer.exe') {
      const list = await gvScreenSources().catch(() => []);
      const w = list.find((x) => x.kind === 'window' && x.id === fg.id);
      if (w) title = w.title;
      else if (fg.exe === 'explorer.exe') {
        toast('info', 'Это окно не показать', 'Рабочий стол и панель задач в показ не берутся');
        return;
      }
    }
    if (!title) title = fg.exe.replace(/\.exe$/i, '') || 'окно';
    try {
      await switchNativeSource({ sourceId: fg.id, isWindow: true }, title);
    } catch (e) {
      toast('error', 'Не удалось сменить окно', shareSwitchErrorText(e));
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
  const actionsRef = useRef({ toggleMic, toggleDeafen, quickShareFocused, showFocusedWindow });
  actionsRef.current = { toggleMic, toggleDeafen, quickShareFocused, showFocusedWindow };
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
        : hk.focusShare && combo === hk.focusShare ? actionsRef.current.showFocusedWindow
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
      return [hk.mute, hk.deafen, hk.screenShare, hk.overlayToggle, hk.diagMark, hk.focusShare ?? ''];
    };
    const actionFor = (combo: string): (() => void) | null => {
      const hk = getHotkeys();
      if (combo === hk.mute) return () => void actionsRef.current.toggleMic();
      if (combo === hk.deafen) return () => void actionsRef.current.toggleDeafen();
      if (combo === hk.screenShare) return () => void actionsRef.current.quickShareFocused();
      if (hk.focusShare && combo === hk.focusShare) return () => void actionsRef.current.showFocusedWindow();
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
  /**
   * Кнопка «Сменить окно или экран» (#237) — ОДНО объявление на обе раскладки дока (тот же урок, что у
   * саундборда). Стоит между глушением звука и саундбордом, НЕ рядом с «Завершить стрим»: промах по краю не
   * должен обрывать показ. Иконка `repeat` (`screen-share` занят индикатором). Рисуется только во время показа.
   */
  const switchButton = sharing ? (
    <button
      type="button"
      className="ctl ss-mini ss-switch"
      title="Сменить окно или экран"
      aria-label="Сменить окно или экран"
      onClick={() => void openSwitch()}
    >
      <Icon name="repeat" size={wide ? 18 : 20} />
    </button>
  ) : null;

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
            {switchButton}
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
            {switchButton}
          </>
        ))}
      {shareDialogOpen && (
        <ScreenShareDialog
          onClose={() => setShareDialogOpen(false)}
          onStart={startNativeShare}
          onStartCamera={startCameraShare}
        />
      )}
      {switchDialog && (
        <ScreenShareDialog
          mode="switch"
          current={switchDialog.current}
          onClose={() => setSwitchDialog(null)}
          onStart={startNativeShare}
          onStartCamera={startCameraShare}
          onSwitch={onSwitchTarget}
        />
      )}
    </div>
  );
}
