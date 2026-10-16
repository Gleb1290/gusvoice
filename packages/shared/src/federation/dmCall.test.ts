import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { it } from 'node:test';
import { runInNewContext } from 'node:vm';
import ts from 'typescript';
import * as calls from './dmCall.js';
import * as fields from './fieldRules.js';

const invite = JSON.parse(readFileSync(new URL('./fixtures/v1/call-invite.json', import.meta.url), 'utf8'));
const states = JSON.parse(readFileSync(new URL('./fixtures/v1/event-call-state.json', import.meta.url), 'utf8')).events.map((e: { payload: unknown }) => e.payload);
const source = readFileSync(new URL('./dmCall.ts', import.meta.url), 'utf8');
function load(raw: string): typeof calls {
  const module = { exports: {} };
  runInNewContext(ts.transpileModule(raw, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText,
    { module, exports: module.exports, require: (id: string) => { assert.equal(id, './fieldRules'); return fields; } });
  return module.exports as typeof calls;
}
function mutated(anchor: string, to: string) {
  assert.equal(source.split(anchor).length - 1, 1, 'единственный якорь провода'); return load(source.replace(anchor, to));
}
it('R200 исторические приглашение и обе фазы звонка переживают serialize parse без потери полей', () => {
  // Измеряем реальный формат fixtures, включая ended, а не только положительную active.
  const v = calls.parseCallInvite(invite); assert.ok(v);
  assert.deepEqual(calls.parseCallInvite(calls.serializeCallInvite(v)), v);
  for (const raw of states) { const state = calls.parseCallState(raw); assert.ok(state); assert.deepEqual(calls.parseCallState(calls.serializeCallState(state)), state); }
});
function expiry(api: typeof calls) {
  assert.equal(api.parseCallInvite(invite)?.expiresAt, invite.expires_at);
  for (const bad of [undefined, null, '123', NaN, Infinity]) assert.equal(api.parseCallInvite({ ...invite, expires_at: bad }), null, 'приглашение требует конечный expires_at');
}
it('R200 приглашение требует все личности и конечные created expires, video пишется только true', () => {
  expiry(calls);
  for (const key of ['instance_id', 'call_id', 'conversation_id', 'to_user_id', 'from', 'created_at']) assert.equal(calls.parseCallInvite({ ...invite, [key]: null }), null);
  assert.equal(calls.parseCallInvite({ ...invite, video: 'true' })?.video, false);
  assert.equal(calls.parseCallInvite({ ...invite, video: true })?.video, true);
});
function phases(api: typeof calls) {
  for (const phase of ['active', 'ended']) assert.equal(api.parseCallState({ ...states[0], phase })?.phase, phase, 'обе известные фазы принимаются');
  for (const phase of [undefined, '', 'ringing', 'future', true]) assert.equal(api.parseCallState({ ...states[0], phase }), null, 'неизвестная фаза не угадывается');
}
it('R200 незнакомая фаза не угадывается, незнакомая причина ended становится hangup', () => {
  phases(calls);
  for (const reason of ['missed', 'busy', 'hangup', 'disconnect']) assert.equal(calls.parseCallState({ ...states[1], reason })?.reason, reason);
  assert.equal(calls.parseCallState({ ...states[1], reason: 'new-reason' })?.reason, 'hangup');
  assert.equal(calls.parseCallState({ ...states[0], reason: 'missed' })?.reason, undefined);
});
it('R200 имя устройства проверяется с обеих сторон64, длительность округляется вниз и не бывает отрицательной', () => {
  // Негодная метка не должна погасить все устройства, а NaN не попадает в длительность истории.
  for (const device of ['a', 'a'.repeat(64), 'tab-1:mobile._']) assert.equal(calls.parseCallState({ ...states[0], callee_device: device })?.calleeDevice, device);
  for (const device of ['', 'a'.repeat(65), 'device with space', null, 1]) assert.equal(calls.parseCallState({ ...states[0], callee_device: device })?.calleeDevice, undefined);
  assert.equal(calls.parseCallState({ ...states[1], duration: 0 })?.duration, 0);
  assert.equal(calls.parseCallState({ ...states[1], duration: 1.9 })?.duration, 1);
  for (const duration of [-1, Infinity, NaN, '123']) assert.equal(calls.parseCallState({ ...states[1], duration })?.duration, undefined);
});
it('R200 ответы приглашения принимают ok true и известные отказы, незнакомый отказ unavailable', () => {
  for (const answer of [{ ok: true } as const, ...calls.FED_CALL_REFUSALS.map(refused => ({ refused }))]) assert.deepEqual(calls.parseCallInviteAnswer(calls.serializeCallInviteAnswer(answer)), answer);
  assert.deepEqual(calls.parseCallInviteAnswer({ refused: 'future-refusal' }), { refused: 'unavailable' });
  for (const raw of [null, {}, { ok: false }, { ok: 'true' }, { refused: 1 }]) assert.equal(calls.parseCallInviteAnswer(raw), null);
});
it('R200 мутант только active теряет ended и обнаруживается по исторической паре фаз', () => {
  phases(load(source));
  assert.throws(() => phases(mutated("r.phase === 'active' || r.phase === 'ended'", "r.phase === 'active'")), e => e instanceof assert.AssertionError && e.message.includes('обе известные фазы'));
});
it('R200 мутант без проверки expires_at принимает повреждённое приглашение', () => {
  expiry(load(source));
  assert.throws(() => expiry(mutated(' || expiresAt === null', '')), e => e instanceof assert.AssertionError && e.message.includes('приглашение требует конечный expires_at'));
});
