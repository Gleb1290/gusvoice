import assert from 'node:assert/strict';
import { it } from 'node:test';
import { BOT_API_FEATURES, BOT_API_VERSION, BOT_UPDATE_TYPES } from './botRules.js';
import * as spec from './botSpec.js';
import { wireUpdate } from './botWire.js';
import { assertion, loadApi, loadSpec, plain, type Edit } from './botOpenApi.harness.js';

function parity(s = spec, edit?: Edit) {
  const f = loadApi(edit);
  try {
    assert.deepEqual(Array.from(s.BOT_METHOD_SPECS, m => m.name.toLowerCase()).sort(), Array.from(f.api.botMethodNames()).sort(), 'R307 реестр равен реальным методам');
  } finally { f.clean(); }
}
function versions(s = spec) {
  assert.equal([...s.BOT_METHOD_SPECS, ...s.BOT_EVENT_SPECS].every(m => [1, 2, 3, 4].includes(m.since)), true, 'R307 since известен');
}
function events(s = spec) {
  assert.deepEqual(Array.from(s.BOT_EVENT_SPECS, e => e.type), [...BOT_UPDATE_TYPES], 'R307 реестр событий полон');
  assert.deepEqual(Array.from(s.BOT_EVENT_SPECS, e => e.type).sort(), Object.keys(wireUpdate.shape).filter(k => k !== 'update_id').sort(), 'R307 события равны полям Update');
}
it('R307 реестр совпадает с настоящим botMethodNames в обе стороны, без загрузки базы и фоновых задач', () => { parity(); parity(loadSpec()); });
it('R307 имена методов и событий уникальны, у каждого метода настоящая схема результата и допустимый тег', () => {
  const names = spec.BOT_METHOD_SPECS.map(m => m.name.toLowerCase());
  assert.equal(new Set(names).size, names.length);
  assert.equal(new Set(spec.BOT_EVENT_SPECS.map(e => e.type)).size, spec.BOT_EVENT_SPECS.length);
  for (const m of spec.BOT_METHOD_SPECS) {
    assert.equal(typeof m.result.safeParse, 'function', `${m.name}: result`);
    assert.ok(spec.BOT_METHOD_TAGS.includes(m.tag));
    if (m.params !== null) assert.equal(typeof m.params.safeParse, 'function', `${m.name}: params`);
  }
});
it('R307 восемь событий реестра совпадают с BOT_UPDATE_TYPES и полями провода', () => { assert.equal(BOT_UPDATE_TYPES.length, 8); events(); events(loadSpec()); });
it('R307 since 1–4 сохраняет историю: голос с 4, кнопки с 2, реакции с 3, сообщения с 1', () => {
  versions(); versions(loadSpec());
  for (const [name, since] of [['getMe', 1], ['sendMessage', 1], ['answerCallbackQuery', 2], ['setMessageReaction', 3], ['joinVoice', 4], ['leaveVoice', 4], ['getVoiceChatMembers', 4]] as const)
    assert.equal(spec.BOT_METHOD_SPECS.find(m => m.name === name)?.since, since);
  assert.deepEqual(plain(spec.BOT_EVENT_SPECS.map(({ type, since }) => ({ type, since }))), BOT_UPDATE_TYPES.map((type, i) => ({ type, since: i < 4 ? 1 : i === 4 ? 2 : i < 7 ? 3 : 4 })));
});
it('R307 OpenAPI добавляет feature, но не меняет уже выпущенную API version 4', () => {
  assert.equal(BOT_API_VERSION, 4); assert.ok(BOT_API_FEATURES.includes('openapi')); assert.ok(BOT_API_FEATURES.includes('voice'));
});

const mutants: { title: string; edit: Edit; check(s: typeof spec): void; marker: string }[] = [
  { title: 'метод потерян из реестра', edit: { from: "  m('getMe', 1, 'bot', null, wireBot),", to: '' }, check: parity, marker: 'R307 реестр равен реальным методам' },
  { title: 'since переименован и пропал из записи', edit: { from: '  since,\n  tag,', to: '  sinceApi: since,\n  tag,' }, check: versions, marker: 'R307 since известен' },
  { title: 'событие голоса потеряно', edit: { from: "  { type: 'voice_state', since: 4, schema: wireVoiceState },", to: '' }, check: events, marker: 'R307 реестр событий полон' },
];
for (const m of mutants) it(`R307 контрфакт реестра: ${m.title}`, () => {
  m.check(spec); m.check(loadSpec()); assert.throws(() => m.check(loadSpec(m.edit)), assertion(m.marker));
});
it('R307 контрфакт: настоящий метод добавлен без записи в реестре', () => {
  parity();
  assert.throws(() => parity(spec, { from: "  joinvoice: voiceMethod('voiceJoin'),", to: "  unlisted: voiceMethod('voiceJoin'),\n  joinvoice: voiceMethod('voiceJoin')," }), assertion('R307 реестр равен реальным методам'));
});
