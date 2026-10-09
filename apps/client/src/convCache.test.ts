import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import ts from 'typescript';
import {
  clearConvCacheWipe, deleteConvCache, finishConvCacheWipes, markConvCacheWipe, readConvCache, writeConvCache,
} from './convCache';
import * as convCacheRules from './convCacheRules';

function fakeStorage() {
  const data = new Map<string, string>();
  return {
    getItem: (key: string) => data.get(key) ?? null,
    setItem: (key: string, value: string) => { data.set(key, value); },
    removeItem: (key: string) => { data.delete(key); },
  };
}

function fakeCursorDb(initial: Record<string, unknown>) {
  const rows = new Map(Object.entries(initial));
  const db = {
    objectStoreNames: { contains: () => true }, createObjectStore: () => {}, close: () => {},
    transaction: () => {
      const tx: { oncomplete?: () => void; onerror?: () => void; onabort?: () => void; objectStore: () => unknown } = {
        objectStore: () => ({ openCursor: () => {
          const request: { result?: unknown; onsuccess?: () => void } = {};
          const keys = [...rows.keys()];
          const advance = (index: number) => setTimeout(() => {
            if (index >= keys.length) { request.result = null; request.onsuccess?.(); setTimeout(() => tx.oncomplete?.(), 0); return; }
            const key = keys[index]!;
            const cursor = { key, value: rows.get(key), update: (value: unknown) => rows.set(key, value), continue: () => advance(index + 1) };
            request.result = cursor; request.onsuccess?.();
          }, 0);
          advance(0); return request;
        } }),
      };
      return tx;
    },
  };
  const indexedDB = { open: () => {
    const req: { result: unknown; onsuccess?: () => void; onupgradeneeded?: () => void; onerror?: () => void; onblocked?: () => void } = { result: db };
    setTimeout(() => req.onsuccess?.(), 0); return req;
  } };
  return { indexedDB, rows };
}

function loadClearMessages(indexedDB: IDBFactory): { clearConvCacheMessages(): Promise<boolean> } {
  const source = readFileSync(new URL('./convCache.ts', import.meta.url), 'utf8').replace(/\r\n/g, '\n');
  const js = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText;
  const module = { exports: {} as Record<string, unknown> };
  runInNewContext(js, { module, exports: module.exports, indexedDB, setTimeout,
    require: (id: string) => { assert.equal(id, './convCacheRules'); return convCacheRules; } });
  return module.exports as { clearConvCacheMessages(): Promise<boolean> };
}

describe('необязательное дисковое хранилище бесед', () => {
  it('очистка освобождает только ленты, сохраняя беседы, черновики, очередь и места', async () => {
    // Ловит очистку всего кеша вместо медиа/сообщений: входящие и несохранённый текст нельзя потерять.
    const old = Object.getOwnPropertyDescriptor(globalThis, 'indexedDB');
    const record = { v: 1, pts: 3, savedAt: 4, summaries: [{ id: 'c' }], messages: { c: [{ id: 'm' }] }, gone: ['gone'],
      outbox: [{ key: 'queued' }], drafts: { c: { text: 'черновик', replyToId: null } }, places: { c: { messageId: 'm', offset: -4 } }, futureField: { retained: true } };
    const empty = { v: 1, pts: 4, savedAt: 5, summaries: [], messages: {}, gone: [] };
    const fake = fakeCursorDb({ account: record, empty });
    Object.defineProperty(globalThis, 'indexedDB', { configurable: true, value: fake.indexedDB });
    try {
      assert.equal(await loadClearMessages(fake.indexedDB as unknown as IDBFactory).clearConvCacheMessages(), true);
      const cleaned = fake.rows.get('account') as typeof record;
      assert.equal(Object.keys(cleaned.messages).length, 0);
      assert.equal(cleaned.summaries, record.summaries); assert.equal(cleaned.drafts, record.drafts);
      assert.equal(cleaned.outbox, record.outbox); assert.equal(cleaned.places, record.places);
      assert.equal(cleaned.futureField, record.futureField);
      assert.equal(fake.rows.get('empty'), empty, 'пустая запись не перезаписывается');
    } finally {
      if (old) Object.defineProperty(globalThis, 'indexedDB', old);
      else Reflect.deleteProperty(globalThis, 'indexedDB');
    }
  });

  it('без IndexedDB чтение даёт null, запись и стирание не бросают', async () => {
    // Ловит отказ входа и выхода в приватном режиме без браузерной базы.
    const old = Object.getOwnPropertyDescriptor(globalThis, 'indexedDB');
    Object.defineProperty(globalThis, 'indexedDB', { configurable: true, value: undefined });
    try {
      assert.equal(await readConvCache('instance|user'), null);
      assert.equal(await deleteConvCache('instance|user'), true);
      await writeConvCache('instance|user', { v: 1, pts: 0, savedAt: 0, summaries: [], messages: {}, gone: [] });
    } finally {
      if (old) Object.defineProperty(globalThis, 'indexedDB', old);
      else Reflect.deleteProperty(globalThis, 'indexedDB');
    }
  });

  it('зависшее открытие IndexedDB заканчивается отсутствием кеша, не зависанием клиента', async () => {
    // Ловит вечное ожидание WebView, который не вызывает ни success, ни error.
    const old = Object.getOwnPropertyDescriptor(globalThis, 'indexedDB');
    Object.defineProperty(globalThis, 'indexedDB', { configurable: true, value: { open: () => ({}) } });
    const start = Date.now();
    try {
      assert.equal(await readConvCache('instance|user'), null);
      assert.ok(Date.now() - start >= 1400);
      assert.ok(Date.now() - start < 10_000);
      assert.equal(await deleteConvCache('instance|user'), false);
    } finally {
      if (old) Object.defineProperty(globalThis, 'indexedDB', old);
      else Reflect.deleteProperty(globalThis, 'indexedDB');
    }
  });

  it('метки стирания не дублируются и удаляются адресно', () => {
    // Ловит потерю отложенного стирания другой учётной записи.
    const old = Object.getOwnPropertyDescriptor(globalThis, 'localStorage');
    const storage = fakeStorage();
    Object.defineProperty(globalThis, 'localStorage', { configurable: true, value: storage });
    try {
      markConvCacheWipe('a');
      markConvCacheWipe('a');
      markConvCacheWipe('b');
      assert.deepEqual(JSON.parse(storage.getItem('gv_conv_wipe') ?? '[]'), ['a', 'b']);
      clearConvCacheWipe('a');
      assert.deepEqual(JSON.parse(storage.getItem('gv_conv_wipe') ?? '[]'), ['b']);
      clearConvCacheWipe('b');
      assert.equal(storage.getItem('gv_conv_wipe'), null);
    } finally {
      if (old) Object.defineProperty(globalThis, 'localStorage', old);
      else Reflect.deleteProperty(globalThis, 'localStorage');
    }
  });

  it('отложенная очистка сохраняет метку при сбое открытия, затем снимает после подтверждённого отсутствия базы', async () => {
    // Ловит утечку старой переписки после временного отказа IndexedDB на выходе.
    const oldDb = Object.getOwnPropertyDescriptor(globalThis, 'indexedDB');
    const oldStorage = Object.getOwnPropertyDescriptor(globalThis, 'localStorage');
    const storage = fakeStorage();
    Object.defineProperty(globalThis, 'localStorage', { configurable: true, value: storage });
    Object.defineProperty(globalThis, 'indexedDB', { configurable: true, value: { open: () => { throw new Error('blocked'); } } });
    try {
      markConvCacheWipe('instance|user');
      assert.equal(await deleteConvCache('instance|user'), false);
      await finishConvCacheWipes();
      assert.deepEqual(JSON.parse(storage.getItem('gv_conv_wipe') ?? '[]'), ['instance|user']);
      Object.defineProperty(globalThis, 'indexedDB', { configurable: true, value: undefined });
      await finishConvCacheWipes();
      assert.equal(storage.getItem('gv_conv_wipe'), null);
    } finally {
      if (oldDb) Object.defineProperty(globalThis, 'indexedDB', oldDb);
      else Reflect.deleteProperty(globalThis, 'indexedDB');
      if (oldStorage) Object.defineProperty(globalThis, 'localStorage', oldStorage);
      else Reflect.deleteProperty(globalThis, 'localStorage');
    }
  });
});
