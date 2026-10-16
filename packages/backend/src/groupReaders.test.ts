import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { afterEach, it } from 'node:test';
import { runInNewContext } from 'node:vm';
import ts from 'typescript';
import * as shared from '@gusvoice/shared';
import * as threats from './linkThreatsRules.js';
import { groupReaders, READ_DATE_EXPIRE_MS, type GroupReaderSide, type ReadTimeSide } from './lastSeenRules.js';

type Mutation = readonly [string, string];
const raw = readFileSync(new URL('./lastSeenRules.ts', import.meta.url), 'utf8').replace(/\r\n/g, '\n');
const featureRaw = readFileSync(new URL('./instanceFeatures.ts', import.meta.url), 'utf8').replace(/\r\n/g, '\n');
const now = Date.UTC(2026, 9, 15, 12);
const me: ReadTimeSide = { id: 'author', privacy: 'everyone', invisible: false, hideReadTime: false };
const reader = (id: string, patch: Partial<GroupReaderSide> = {}): GroupReaderSide => ({
  ...me, id, lastReadKey: 100, blocked: false, deleted: false, isPeer: false, ...patch,
});
type Rules = typeof groupReaders;
const input = (members: readonly GroupReaderSide[], author = me, age = 0) => ({
  me: author, members, now, sortKey: 100, createdAt: new Date(now - age),
});
const ids = (members: readonly GroupReaderSide[], author = me, age = 0) => groupReaders(input(members, author, age)).ids;
const unexpected: string[] = [];
afterEach(() => assert.deepEqual(unexpected.splice(0), [], 'R239-rules-IO: ни одного скрытого импорта/IO'));
function load<T>(source: string, deps: Record<string, unknown> = {}, env: Record<string, string> = {}): T {
  const module = { exports: {} as T };
  // Выполняется целый модуль правил, не фрагмент функции; окружение всегда синтетическое.
  runInNewContext(ts.transpileModule(source, { compilerOptions: {
    module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022,
  } }).outputText, { module, exports: module.exports, process: { env },
    require(id: string) {
      if (!Object.hasOwn(deps, id)) { unexpected.push(id); throw new Error(`неожиданный импорт ${id}`); }
      return deps[id];
    } });
  return module.exports;
}
function changed(source: string, [before, after]: Mutation): string {
  assert.equal(source.split(before).length - 1, 1, 'R239-rules-anchor: единственный якорь');
  return source.replace(before, after);
}
const mutant = (change: Mutation) => load<{ groupReaders: Rules }>(changed(raw, change)).groupReaders;
function killed(prefix: string, actual: unknown, expected: unknown) {
  return (e: unknown) => e instanceof assert.AssertionError && e.message.startsWith(prefix)
    && e.operator === 'strictEqual' && Object.is(e.actual, actual) && Object.is(e.expected, expected);
}

it('R239 пустая группа даёт пустой неистёкший список, единственный подходящий читатель принимается', () => {
  assert.deepEqual(groupReaders(input([])), { ids: [], expired: false });
  assert.deepEqual(ids([reader('one')]), ['one']);
});
it('R239 ключ ровно сообщения уже считается прочтением, меньший нет; порядок участников сохраняется без мутации', () => {
  const members = Object.freeze([Object.freeze(reader('above', { lastReadKey: 101 })),
    Object.freeze(reader('below', { lastReadKey: 99 })), Object.freeze(reader('exact'))]);
  assert.deepEqual(ids(members), ['above', 'exact']);
  assert.deepEqual(members.map(m => m.id), ['above', 'below', 'exact']);
});
it('R239 автор, удалённый и заблокированный исключены отдельно, снятие каждого ограничения возвращает читателя', () => {
  assert.deepEqual(ids([reader(me.id), reader('deleted', { deleted: true }), reader('blocked', { blocked: true }), reader('ok')]), ['ok']);
  assert.deepEqual(ids([reader('deleted'), reader('blocked')]), ['deleted', 'blocked']);
});
it('R239 читатель скрывается только сочетанием hideReadTime и закрытого для автора времени захода', () => {
  assert.deepEqual(ids([reader('hidden', { privacy: 'nobody', hideReadTime: true }),
    reader('no-hide', { privacy: 'nobody' }), reader('shared', { hideReadTime: true }),
    reader('peer', { privacy: 'peers', hideReadTime: true, isPeer: true }),
    reader('stranger', { privacy: 'peers', hideReadTime: true, isPeer: false })]), ['no-hide', 'shared', 'peer']);
});
it('R239 скрывший собственное время автор не видит читателей, открытая настройка и выключенный hideReadTime принимаются', () => {
  assert.deepEqual(ids([reader('one')], { ...me, privacy: 'nobody', hideReadTime: true }), []);
  assert.deepEqual(ids([reader('one')], { ...me, privacy: 'nobody', hideReadTime: false }), ['one']);
  assert.deepEqual(ids([reader('one')], { ...me, privacy: 'everyone', hideReadTime: true }), ['one']);
});
it('R239 исключения всегда взаимны и адресны, никогда сильнее всегда при пересечении', () => {
  const author = { ...me, privacy: 'nobody' as const, hideReadTime: true,
    exceptions: { always: new Set(['allowed']), never: new Set<string>() } };
  const allowed = reader('allowed', { privacy: 'nobody', hideReadTime: true,
    exceptions: { always: new Set([me.id]), never: new Set<string>() } });
  assert.deepEqual(ids([allowed, reader('other')], author), ['allowed']);
  assert.deepEqual(ids([{ ...allowed, exceptions: { always: new Set(['unrelated']), never: new Set<string>() } }], author), []);
  assert.deepEqual(ids([{ ...allowed, exceptions: { always: new Set([me.id]), never: new Set([me.id]) } }], author), []);
  assert.deepEqual(ids([allowed], { ...author, exceptions: { always: new Set(['allowed']), never: new Set(['allowed']) } }), []);
});
it('R239 невидимость серверного присутствия не скрывает читателя и не ограничивает автора в группе', () => {
  assert.deepEqual(ids([reader('one', { invisible: true })], { ...me, invisible: true }), ['one']);
});
it('R239 семь суток минус миллисекунда принимаются, ровно семь и следующая миллисекунда истекли', () => {
  assert.equal(READ_DATE_EXPIRE_MS, 7 * 86_400_000, 'срок проверяется независимо от используемой в расчёте константы');
  assert.deepEqual(groupReaders(input([reader('one')], me, READ_DATE_EXPIRE_MS - 1)), { ids: ['one'], expired: false });
  for (const age of [READ_DATE_EXPIRE_MS, READ_DATE_EXPIRE_MS + 1]) {
    assert.deepEqual(groupReaders(input([reader('one')], me, age)), { ids: [], expired: true });
  }
});
it('R239 контрфакт строго большего ключа ловится ровно на отметке сообщения', () => {
  const check = (rule: Rules) => assert.equal(rule(input([reader('one')])).ids.join(','), 'one', 'R239-key: равный ключ прочитан');
  check(groupReaders); check(load<{ groupReaders: Rules }>(raw).groupReaders);
  assert.throws(() => check(mutant(['m.lastReadKey >= sortKey', 'm.lastReadKey > sortKey'])), killed('R239-key:', '', 'one'));
});
it('R239 контрфакт без взаимного скрытия не раскрывает закрытое время читателя', () => {
  const check = (rule: Rules) => assert.equal(rule(input([reader('hidden', { privacy: 'nobody', hideReadTime: true })])).ids.join(','), '',
    'R239-hidden: скрытый читатель отсутствует');
  check(groupReaders); check(load<{ groupReaders: Rules }>(raw).groupReaders);
  assert.throws(() => check(mutant([' && !readTimeHidden(me, m, m.isPeer)', ''])), killed('R239-hidden:', 'hidden', ''));
});
it('R239 контрфакты пропущенных фильтров автора, удаления и блокировки ловятся независимо', () => {
  for (const [fragment, member] of [['m.id !== me.id && ', reader(me.id)], ['!m.deleted && ', reader('deleted', { deleted: true })],
    ['!m.blocked && ', reader('blocked', { blocked: true })]] as const) {
    const check = (rule: Rules) => assert.equal(rule(input([member])).ids.join(','), '', 'R239-filter: непригодный читатель отсутствует');
    check(groupReaders); check(load<{ groupReaders: Rules }>(raw).groupReaders);
    assert.throws(() => check(mutant([fragment, ''])), killed('R239-filter:', member.id, ''));
  }
});
it('R239 контрфакты отсечки на семь суток ловятся и на границе, и за ней', () => {
  // Якорь включает тело именно groupReaders, не одноимённое условие readAtView выше.
  const anchor = 'if (now - createdAt.getTime() >= READ_DATE_EXPIRE_MS) return { ids: [], expired: true };';
  for (const [mutation, age] of [
    [[anchor, 'if (now - createdAt.getTime() > READ_DATE_EXPIRE_MS) return { ids: [], expired: true };'], READ_DATE_EXPIRE_MS],
    [[anchor, 'if (false) return { ids: [], expired: true };'], READ_DATE_EXPIRE_MS + 1],
    [['export const READ_DATE_EXPIRE_MS = 7 * 86_400_000;', 'export const READ_DATE_EXPIRE_MS = 8 * 86_400_000;'], 7 * 86_400_000],
  ] as const) {
    const check = (rule: Rules) => assert.equal(rule(input([reader('one')], me, age)).expired, true, 'R239-expired: старое сообщение закрыто');
    check(groupReaders); check(load<{ groupReaders: Rules }>(raw).groupReaders);
    assert.throws(() => check(mutant(mutation)), killed('R239-expired:', false, true));
  }
});

function features(source = featureRaw, env: Record<string, string> = {}) {
  return load<{ INSTANCE_FEATURES: string[] }>(source,
    { '@gusvoice/shared': shared, './linkThreatsRules.js': threats }, env).INSTANCE_FEATURES;
}
it('R239 сервер объявляет readers1 ровно один раз независимо от опциональных возможностей окружения', () => {
  assert.equal(shared.FEATURE_READERS1, 'readers1');
  const environments: Record<string, string>[] = [{},
    { FEDERATION_DM_ENABLED: 'true', LINK_THREATS_ENABLED: 'false', MAP_PMTILES_PATH: '/maps/fixture.pmtiles' }];
  for (const env of environments) {
    assert.equal(features(featureRaw, env).filter(f => f === shared.FEATURE_READERS1).length, 1);
  }
});
it('R239 потеря readers1 в объявленном списке ловится, даже если импорт константы остался', () => {
  const check = (source: string) => assert.equal(features(source).includes('readers1'), true, 'R239-capability: readers объявлен клиентам');
  check(featureRaw);
  const listStart = 'export const INSTANCE_FEATURES: readonly string[] = [';
  assert.equal(featureRaw.split(listStart).length - 1, 1, 'единственное объявление живого списка');
  const index = featureRaw.indexOf(listStart);
  const changedList = featureRaw.slice(0, index) + changed(featureRaw.slice(index), ['  FEATURE_READERS1,\n', '']);
  assert.throws(() => check(changedList), killed('R239-capability:', false, true));
});
