import assert from 'node:assert/strict';
import * as crypto from 'node:crypto';
import { readFileSync } from 'node:fs';
import { it } from 'node:test';
import { runInNewContext } from 'node:vm';
import ts from 'typescript';
import * as shared from '@gusvoice/shared';
import * as rules from './botRules.js';

const P = shared.Permission;
const source = readFileSync(new URL('./botRules.ts', import.meta.url), 'utf8').replace(/\r\n/g, '\n');
function load(from?: string, to = ''): typeof rules {
  if (from) { assert.equal(source.split(from).length - 1, 1, 'единственный якорь правил голоса'); }
  const module = { exports: {} };
  runInNewContext(ts.transpileModule(from ? source.replace(from, to) : source, { compilerOptions: {
    module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022,
  } }).outputText, { module, exports: module.exports, Buffer, Date, Error,
    require(id: string) { if (id === 'node:crypto') return crypto; assert.equal(id, '@gusvoice/shared'); return shared; } });
  return module.exports as typeof rules;
}
const base: rules.BotVoiceInput = { enabled: true, target: { type: 'voice' }, perms: P.CONNECT | P.SPEAK };
const later = { rateWait: 7, botsInChannel: 3, otherRooms: 10 };
// Каждый отказ одновременно конкурирует с последующими: перестановка проверок меняет публичную ошибку.
const refusals: [string, Partial<rules.BotVoiceInput>, number, string][] = [
  ['выключено раньше поиска канала', { ...later, enabled: false, target: 'missing', perms: 0n }, 403, 'Forbidden: voice is disabled for bots on this server'],
  ['не найден раньше прав', { ...later, target: 'missing', perms: 0n }, 400, 'Bad Request: chat not found'],
  ['сервер вместо канала раньше прав', { ...later, target: 'server', perms: 0n }, 400, 'Bad Request: chat is a server; use a channel id'],
  ['текстовый канал раньше CONNECT', { ...later, target: { type: 'text' }, perms: 0n }, 400, 'Bad Request: chat is not a voice channel'],
  ['CONNECT раньше SPEAK', { ...later, perms: 0n }, 403, 'Forbidden: not enough rights to connect to the voice chat'],
  ['SPEAK раньше частоты', { ...later, perms: P.CONNECT }, 403, 'Forbidden: not enough rights to speak in the voice chat'],
  ['частота раньше числа ботов', later, 429, 'Too Many Requests: retry after 7'],
  ['три других бота раньше числа комнат', { botsInChannel: 3, otherRooms: 10 }, 400, 'Bad Request: too many bots in the voice chat'],
  ['десять других комнат', { botsInChannel: 2, otherRooms: 10 }, 400, 'Bad Request: too many active voice chats'],
];
for (const [title, patch, code, description] of refusals) it(`R306 вход бота: ${title}`, () => {
  const e = rules.botVoiceDecision({ ...base, ...patch }); assert.ok(e);
  assert.equal(e.code, code); assert.equal(e.description, description); assert.equal(e.retryAfter, code === 429 ? 7 : undefined);
});
it('R306 третий бот и десятая комната ещё допускаются, отсутствующие счётчики не запрещают обход', () => {
  assert.equal(rules.botVoiceDecision(base), null);
  assert.equal(rules.botVoiceDecision({ ...base, botsInChannel: 2, otherRooms: 9, rateWait: 0 }), null);
  assert.equal(rules.BOT_VOICE_PER_CHANNEL, 3); assert.equal(rules.BOT_VOICE_MAX_ROOMS, 10);
});
it('R306 отсутствие voice сохраняет прежний JSON настройки, явное true тоже не добавляет поле', () => {
  const expected = '{"creators":"all","perUserLimit":10,"allowInternalWebhooks":false,"enabled":false}';
  for (const voice of [undefined, true, 'false', 0, null]) {
    const value = rules.normalizeBotSettings({ voice }); assert.equal(JSON.stringify(value), expected);
    assert.equal(Object.hasOwn(value, 'voice'), false);
  }
  assert.equal(JSON.stringify(rules.normalizeBotSettings(undefined)), expected);
});
it('R306 только явный false выключает голос, но голос не обходит общий выключатель ботов', () => {
  assert.equal(rules.normalizeBotSettings({ enabled: true, voice: false }).voice, false);
  assert.equal(rules.botVoiceEnabled({ enabled: true }), true);
  assert.equal(rules.botVoiceEnabled({ enabled: true, voice: true }), true);
  assert.equal(rules.botVoiceEnabled({ enabled: true, voice: false }), false);
  for (const enabled of [undefined, false]) for (const voice of [undefined, false, true])
    assert.equal(rules.botVoiceEnabled({ enabled, voice }), false);
});
it('R306 первый и пустой срезы голоса не создают выдуманных выходов', () => {
  for (const prev of [null, undefined, []]) assert.deepEqual(rules.voiceStateDiff(prev, ['a']), { joined: ['a'], left: [] });
  assert.deepEqual(rules.voiceStateDiff([], []), { joined: [], left: [] });
  assert.deepEqual(rules.voiceStateDiff(['a'], []), { joined: [], left: ['a'] });
});
it('R306 screen-companion, пустые id и дубли не участвуют в разнице, порядок людей сохраняется', () => {
  assert.deepEqual(rules.voiceStateDiff(['b', 'a', 'b', 'a#screen', ''], ['c', 'a', 'c', 'c#screen', 'd']),
    { joined: ['c', 'd'], left: ['b'] });
  assert.deepEqual(rules.voiceStateDiff(['a', 'b'], ['b', 'a', 'b']), { joined: [], left: [] });
});
it('R306 человек сбрасывает одиночество, пустой канал и канал без ботов его не начинают', () => {
  for (const members of [[], [{}], [{ bot: false }], [{ bot: true }, {}]])
    assert.equal(rules.botAloneSince(members, 10, 20), null);
});
it('R306 одни боты начинают отсчёт один раз и сохраняют даже отметку нулевой секунды', () => {
  for (const members of [[{ bot: true }], [{ bot: true }, { bot: true }]]) {
    assert.equal(rules.botAloneSince(members, null, 20), 20);
    assert.equal(rules.botAloneSince(members, 10, 20), 10);
    assert.equal(rules.botAloneSince(members, 0, 20), 0);
  }
});
it('R306 бот уходит ровно через 300 секунд, отсутствие отметки и откат часов не считаются истечением', () => {
  assert.equal(rules.BOT_VOICE_ALONE_S, 300);
  for (const [at, expired] of [[999, false], [1299, false], [1300, true], [1301, true]] as const)
    assert.equal(rules.botAloneExpired(1000, at, 300), expired);
  assert.equal(rules.botAloneExpired(null, 1e9, 300), false);
});
const mutants = [
  ['SPEAK проверяется до CONNECT', "if (!has(i.perms, Permission.CONNECT))", "if (!has(i.perms, Permission.CONNECT) && has(i.perms, Permission.SPEAK))",
    (r: typeof rules) => assert.equal(r.botVoiceDecision({ ...base, perms: 0n })?.description,
      'Forbidden: not enough rights to connect to the voice chat', 'R306 порядок CONNECT перед SPEAK'),
    'R306 порядок CONNECT перед SPEAK', 'Forbidden: not enough rights to speak in the voice chat', 'Forbidden: not enough rights to connect to the voice chat'],
  ['четвёртый бот проходит', '(i.botsInChannel ?? 0) >= BOT_VOICE_PER_CHANNEL', '(i.botsInChannel ?? 0) > BOT_VOICE_PER_CHANNEL',
    (r: typeof rules) => assert.equal(r.botVoiceDecision({ ...base, botsInChannel: 3 })?.code, 400, 'R306 четвёртому боту отказ'),
    'R306 четвёртому боту отказ', undefined, 400],
  ['одиннадцатая комната проходит', '(i.otherRooms ?? 0) >= BOT_VOICE_MAX_ROOMS', '(i.otherRooms ?? 0) > BOT_VOICE_MAX_ROOMS',
    (r: typeof rules) => assert.equal(r.botVoiceDecision({ ...base, otherRooms: 10 })?.code, 400, 'R306 одиннадцатой комнате отказ'),
    'R306 одиннадцатой комнате отказ', undefined, 400],
  ['ровно пять минут ещё не истекли', 'nowS - aloneSince >= aloneS', 'nowS - aloneSince > aloneS',
    (r: typeof rules) => assert.equal(r.botAloneExpired(1000, 1300, 300), true, 'R306 ровно пять минут истекли'),
    'R306 ровно пять минут истекли', false, true],
] as const;
for (const [title, from, to, check, marker, actual, expected] of mutants) it(`R306 контрфакт: ${title}`, () => {
  check(rules); check(load());
  assert.throws(() => check(load(from, to)), e => e instanceof assert.AssertionError && e.code === 'ERR_ASSERTION'
    && e.operator === 'strictEqual' && e.message.startsWith(marker) && e.actual === actual && e.expected === expected);
});
