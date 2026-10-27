import assert from 'node:assert/strict';
import { webcrypto } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { it } from 'node:test';
import { runInNewContext } from 'node:vm';
import ts from 'typescript';
import { DEFAULT_TOLERANCE_S, parseSignatureHeader, SIGNATURE_HEADER, verifyWebhookSignature } from './webhook.js';

const source = readFileSync(new URL('./webhook.ts', import.meta.url), 'utf8').replaceAll('\r\n', '\n');
type WebhookModule = typeof import('./webhook.js');
// URL оставлен runtime-строкой: SDK build с rootDir=src не должен затягивать серверные .ts в свой dist.
const serverModuleUrl = new URL('../../backend/src/bots/botRules.js', import.meta.url).href;
async function signature(body: string | Buffer, nowS: number, secret = 'synthetic-webhook-secret'): Promise<string> {
  const server = await import(serverModuleUrl) as { webhookSignature(secret: string, body: string | Buffer, nowS: number): string };
  return server.webhookSignature(secret, body, nowS);
}
const secret = 'synthetic-webhook-secret';
const now = 1_800_000_000;
const body = '{ "text": "Гусь 🪿", "n": 1 }\n';

function load(raw: string): WebhookModule {
  const module = { exports: {} };
  runInNewContext(ts.transpileModule(raw, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText,
    { module, exports: module.exports, TextEncoder, TextDecoder, Uint8Array, crypto: webcrypto });
  return module.exports as WebhookModule;
}
function change(from: string, to: string): string {
  assert.equal(source.split(from).length - 1, 1, 'уникальный якорь контрфакта webhook');
  return source.replace(from, to);
}
function guardFailure(error: unknown, label: string, actual: unknown, expected: unknown): boolean {
  return error instanceof assert.AssertionError && error.code === 'ERR_ASSERTION'
    && error.message.split(/\r?\n/, 1)[0] === label && error.operator === 'strictEqual'
    && error.actual === actual && error.expected === expected;
}

it('R299 SDK принимает настоящую серверную подпись строки и её точных UTF-8 байтов', async () => {
  assert.equal(SIGNATURE_HEADER, 'x-gusvoice-signature');
  assert.equal(DEFAULT_TOLERANCE_S, 300);
  const header = await signature(body, now);
  assert.equal(await verifyWebhookSignature(secret, header, body, { nowS: now }), true);
  assert.equal(await verifyWebhookSignature(secret, header, Buffer.from(body, 'utf8'), { nowS: now }), true);
});

it('R299 окно подписи допускает ровно 300 секунд в обе стороны и отсекает 301', async () => {
  for (const delta of [-300, 300, -301, 301]) {
    const header = await signature(body, now + delta);
    assert.equal(await verifyWebhookSignature(secret, header, body, { nowS: now }), Math.abs(delta) <= 300, String(delta));
  }
});

it('R299 своё окно времени применяется на обеих границах, включая нулевое', async () => {
  for (const delta of [-11, -10, 0, 10, 11]) {
    const header = await signature(body, now + delta);
    assert.equal(await verifyWebhookSignature(secret, header, body, { nowS: now, toleranceS: 10 }), Math.abs(delta) <= 10);
  }
  assert.equal(await verifyWebhookSignature(secret, await signature(body, now), body, { nowS: now, toleranceS: 0 }), true);
  assert.equal(await verifyWebhookSignature(secret, await signature(body, now - 1), body, { nowS: now, toleranceS: 0 }), false);
});

it('R299 чужой и пустой секреты отвергаются, исходный секрет принимается', async () => {
  const header = await signature(body, now);
  assert.equal(await verifyWebhookSignature('another-secret', header, body, { nowS: now }), false);
  assert.equal(await verifyWebhookSignature('', header, body, { nowS: now }), false);
  assert.equal(await verifyWebhookSignature(secret, header, body, { nowS: now }), true);
});

it('R299 изменение даже пробела исходного JSON ломает подпись без изменения смысла JSON', async () => {
  const header = await signature(body, now);
  assert.equal(await verifyWebhookSignature(secret, header, JSON.stringify(JSON.parse(body)), { nowS: now }), false);
  assert.equal(await verifyWebhookSignature(secret, header, body.replace('Гусь', 'Утка'), { nowS: now }), false);
  assert.equal(await verifyWebhookSignature(secret, header, body, { nowS: now }), true);
});

it('R299 отсутствующий, сломанный, неполный и не-hex заголовки отвергаются', async () => {
  const valid = await signature(body, now);
  const mac = valid.split('v1=')[1];
  for (const header of [null, undefined, '', 'broken', `v1=${mac}`, `t=${now}`, `t=no,v1=${mac}`, `t=-1,v1=${mac}`,
    `t=1234567890123,v1=${mac}`, `t=${now},v1=${'g'.repeat(64)}`, `t=${now},v1=${'a'.repeat(63)}`]) {
    assert.equal(await verifyWebhookSignature(secret, header, body, { nowS: now }), false, String(header));
  }
  assert.equal(await verifyWebhookSignature(secret, valid, body, { nowS: now }), true);
});

it('R299 при ротации достаточно одной верной v1 в любой позиции, одних неверных недостаточно', async () => {
  const valid = await signature(body, now);
  const mac = valid.split('v1=')[1];
  const wrong = '0'.repeat(64);
  for (const values of [[wrong, mac], [mac, wrong], [wrong, mac, wrong]]) {
    const header = `t=${now},${values.map(v => `v1=${v}`).join(',')}`;
    assert.equal(await verifyWebhookSignature(secret, header, body, { nowS: now }), true);
  }
  assert.equal(await verifyWebhookSignature(secret, `t=${now},v1=${wrong},v1=${'1'.repeat(64)}`, body, { nowS: now }), false);
});

it('R299 разбор заголовка допускает пробелы, неизвестные поля и uppercase hex', async () => {
  const valid = await signature(body, now);
  const mac = valid.split('v1=')[1];
  const header = ` ignored = future, t = ${now}, v1 = ${mac.toUpperCase()}, v2=anything `;
  assert.deepEqual(parseSignatureHeader(header), { t: now, v1: [mac] });
  assert.equal(await verifyWebhookSignature(secret, header, body, { nowS: now }), true);
});

it('R299 контрфакт постоянного успеха принимает HMAC с чужим секретом', async () => {
  const header = await signature(body, now, 'another-secret');
  const scenario = async (raw: string) => {
    assert.equal(await load(raw).verifyWebhookSignature(secret, header, body, { nowS: now }), false, 'R299-webhook-проверяет-HMAC');
  };
  await scenario(source);
  await assert.rejects(scenario(change('  return ok;', '  return true;')),
    error => guardFailure(error, 'R299-webhook-проверяет-HMAC', true, false));
});

it('R299 контрфакт без окна принимает старую, но правильно подписанную доставку', async () => {
  const header = await signature(body, now - 301);
  const scenario = async (raw: string) => {
    assert.equal(await load(raw).verifyWebhookSignature(secret, header, body, { nowS: now }), false, 'R299-webhook-отсекает-replay');
  };
  await scenario(source);
  const mutant = change('if (Math.abs(now - sig.t) > (options.toleranceS ?? DEFAULT_TOLERANCE_S)) return false;', '/* окно удалено */');
  await assert.rejects(scenario(mutant), error => guardFailure(error, 'R299-webhook-отсекает-replay', true, false));
});

it('R299 контрфакт без Math.abs принимает подпись из слишком далёкого будущего', async () => {
  const header = await signature(body, now + 301);
  const scenario = async (raw: string) => {
    assert.equal(await load(raw).verifyWebhookSignature(secret, header, body, { nowS: now }), false, 'R299-webhook-проверяет-будущее');
  };
  await scenario(source);
  const mutant = change('Math.abs(now - sig.t)', '(now - sig.t)');
  await assert.rejects(scenario(mutant), error => guardFailure(error, 'R299-webhook-проверяет-будущее', true, false));
});
