/**
 * Качество чужого показа у ЗРИТЕЛЯ (#191, 23.09).
 *
 * 🔴 **Откуда взялось.** Зритель всегда получал верхний слой: комната собрана с `adaptiveStream: false`
 * (выключен осознанно — см. `VoiceChannelView.tsx`, превью-снимки), а `setVideoQuality` не звал никто.
 * Замер 20.09 на четырёх ядрах: один открытый показ в 2К — 19–20 % процессора и 4,5 Мбит/с постоянно,
 * даже когда наше окно лежит под игрой и картинку никто не видит.
 *
 * Здесь только правила и запомненный выбор. Применяет их к трекам `VoiceConnection` — то же место,
 * что громкость стримов: оно смонтировано всегда, пока человек в голосе, а сцена — нет.
 *
 * ⚠️ Слои есть не всегда: у показывающего их выключает настройка «слои» (старая видеокарта, падения —
 * `layersOff.ts`). Тогда просить нечего, и зритель видит это честно (`streamHasLayers`), а не жмёт
 * кнопку, от которой ничего не меняется.
 */

import { useSyncExternalStore } from 'react';

/** Что выбрал человек. `auto` — верхний слой, пока окно видно. */
export type StreamQualityPref = 'auto' | 'high' | 'medium' | 'low';
/** Какой слой просить у сервера. */
export type StreamLayer = 'high' | 'medium' | 'low';

export const STREAM_QUALITY_ORDER: readonly StreamQualityPref[] = ['auto', 'high', 'medium', 'low'];

export const STREAM_QUALITY_LABEL: Record<StreamQualityPref, string> = {
  auto: 'Авто',
  high: 'Высокое',
  medium: 'Среднее',
  low: 'Экономное',
};

/**
 * Подпись под пунктом, когда разрешение слоя неизвестно. Обычно под пунктом стоит разрешение слоя
 * (`layerChoices`), а эти слова остаются только для «Авто» и для показа без описания слоёв.
 */
export const STREAM_QUALITY_HINT: Record<StreamQualityPref, string> = {
  auto: 'лучшее, пока окно видно',
  high: 'как шлёт показывающий',
  medium: 'поменьше',
  low: 'экономит трафик и процессор',
};

/**
 * Какой слой просить.
 *
 * - Окно не видно (свёрнуто, вкладка скрыта, накрыто игрой) — нижний при ЛЮБОМ выборе: картинку
 *   никто не смотрит, а платить полным потоком — ровно жалоба #191. Звук показа — отдельный трек, его
 *   это не касается. Вернулось окно — вернулся выбор.
 * - Показ не открыт (превью-снимок раз в минуту) — нижний: снимку нужно 480 пикселей в ширину.
 * - Иначе — выбор человека, `auto` = верхний.
 */
export function wantedLayer(pref: StreamQualityPref, ctx: { windowHidden: boolean; watched: boolean }): StreamLayer {
  if (ctx.windowHidden || !ctx.watched) return 'low';
  return pref === 'auto' ? 'high' : pref;
}

/**
 * Есть ли у показа слои, между которыми можно выбирать.
 *
 * `simulcasted` — у H.264/VP8 с запасными потоками; у VP9 режим `L3T3` отдаёт пространственные слои
 * внутри одного потока, и их видно только по описанию трека (`layers`). Одного признака мало.
 */
export function streamHasLayers(pub: { simulcasted?: boolean; trackInfo?: { layers?: readonly unknown[] } } | undefined): boolean {
  if (!pub) return false;
  if (pub.simulcasted) return true;
  return (pub.trackInfo?.layers?.length ?? 0) > 1;
}

/** Слой из описания трека (`TrackInfo.layers`): только то, что нам нужно. */
export interface LayerInfo {
  width?: number;
  height?: number;
}

/** Пункт меню качества: какой выбор он ставит и какое разрешение за ним стоит («720p»). */
export interface LayerChoice {
  pref: StreamLayer;
  label: string;
}

/**
 * Какие слои РЕАЛЬНО есть у показа — пункты меню качества (#191, разбор 24.09).
 *
 * 🔴 Раньше меню показывало три пункта всегда, а у показа экрана в H.264 слоёв было ДВА: полный
 * (метка сервера MEDIUM) и половинный на 3 к/с (LOW). HIGH не было вовсе, и сервер отдавал на
 * «Среднее» тот же полный слой, что на «Высокое», — пункт ничего не менял. Теперь пункты строятся
 * из описания трека: верхний слой — «Высокое», нижний — «Экономное», третий между ними — «Среднее».
 *
 * ⚠️ Подпись — класс разрешения по короткой стороне («1440p»), а не «2560×1440»: сервер знает только
 * ОБЪЯВЛЕННЫЙ размер (по настройке показывающего), а реальный кадр часто меньше — ультраширокий
 * монитор даёт 2560×1068, окно 1920×1032. Точное число, которое приходит, меню пишет отдельной
 * строкой из статистики приёма.
 *
 * Слоёв меньше двух — выбирать не из чего, пустой список.
 */
export function layerChoices(info: { layers?: readonly LayerInfo[]; codecs?: readonly { layers?: readonly LayerInfo[] }[] } | undefined): LayerChoice[] {
  const raw = info?.layers?.length ? info.layers : (info?.codecs?.[0]?.layers ?? []);
  const shorts = [
    ...new Set(
      raw
        .map((l) => Math.min(l.width || l.height || 0, l.height || l.width || 0))
        .filter((v) => v > 0),
    ),
  ].sort((a, b) => b - a);
  if (shorts.length < 2) return [];
  const top = shorts[0];
  const bottom = shorts[shorts.length - 1];
  const out: LayerChoice[] = [{ pref: 'high', label: `${top}p` }];
  if (shorts.length >= 3) out.push({ pref: 'medium', label: `${shorts[1]}p` });
  out.push({ pref: 'low', label: `${bottom}p` });
  return out;
}

/**
 * Какой пункт отметить в меню, если сохранённого выбора у ЭТОГО показа нет.
 *
 * Выбор общий на все показы, а слои у показов разные: «Среднее», выбранное на показе с тремя
 * слоями, у показа с двумя слоями не существует. Сервер в этом случае отдаёт верхний слой (просьба
 * MEDIUM при слоях LOW+MEDIUM попадает в верхний), так что честная отметка — «Высокое».
 */
export function shownPref(pref: StreamQualityPref, choices: readonly LayerChoice[]): StreamQualityPref {
  if (pref === 'auto' || choices.length === 0) return 'auto';
  if (choices.some((c) => c.pref === pref)) return pref;
  return pref === 'medium' ? 'high' : 'auto';
}

/**
 * Состояние детектора «зрителя скинуло на слой ниже» (#191, 24.09).
 *
 * `key` — что мы просили у сервера (показ + слой): сменилась просьба — картинка обязана поменяться,
 * и это не падение. `best*` — лучший кадр с этой просьбы, `low` — сколько замеров подряд кадр
 * заметно меньше лучшего, `notifiedAt` — когда последний раз сказали человеку.
 */
export interface DropTracker {
  key: string;
  settleUntil: number;
  bestW: number;
  bestH: number;
  low: number;
  notifiedAt: number;
}

/** Сколько ждать после смены просьбы: сервер переключает слой по опорному кадру, это ~секунда. */
export const DROP_SETTLE_MS = 6_000;
/** Кадр меньше лучшего хотя бы на пятую часть. Соседние слои отличаются в 1,5–2 раза. */
export const DROP_RATIO = 0.8;
/** Столько замеров подряд (замер раз в 3 с) — не мигание, а падение. */
export const DROP_SAMPLES = 2;
/** Не чаще раза в две минуты на показ: плохая связь качает слой туда-сюда. */
export const DROP_COOLDOWN_MS = 120_000;

/**
 * Один замер детектора. `notify` — сказать человеку сейчас.
 *
 * 🔴 Сравнение с ЛУЧШИМ увиденным кадром, а не с объявленным размером слоя: объявленный размер —
 * настройка показывающего, реальный кадр часто меньше (ультраширокий монитор, окно). Сравнение с
 * объявленным кричало бы «вас скинуло» каждому зрителю такого показа.
 *
 * ⚠️ Смена ПРОПОРЦИЙ — не падение, а другой кадр у показывающего (растянул окно). Слой меняет
 * размер ровно в N раз по обеим сторонам, пропорции остаются. Поэтому при новых пропорциях лучший
 * кадр просто начинается заново.
 */
export function stepDrop(
  t: DropTracker | null,
  s: { key: string; w?: number; h?: number; now: number },
): { next: DropTracker; notify: boolean } {
  if (!t || t.key !== s.key) {
    return {
      next: { key: s.key, settleUntil: s.now + DROP_SETTLE_MS, bestW: 0, bestH: 0, low: 0, notifiedAt: t?.notifiedAt ?? -Infinity },
      notify: false,
    };
  }
  const { w, h } = s;
  if (!w || !h || s.now < t.settleUntil) return { next: t, notify: false };
  if (t.bestH === 0) return { next: { ...t, bestW: w, bestH: h, low: 0 }, notify: false };
  const aspect = w / h;
  const bestAspect = t.bestW / t.bestH;
  if (Math.abs(aspect - bestAspect) / bestAspect > 0.03) {
    return { next: { ...t, bestW: w, bestH: h, low: 0 }, notify: false };
  }
  if (h >= t.bestH) return { next: { ...t, bestW: w, bestH: h, low: 0 }, notify: false };
  if (h > t.bestH * DROP_RATIO) return { next: { ...t, low: 0 }, notify: false };
  const low = t.low + 1;
  const notify = low === DROP_SAMPLES && s.now - t.notifiedAt >= DROP_COOLDOWN_MS;
  return { next: { ...t, low, notifiedAt: notify ? s.now : t.notifiedAt }, notify };
}

/** Разрешение, которое реально приходит, — подписью в меню («сейчас 1280×720»). */
export function resolutionText(w: number | undefined, h: number | undefined): string | null {
  if (!w || !h) return null;
  return `${w}×${h}`;
}

const KEY = 'gv_stream_quality';
const listeners = new Set<() => void>();

function isPref(v: unknown): v is StreamQualityPref {
  return typeof v === 'string' && (STREAM_QUALITY_ORDER as readonly string[]).includes(v);
}

/** Запомненный выбор. Хранилище недоступно или испорчено — `auto`. */
export function getStreamQuality(): StreamQualityPref {
  try {
    const v = localStorage.getItem(KEY);
    return isPref(v) ? v : 'auto';
  } catch {
    return 'auto';
  }
}

export function setStreamQuality(pref: StreamQualityPref): void {
  try {
    localStorage.setItem(KEY, pref);
  } catch {
    /* не запомнили — выбор всё равно применится до перезагрузки */
  }
  current = pref;
  for (const fn of listeners) {
    try {
      fn();
    } catch {
      /* один слушатель не должен ронять остальных */
    }
  }
}

// ⚠️ Объявлено ПОСЛЕ `getStreamQuality` намеренно, но читается только из функций, которые зовут позже, —
// на загрузке модуля к нему не обращается никто, мёртвой зоны `let` нет (урок аварии 18.09).
let current: StreamQualityPref = getStreamQuality();

/** Подписаться на смену выбора. Возвращает отписку. */
export function onStreamQuality(fn: () => void): () => void {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

/** Текущий выбор для компонента — перерисовка по смене. */
export function useStreamQuality(): StreamQualityPref {
  return useSyncExternalStore(onStreamQuality, () => current);
}
