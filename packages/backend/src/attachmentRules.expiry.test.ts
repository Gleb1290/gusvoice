import assert from 'node:assert/strict';
import * as crypto from 'node:crypto';
import { readFileSync } from 'node:fs';
import { it } from 'node:test';
import { runInNewContext } from 'node:vm';
import ts from 'typescript';
import * as rules from './attachmentRules.js';
import * as storageRules from './storageRules.js';

const key = rules.deriveAttKey('synthetic-attachment-key');
const id = '00000000-0000-4000-8000-000000000001', viewer = 'viewer-1';
const now = Date.parse('2026-10-26T12:00:00Z');
const day = 24 * 60 * 60 * 1000;
it('R304 срок ссылки — конец следующих UTC-суток, за одни сутки адрес не меняется', () => {
  const midnight = Date.parse('2026-10-26T00:00:00Z');
  assert.equal(rules.ATT_LINK_DAY_MS, day);
  assert.equal(rules.attLinkExpiry(midnight), midnight + 2 * day);
  assert.equal(rules.attLinkExpiry(midnight + day - 1), midnight + 2 * day);
  assert.equal(rules.attLinkExpiry(midnight + day), midnight + 3 * day);
  assert.equal(rules.attLinkExpiry(midnight) - midnight, 48 * 3600 * 1000);
  assert.equal(rules.attLinkExpiry(midnight + day - 1) - (midnight + day - 1), day + 1);
});
it('R304 v2-подпись включает срок, вложение, смотрящего, поколение и ключ', () => {
  const expires = rules.attLinkExpiry(now), signature = rules.attSigExp(key, id, viewer, 2, expires);
  assert.match(signature, /^[A-Za-z0-9_-]{32}\.[0-9a-z]+$/);
  assert.equal(parseInt(signature.slice(33), 36) * 1000, expires);
  assert.equal(rules.attSigExpValid(key, id, viewer, 2, signature, now), true);
  for (const [a, v, gen, k] of [[id, 'other', 2, key], [id, viewer, 3, key],
    ['00000000-0000-4000-8000-000000000002', viewer, 2, key], [id, viewer, 2, rules.deriveAttKey('synthetic-other-key')]] as const) {
    assert.equal(rules.attSigExpValid(k, a, v, gen, signature, now), false);
  }
  const changedExpiry = signature.slice(0, 33) + Math.floor((expires - 1000) / 1000).toString(36);
  assert.equal(rules.attSigExpValid(key, id, viewer, 2, changedExpiry, now), false);
});
it('R304 последняя миллисекунда срока принимается, ровно срок и миллисекунда после него уже отказ', () => {
  const expires = now + 60_000, signature = rules.attSigExp(key, id, viewer, 0, expires);
  assert.equal(rules.attSigExpValid(key, id, viewer, 0, signature, expires - 1), true);
  for (const current of [expires, expires + 1]) assert.equal(rules.attSigExpValid(key, id, viewer, 0, signature, current), false);
});
it('R304 подписанный срок дальше разрешённого потолка отклоняется, точный потолок принимается', () => {
  const cap = rules.attLinkExpiry(now);
  for (const expires of [cap - 1000, cap]) assert.equal(rules.attSigExpValid(key, id, viewer, 2, rules.attSigExp(key, id, viewer, 2, expires), now), true);
  assert.equal(rules.attSigExpValid(key, id, viewer, 2, rules.attSigExp(key, id, viewer, 2, cap + 1000), now), false);
});
it('R304 бессрочная v1 остаётся допустимой GIF-подписью, но не разрешает файлы ЛС', () => {
  const v1 = rules.attSig(key, id, viewer, 2);
  assert.equal(rules.attSigValid(key, id, viewer, 2, v1), true);
  assert.equal(rules.attSigExpValid(key, id, viewer, 2, v1, now), false);
});
it('R304 формат exp допускает 1–10 знаков base36 и отвергает пустой/длинный/заглавный/лишнюю точку', () => {
  const sig = 'a'.repeat(32);
  for (const exp of ['1', 'a', '0123456789']) assert.equal(rules.attPartsWellFormed(id, viewer, `${sig}.${exp}`), true);
  for (const exp of ['', '0123456789a', 'A', '1.2', '-1', ' 1', '1/2']) assert.equal(rules.attPartsWellFormed(id, viewer, `${sig}.${exp}`), false);
  assert.equal(rules.attPartsWellFormed(id, viewer, sig), true, 'формат v1 нужен GIF, но не означает разрешение ЛС');
  const expires = rules.attSigExp(key, id, viewer, 2, rules.attLinkExpiry(now));
  for (const value of ['', 'x', expires + '.x', expires.slice(1), expires.slice(0, 33) + 'ZZ']) {
    assert.equal(rules.attSigExpValid(key, id, viewer, 2, value, now), false);
  }
});
it('R304 once получает no-store, обычный файл сохраняет private no-cache и ETag', () => {
  const ordinary = rules.attachmentHeaders('image/png', 'фото.png', id);
  const once = rules.attachmentHeaders('image/png', 'фото.png', id, true);
  assert.equal(ordinary['Cache-Control'], 'private, no-cache'); assert.equal(once['Cache-Control'], 'private, no-store');
  assert.equal(ordinary.ETag, `"${id}"`); assert.equal(once.ETag, ordinary.ETag);
  assert.equal(once['Content-Type'], 'image/png'); assert.equal(once['Content-Security-Policy'], "default-src 'none'; sandbox");
});
it('R304 контрфакт принятой v1 ловится отказом срока, оригинал проходит тем же VM-путём', () => {
  const source = readFileSync(new URL('./attachmentRules.ts', import.meta.url), 'utf8');
  const load = (raw: string): typeof rules => {
    const module = { exports: {} };
    runInNewContext(ts.transpileModule(raw, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS } }).outputText,
      { module, exports: module.exports, Buffer, require(name: string) {
        if (name === 'node:crypto') return crypto;
        assert.equal(name, './storageRules.js'); return storageRules;
      } });
    return module.exports as typeof rules;
  };
  const probe = (r: typeof rules) => assert.equal(r.attSigExpValid(key, id, viewer, 2, rules.attSig(key, id, viewer, 2), now), false,
    'R304 бессрочная подпись не открывает ЛС');
  probe(rules); probe(load(source)); const needle = 'if (dot !== 32) return false;'; assert.equal(source.split(needle).length - 1, 1);
  assert.throws(() => probe(load(source.replace(needle, 'if (dot !== 32) return attSigValid(key, attId, viewerId, tokenGen, sig);'))),
    (e: unknown) => e instanceof assert.AssertionError && e.code === 'ERR_ASSERTION' && e.operator === 'strictEqual'
      && e.message.split(/\r?\n/, 1)[0] === 'R304 бессрочная подпись не открывает ЛС' && e.actual === true && e.expected === false);
});
