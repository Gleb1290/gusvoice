import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { it } from 'node:test';
import { runInNewContext } from 'node:vm';
import ts from 'typescript';

type State = { user: { id: string } | null; selfInstanceName: string };
const source = readFileSync(new URL('./selfInstanceName.ts', import.meta.url), 'utf8').replace(/\r\n/g, '\n');
const settle = async () => { for (let i = 0; i < 5; i++) await Promise.resolve(); };
function fixture(loggedIn = false, raw = source) {
  let state: State = { user: loggedIn ? { id: 'me' } : null, selfInstanceName: 'Прежняя подпись' };
  const config = { apiUrl: 'https://first.example.test' };
  const listeners: ((next: State, prev: State) => void)[] = [], writes: string[] = [];
  type Info = { name?: string | null; fedName?: string | null };
  const calls: { url: string; resolve: (info: Info) => void; reject: (error: unknown) => void }[] = [];
  const deps: Record<string, unknown> = {
    './api': { api: { instance: () => new Promise<Info>((resolve, reject) => calls.push({ url: config.apiUrl, resolve, reject })) } },
    './config': { config },
    './store': { useStore: { getState: () => state,
      setState: (patch: Partial<State>) => { state = { ...state, ...patch }; if ('selfInstanceName' in patch) writes.push(state.selfInstanceName); },
      subscribe: (fn: (next: State, prev: State) => void) => listeners.push(fn) } },
  };
  const module = { exports: {} };
  runInNewContext(ts.transpileModule(raw, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText,
    { module, exports: module.exports, require: (id: string) => { assert.ok(Object.hasOwn(deps, id), `явный импорт имени дома: ${id}`); return deps[id]; } });
  return { api: module.exports as typeof import('./selfInstanceName'), config, calls, listeners, writes,
    state: () => state, login: (id: string | null) => {
      const previous = state; state = { ...state, user: id === null ? null : { id } }; for (const fn of listeners) fn(state, previous);
    } };
}
async function once(raw = source) {
  const f = fixture(false, raw); f.api.startSelfInstanceName(); f.api.startSelfInstanceName();
  assert.equal(f.listeners.length, 1); assert.equal(f.calls.length, 0);
  f.login('me'); assert.equal(f.state().selfInstanceName, '');
  f.calls[0].resolve({ name: '  Наш инстанс  ' }); await settle();
  assert.equal(f.state().selfInstanceName, 'Наш инстанс');
  f.login('me'); f.login(null); f.login('another');
  assert.equal(f.calls.length, 1, 'один запрос названия на адрес API');
}
// Имя записи реестра не заменяет официальное название: до входа запроса нет, после — ровно один на этот API.
it('R208 имя своего инстанса спрашивается после входа один раз, ответ обрезает пробелы', async () => { await once(); });

// Уже вошедший человек должен получить имя сразу, а не ждать следующего изменения user.
it('R208 старт при существующем входе немедленно спрашивает имя', async () => {
  const f = fixture(true); f.api.startSelfInstanceName();
  assert.equal(f.calls.length, 1); assert.equal(f.calls[0].url, f.config.apiUrl);
  assert.equal(f.state().selfInstanceName, '');
  f.calls[0].resolve({ name: 'Инстанс' }); await settle(); assert.equal(f.state().selfInstanceName, 'Инстанс');
});

// Поздний ответ покинутого API не должен затереть имя нового инстанса.
it('R208 смена API спрашивает новое имя и игнорирует поздний ответ прежнего адреса', async () => {
  const f = fixture(true); f.api.startSelfInstanceName();
  f.config.apiUrl = 'https://second.example.test'; f.login('second-me');
  assert.equal(f.calls.length, 2); assert.deepEqual(f.calls.map(c => c.url), ['https://first.example.test', 'https://second.example.test']);
  f.calls[1].resolve({ name: 'Второй инстанс' }); await settle();
  f.calls[0].resolve({ name: 'Первый инстанс' }); await settle();
  assert.equal(f.state().selfInstanceName, 'Второй инстанс');
  assert.deepEqual(f.writes, ['', '', 'Второй инстанс']);
});

async function retry(raw = source) {
  const f = fixture(true, raw); f.api.startSelfInstanceName();
  f.calls[0].reject(new Error('фиктивный сбой сети')); await settle();
  assert.equal(f.state().selfInstanceName, '');
  f.login('me-again'); assert.equal(f.calls.length, 2, 'сбой позволяет повторить запрос имени');
  f.calls[1].resolve({ name: 'Восстановленный дом' }); await settle();
  assert.equal(f.state().selfInstanceName, 'Восстановленный дом');
}
// Ошибка первого запроса не должна навсегда закрепить локальный домен вместо официального имени.
it('R208 сбой загрузки имени разрешает повтор после следующего входа', async () => { await retry(); });

// Отсутствие официального имени оставляет пустую строку для fallback, а не "null" или "undefined".
it('R208 пустое, пробельное и отсутствующее имя дают пустую подпись', async () => {
  for (const info of [{}, { name: null }, { name: '' }, { name: '   ' }]) {
    const f = fixture(true); f.api.startSelfInstanceName(); f.calls[0].resolve(info); await settle();
    assert.equal(f.state().selfInstanceName, '');
  }
});

// Обе контрфактические ветки проходят оригинал; ошибка распознаётся по конкретной проверке, не по rejection API.
for (const [name, anchor, replacement, check, label, actual, expected] of [
  ['потерян кеш по API', '  if (askedFor === key) return;', '', once, 'один запрос названия на адрес API', 3, 1],
  ['ошибка не разрешает повтор', "if (askedFor === key) askedFor = '';", 'void key;', retry, 'сбой позволяет повторить запрос имени', 1, 2],
] as const) it(`R208 контрфакт имени дома: ${name}`, async () => {
  await check(); assert.equal(source.split(anchor).length - 1, 1);
  await assert.rejects(check(source.replace(anchor, replacement)), e => e instanceof assert.AssertionError && e.message.startsWith(label)
    && e.actual === actual && e.expected === expected);
});

async function federationName(raw = source) {
  const cases = [
    { info: { name: 'Вкладка', fedName: '  Для соседей  ' }, expected: 'Для соседей' },
    { info: { name: '  Вкладка  ', fedName: null }, expected: 'Вкладка' },
    { info: { name: 'Вкладка', fedName: '' }, expected: 'Вкладка' },
    { info: { fedName: '  ' }, expected: '' },
    { info: { name: '  ', fedName: null }, expected: '' },
  ];
  for (const row of cases) {
    const f = fixture(true, raw); f.api.startSelfInstanceName(); f.calls[0].resolve(row.info); await settle();
    assert.equal(f.state().selfInstanceName, row.expected, 'подпись своего дома предпочитает федеративное имя, затем имя вкладки');
  }
}
// Заголовок вкладки может отличаться от визитки: «через» должен называть дом тем именем, которое знают соседи.
it('R210 имя для соседей главнее имени вкладки, null и пустое сохраняют fallback', () => federationName());
// Правдоподобное локальное название не должно скрыть официальное имя из федеративной визитки.
it('R210 перестановка fedName и name обнаруживается неверной подписью своего дома', async () => {
  await federationName();
  const anchor = 'info.fedName?.trim() || info.name?.trim()'; assert.equal(source.split(anchor).length - 1, 1);
  await assert.rejects(federationName(source.replace(anchor, 'info.name?.trim() || info.fedName?.trim()')),
    e => e instanceof assert.AssertionError && e.message.startsWith('подпись своего дома предпочитает федеративное имя')
      && e.operator === 'strictEqual' && e.actual === 'Вкладка' && e.expected === 'Для соседей');
});
