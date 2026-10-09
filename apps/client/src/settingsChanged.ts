/**
 * Маркер «изменено» (#153, дизайн round 9) — чистый счёт отличий от заводских настроек.
 *
 * **Повод.** Настроек стало много, и человек, пришедший в них после «у тебя работает, а у меня
 * нет», листает тридцать строк, пытаясь вспомнить, что он тут когда-то переключил. Точка у раздела
 * и счётчик «изменено 2 из 14» отвечают на этот вопрос за один взгляд.
 *
 * 🔴 **«Изменено» = отличается от заводского СЕЙЧАС, а не «человек это трогал».** Вернул значение
 * руками — точка гаснет, хотя настройку открывали. Так и задумано: маркер отвечает на вопрос «что у
 * меня не как у всех», а не ведёт журнал правок. Журнал потребовал бы хранить историю, а отвечал бы
 * на вопрос, которого никто не задаёт.
 *
 * ⚠️ **Заводское значение приходит снимком, а не константой из этого файла.** Умолчания зависят от
 * платформы (на телефоне шумодав по умолчанию другой) и от системных просьб (`prefers-reduced-motion`
 * гасит анимацию аватаров). Захардкодь их здесь — и на телефоне всё светилось бы «изменено» сразу
 * после установки.
 *
 * ⚠️ Перечень ручной, как и реестр поиска в `settingsNav.ts`: новая настройка сама сюда не попадёт.
 * Не дописал — она просто не считается, интерфейс от этого не ломается.
 */

import type { AudioSettings } from './audioSettings';
import { AUTO_DOWNLOAD_DEFAULTS, type AutoDownloadSettings } from './autoDownloadRules';
import type { CameraPreset } from './cameraSettings';
import type { CoinNotifyLevel } from './coinNotifyRules';
import type { CloseBehavior } from './desktopWindow';
import type { Hotkeys } from './hotkeys';
import type { OsNotifyLevel } from './notifyRules';
import type { OverlaySettings } from './overlaySettings';
import type { SoundSettings } from './sounds';
import type { StreamSettings } from './streamSettings';
import type { Theme } from './theme';
import type { ToastSettings } from './toastSettings';
import type { UiScale } from './uiPrefs';

/** Всё, что настройки умеют менять, одним снимком: живой — из хранилищ, заводской — из умолчаний. */
export interface SettingsSnapshot {
  audio: AudioSettings;
  camera: CameraPreset;
  hotkeys: Hotkeys;
  stream: StreamSettings;
  overlay: OverlaySettings;
  toast: ToastSettings;
  sounds: SoundSettings;
  theme: Theme;
  uiScale: UiScale;
  sidebarWidth: number;
  animatedAvatars: boolean;
  /** Оптимизированный режим (`liteMode.ts`). Необязательное: старые снимки в тестах его не знают. */
  liteMode?: boolean;
  linkPreviews: boolean;
  /** Отправка по Enter или Ctrl+Enter (`sendMode.ts`, G36). Необязательное: старые снимки в тестах его не знают. */
  sendMode?: 'enter' | 'ctrl-enter';
  /** Вид списка бесед: две или три строки (`dmListView.ts`, G34). Необязательное: старые снимки его не знают. */
  listLines?: 'two' | 'three';
  /** Подсказывать эмодзи при наборе (`emojiSuggest.ts`, G53). Необязательное: старые снимки в тестах его не знают. */
  emojiSuggest?: boolean;
  /** Свайп по чату (`chatSwipe.ts`, G42): `'auto'` — как у Telegram. Необязательное по той же причине. */
  chatSwipe?: string;
  /** Двойной клик по сообщению: реакция / ответ / ничего (`quickReaction.ts`, G45). Необязательное: старые снимки его не знают. */
  doubleClick?: 'react' | 'reply' | 'none';
  /** Быстрая реакция двойного клика (`quickReaction.ts`, G45). Необязательное: старые снимки его не знают. */
  quickReaction?: string;
  osNotify: OsNotifyLevel;
  coinNotify: CoinNotifyLevel;
  closeBehavior: CloseBehavior;
  /** null = папка не выбрана, спросим при первом скачивании. */
  downloadDir: string | null;
  /** «Данные и память» (`autoDownload.ts`, G32). Необязательное: старые снимки в тестах его не знают. */
  autoDownload?: AutoDownloadSettings;
}

/** Один сравниваемый пункт. Вернуть массив — значит «считать это одним решением» (см. положение). */
type Item = (s: SettingsSnapshot) => unknown;

/**
 * Что лежит в какой группе. Ключ — тот же id якоря `set-g-*`, что в `settingsNav.ts`.
 *
 * Групп с действиями и данными (профиль, почта, пароль, сессии, «где я гость», ссылки на
 * приложения) здесь нет намеренно: у почты нет заводского значения, с которым её сравнивать.
 */
export const GROUP_ITEMS: Record<string, Item[]> = {
  // Выбранное устройство — тоже отличие от «как решит система». Человек, у которого пропал звук,
  // первым делом должен увидеть, что микрофон здесь выбран руками.
  'set-g-devices': [
    (s) => s.audio.inputDeviceId,
    (s) => s.audio.outputDeviceId,
    (s) => s.audio.cameraDeviceId,
    (s) => s.camera,
  ],
  'set-g-mic': [(s) => s.audio.inputGain, (s) => s.audio.vadThreshold],
  'set-g-audio-proc': [(s) => s.audio.noiseFilter, (s) => s.audio.echoCancellation, (s) => s.audio.autoGainControl],
  'set-g-ptt': [(s) => s.audio.pushToTalk, (s) => s.audio.pttKey, (s) => s.audio.pttReleaseMs],
  'set-g-hotkeys': [
    (s) => s.hotkeys.mute,
    (s) => s.hotkeys.deafen,
    (s) => s.hotkeys.screenShare,
    (s) => s.hotkeys.overlayToggle,
    (s) => s.hotkeys.diagMark,
  ],
  'set-g-stream': [
    (s) => s.stream.resolution,
    (s) => s.stream.fps,
    (s) => s.stream.mode,
    (s) => s.stream.codec,
    (s) => s.stream.audio,
    (s) => s.stream.wgcWindow,
    (s) => s.stream.layers,
    (s) => s.stream.gpuPipeline !== false,
    (s) => s.stream.streamPreview,
    // «Максимальное качество» (06.10): отсутствие = выключено, как умолчание.
    (s) => s.stream.maxQuality === true,
  ],
  'set-g-stream-cursor': [(s) => s.stream.cursor !== false],
  'set-g-osn': [(s) => s.osNotify],
  'set-g-coin': [(s) => s.coinNotify],
  'set-g-poke-toast': [
    (s) => s.toast.enabled,
    (s) => s.toast.tips,
    (s) => s.toast.pokes,
    // Положение — ОДИН пункт из шести полей: человек двигает плашку одним решением, а не шесть раз.
    (s) => [s.toast.posMode, s.toast.corner, s.toast.marginX, s.toast.marginY, s.toast.customX, s.toast.customY],
    (s) => s.toast.opacity,
    (s) => s.toast.scale,
    (s) => s.toast.onlyInVoice,
  ],
  // Набор звучащих событий — тоже один пункт: выключенный «вход» и выключенный «выход» это не две
  // разные настройки в глазах человека, а одно решение «я убрал лишние звуки».
  'set-g-sounds': [(s) => s.sounds.enabled, (s) => s.sounds.volume, (s) => s.sounds.events],
  'set-g-theme': [(s) => s.theme],
  'set-g-scale': [(s) => s.uiScale],
  'set-g-sidebar': [(s) => s.sidebarWidth],
  'set-g-listview': [(s) => s.listLines ?? 'two'],
  'set-g-avatars': [(s) => s.animatedAvatars],
  'set-g-lite': [(s) => s.liteMode ?? false],
  'set-g-links': [(s) => s.linkPreviews],
  'set-g-send': [(s) => s.sendMode ?? 'enter'],
  'set-g-emoji': [(s) => s.emojiSuggest ?? true],
  // Режим и эмодзи — одна настройка в глазах человека («двойной клик ставит вот это»): одно решение.
  'set-g-swipe': [(s) => s.chatSwipe ?? 'auto'],
  'set-g-dblclick': [(s) => [s.doubleClick ?? 'react', s.quickReaction ?? '👍']],
  'set-g-overlay': [
    (s) => s.overlay.enabled,
    (s) => s.overlay.mode,
    (s) => s.overlay.apps,
    (s) => s.overlay.content,
    (s) => [
      s.overlay.posMode,
      s.overlay.corner,
      s.overlay.marginX,
      s.overlay.marginY,
      s.overlay.customX,
      s.overlay.customY,
    ],
    (s) => s.overlay.opacity,
    (s) => s.overlay.onlyInVoice,
  ],
  // Сетка «тип × источник» — одно решение «что качать само»; пределы — по пункту на ползунок (G32).
  'set-g-autodl': [
    (s) => {
      const a = s.autoDownload ?? AUTO_DOWNLOAD_DEFAULTS;
      return [a.photo, a.video, a.gif];
    },
    (s) => (s.autoDownload ?? AUTO_DOWNLOAD_DEFAULTS).photoLimitMb,
    (s) => (s.autoDownload ?? AUTO_DOWNLOAD_DEFAULTS).videoLimitMb,
  ],
  'set-g-autoplay': [
    (s) => (s.autoDownload ?? AUTO_DOWNLOAD_DEFAULTS).autoplayGif,
    (s) => (s.autoDownload ?? AUTO_DOWNLOAD_DEFAULTS).autoplayVideo,
    (s) => (s.autoDownload ?? AUTO_DOWNLOAD_DEFAULTS).autoplayRound,
  ],
  'set-g-close': [(s) => s.closeBehavior],
  'set-g-downloads': [(s) => s.downloadDir],
};

export interface GroupMark {
  changed: number;
  total: number;
}

/** id группы → сколько в ней настроек и сколько из них не заводские. */
export type SettingsMarks = Record<string, GroupMark>;

/**
 * Равны ли два значения настройки.
 *
 * ⚠️ Числа сравниваем с допуском: ползунок громкости отдаёт 0.6000000000000001 там, где завод —
 * ровно 0.6, и строгое равенство зажгло бы точку у настройки, которую человек вернул как было.
 */
export function sameValue(a: unknown, b: unknown): boolean {
  if (typeof a === 'number' && typeof b === 'number') return Math.abs(a - b) < 1e-6;
  if (Array.isArray(a) || Array.isArray(b)) {
    if (!Array.isArray(a) || !Array.isArray(b) || a.length !== b.length) return false;
    return a.every((v, i) => sameValue(v, b[i]));
  }
  if (a !== null && b !== null && typeof a === 'object' && typeof b === 'object') {
    const ao = a as Record<string, unknown>;
    const bo = b as Record<string, unknown>;
    // Ключи обоих: настройка, которой в заводском наборе нет вовсе, — тоже отличие.
    const keys = new Set([...Object.keys(ao), ...Object.keys(bo)]);
    for (const k of keys) if (!sameValue(ao[k], bo[k])) return false;
    return true;
  }
  return a === b;
}

/** Посчитать отличия живых настроек от заводских по всем группам. */
export function markChanged(now: SettingsSnapshot, factory: SettingsSnapshot): SettingsMarks {
  const marks: SettingsMarks = {};
  for (const [group, items] of Object.entries(GROUP_ITEMS)) {
    let changed = 0;
    for (const pick of items) if (!sameValue(pick(now), pick(factory))) changed += 1;
    marks[group] = { changed, total: items.length };
  }
  return marks;
}

/**
 * Итог по разделу.
 *
 * 🔴 Считаем по ВИДИМЫМ группам, которые передал вызывающий: в браузере нет ни оверлея, ни плашки,
 * ни папки загрузок — иначе счётчик обещал бы настройки, которых на этом устройстве не существует.
 */
export function sectionMark(marks: SettingsMarks, groups: { id: string }[]): GroupMark {
  let changed = 0;
  let total = 0;
  for (const g of groups) {
    const m = marks[g.id];
    if (!m) continue;
    changed += m.changed;
    total += m.total;
  }
  return { changed, total };
}

/** Одинаковы ли две сводки — чтобы не перерисовывать настройки на каждый клик впустую. */
export function sameMarks(a: SettingsMarks, b: SettingsMarks): boolean {
  const keys = new Set([...Object.keys(a), ...Object.keys(b)]);
  for (const k of keys) {
    const x = a[k];
    const y = b[k];
    if (!x || !y || x.changed !== y.changed || x.total !== y.total) return false;
  }
  return true;
}

/**
 * Отпечаток значений каждой группы — «что человек видел», когда погасил точку «изменено» (23.09).
 *
 * 🔴 Повод — просьба владельца: точки горели ВСЕГДА (у него 7 групп из 8), наведение их не гасило,
 * и отметка превратилась в фон, на который перестают смотреть. Теперь точка — «здесь есть изменения,
 * которые ты ещё не видел»: навёл — погасла, а поменялось значение в группе снова — отпечаток другой,
 * и точка загорается опять. Счётчик «изменено N из M» в шапке остаётся фактом и не гаснет.
 */
export function groupPrints(now: SettingsSnapshot): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [group, items] of Object.entries(GROUP_ITEMS)) out[group] = JSON.stringify(items.map((pick) => pick(now)));
  return out;
}

/** Гореть ли точке «изменено» у группы: отличия от завода есть, и такой их набор ещё не видели. */
export function changedDotOn(mark: GroupMark | undefined, seenPrint: string | undefined, nowPrint: string | undefined): boolean {
  return (mark?.changed ?? 0) > 0 && seenPrint !== nowPrint;
}

/** Одинаковы ли два набора отпечатков — чтобы не перерисовывать окно на каждый клик. */
export function samePrints(a: Record<string, string>, b: Record<string, string>): boolean {
  const keys = new Set([...Object.keys(a), ...Object.keys(b)]);
  for (const k of keys) if (a[k] !== b[k]) return false;
  return true;
}

/** «изменено 2 из 14» — подпись под заголовком раздела. Пусто, когда всё заводское. */
export function marksLabel(m: GroupMark): string | null {
  if (m.changed === 0 || m.total === 0) return null;
  return `изменено ${m.changed} из ${m.total}`;
}
