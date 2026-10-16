import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { it } from 'node:test';
import { runInNewContext } from 'node:vm';
import ts from 'typescript';
import * as rules from './convVia.js';
import * as fields from './fieldRules.js';
import * as wire from './convWire.js';

const fixture = (name: string): Record<string, any> => JSON.parse(readFileSync(new URL(`./fixtures/v1/${name}.json`, import.meta.url), 'utf8'));
const page = fixture('conv-via-page');
const verdicts = fixture('event-conv-via-verdict');
const claim = { conversationId: page.items[0].conversation_id as string, clientId: page.items[0].client_id as string, payloadHash: 'a'.repeat(64) };
const source = readFileSync(new URL('./convVia.ts', import.meta.url), 'utf8');
function load(raw: string): typeof rules {
  const module = { exports: {} };
  const deps: Record<string, unknown> = { './fieldRules': fields, './convWire': wire };
  runInNewContext(ts.transpileModule(raw, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText,
    { module, exports: module.exports, require: (id: string) => { assert.ok(Object.hasOwn(deps, id), `неописанный импорт ${id}`); return deps[id]; } });
  return module.exports as typeof rules;
}
const input = (patch: Partial<Parameters<typeof rules.viaVerdictFor>[0]> = {}) => ({ clientId: claim.clientId, claimHash: null, wireHash: claim.payloadHash, ageMs: 0, sinceReportMs: null, ...patch });
function hashContract(api: typeof rules) {
  assert.equal(api.viaVerdictFor(input({ claimHash: claim.payloadHash })), 'confirmed', 'совпавший пересчитанный отпечаток подтверждается');
  assert.equal(api.viaVerdictFor(input({ claimHash: claim.payloadHash, wireHash: 'b'.repeat(64) })), 'rejected', 'пересчитанный отпечаток не совпал');
  assert.equal(api.viaVerdictFor(input({ clientId: null, claimHash: claim.payloadHash })), 'rejected', 'без clientId дом не ручается');
}
it('R198 совпадение claimHash с пересчитанным wireHash подтверждается, конфликт и отсутствие clientId отвергаются', () => {
  // wireHash здесь уже посчитан домом. Реальный пересчёт текста в decidePending покрывается backend-партией.
  hashContract(rules);
  assert.equal(rules.viaVerdictFor(input({ clientId: '', claimHash: claim.payloadHash })), 'rejected');
  assert.equal(rules.viaVerdictFor(input({ claimHash: '', wireHash: claim.payloadHash })), 'rejected');
  assert.equal(rules.viaVerdictFor(input({ claimHash: claim.payloadHash, ageMs: rules.FED_VIA_LIMITS.claimWaitMs, sinceReportMs: rules.FED_VIA_LIMITS.reportGraceMs })), 'confirmed');
});
it('R198 без отчёта семь суток минус миллисекунда ещё wait, ровно семь и позже unverified', () => {
  assert.equal(rules.FED_VIA_LIMITS.claimWaitMs, 7 * 24 * 60 * 60 * 1000);
  for (const ageMs of [0, rules.FED_VIA_LIMITS.claimWaitMs - 1]) assert.equal(rules.viaVerdictFor(input({ ageMs })), 'wait');
  for (const ageMs of [rules.FED_VIA_LIMITS.claimWaitMs, rules.FED_VIA_LIMITS.claimWaitMs + 1]) assert.equal(rules.viaVerdictFor(input({ ageMs })), 'unverified');
});
function graceContract(api: typeof rules) {
  assert.equal(api.viaVerdictFor(input({ sinceReportMs: 60 * 60 * 1000 - 1 })), 'wait', 'остальным устройствам остаётся час');
  assert.equal(api.viaVerdictFor(input({ sinceReportMs: 60 * 60 * 1000 })), 'rejected', 'ровно час без строки в отчёте означает лишнее сообщение');
}
it('R198 отчёт без строки оставляет час на остальные устройства, после часа отвергает даже просроченное сообщение', () => {
  assert.equal(rules.FED_VIA_LIMITS.reportGraceMs, 60 * 60 * 1000); graceContract(rules);
  assert.equal(rules.viaVerdictFor(input({ sinceReportMs: 60 * 60 * 1000 + 1 })), 'rejected');
  assert.equal(rules.viaVerdictFor(input({ ageMs: rules.FED_VIA_LIMITS.claimWaitMs, sinceReportMs: 60 * 60 * 1000 })), 'rejected');
});
it('R198 claims принимают ровно 500 строк, 501 отвергается целиком, пустой отчёт разрешён', () => {
  assert.equal(rules.FED_VIA_LIMITS.claimsMax, 500);
  assert.deepEqual(rules.parseViaClaims({ items: [] }), []);
  for (const count of [499, 500]) assert.equal(rules.parseViaClaims({ items: Array.from({ length: count }, () => claim) })?.length, count);
  assert.equal(rules.parseViaClaims({ items: Array.from({ length: 501 }, () => claim) }), null);
  for (const raw of [null, {}, { items: null }, { items: {} }]) assert.equal(rules.parseViaClaims(raw), null);
});
it('R198 claims допускают только hex64 нижнего регистра, битые строки не теряют соседнюю корректную', () => {
  for (const payloadHash of ['0'.repeat(64), '0123456789abcdef'.repeat(4)]) assert.deepEqual(rules.parseViaClaims({ items: [{ ...claim, payloadHash }] }), [{ ...claim, payloadHash }]);
  for (const payloadHash of ['a'.repeat(63), 'a'.repeat(65), 'g'.repeat(64), 'A'.repeat(64), '', null, 123])
    assert.deepEqual(rules.parseViaClaims({ items: [{ ...claim, payloadHash }, claim] }), [claim]);
  for (const row of [null, 1, {}, { ...claim, conversationId: '' }, { ...claim, clientId: '' }]) assert.deepEqual(rules.parseViaClaims({ items: [row, claim] }), [claim]);
});
it('R198 историческая via-страница сохраняет сообщение, негодные строки терпимо пропускаются и потолок 200 действует', () => {
  const parsed = rules.parseViaPage(page); assert.equal(parsed?.length, 1); assert.equal(parsed?.[0].content, page.items[0].content);
  assert.equal(parsed?.[0].clientId, page.items[0].client_id); assert.equal(parsed?.[0].payloadHash, page.items[0].payload_hash);
  assert.deepEqual(rules.parseViaPage(rules.serializeViaPage([wire.serializeConvMessageWire(parsed![0])])), parsed);
  assert.deepEqual(rules.parseViaPage({ items: [null, {}, page.items[0]] }), parsed);
  for (const count of [199, 200, 201]) assert.equal(rules.parseViaPage({ items: Array.from({ length: count }, () => page.items[0]) })?.length, Math.min(count, 200));
  for (const raw of [null, {}, { items: {} }]) assert.equal(rules.parseViaPage(raw), null);
});
it('R198 решения исторического события и все четыре вердикта переживают круг, неизвестный не угадывается', () => {
  for (const event of verdicts.events) {
    const parsed = rules.parseViaVerdict(event.payload); assert.ok(parsed);
    assert.equal(parsed.verdict, event.payload.verdict); assert.equal(parsed.messageId, event.payload.message_id);
    assert.deepEqual(rules.parseViaVerdict(rules.serializeViaVerdict(parsed)), parsed);
  }
  const base = verdicts.events[0].payload;
  for (const verdict of ['confirmed', 'rejected', 'duplicate', 'unverified']) assert.equal(rules.parseViaVerdict({ ...base, verdict })?.verdict, verdict);
  for (const verdict of ['future', 'CONFIRMED', '', null, true]) assert.equal(rules.parseViaVerdict({ ...base, verdict }), null);
  for (const row of [null, {}, { ...base, conversation_id: '' }, { ...base, message_id: '' }]) assert.equal(rules.parseViaVerdict(row), null);
});
for (const [name, anchor, replacement, check, target] of [
  ['всегда confirmed', "if (!input.clientId) return 'rejected';", "return 'confirmed';", hashContract, 'пересчитанный отпечаток не совпал'],
  ['сравнение отчёта с самим собой', 'input.claimHash === input.wireHash', 'input.claimHash === input.claimHash', hashContract, 'пересчитанный отпечаток не совпал'],
  ['убран час после отчёта', 'input.sinceReportMs !== null && input.sinceReportMs >= FED_VIA_LIMITS.reportGraceMs', 'input.sinceReportMs !== null', graceContract, 'остальным устройствам остаётся час'],
] as const) it(`R198 мутант «${name}» ломает адресный контракт целого via-модуля`, () => {
  check(rules); check(load(source)); assert.equal(source.split(anchor).length - 1, 1, 'единственный якорь');
  const mutant = load(source.replace(anchor, replacement));
  assert.throws(() => check(mutant), e => e instanceof assert.AssertionError && e.message.includes(target));
});
