/**
 * Настройки всплывающей плашки «кто кого типнул» (десктоп). Живут в `localStorage` ГЛАВНОГО окна;
 * окну плашки нужное приезжает внутри каждого пуша состояния (см. `tipToast.ts`).
 *
 * 🔴 **Свои настройки, а не общие с ростером** (решение 05.09). Плашку и ростер держат
 * одновременно: ростер маленький в углу, плашка крупная по центру. Одна позиция и одна прозрачность
 * на двоих означали бы, что включить обе разом нельзя.
 *
 * ⚠️ Размер задаётся МНОЖИТЕЛЕМ, а не пикселями: окно плашки фиксированного размера, и человек
 * крутит «крупнее/мельче», а не подбирает ширину под самое длинное имя.
 */
export type ToastCorner = 'tl' | 'tr' | 'bl' | 'br' | 'tc' | 'c';

export interface ToastSettings {
  enabled: boolean;
  /** Показывать типы. */
  tips: boolean;
  /** Показывать щипки. */
  pokes: boolean;
  posMode: 'corner' | 'custom';
  corner: ToastCorner;
  marginX: number;
  marginY: number;
  customX: number;
  customY: number;
  /** 0.3..1 — прозрачность содержимого. */
  opacity: number;
  /** 0.7..2 — множитель размера плашки и шрифта. */
  scale: number;
  /** Показывать, только пока я в голосовом канале. */
  onlyInVoice: boolean;
}

export const TOAST_DEFAULTS: ToastSettings = {
  enabled: false,
  tips: true,
  pokes: true,
  posMode: 'corner',
  // Сверху по центру: плашку надо заметить, не отводя глаз от середины экрана, а углы в игре заняты
  // её собственным интерфейсом — миникартой, здоровьем, счётом.
  corner: 'tc',
  marginX: 24,
  marginY: 64,
  customX: 40,
  customY: 40,
  opacity: 0.95,
  scale: 1,
  onlyInVoice: true,
};

/**
 * Размер окна при множителе 1 (логические px). Окно фиксированное — на событие оно НЕ меняется.
 *
 * ⚠️ Ширина подобрана ЗАМЕРОМ на стенде, а не на глаз: при 460 боевая пара ников в 18 и 12 символов
 * («… типнул …») обрезалась многоточием с ОБЕИХ сторон. Высоты хватает на две строки и кнопку
 * «Готово» в режиме расстановки.
 */
export const TOAST_BASE_W = 560;
export const TOAST_BASE_H = 150;

const KEY = 'gv_toast_settings';
type Listener = (s: ToastSettings) => void;
const listeners = new Set<Listener>();

let cache: ToastSettings | null = null;

export function getToastSettings(): ToastSettings {
  if (cache) return cache;
  let loaded: ToastSettings;
  try {
    const raw = localStorage.getItem(KEY);
    loaded = raw ? { ...TOAST_DEFAULTS, ...JSON.parse(raw) } : { ...TOAST_DEFAULTS };
  } catch {
    loaded = { ...TOAST_DEFAULTS };
  }
  cache = loaded;
  return loaded;
}

export function setToastSettings(patch: Partial<ToastSettings>): ToastSettings {
  const next = { ...getToastSettings(), ...patch };
  cache = next;
  try {
    localStorage.setItem(KEY, JSON.stringify(next));
  } catch {
    /* ignore quota */
  }
  for (const l of listeners) l(next);
  return next;
}

export function onToastSettings(fn: Listener): () => void {
  listeners.add(fn);
  return () => listeners.delete(fn);
}
