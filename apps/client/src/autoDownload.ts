import { createContext, useContext, useSyncExternalStore } from 'react';
import {
  acceptAutoDownload,
  AUTO_DOWNLOAD_DEFAULTS,
  mediaKindOf,
  shouldAutoLoad,
  shouldAutoplay,
  type AutoDownloadSettings,
  type MediaKind,
  type MediaSource,
} from './autoDownloadRules';

/**
 * «Данные и память» (G32): где живут настройки автозагрузки и кто их читает. Правило — `autoDownloadRules.ts`.
 *
 * Хранение — на этом устройстве (`localStorage`, как у Telegram: автозагрузка — настройка устройства, не аккаунта), без
 * сервера и без изменений протокола. Хранилища нет (приватный режим, WebView без него) — заводские значения.
 */

const KEY = 'gv_autodl';

let cached: AutoDownloadSettings | null = null;
const listeners = new Set<() => void>();

export function getAutoDownload(): AutoDownloadSettings {
  if (cached) return cached;
  let raw: unknown = null;
  try {
    const s = localStorage.getItem(KEY);
    raw = s ? JSON.parse(s) : null;
  } catch {
    raw = null;
  }
  cached = acceptAutoDownload(raw);
  return cached;
}

export function setAutoDownload(next: AutoDownloadSettings): void {
  cached = acceptAutoDownload(next);
  try {
    localStorage.setItem(KEY, JSON.stringify(cached));
  } catch {
    /* место кончилось или хранилища нет — настройка живёт до перезагрузки */
  }
  for (const fn of listeners) fn();
}

export function resetAutoDownload(): void {
  try {
    localStorage.removeItem(KEY);
  } catch {
    /* нет хранилища */
  }
  cached = AUTO_DOWNLOAD_DEFAULTS;
  for (const fn of listeners) fn();
}

function subscribe(fn: () => void): () => void {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

export function useAutoDownload(): AutoDownloadSettings {
  return useSyncExternalStore(subscribe, getAutoDownload, getAutoDownload);
}

/** Браузер просит экономить трафик (`navigator.connection.saveData`, есть в Chromium и WebView Android). */
export function saveDataOn(): boolean {
  try {
    const c = (navigator as Navigator & { connection?: { saveData?: boolean } }).connection;
    return c?.saveData === true;
  } catch {
    return false;
  }
}

/**
 * Источник ленты для вложений внутри неё: `MessagePane` кладёт «ЛС / группа / канал», `AttachmentView` читает. Нет
 * провайдера (отложенные и прочие места) — `null`: правило грузит всё, как раньше.
 */
export const AutoDownloadSource = createContext<MediaSource | null>(null);

/**
 * Что человек уже открыл нажатием «Скачать» — до перезагрузки страницы. Лента виртуальная: строка, ушедшая за экран и
 * вернувшаяся, монтируется заново, и без этого списка скачанное фото снова стало бы заглушкой.
 */
const loadedByHand = new Set<string>();

export function markLoadedByHand(key: string): void {
  loadedByHand.add(key);
}

export function loadedByHandHas(key: string): boolean {
  return loadedByHand.has(key);
}

/** Решение для одного вложения ленты: грузить ли сразу и играть ли само. */
export function useAutoLoad(a: {
  contentType: string;
  size: number;
  asFile?: boolean;
  gif?: boolean;
  waveform?: number[] | null;
}): { kind: MediaKind; load: boolean; autoplay: boolean } {
  const s = useAutoDownload();
  const source = useContext(AutoDownloadSource);
  const kind = mediaKindOf(a);
  const save = saveDataOn();
  return { kind, load: shouldAutoLoad(kind, a.size, source, s, save), autoplay: shouldAutoplay(kind, s, save) };
}
