import { clearConvCacheMessages, convCacheUsage } from './convCache';

/**
 * «Данные и память» → «Использование памяти» (G32, FD-12, FA-09): сколько места этот клиент занимает на устройстве и
 * «Очистить кэш». Как у Telegram (`settings_local_storage.cpp`, Android `CacheControlActivity`): по категориям, где их можно
 * узнать, очистка не трогает вход, настройки и черновики.
 *
 * Что браузер даёт узнать:
 * - `navigator.storage.estimate()` — всё хранилище сайта; в Chromium ещё и `usageDetails` (IndexedDB, Cache Storage);
 * - кеш бесед (`convCache.ts`, IndexedDB `gv-conv`) — свой подсчёт по снимкам;
 * - Cache Storage — его этот клиент сам не заводит (сервис-воркера нет), но место показываем и чистим, если там что-то есть.
 * Картинки и видео ленты лежат в HTTP-кеше браузера: странице он не виден и не чистится, — в окне это сказано словами.
 * Своего медиакэша с метками времени нет, поэтому и «Хранить медиа: 3 дня / неделю / месяц / всегда» нет (решение владельца).
 */

export interface StorageUsage {
  /** Всего занято сайтом, байт (`estimate().usage`); браузер не умеет — `null`. */
  total: number | null;
  /** Сколько браузер готов дать, байт (`estimate().quota`). */
  quota: number | null;
  /** Из них IndexedDB (Chromium, `usageDetails.indexedDB`). */
  indexedDb: number | null;
  /** Cache Storage (`usageDetails.caches`). */
  caches: number | null;
  /** Кеш бесед: записей (по одной на аккаунт и сервер) и примерный объём, из него — ленты. */
  conv: { records: number; bytes: number; messageBytes: number } | null;
}

interface EstimateWithDetails {
  usage?: number;
  quota?: number;
  usageDetails?: { indexedDB?: number; caches?: number };
}

async function estimate(): Promise<EstimateWithDetails | null> {
  try {
    if (typeof navigator === 'undefined' || !navigator.storage?.estimate) return null;
    return (await navigator.storage.estimate()) as EstimateWithDetails;
  } catch {
    return null;
  }
}

const num = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? v : null);

export async function measureStorage(): Promise<StorageUsage> {
  const [e, conv] = await Promise.all([estimate(), convCacheUsage()]);
  return {
    total: num(e?.usage),
    quota: num(e?.quota),
    indexedDb: num(e?.usageDetails?.indexedDB),
    caches: num(e?.usageDetails?.caches),
    conv,
  };
}

/**
 * «Очистить кэш»: ленты из кеша бесед и всё из Cache Storage. Вход (`localStorage`), настройки, черновики, неотправленные и
 * список бесед остаются. `false` — что-то не стёрлось (база не открылась).
 */
export async function clearDeviceCache(): Promise<boolean> {
  const conv = await clearConvCacheMessages();
  let cachesOk = true;
  try {
    if (typeof caches !== 'undefined') {
      const names = await caches.keys();
      await Promise.all(names.map((n) => caches.delete(n)));
    }
  } catch {
    cachesOk = false;
  }
  return conv && cachesOk;
}
