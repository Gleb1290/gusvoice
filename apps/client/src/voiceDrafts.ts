/**
 * Черновик голосового (08.10, #211, G54; Telegram Desktop: запись в прослушивании переживает уход в другую беседу,
 * в списке — «Черновик: Голосовое сообщение»). Запись на паузе / в прослушивании, когда человек ушёл из беседы, не
 * выбрасывается, а лежит черновиком ленты: в памяти вкладки и в IndexedDB этого устройства (НЕ на сервере — файл записи
 * личный и большой). Вернулся в беседу — прослушивание восстановлено (без «Продолжить запись»: микрофон отпущен).
 * Отправил или выбросил — черновик уходит.
 *
 * Ключ — id ленты (`MessagePane.feedId`: беседа ЛС или канал). Список бесед читает `useVoiceDraftKeys`.
 */

import { useSyncExternalStore } from 'react';
import type { VoiceTrimRange } from './voiceTrim';

export interface VoiceDraft {
  file: File;
  durationMs: number;
  waveform: number[];
  /** «Прослушать один раз» было включено. */
  once: boolean;
  /** Ручки обрезки. */
  trim: VoiceTrimRange | null;
  /** Когда положен (ISO) — время строки в списке. */
  at: string;
}

const DB_NAME = 'gv-voice-drafts';
const STORE = 'drafts';

const memory = new Map<string, VoiceDraft>();
/** Ключи с черновиком (память + прочитанные из базы при старте) — снимок для `useSyncExternalStore`. */
let keys: ReadonlyMap<string, string> = new Map();
const listeners = new Set<() => void>();
let loaded = false;

function publish(next: Map<string, string>): void {
  keys = next;
  for (const l of listeners) l();
}

function openDb(): Promise<IDBDatabase | null> {
  if (typeof indexedDB === 'undefined') return Promise.resolve(null);
  return new Promise((resolve) => {
    try {
      const req = indexedDB.open(DB_NAME, 1);
      req.onupgradeneeded = () => {
        if (!req.result.objectStoreNames.contains(STORE)) req.result.createObjectStore(STORE);
      };
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => resolve(null);
      req.onblocked = () => resolve(null);
    } catch {
      resolve(null);
    }
  });
}

/** Одна операция над хранилищем; сбой базы (приватный режим, квота) — черновик живёт только в памяти. */
async function withStore<T>(mode: IDBTransactionMode, run: (s: IDBObjectStore) => IDBRequest<T>): Promise<T | null> {
  const db = await openDb();
  if (!db) return null;
  return new Promise((resolve) => {
    try {
      const tx = db.transaction(STORE, mode);
      const req = run(tx.objectStore(STORE));
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => resolve(null);
      tx.oncomplete = () => db.close();
      tx.onabort = () => db.close();
    } catch {
      db.close();
      resolve(null);
    }
  });
}

interface StoredDraft {
  blob: Blob;
  name: string;
  type: string;
  durationMs: number;
  waveform: number[];
  once: boolean;
  trim: VoiceTrimRange | null;
  at: string;
}

/** Ключи черновиков из базы — один раз за жизнь вкладки (список бесед показывает их и после перезагрузки). */
function ensureLoaded(): void {
  if (loaded) return;
  loaded = true;
  void withStore('readonly', (s) => s.getAll() as IDBRequest<StoredDraft[]>).then((rows) => {
    void withStore('readonly', (s) => s.getAllKeys()).then((ks) => {
      if (!rows || !ks) return;
      const next = new Map(keys);
      ks.forEach((k, i) => {
        if (typeof k === 'string' && !next.has(k)) next.set(k, rows[i]?.at ?? new Date().toISOString());
      });
      publish(next);
    });
  });
}

/** Положить черновик ленты (память сразу, база — в фоне). */
export function saveVoiceDraft(key: string, draft: VoiceDraft): void {
  memory.set(key, draft);
  publish(new Map(keys).set(key, draft.at));
  const row: StoredDraft = {
    blob: draft.file,
    name: draft.file.name,
    type: draft.file.type,
    durationMs: draft.durationMs,
    waveform: draft.waveform,
    once: draft.once,
    trim: draft.trim,
    at: draft.at,
  };
  void withStore('readwrite', (s) => s.put(row, key));
}

/** Черновик ленты: из памяти, иначе из базы (после перезагрузки). Нет — `null`. */
export async function loadVoiceDraft(key: string): Promise<VoiceDraft | null> {
  const mem = memory.get(key);
  if (mem) return mem;
  const row = (await withStore('readonly', (s) => s.get(key) as IDBRequest<StoredDraft | undefined>)) ?? null;
  if (!row || !(row.blob instanceof Blob)) return null;
  const draft: VoiceDraft = {
    file: new File([row.blob], row.name, { type: row.type }),
    durationMs: row.durationMs,
    waveform: row.waveform,
    once: !!row.once,
    trim: row.trim ?? null,
    at: row.at,
  };
  memory.set(key, draft);
  return draft;
}

/** Отправлен или выброшен — черновика больше нет. */
export function dropVoiceDraft(key: string): void {
  const had = memory.delete(key) || keys.has(key);
  if (had) {
    const next = new Map(keys);
    next.delete(key);
    publish(next);
  }
  void withStore('readwrite', (s) => s.delete(key));
}

function subscribe(l: () => void): () => void {
  ensureLoaded();
  listeners.add(l);
  return () => listeners.delete(l);
}

/** Ленты с черновиком голосового → время черновика (ISO). Для строки списка «Черновик: Голосовое сообщение». */
export function useVoiceDraftKeys(): ReadonlyMap<string, string> {
  return useSyncExternalStore(subscribe, () => keys, () => keys);
}
