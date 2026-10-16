import { useSyncExternalStore } from 'react';

/**
 * Видовая настройка сцены голосового канала (10.10): «Скрыть участников без видео» — как пункт
 * Discord «Show Non-Video Participants». Локально у пользователя (как `gv_stream_quality`), на сервер
 * не уходит; по умолчанию участники без видео показываются.
 */
const KEY = 'gv_stage_hide_novideo';
const listeners = new Set<() => void>();

/** Запомненный выбор. Хранилище недоступно или испорчено — `false` (показывать всех). */
export function getHideNoVideo(): boolean {
  try {
    return localStorage.getItem(KEY) === '1';
  } catch {
    return false;
  }
}

export function setHideNoVideo(hide: boolean): void {
  try {
    if (hide) localStorage.setItem(KEY, '1');
    else localStorage.removeItem(KEY);
  } catch {
    /* не запомнили — выбор всё равно действует до перезагрузки */
  }
  current = hide;
  for (const fn of listeners) {
    try {
      fn();
    } catch {
      /* один слушатель не должен ронять остальных */
    }
  }
}

// ⚠️ Объявлено ПОСЛЕ `getHideNoVideo` намеренно и читается только из функций, которые зовут позже:
// на загрузке модуля к нему не обращается никто, мёртвой зоны `let` нет (урок аварии 18.09).
let current: boolean = getHideNoVideo();

/** Подписаться на смену выбора. Возвращает отписку. */
export function onHideNoVideo(fn: () => void): () => void {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

/** Текущий выбор для компонента — перерисовка по смене. */
export function useHideNoVideo(): boolean {
  return useSyncExternalStore(onHideNoVideo, () => current);
}
