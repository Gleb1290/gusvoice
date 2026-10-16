import { useSyncExternalStore } from 'react';
import { parseStageLayout, type StageLayout } from './stageLayoutRules';
/**
 * Вид сцены (#221, 16.10): Авто / Сетка / Фокус / Сбоку / Говорящий. Хранится так же, как «Скрыть без видео»
 * (`stageViewPrefs.ts`; отдельным модулем — тот грузится в тестах без зависимостей, кроме React):
 * локально, один на человека и устройство, действует во всех голосовых каналах. Нет записи — «Авто».
 * Правила режимов — `stageLayoutRules.ts`; на телефоне сохранённый «Сетка/Сбоку» действует как «Авто»
 * (`effectiveStageLayout`), а сам выбор не переписывается — вернулся на ПК, режим прежний.
 */
const LAYOUT_KEY = 'gv_stage_layout';
const layoutListeners = new Set<() => void>();

export function getStageLayout(): StageLayout {
  try {
    return parseStageLayout(localStorage.getItem(LAYOUT_KEY));
  } catch {
    return 'auto';
  }
}

export function setStageLayout(layout: StageLayout): void {
  try {
    if (layout === 'auto') localStorage.removeItem(LAYOUT_KEY);
    else localStorage.setItem(LAYOUT_KEY, layout);
  } catch {
    /* не запомнили — выбор всё равно действует до перезагрузки */
  }
  currentLayout = layout;
  for (const fn of layoutListeners) {
    try {
      fn();
    } catch {
      /* один слушатель не должен ронять остальных */
    }
  }
}

// ⚠️ Объявлено после `getStageLayout` (как `current` в `stageViewPrefs.ts`), на загрузке модуля к нему никто не обращается.
let currentLayout: StageLayout = getStageLayout();

export function onStageLayout(fn: () => void): () => void {
  layoutListeners.add(fn);
  return () => layoutListeners.delete(fn);
}

/** Сохранённый вид сцены для компонента — перерисовка по смене (и в шапке, и на сцене). */
export function useStageLayout(): StageLayout {
  return useSyncExternalStore(onStageLayout, () => currentLayout);
}
