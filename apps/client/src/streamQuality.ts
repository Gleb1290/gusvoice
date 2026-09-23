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
  low: 'Низкое',
};

export const STREAM_QUALITY_HINT: Record<StreamQualityPref, string> = {
  auto: 'лучшее, пока окно видно',
  high: 'как шлёт показывающий',
  medium: 'примерно вдвое меньше',
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
