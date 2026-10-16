import { mapStaticPath, mapStaticSize, type MapStaticTheme } from '@gusvoice/shared';
import { api } from './api';

/**
 * Картинка карты для карточки геопозиции ЛС (14.10, признак сервера `yamap1`): просим у СВОЕГО сервера (`GET /api/maps/static`,
 * он проксирует Static API Яндекса), показываем через `blob:`-адрес. Условие бесплатного API — полученное не сохранять:
 * держим картинки ТОЛЬКО в памяти вкладки (небольшой перечень последних, при вытеснении `revokeObjectURL`), ни `localStorage`,
 * ни `IndexedDB`, ни кеш-хранилище приложения не трогаем. Сбой запоминаем на минуту, чтобы прокрутка ленты не долбила сервер.
 */

/** Размер картинки в показе, CSS-пиксели (карточка в пузыре); запрашивается вдвое больше, в пределах API. */
export const GEO_MAP_CSS_W = 280;
export const GEO_MAP_CSS_H = 160;

const KEEP = 60;
const FAIL_MS = 60_000;
const urls = new Map<string, string>();
const pending = new Map<string, Promise<string | null>>();
const failedUntil = new Map<string, number>();

/** Тема карты по теме приложения (`<html data-theme="light">` — светлая). */
export function mapThemeNow(): MapStaticTheme {
  return typeof document !== 'undefined' && document.documentElement.getAttribute('data-theme') === 'light' ? 'light' : 'dark';
}

/** Адрес картинки: из памяти или с сервера; `null` — карты не будет (сбой, отказ, лимит). */
export function loadMapImage(lat: number, lon: number, theme: MapStaticTheme): Promise<string | null> {
  const { w, h } = mapStaticSize(GEO_MAP_CSS_W, GEO_MAP_CSS_H);
  const path = mapStaticPath({ lat, lon, w, h, theme });
  const hit = urls.get(path);
  if (hit) {
    // Обновляем «свежесть»: перекладываем в конец порядка вставки.
    urls.delete(path);
    urls.set(path, hit);
    return Promise.resolve(hit);
  }
  if ((failedUntil.get(path) ?? 0) > Date.now()) return Promise.resolve(null);
  const wait = pending.get(path);
  if (wait) return wait;
  const job = api
    .mapStaticImage(path)
    .then((blob) => {
      const url = URL.createObjectURL(blob);
      urls.set(path, url);
      while (urls.size > KEEP) {
        const oldest = urls.keys().next().value as string;
        URL.revokeObjectURL(urls.get(oldest)!);
        urls.delete(oldest);
      }
      return url;
    })
    .catch(() => {
      failedUntil.set(path, Date.now() + FAIL_MS);
      return null;
    })
    .finally(() => {
      pending.delete(path);
    });
  pending.set(path, job);
  return job;
}
