import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { it } from 'node:test';
import { runInNewContext } from 'node:vm';
import ts from 'typescript';
import * as real from './ephemeral.js';
import * as fields from './fieldRules.js';
import * as wire from './convWire.js';
import * as typing from '../typingAction.js';

const source = readFileSync(new URL('./ephemeral.ts', import.meta.url), 'utf8').replace(/\r\n/g, '\n');
const fixture = (name: string) => JSON.parse(readFileSync(new URL(`./fixtures/v1/${name}.json`, import.meta.url), 'utf8'));
const raw = fixture('ephemeral-presence-msgpriv');
const plain = (v: unknown) => JSON.parse(JSON.stringify(v));
function load(text = source): typeof real {
  const module = { exports: {} }, deps: Record<string, unknown> = { './fieldRules': fields, './convWire': wire, '../typingAction': typing };
  runInNewContext(ts.transpileModule(text, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText,
    { module, exports: module.exports, require(id: string) { assert.ok(Object.hasOwn(deps, id), `явный импорт всего ephemeral: ${id}`); return deps[id]; } });
  return module.exports as typeof real;
}
function parse(value: unknown, api = real): real.FedPresenceWire {
  const event = api.parseEphemeralWire(value); assert.ok(event && event !== 'unknown' && event.kind === 'presence'); return event;
}
it('R212 историческая запись no_messages проходит круг провода без потери адресного отказа', () => {
  const e = parse(raw); assert.equal(e.views[0]!.noMessages, true); assert.equal(e.views[1]!.noMessages, undefined);
  assert.deepEqual(plain(real.serializeEphemeralWire(e.user.instanceId, e)), raw);
});
function strictFlag(api = real) {
  const e = parse({ ...raw, views: [{ ...raw.views[0], no_messages: 'yes' }] }, api);
  assert.equal(e.views[0]!.noMessages, undefined, 'R212-no-messages-boolean: строка не обещает запрет сообщений');
}
it('R212 отказ сообщений включается только буквальным true, мусор и false остаются совместимыми', () => {
  strictFlag();
  for (const value of [undefined, null, false, 0, 1, '', [], {}]) assert.equal(parse({ ...raw, views: [{ ...raw.views[0], no_messages: value }] }).views[0]!.noMessages, undefined);
  assert.equal(parse({ ...raw, views: [{ ...raw.views[0], no_messages: true }] }).views[0]!.noMessages, true);
});
function legacy(api = real) {
  const before = fixture('ephemeral-presence'), e = parse(before, api), out = api.serializeEphemeralWire(e.user.instanceId, e);
  assert.equal((out.views as object[]).some(v => Object.hasOwn(v, 'no_messages')), false, 'R212-legacy-presence: отсутствие отказа не сериализуется как новый запрет');
  assert.deepEqual(plain(out), before);
}
it('R212 старая запись присутствия остаётся без поля no_messages после круга', () => legacy());
it('R212 empty views не добавляет запреты, а точное время и категория сохраняются рядом с отказом', () => {
  assert.deepEqual(real.serializeEphemeralWire(raw.instance_id, parse({ ...raw, views: [] })).views, []);
  const p = parse(raw); assert.equal(p.views[0]!.lastSeen, raw.views[0].last_seen); assert.equal(p.views[1]!.approx, 'recently');
});
it('R212 контрфакт truthy-разбор превращает строку yes в запрет сообщений', () => {
  strictFlag(load(source)); const from = 'r.no_messages === true'; assert.equal(source.split(from).length - 1, 1);
  assert.throws(() => strictFlag(load(source.replace(from, 'r.no_messages'))), e => e instanceof assert.AssertionError
    && e.message.startsWith('R212-no-messages-boolean:') && e.operator === 'strictEqual' && e.actual === true && e.expected === undefined);
});
it('R212 контрфакт всегда записывает запрет и ломает совместимость со старым presence', () => {
  legacy(load(source)); const from = '...(v.noMessages ? { no_messages: true } : {}),'; assert.equal(source.split(from).length - 1, 1);
  assert.throws(() => legacy(load(source.replace(from, 'no_messages: true,'))), e => e instanceof assert.AssertionError
    && e.message.startsWith('R212-legacy-presence:') && e.operator === 'strictEqual' && e.actual === true && e.expected === false);
});
