import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { it } from 'node:test';
import { runInNewContext } from 'node:vm';
import ts from 'typescript';
import * as rules from './ephemeral.js';
import * as fields from './fieldRules.js';
import * as wire from './convWire.js';
import * as actions from '../typingAction.js';

const fixture = (name: string): Record<string, any> => JSON.parse(readFileSync(new URL(`./fixtures/v1/${name}.json`, import.meta.url), 'utf8'));
const typing = fixture('ephemeral-typing');
const presence = fixture('ephemeral-presence');
const source = readFileSync(new URL('./ephemeral.ts', import.meta.url), 'utf8');
function load(raw: string): typeof rules {
  const module = { exports: {} };
  const dependencies: Record<string, unknown> = { './fieldRules': fields, './convWire': wire, '../typingAction': actions };
  runInNewContext(ts.transpileModule(raw, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText,
    { module, exports: module.exports, require: (id: string) => { assert.ok(Object.hasOwn(dependencies, id), `неописанный импорт ${id}`); return dependencies[id]; } });
  return module.exports as typeof rules;
}
function parsed(value: unknown): rules.FedEphemeralWire {
  const result = rules.parseEphemeralWire(value);
  assert.ok(result && result !== 'unknown'); return result;
}
it('R197 исторические typing и presence сохраняют личности, время и приватную категорию после круга провода', () => {
  // Проверяем существующий провод, а не заново придуманное представление мгновенного события.
  const t = parsed(typing); assert.equal(t.kind, 'typing');
  assert.equal(t.user.instanceId, typing.user.instance_id); assert.equal(t.user.userId, typing.user.user_id);
  assert.equal(t.kind === 'typing' && t.conversationId, typing.conversation_id);
  assert.equal(t.kind === 'typing' && t.action, 'voice'); assert.equal(t.kind === 'typing' && t.until, typing.until);
  const p = parsed(presence); assert.equal(p.kind, 'presence');
  assert.equal(p.kind === 'presence' && p.online, false); assert.equal(p.kind === 'presence' && p.at, presence.at);
  assert.equal(p.kind === 'presence' && p.views[0].lastSeen, presence.views[0].last_seen);
  assert.equal(p.kind === 'presence' && p.views[1].approx, 'recently');
  for (const event of [t, p]) assert.deepEqual(rules.parseEphemeralWire(rules.serializeEphemeralWire(event.user.instanceId, event)), event);
});
it('R197 typing не пишет обычное действие и stop=false, неизвестное действие читается как печатает', () => {
  const original = parsed({ ...typing, action: 'typing' }); assert.equal(original.kind, 'typing');
  const serialized = rules.serializeEphemeralWire('home', original);
  assert.equal(Object.hasOwn(serialized, 'action'), false); assert.equal(Object.hasOwn(serialized, 'stop'), false);
  for (const action of [undefined, null, '', 'future-action', 5]) {
    const result = parsed({ ...typing, action }); assert.equal(result.kind === 'typing' && result.action, 'typing');
  }
  const stopped = parsed({ ...typing, stop: true });
  assert.equal(rules.serializeEphemeralWire('home', stopped).stop, true);
  assert.equal(parsed({ ...typing, stop: 'true' }).kind === 'typing' && (parsed({ ...typing, stop: 'true' }) as rules.FedTypingWire).stop, false);
});
it('R197 точное last_seen сильнее approx, негодное время оставляет допустимую категорию без утечки', () => {
  for (const at of [0, presence.at]) {
    const event = parsed({ ...presence, views: [{ ...presence.views[0], last_seen: at, approx: 'week' }] }) as rules.FedPresenceWire;
    assert.equal(event.views[0].lastSeen, at); assert.equal(event.views[0].approx, null);
  }
  for (const at of [null, undefined, NaN, Infinity, '1760270395000']) {
    const event = parsed({ ...presence, views: [{ ...presence.views[0], last_seen: at, approx: 'week' }] }) as rules.FedPresenceWire;
    assert.equal(event.views[0].lastSeen, null); assert.equal(event.views[0].approx, 'week');
  }
  for (const approx of ['recently', 'week', 'month', 'long', 'future', null]) {
    const event = parsed({ ...presence, views: [{ ...presence.views[0], last_seen: null, approx }] }) as rules.FedPresenceWire;
    assert.equal(event.views[0].approx, approx === 'future' ? null : approx);
  }
});
it('R197 потолок views=200 действует с обеих сторон, битые строки отбрасываются поштучно', () => {
  assert.equal(rules.FED_PRESENCE_VIEWS_MAX, 200);
  for (const count of [199, 200, 201]) {
    const views = Array.from({ length: count }, () => presence.views[0]);
    const event = parsed({ ...presence, views }) as rules.FedPresenceWire;
    assert.equal(event.views.length, Math.min(count, 200));
    assert.equal((rules.serializeEphemeralWire('home', { ...event, views: Array.from({ length: count }, () => event.views[0]) }).views as unknown[]).length, Math.min(count, 200));
  }
  const event = parsed({ ...presence, views: [null, {}, { user: {} }, presence.views[1]] }) as rules.FedPresenceWire;
  assert.equal(event.views.length, 1); assert.equal(event.views[0].user.userId, presence.views[1].user.user_id);
  for (const views of [null, undefined, {}]) assert.equal((parsed({ ...presence, views }) as rules.FedPresenceWire).views.length, 0);
});
function onlineContract(api: typeof rules) {
  for (const online of [undefined, null, 0, 1, 'true', 'false'])
    assert.equal(api.parseEphemeralWire({ ...presence, online }), null, 'presence требует настоящий boolean');
  for (const online of [false, true]) {
    const result = api.parseEphemeralWire({ ...presence, online });
    assert.equal(typeof result === 'object' && result?.kind === 'presence' && result.online, online);
  }
}
it('R197 presence принимает оба boolean online и отклоняет truthy-подделки', () => onlineContract(rules));
function kindContract(api: typeof rules) {
  for (const kind of [undefined, null, 0, {}]) assert.equal(api.parseEphemeralWire({ ...presence, kind }), null, 'без строкового kind конверт негоден');
  for (const kind of ['future', 'Typing', '']) assert.equal(api.parseEphemeralWire({ ...presence, kind }), 'unknown');
  for (const value of [null, undefined, 0, 'typing']) assert.equal(api.parseEphemeralWire(value), null);
}
it('R197 неизвестный строковый kind пропускается, отсутствие kind не выдаётся за новое событие', () => kindContract(rules));
it('R197 негодные личности и время конверта отклоняются, нулевое конечное время принимается', () => {
  for (const base of [typing, presence]) {
    for (const user of [null, {}, { instance_id: 'home' }, { instance_id: 'home', user_id: '' }]) assert.equal(rules.parseEphemeralWire({ ...base, user }), null);
    const key = base.kind === 'typing' ? 'until' : 'at';
    for (const at of [undefined, null, NaN, Infinity, '0']) assert.equal(rules.parseEphemeralWire({ ...base, [key]: at }), null);
    assert.notEqual(rules.parseEphemeralWire({ ...base, [key]: 0 }), null);
  }
  for (const conversation_id of [null, '', {}]) assert.equal(rules.parseEphemeralWire({ ...typing, conversation_id }), null);
});
for (const [name, anchor, replacement, check, target] of [
  ['online без проверки типа', " || typeof r.online !== 'boolean'", '', onlineContract, 'presence требует настоящий boolean'],
  ['отсутствующий kind считается unknown', "return typeof r.kind === 'string' ? 'unknown' : null;", "return 'unknown';", kindContract, 'без строкового kind'],
] as const) it(`R197 мутант «${name}» отвергается адресным контрактом целого модуля`, () => {
  check(rules); check(load(source)); assert.equal(source.split(anchor).length - 1, 1, 'единственный якорь');
  const mutant = load(source.replace(anchor, replacement));
  assert.throws(() => check(mutant), e => e instanceof assert.AssertionError && e.message.includes(target));
});
