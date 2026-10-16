import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { it } from 'node:test';
import { runInNewContext } from 'node:vm';
import ts from 'typescript';
import * as rules from './notifyPopupRules';

type Api = typeof import('./notifyPopupPrefs');
const plain = (value: unknown) => JSON.parse(JSON.stringify(value));
function fixture(raw?: string, failRead = false, failWrite = false) {
  const storage = new Map<string, string>(); if (raw !== undefined) storage.set('gv_notify_popup', raw);
  const module = { exports: {} };
  const source = readFileSync(new URL('./notifyPopupPrefs.ts', import.meta.url), 'utf8');
  runInNewContext(ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText, {
    module, exports: module.exports,
    localStorage: {
      getItem(key: string) { if (failRead) throw new Error('storage unavailable'); return storage.get(key) ?? null; },
      setItem(key: string, value: string) { if (failWrite) throw new Error('storage unavailable'); storage.set(key, value); },
    },
    require(id: string) { assert.equal(id, './notifyPopupRules'); return rules; },
  });
  return { api: module.exports as Api, storage };
}
it('R223 пустое или недоступное хранилище выбирает свои окна, правый нижний угол и три карточки', () => {
  for (const f of [fixture(), fixture(undefined, true)]) {
    assert.deepEqual(plain(f.api.getNotifyPopupPrefs()), { native: false, corner: 'br', count: 3, monitor: '' });
    const p = f.api.getNotifyPopupPrefs(); p.native = true;
    assert.equal(f.api.getNotifyPopupPrefs().native, false, 'выдана копия, а не общий объект умолчаний');
  }
});
it('R223 битый JSON и примитивы безопасно дают умолчания, корректные поля сохраняются и нормализуются', () => {
  for (const raw of ['{', 'null', 'true', '5', '"строка"']) assert.deepEqual(plain(fixture(raw).api.getNotifyPopupPrefs()), { native: false, corner: 'br', count: 3, monitor: '' });
  assert.deepEqual(plain(fixture('{"native":true,"corner":"tl","count":5,"monitor":"Второй"}').api.getNotifyPopupPrefs()), { native: true, corner: 'tl', count: 5, monitor: 'Второй' });
  assert.deepEqual(plain(fixture('{"native":"true","corner":"bad","count":99,"monitor":1}').api.getNotifyPopupPrefs()), { native: false, corner: 'br', count: 5, monitor: '' });
  assert.equal(fixture('{"count":0}').api.getNotifyPopupPrefs().count, 1);
});
it('R223 смена настройки сливается с сохранёнными полями и уведомляет только действующих подписчиков', () => {
  const f = fixture('{"native":true,"corner":"tl","count":2,"monitor":"Второй"}'), seen: unknown[] = [], removed: unknown[] = [];
  const off = f.api.onNotifyPopupPrefs(p => seen.push(plain(p)));
  const offRemoved = f.api.onNotifyPopupPrefs(p => removed.push(p)); offRemoved();
  const next = f.api.setNotifyPopupPrefs({ count: 4, native: false });
  assert.deepEqual(plain(next), { native: false, corner: 'tl', count: 4, monitor: 'Второй' });
  assert.deepEqual(JSON.parse(f.storage.get('gv_notify_popup')!), plain(next)); assert.deepEqual(seen, [plain(next)]); assert.equal(removed.length, 0);
  off(); f.api.setNotifyPopupPrefs({ corner: 'br' }); assert.equal(seen.length, 1); assert.equal(f.api.getNotifyPopupPrefs().corner, 'br');
});
it('R223 отказ записи не выбрасывает исключение и всё равно доставляет новые настройки подписчику', () => {
  const f = fixture(undefined, false, true), seen: unknown[] = [];
  f.api.onNotifyPopupPrefs(p => seen.push(plain(p)));
  const next = f.api.setNotifyPopupPrefs({ count: 1 });
  assert.equal(next.count, 1); assert.deepEqual(seen, [plain(next)]); assert.equal(f.storage.size, 0);
});
