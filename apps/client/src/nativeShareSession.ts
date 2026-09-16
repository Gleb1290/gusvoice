/**
 * Сборка сессии нативной трансляции для приложения: ядро из `nativeShareCore.ts` + настоящие
 * зависимости (стор, Tauri) + подписка на «источник исчез» с тостом и звуком.
 *
 * 🔴 **#96.** Раньше и флаг «идёт нативная трансляция», и teardown системного звука лежали в
 * `useState`/`useRef` внутри `VoiceControls`. А `VoiceControls` живёт в сайдбаре, который при
 * переходе в личные сообщения подменяется ЦЕЛИКОМ (`ChannelSidebar` → `DmSidebar` — разные
 * компоненты, значит React размонтирует поддерево). Cleanup эффекта, написанного как «сменился
 * канал», React зовёт и на размонтировании тоже — и трансляция обрывалась у всех зрителей ровно в
 * момент открытия ЛС.
 *
 * ⚠️ Гасит трансляцию ТОЛЬКО реальный уход из канала — эффект в `VoiceConnection`, который живёт
 * ровно столько же, сколько сам голос, и переживает любую навигацию по каналам и ЛС.
 *
 * ⚠️ Считающая часть переехала в `nativeShareCore.ts` (просьба Codex, 2026-08-01): этот файл тянет
 * стор и Tauri, поэтому в Node не грузится и проверить в нём ничего нельзя.
 */
import { createNativeShareSession } from './nativeShareCore';
import { layersOffPlan } from './layersOff';
import { setDiagSharing } from './diag';
import { gvScreenShareStop, onNativeShareEnded, onNativeShareHealed, onNativeShareLayersOff } from './nativeScreenShare';
import { getStreamSettings, setStreamSettings } from './streamSettings';
import { playSound } from './sounds';
import { useStore } from './store';
import { toast } from './toast';

const session = createNativeShareSession({
  stopCapture: gvScreenShareStop,
  getSharing: () => useStore.getState().nativeSharing,
  setSharing: (v) => useStore.getState().setNativeSharing(v),
});

/**
 * Второй слой качества выключен за человека (#112) — приводим настройку в соответствие и объясняем.
 *
 * 🔴 Подписка на УРОВНЕ МОДУЛЯ, а не по факту старта показа: событие прилетает из `start()` ещё до
 * того, как публикация поднялась, и подписка «когда пошёл показ» опоздала бы ровно всегда.
 *
 * ⚠️ Настройку правим ТОЛЬКО на постоянных причинах — старая карта и серия падений. Здесь раньше
 * стояло «правим по-настоящему всегда», и это оказалось той самой ошибкой: одно падение навсегда
 * лишало человека слоя, а расплачивался за это весь канал (#109). Что постоянно, а что нет —
 * решает `layersOffPlan`.
 */
onNativeShareLayersOff((reason) => {
  // Решение — в чистом `layersOff.ts` под тестами. Оно того стоит: это межъязыковой контракт со
  // строками из Rust, и Codex показал, что перестановка `crash` и `crash-final` там превращала
  // временный отказ в постоянный, не покраснив ни одного теста.
  const plan = layersOffPlan(reason);
  if (plan.persistOff) {
    const s = getStreamSettings();
    if (s.layers) setStreamSettings({ ...s, layers: false });
  }
  toast('warn', plan.title, plan.text);
});

/** Запомнить teardown, вернутый `startNativeStreamAudio` (или `null`, если звук не поднялся). */
export function setNativeAudioStop(fn: (() => Promise<void>) | null): void {
  session.setAudioStop(fn);
}

export function hasNativeAudio(): boolean {
  return session.hasAudio();
}

/** Погасить захват системного звука. Идемпотентно: повторный вызов ничего не делает. */
export function stopNativeAudio(): Promise<void> {
  return session.stopAudio();
}

export function isNativeSharing(): boolean {
  return session.isSharing();
}

/** Погасить нативную трансляцию целиком. */
export function stopNativeShare(): Promise<void> {
  setDiagSharing(null); // фаза показа закончилась; сам сбор идёт до выхода из голоса (#100)
  return session.stop();
}

/** То же, но молча и только если трансляция реально идёт — для teardown при уходе из канала. */
export function stopNativeShareIfActive(): Promise<void> {
  setDiagSharing(null);
  return session.stopIfActive();
}

/**
 * Подписка на «источник исчез» из Rust (#99). Ставится один раз и живёт до перезагрузки: событие
 * приходит только пока идёт нативная трансляция, а держать подписку в компоненте нельзя — ровно на
 * этом обжигались в #96 (сайдбар размонтируется при переходе в личные сообщения).
 */
let endedUnsub: (() => void) | null = null;

function watchSourceEnd(): void {
  if (endedUnsub) return;
  endedUnsub = onNativeShareEnded(() => {
    if (!session.isSharing()) return; // уже погашено обычным путём — второй раз не шумим
    setDiagSharing(null); // этот путь идёт мимо stopNativeShare — фазу закрываем тут
    void session.stop();
    playSound('streamStop', useStore.getState().voice?.channelId);
    toast('info', 'Показ экрана остановлен', 'Окно, которое вы показывали, закрылось.');
  });
}

/**
 * Подписка на «показ залип и пересобран сам» (#111). Приходит только показывающему.
 *
 * Тост здесь не для красоты: зрители в этот момент видят секундное моргание, и без объяснения
 * стример решит, что показ отвалился сам по себе, — и полезет перезапускать руками ровно то, что
 * уже починилось. Заодно это единственное место, где человек узнаёт, что лечение вообще было.
 */
let healedUnsub: (() => void) | null = null;

function watchHealed(): void {
  if (healedUnsub) return;
  healedUnsub = onNativeShareHealed(() => {
    if (!session.isSharing()) return;
    toast(
      'info',
      'Показ пересобран',
      'Картинка застряла на низкой частоте кадров — перезапустили показ сами, кадры вернулись.',
    );
  });
}

/** Отметить, что companion-участник поднялся и трансляция пошла. */
export function markNativeSharing(): void {
  session.markSharing();
  watchSourceEnd();
  watchHealed();
}
