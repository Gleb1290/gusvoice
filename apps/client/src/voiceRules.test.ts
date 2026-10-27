import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { it } from 'node:test';
import { runInNewContext } from 'node:vm';
import ts from 'typescript';
import * as rules from './voiceRules';

const source = readFileSync(new URL('./voiceRules.ts', import.meta.url), 'utf8').replace(/\r\n/g, '\n');
type Rules = typeof rules;
function load(raw: string): Rules {
  const module = { exports: {} as Rules };
  runInNewContext(ts.transpileModule(raw, { compilerOptions: {
    module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022,
  } }).outputText, { module, exports: module.exports,
    require(id: string) { throw Error(`Неописанный импорт voiceRules ${id}`); },
  });
  return module.exports;
}
function mutation(anchor: string, replacement: string, probe: (r: Rules) => void, marker: string) {
  assert.equal(source.split(anchor).length - 1, 1, 'якорь мутанта однозначен');
  probe(rules);
  assert.throws(() => probe(load(source.replace(anchor, replacement))),
    e => e instanceof assert.AssertionError && e.message.startsWith(marker),
    'мутант отвергается целевым контрактом, не ошибкой загрузки');
}

it('R306 булева метка bot:true в метаданных распознаётся и с соседними полями', () => {
  for (const metadata of ['{"bot":true}', '{"name":"music","bot":true,"avatarUrl":null}'])
    assert.equal(rules.isBotMetadata(metadata), true);
});

function metadataContract(r: Rules) {
  for (const raw of [undefined, null, '', 'broken JSON', 'null', 'true', '1', '"bot"', '[]', '{}',
    '{"bot":"true"}', '{"bot":1}', '{"bot":false}', '{"bot":null}'])
    assert.equal(r.isBotMetadata(raw), false, 'R306_METADATA: только булево true, без coercion');
}
it('R306 пустые, повреждённые и неверно типизированные метаданные не превращают человека в бота', () => metadataContract(rules));

it('R306 presence или метаданных достаточно по отдельности — второй источник не отменяет метку', () => {
  for (const presence of [undefined, [], [{ userId: 'music', bot: false }]])
    assert.equal(rules.isVoiceBot('music', presence, '{"bot":true}'), true);
  for (const metadata of [undefined, null, '', 'broken', '{"bot":false}'])
    assert.equal(rules.isVoiceBot('music', [{ userId: 'music', bot: true }], metadata), true);
});

it('R306 бот с другим id не заражает человека, а старый сервер без метки сохраняет прежний вид', () => {
  for (const presence of [undefined, [], [{ userId: 'someone-else', bot: true }], [{ userId: 'me', bot: false }], [{ userId: 'me' }]])
    assert.equal(rules.isVoiceBot('me', presence, '{"bot":false}'), false);
  assert.equal(rules.isVoiceBot('me', undefined), false);
});

const interleaved = [{ id: 'bot-z', bot: true }, { id: 'human-z' }, { id: 'bot-a', bot: true }, { id: 'human-a' }];
function orderContract(r: Rules) {
  assert.equal(r.botsAfterHumans(interleaved, p => p.bot === true).map(p => p.id).join(','),
    'human-z,human-a,bot-z,bot-a', 'R306_ORDER: порядок каждой части сохраняется, без сортировки по имени');
}
it('R306 общий список ставит ботов после людей и сохраняет исходный порядок внутри обеих частей', () => orderContract(rules));

it('R306 пустая, человеческая и ботская части возвращаются новой копией без изменения элементов', () => {
  for (const list of [[], interleaved.filter(p => !p.bot), interleaved.filter(p => p.bot)]) {
    const before = list.slice(); Object.freeze(list);
    const actual = rules.botsAfterHumans(list, p => p.bot === true);
    assert.notEqual(actual, list); assert.deepEqual(actual, before);
    actual.forEach((p, i) => assert.equal(p, before[i], 'элементы не клонируются и не подменяются'));
  }
});

it('R306 перемешанный readonly список не мутируется, предикат применяется к каждому ровно один раз', () => {
  const list = Object.freeze([...interleaved]); const seen: string[] = [];
  const actual = rules.botsAfterHumans(list, p => { seen.push(p.id); return p.bot === true; });
  assert.deepEqual(seen, interleaved.map(p => p.id));
  assert.deepEqual(list, interleaved); assert.equal(actual[0], list[1]); assert.equal(actual[2], list[0]);
});

function micContract(r: Rules) {
  for (const bot of [false, true]) for (const muted of [false, true]) for (const serverMuted of [false, true])
    assert.equal(r.showMicOff(bot, muted, serverMuted), bot ? serverMuted : muted,
      `R306_MIC: bot=${bot}, muted=${muted}, serverMuted=${serverMuted}`);
}
it('R306 матрица микрофона: тишина бота без значка, мьют модератором красный, человек по своему muted', () => micContract(rules));

it('R306 матрица деафена: человек сохраняет оба состояния, у бота наушников нет никогда', () => {
  for (const bot of [false, true]) for (const deafened of [false, true])
    assert.equal(rules.showDeafened(bot, deafened), !bot && deafened, `bot=${bot}, deafened=${deafened}`);
});

it('R306 социальные действия запрещены боту, человеку разрешены', () => {
  assert.equal(rules.botAcceptsSocial(true), false); assert.equal(rules.botAcceptsSocial(false), true);
});

it('R306 контрфакт строковой метки true отвергается реальным модулем', () => {
  mutation('?.bot === true', '?.bot == true || metadata?.includes(\'"true"\') === true', metadataContract, 'R306_METADATA:');
});

it('R306 контрфакт потери presence-метки отвергается даже при повреждённых метаданных', () => {
  const probe = (r: Rules) => assert.equal(r.isVoiceBot('music', [{ userId: 'music', bot: true }], 'broken'), true,
    'R306_PRESENCE: presence самодостаточен');
  mutation('if (presence?.some((p) => p.userId === userId && p.bot === true)) return true;',
    'if (false) return true;', probe, 'R306_PRESENCE:');
});

it('R306 контрфакт перестановки внутри человеческой и ботской частей отвергается', () => {
  mutation('[...humans, ...bots]', '[...humans.reverse(), ...bots.reverse()]', orderContract, 'R306_ORDER:');
});

it('R306 контрфакт значка выключенного микрофона у молчащего бота отвергается', () => {
  mutation('return isBot ? serverMuted : muted;', 'return isBot ? (muted || serverMuted) : muted;', micContract, 'R306_MIC:');
});
