/**
 * Системные вставки Android → CSS-переменные `--gv-sat / --gv-sar / --gv-sab / --gv-sal` (08.10).
 *
 * WebView до ~M135 при edge-to-edge отдаёт в `env(safe-area-inset-*)` только вырез экрана: панель навигации
 * (три кнопки) и строка состояния туда не попадают, и нижняя панель вкладок уезжала под «назад / домой / недавние»
 * (S20+, WebView 111). Оболочка (`MainActivity.publishSafeArea`) считает вставки сама и отдаёт их сюда в CSS-пикселях:
 * на старте — мостом `GusVoiceNative.safeArea()`, потом при каждом изменении — вызовом `window.__gvSafeArea(…)`.
 * CSS берёт `max(env(safe-area-inset-*), var(--gv-sa*, 0px))`, поэтому на новом WebView отступ не удваивается.
 * В браузере и на десктопе моста нет — переменные не ставятся, остаётся чистый `env()`.
 */

export interface SafeArea {
  top: number;
  right: number;
  bottom: number;
  left: number;
}

const SIDES = ['top', 'right', 'bottom', 'left'] as const;
const VARS: Record<(typeof SIDES)[number], string> = { top: '--gv-sat', right: '--gv-sar', bottom: '--gv-sab', left: '--gv-sal' };

/** Разбор ответа оболочки: JSON-строка или уже объект. Чужое/битое/отрицательное → null (ничего не трогаем). */
export function parseSafeArea(raw: unknown): SafeArea | null {
  let v: unknown = raw;
  if (typeof raw === 'string') {
    if (!raw) return null;
    try { v = JSON.parse(raw); } catch { return null; }
  }
  if (!v || typeof v !== 'object') return null;
  const o = v as Record<string, unknown>;
  const out = {} as SafeArea;
  for (const s of SIDES) {
    const n = o[s];
    if (typeof n !== 'number' || !Number.isFinite(n) || n < 0) return null;
    out[s] = n;
  }
  return out;
}

/** Пары «переменная → значение» для `style.setProperty`. */
export function safeAreaVars(a: SafeArea): Array<[string, string]> {
  return SIDES.map(s => [VARS[s], `${Math.round(a[s] * 100) / 100}px`]);
}

function apply(raw: unknown): void {
  const a = parseSafeArea(raw);
  if (!a) return;
  const st = document.documentElement.style;
  for (const [k, val] of safeAreaVars(a)) st.setProperty(k, val);
}

/** Вызывать на старте клиента: сначала ставим приёмник для оболочки, потом забираем уже посчитанное значение. */
export function installNativeSafeArea(): void {
  const w = window as unknown as {
    GusVoiceNative?: { safeArea?: () => string };
    __gvSafeArea?: (v: unknown) => void;
  };
  const bridge = w.GusVoiceNative;
  if (!bridge || typeof bridge.safeArea !== 'function') return;
  w.__gvSafeArea = apply;
  try { apply(bridge.safeArea()); } catch { /* мост старой оболочки — остаётся env() */ }
}
