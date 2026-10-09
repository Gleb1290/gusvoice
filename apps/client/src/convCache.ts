import { acceptRecord, convCacheInstancePart, shouldOverwrite, withoutMessages, type ConvCacheRecord } from './convCacheRules';

/**
 * ЛС, этап 2 (шаг 2б): хранилище кеша бесед — IndexedDB (`docs/dm/STAGE2.md`). Правила — `convCacheRules.ts`.
 *
 * ⚠️ Кеш — удобство, а не опора: нет IndexedDB (смоук `check-client-boot` в happy-dom, приватный режим, сбой WebView),
 * открытие зависло, место кончилось — всё молча превращается в «кеша нет», и клиент работает как без него. Поэтому
 * каждый вход здесь ловит ошибки сам и никогда не бросает наружу.
 */

const DB_NAME = 'gv-conv';
const STORE = 'records';
/** Открытие базы дольше этого — считаем, что кеша нет (WebView бывает, что не отвечает на `open` вовсе). */
const OPEN_TIMEOUT_MS = 1500;

let dbPromise: Promise<IDBDatabase | null> | null = null;

/** IndexedDB в этой среде нет вовсе — значит, и записи нет: стирать нечего. */
function noIndexedDb(): boolean {
  try {
    return typeof indexedDB === 'undefined' || !indexedDB;
  } catch {
    return true;
  }
}

function openDb(): Promise<IDBDatabase | null> {
  if (dbPromise) return dbPromise;
  dbPromise = new Promise<IDBDatabase | null>((resolve) => {
    let done = false;
    const finish = (db: IDBDatabase | null) => {
      if (done) return;
      done = true;
      resolve(db);
    };
    try {
      if (noIndexedDb()) return finish(null);
      const req = indexedDB.open(DB_NAME, 1);
      req.onupgradeneeded = () => {
        if (!req.result.objectStoreNames.contains(STORE)) req.result.createObjectStore(STORE);
      };
      req.onsuccess = () => finish(req.result);
      req.onerror = () => finish(null);
      req.onblocked = () => finish(null);
      setTimeout(() => finish(null), OPEN_TIMEOUT_MS);
    } catch {
      finish(null);
    }
  }).then((db) => {
    /* Не открылось — в следующий раз попробуем снова (сбой мог быть временным). ⚠️ Без паузы между попытками (ревью
       30.09): пропущенное из-за паузы стартовое чтение оставило бы стор без черновиков и неотправленного, и первая же
       запись затёрла бы их на диске. Лишние 1,5 с на запуске с меткой стирания дешевле. */
    if (!db) dbPromise = null;
    return db;
  });
  return dbPromise;
}

function done(tx: IDBTransaction): Promise<boolean> {
  return new Promise((resolve) => {
    tx.oncomplete = () => resolve(true);
    tx.onerror = () => resolve(false);
    tx.onabort = () => resolve(false);
  });
}

/** Прочитать запись; нет, битая, чужая схема — `null`. */
export async function readConvCache(key: string): Promise<ConvCacheRecord | null> {
  const db = await openDb();
  if (!db) return null;
  try {
    const tx = db.transaction(STORE, 'readonly');
    const req = tx.objectStore(STORE).get(key);
    const raw = await new Promise<unknown>((resolve) => {
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => resolve(null);
    });
    return acceptRecord(raw);
  } catch {
    return null;
  }
}

/**
 * Записать снимок. Сравнение с лежащим и запись — в ОДНОЙ транзакции: другая вкладка того же человека могла уйти дальше
 * по журналу, и её запись затирать нельзя. Места не хватило — пишем только список, без лент.
 */
export async function writeConvCache(key: string, rec: ConvCacheRecord): Promise<void> {
  const db = await openDb();
  if (!db) return;
  const attempt = async (r: ConvCacheRecord): Promise<boolean> => {
    try {
      const tx = db.transaction(STORE, 'readwrite');
      const store = tx.objectStore(STORE);
      const cur = store.get(key);
      cur.onsuccess = () => {
        const stored = acceptRecord(cur.result);
        if (shouldOverwrite(stored, r)) store.put(r, key);
      };
      return await done(tx);
    } catch {
      return false;
    }
  };
  if (!(await attempt(rec))) await attempt(withoutMessages(rec));
}

const WIPE_KEY = 'gv_conv_wipe';

/**
 * Метка «стереть при следующем запуске» — синхронно, в `localStorage`: стирание в IndexedDB асинхронное, и перезагрузка
 * сразу после выхода может его оборвать. Следующий запуск доделывает (`finishConvCacheWipes`) ДО любого чтения кеша.
 */
export function markConvCacheWipe(key: string | null): void {
  if (!key) return;
  try {
    const list = JSON.parse(localStorage.getItem(WIPE_KEY) ?? '[]') as unknown;
    const keys = Array.isArray(list) ? list.filter((x): x is string => typeof x === 'string') : [];
    if (!keys.includes(key)) keys.push(key);
    localStorage.setItem(WIPE_KEY, JSON.stringify(keys.slice(-20)));
  } catch {
    /* нет хранилища — остаётся только немедленное стирание */
  }
}

export function clearConvCacheWipe(key: string | null): void {
  if (!key) return;
  try {
    const list = JSON.parse(localStorage.getItem(WIPE_KEY) ?? '[]') as unknown;
    const keys = Array.isArray(list) ? list.filter((x) => x !== key) : [];
    if (keys.length) localStorage.setItem(WIPE_KEY, JSON.stringify(keys));
    else localStorage.removeItem(WIPE_KEY);
  } catch {
    /* нечего чистить */
  }
}

/** Доделать стирания, оборванные прошлой перезагрузкой. */
export async function finishConvCacheWipes(): Promise<void> {
  let keys: string[] = [];
  try {
    const list = JSON.parse(localStorage.getItem(WIPE_KEY) ?? '[]') as unknown;
    keys = Array.isArray(list) ? list.filter((x): x is string => typeof x === 'string') : [];
  } catch {
    return;
  }
  for (const k of keys) {
    if (await deleteConvCache(k)) clearConvCacheWipe(k);
  }
}

/**
 * Стереть запись человека (выход, удаление аккаунта, смена сервера). `true` — записи точно нет (стёрта или IndexedDB
 * тут нет вовсе); `false` — база не открылась или стирание не прошло: метку стирания НЕ снимать, иначе переписка
 * осталась бы на диске без напоминания дочистить.
 */
export async function deleteConvCache(key: string | null): Promise<boolean> {
  if (!key) return true;
  if (noIndexedDb()) return true;
  const db = await openDb();
  if (!db) return false;
  try {
    const tx = db.transaction(STORE, 'readwrite');
    tx.objectStore(STORE).delete(key);
    const ok = await done(tx);
    return (await wipeVoiceDrafts()) && ok;
  } catch {
    return false;
  }
}

/**
 * База черновиков голосовых (`voiceDrafts.ts`, `DB_NAME`): записи там лежат по id ленты, а не человека — стираются вместе с
 * перепиской (ревью 08.10: после «Выйти» следующий вошедший в общей группе получал чужую запись в своё поле ввода).
 * Не через импорт `voiceDrafts`: модуль тянет React, а этот — нет. `false` — не стёрлась (метка стирания остаётся).
 */
const VOICE_DRAFTS_DB = 'gv-voice-drafts';

function wipeVoiceDrafts(): Promise<boolean> {
  return new Promise((resolve) => {
    try {
      const req = indexedDB.deleteDatabase(VOICE_DRAFTS_DB);
      req.onsuccess = () => resolve(true);
      req.onerror = () => resolve(false);
      req.onblocked = () => resolve(false);
    } catch {
      resolve(false);
    }
  });
}

/** Стереть все записи инстанса (его убрали из реестра): ключ начинается с его части. */
export async function deleteConvCacheForInstance(instance: string | null | undefined): Promise<void> {
  if (!instance) return;
  const prefix = `${convCacheInstancePart(instance)}|`;
  const db = await openDb();
  if (!db) return;
  try {
    const tx = db.transaction(STORE, 'readwrite');
    const store = tx.objectStore(STORE);
    const req = store.getAllKeys();
    req.onsuccess = () => {
      for (const k of req.result) if (typeof k === 'string' && k.startsWith(prefix)) store.delete(k);
    };
    await done(tx);
  } catch {
    /* нечего стирать */
  }
}

/**
 * Сколько места занимают ленты в кеше бесед («Данные и память» → «Использование памяти», G32): записей и примерный объём
 * в байтах — длина JSON-снимка (точного размера на диске IndexedDB не отдаёт). `null` — базы нет или не открылась.
 */
export async function convCacheUsage(): Promise<{ records: number; bytes: number; messageBytes: number } | null> {
  if (noIndexedDb()) return null;
  const db = await openDb();
  if (!db) return null;
  try {
    const tx = db.transaction(STORE, 'readonly');
    const req = tx.objectStore(STORE).getAll();
    const all = await new Promise<unknown[]>((resolve) => {
      req.onsuccess = () => resolve(Array.isArray(req.result) ? req.result : []);
      req.onerror = () => resolve([]);
    });
    let bytes = 0;
    let messageBytes = 0;
    for (const raw of all) {
      bytes += JSON.stringify(raw ?? null).length;
      const rec = acceptRecord(raw);
      if (rec) messageBytes += JSON.stringify(rec.messages).length;
    }
    return { records: all.length, bytes, messageBytes };
  } catch {
    return null;
  }
}

/**
 * «Очистить кэш» (G32): из каждой записи убираются ленты — список бесед, черновики, неотправленные и места остаются (как у
 * Telegram: очистка кэша не трогает ни вход, ни черновики). Ленты открытых сейчас бесед писатель вернёт следующим снимком —
 * это свежая копия того, что на экране. Битую запись не трогаем — её выбросит чтение (`acceptRecord`).
 */
export async function clearConvCacheMessages(): Promise<boolean> {
  if (noIndexedDb()) return true;
  const db = await openDb();
  if (!db) return false;
  try {
    const tx = db.transaction(STORE, 'readwrite');
    const store = tx.objectStore(STORE);
    const req = store.openCursor();
    req.onsuccess = () => {
      const cur = req.result;
      if (!cur) return;
      const rec = acceptRecord(cur.value);
      // Пишем исходную запись без лент, а не разобранную: разбор отбрасывает поля, которых не знает, — а их мог положить
      // клиент новее этого.
      if (rec && Object.keys(rec.messages).length > 0) cur.update({ ...(cur.value as object), messages: {} });
      cur.continue();
    };
    return await done(tx);
  } catch {
    return false;
  }
}
