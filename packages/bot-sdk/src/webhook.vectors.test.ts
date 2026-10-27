import assert from 'node:assert/strict';
import { webcrypto } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { it } from 'node:test';
import { runInNewContext } from 'node:vm';
import ts from 'typescript';
import * as webhook from './webhook.js';

type Vector = { name: string; secret: string; body: string; now_s: number; tolerance_s: number | null; header: string | null; expect: boolean };
const fixture = JSON.parse(readFileSync(new URL('../test-vectors/webhook-signature.json', import.meta.url), 'utf8')) as { cases: Vector[] };
const source = readFileSync(new URL('./webhook.ts', import.meta.url), 'utf8').replaceAll('\r\n', '\n');
const serverUrl = new URL('../../backend/src/bots/botRules.js', import.meta.url).href;
function load(raw = source) {
  const exports = {};
  const reads: number[] = [], cryptoCalls: string[] = [];
  // Подмена среды наблюдает ВСЕ чтения символов реальным safeEqual, не меряет шумное время процессора.
  const instrumentation = `{
    const original = String.prototype.charCodeAt;
    String.prototype.charCodeAt = function(i) { __reads.push(i); return original.call(this, i); };
  }\n`;
  runInNewContext(instrumentation + ts.transpileModule(raw, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS } }).outputText,
    { exports, __reads: reads, TextEncoder, Uint8Array, crypto: { subtle: {
      importKey: (...args: Parameters<typeof webcrypto.subtle.importKey>) => { cryptoCalls.push('importKey'); return webcrypto.subtle.importKey(...args); },
      sign: (...args: Parameters<typeof webcrypto.subtle.sign>) => { cryptoCalls.push('sign'); return webcrypto.subtle.sign(...args); },
    } }, require: (name: string) => { throw new Error(`R307 подпись: неописанный импорт ${name}`); } });
  return { mod: exports as typeof webhook, reads, cryptoCalls };
}
const options = (v: Vector) => ({ nowS: v.now_s, ...(v.tolerance_s === null ? {} : { toleranceS: v.tolerance_s }) });
it('R307 один общий набор подписи содержит 29 уникальных случаев', () => {
  assert.equal(fixture.cases.length, 29); assert.equal(new Set(fixture.cases.map(v => v.name)).size, 29);
});
for (const v of fixture.cases) it(`R307 общий вектор подписи: ${v.name}`, async () => {
  assert.equal(await webhook.verifyWebhookSignature(v.secret, v.header, v.body, options(v)), v.expect);
  assert.equal(await webhook.verifyWebhookSignature(v.secret, v.header, Buffer.from(v.body, 'utf8'), options(v)), v.expect);
  if (v.expect) {
    const parsed = webhook.parseSignatureHeader(v.header); assert.ok(parsed);
    const server = await import(serverUrl) as { webhookSignature(secret: string, body: string | Buffer, nowS: number): string };
    const signed = server.webhookSignature(v.secret, Buffer.from(v.body, 'utf8'), parsed.t);
    assert.equal(parsed.v1.includes(signed.split('v1=')[1]), true, 'R307 правильный вектор совпадает с реальным HMAC сервера');
    assert.equal(await webhook.verifyWebhookSignature(v.secret, signed, v.body, options(v)), true);
  }
});
function vector(name: string) { const v = fixture.cases.find(c => c.name === name); assert.ok(v, `R307 вектор ${name} существует`); return v; }
async function stale(raw = source) {
  const v = vector('too-old');
  assert.equal(await load(raw).mod.verifyWebhookSignature(v.secret, v.header, v.body, options(v)), false, 'R307 окно не шире 300 секунд');
}
async function uppercase(raw = source) {
  const v = vector('valid-uppercase-hex');
  assert.equal(await load(raw).mod.verifyWebhookSignature(v.secret, v.header, v.body, options(v)), true, 'R307 uppercase HMAC принимается');
}
async function timestamp(raw = source) {
  const v = vector('valid-uppercase-hex');
  assert.equal(load(raw).mod.parseSignatureHeader(v.header!.replace(/^t=\d+,/, '')) === null, true, 'R307 без t заголовок недействителен');
}
async function constantTime(raw = source) {
  const v = vector('valid-uppercase-hex');
  const parsed = webhook.parseSignatureHeader(v.header)!; const valid = parsed.v1[0];
  for (const index of [0, 31, 63, -1]) {
    const mac = index < 0 ? valid : valid.slice(0, index) + (valid[index] === '0' ? '1' : '0') + valid.slice(index + 1);
    const h = load(raw);
    assert.equal(await h.mod.verifyWebhookSignature(v.secret, `t=${parsed.t},v1=${mac}`, v.body, options(v)), index < 0);
    assert.deepEqual(h.cryptoCalls, ['importKey', 'sign']);
    assert.equal(h.reads.length, 128, 'R307 HMAC сравнивает все 64 символа обеих строк');
    assert.deepEqual(h.reads, Array.from({ length: 64 }, (_, i) => [i, i]).flat());
  }
}
it('R307 HMAC: первое/среднее/последнее расхождение и успех читают одинаковые 64 пары символов', () => constantTime());
it('R307 HMAC разной длины отклоняется до crypto и без исключения', async () => {
  const v = vector('valid-uppercase-hex'); const parsed = webhook.parseSignatureHeader(v.header)!;
  for (const mac of [parsed.v1[0].slice(1), parsed.v1[0] + '0']) {
    const h = load();
    assert.equal(await h.mod.verifyWebhookSignature(v.secret, `t=${parsed.t},v1=${mac}`, v.body, options(v)), false);
    assert.deepEqual(h.cryptoCalls, []); assert.deepEqual(h.reads, []);
  }
});
const safeEqualBody = `  if (expected.length !== got.length) return false;
  let diff = 0;
  for (let i = 0; i < expected.length; i++) diff |= expected.charCodeAt(i) ^ got.charCodeAt(i);
  return diff === 0;`;
for (const c of [
  { name: 'окно 3000 секунд', from: 'export const DEFAULT_TOLERANCE_S = 300;', to: 'export const DEFAULT_TOLERANCE_S = 3000;', check: stale, marker: 'R307 окно не шире 300 секунд' },
  { name: 'нет проверки t', from: 'Number.isFinite(t) && v1.length > 0', to: 'v1.length > 0', check: timestamp, marker: 'R307 без t заголовок недействителен' },
  { name: 'нет нормализации hex', from: 'v1.push(v.toLowerCase())', to: 'v1.push(v)', check: uppercase, marker: 'R307 uppercase HMAC принимается' },
  { name: 'обычное равенство вместо полного сравнения', from: safeEqualBody, to: '  return expected === got;', check: constantTime, marker: 'R307 HMAC сравнивает все 64 символа обеих строк' },
]) it(`R307 подпись контрфакт: ${c.name}, оригинал проходит первым`, async () => {
  await c.check(source); assert.equal(source.split(c.from).length - 1, 1, 'R307 подпись: уникальный якорь');
  await assert.rejects(c.check(source.replace(c.from, c.to)), (e: unknown) => e instanceof assert.AssertionError
    && e.code === 'ERR_ASSERTION' && e.operator === 'strictEqual' && e.message.split('\n', 1)[0] === c.marker);
});
