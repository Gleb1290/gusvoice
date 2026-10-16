import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { afterEach, it } from 'node:test';
import { runInNewContext } from 'node:vm';
import ts from 'typescript';
import * as shared from '@gusvoice/shared';
import * as dmListRules from './dmListRules';
import { READERS_EXPIRE_MS, readersLabel, readersLineShown } from './lastSeenText';
import { serverReaders } from './convSyncRules';

type Mutation = readonly [string, string];
const raw = readFileSync(new URL('./lastSeenText.ts', import.meta.url), 'utf8').replace(/\r\n/g, '\n');
const syncRaw = readFileSync(new URL('./convSyncRules.ts', import.meta.url), 'utf8').replace(/\r\n/g, '\n');
const now = Date.UTC(2026, 9, 15, 12);
const fresh = { mine: true, read: true, createdAt: new Date(now).toISOString(), now };
const unexpected: string[] = [];
afterEach(() => assert.deepEqual(unexpected.splice(0), [], 'R239-client-rules-IO: нет скрытых импортов'));
function load<T>(source: string): T {
  const module = { exports: {} as T };
  const deps: Record<string, unknown> = { '@gusvoice/shared': shared, './dmListRules': dmListRules };
  // Исполняется весь модуль с закрытым перечнем зависимостей, не вырезанный расчёт.
  runInNewContext(ts.transpileModule(source, { compilerOptions: {
    module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022,
  } }).outputText, { module, exports: module.exports, require(id: string) {
    if (!Object.hasOwn(deps, id)) { unexpected.push(id); throw new Error(`неожиданный импорт ${id}`); }
    return deps[id];
  } });
  return module.exports;
}
function changed(source: string, [before, after]: Mutation) {
  assert.equal(source.split(before).length - 1, 1, 'R239-client-rules-anchor: единственный якорь');
  return source.replace(before, after);
}
function killed(prefix: string, actual: unknown, expected: unknown) {
  return (e: unknown) => e instanceof assert.AssertionError && e.message.startsWith(prefix)
    && e.operator === 'strictEqual' && Object.is(e.actual, actual) && Object.is(e.expected, expected);
}

it('R239 строка прочитавших доступна только своему сообщению с прочтением, каждое отсутствие запрещает её', () => {
  for (const mine of [false, true]) for (const read of [false, true]) {
    assert.equal(readersLineShown({ ...fresh, mine, read }), mine && read);
  }
});
it('R239 клиент принимает семь суток минус миллисекунда, но скрывает строку ровно в семь и позже', () => {
  assert.equal(READERS_EXPIRE_MS, 7 * 86_400_000);
  for (const [age, shown] of [[READERS_EXPIRE_MS - 1, true], [READERS_EXPIRE_MS, false], [READERS_EXPIRE_MS + 1, false]] as const) {
    assert.equal(readersLineShown({ ...fresh, createdAt: new Date(now - age).toISOString() }), shown);
  }
  assert.equal(readersLineShown({ ...fresh, createdAt: new Date(now + 1000).toISOString() }), true,
    'отстающие часы клиента не скрывают свежее сообщение');
});
it('R239 отсутствие и битая дата не открывают строку, валидная свежая ISO-дата принимается', () => {
  for (const createdAt of [undefined, '', 'not-a-date', 'NaN']) assert.equal(readersLineShown({ ...fresh, createdAt }), false);
  assert.equal(readersLineShown(fresh), true);
});
it('R239 подпись различает никого, имя единственного читателя и число нескольких, не меняя список имён', () => {
  assert.equal(readersLabel([]), 'Никто не прочитал');
  assert.equal(readersLabel(['Посетитель']), 'Посетитель');
  for (const count of [2, 3, 5, 21]) {
    const names = Object.freeze(Array.from({ length: count }, (_, i) => `Участник ${i}`));
    assert.equal(readersLabel(names), `${count} прочитали`);
    assert.equal(names.length, count);
  }
});
it('R239 только точный readers1 включает список читателей, старый и похожие признаки не включают', () => {
  for (const features of [undefined, null, [], ['lastseen1'], ['READERS1'], ['readers10']] as const) assert.equal(serverReaders(features), false);
  assert.equal(serverReaders(['readers1']), true);
  assert.equal(serverReaders(['conv3', 'readers1']), true);
});
it('R239 контрфакты чужого и непрочитанного сообщения ловятся независимо на живом правиле', () => {
  const anchor = 'if (!mine || !read || !createdAt) return false;';
  for (const [replacement, input] of [
    ['if (!read || !createdAt) return false;', { ...fresh, mine: false }],
    ['if (!mine || !createdAt) return false;', { ...fresh, read: false }],
  ] as const) {
    const check = (rule: typeof readersLineShown) => assert.equal(rule(input), false, 'R239-line-guard: неподходящее сообщение скрыто');
    check(readersLineShown); check(load<{ readersLineShown: typeof readersLineShown }>(raw).readersLineShown);
    const rule = load<{ readersLineShown: typeof readersLineShown }>(changed(raw, [anchor, replacement])).readersLineShown;
    assert.throws(() => check(rule), killed('R239-line-guard:', true, false));
  }
});
it('R239 контрфакты включённой границы семи суток и разрешения битой даты не проходят', () => {
  for (const [mutation, input] of [
    [['now - t < READERS_EXPIRE_MS', 'now - t <= READERS_EXPIRE_MS'], { ...fresh, createdAt: new Date(now - READERS_EXPIRE_MS).toISOString() }],
    [['Number.isFinite(t) && now - t < READERS_EXPIRE_MS', '!Number.isFinite(t) || now - t < READERS_EXPIRE_MS'], { ...fresh, createdAt: 'not-a-date' }],
    [['export const READERS_EXPIRE_MS = 7 * 86_400_000;', 'export const READERS_EXPIRE_MS = 8 * 86_400_000;'], { ...fresh, createdAt: new Date(now - 7 * 86_400_000).toISOString() }],
  ] as const) {
    const check = (rule: typeof readersLineShown) => assert.equal(rule(input), false, 'R239-line-expiry: просроченное и битое скрыто');
    check(readersLineShown); check(load<{ readersLineShown: typeof readersLineShown }>(raw).readersLineShown);
    const rule = load<{ readersLineShown: typeof readersLineShown }>(changed(raw, mutation)).readersLineShown;
    assert.throws(() => check(rule), killed('R239-line-expiry:', true, false));
  }
});
it('R239 контрфакт включения читателей любым непустым списком возможностей ловится старым сервером', () => {
  const check = (rule: typeof serverReaders) => assert.equal(rule(['lastseen1']), false, 'R239-client-capability: старый сервер не обещает readers');
  check(serverReaders); check(load<{ serverReaders: typeof serverReaders }>(syncRaw).serverReaders);
  const rule = load<{ serverReaders: typeof serverReaders }>(changed(syncRaw,
    ['return !!features?.includes(FEATURE_READERS1);', 'return !!features?.length;'])).serverReaders;
  assert.throws(() => check(rule), killed('R239-client-capability:', true, false));
});
