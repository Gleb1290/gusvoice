export type Theme = 'dark' | 'light';

const KEY = 'gv_theme';

/** Заводская тема. Живёт отдельной константой, чтобы настройки могли сказать «здесь изменено». */
export const THEME_DEFAULT: Theme = 'dark';

export function getTheme(): Theme {
  return localStorage.getItem(KEY) === 'light' ? 'light' : THEME_DEFAULT;
}

/** Reflect the theme on <html data-theme> so the :root[data-theme=light] token set applies. */
export function applyTheme(theme: Theme): void {
  const el = document.documentElement;
  if (theme === 'light') el.setAttribute('data-theme', 'light');
  else el.removeAttribute('data-theme');
}

export function setTheme(theme: Theme): void {
  try {
    localStorage.setItem(KEY, theme);
  } catch {
    /* ignore */
  }
  applyTheme(theme);
}
