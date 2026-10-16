import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { it } from 'node:test';
import { runInNewContext } from 'node:vm';
import ts from 'typescript';
import * as real from './messagePrivacyRules.js';

const source = readFileSync(new URL('./messagePrivacyRules.ts', import.meta.url), 'utf8').replace(/\r\n/g, '\n');
function load(raw = source): typeof real {
  const module = { exports: {} };
  runInNewContext(ts.transpileModule(raw, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText,
    { module, exports: module.exports, require: (id: string) => assert.fail(`чистое правило приватности не требует ${id}`) });
  return module.exports as typeof real;
}
for (const privacy of ['everyone', 'contacts'] as const) for (let mask = 0; mask < 8; mask++) {
  it(`R212 ${privacy}: контакт=${!!(mask & 1)}, писал первым=${!!(mask & 2)}, исключение=${!!(mask & 4)} — каждый отдельный повод допускает`, () => {
    assert.equal(real.messageAllowed({ privacy, isContact: !!(mask & 1), wroteFirst: !!(mask & 2), alwaysAllowed: !!(mask & 4) }), privacy === 'everyone' || mask !== 0);
  });
}
function normalize(api = real) {
  assert.equal(api.normalizeMessagePrivacy('contacts'), 'contacts', 'R212-privacy-normalize: контакты не превращаются в открытый доступ');
  for (const value of [undefined, null, '', 'everyone', 'Contacts', 'unknown', {}, [], 0, true]) assert.equal(api.normalizeMessagePrivacy(value), 'everyone');
}
it('R212 ровно contacts сохраняется, неизвестное значение совместимо с прежним everyone', () => normalize());
it('R212 контрфакт И вместо ИЛИ отказывает каждому отдельному разрешающему основанию', () => {
  const check = (api: typeof real) => {
    for (const mask of [1, 2, 4]) assert.equal(api.messageAllowed({ privacy: 'contacts', isContact: !!(mask & 1), wroteFirst: !!(mask & 2), alwaysAllowed: !!(mask & 4) }), true,
      'R212-privacy-or: один контакт, первый ответ или исключение уже разрешает сообщения');
  };
  check(load(source)); const from = 'i.alwaysAllowed || i.isContact || i.wroteFirst'; assert.equal(source.split(from).length - 1, 1);
  assert.throws(() => check(load(source.replace(from, 'i.alwaysAllowed && i.isContact && i.wroteFirst'))), e => e instanceof assert.AssertionError
    && e.message.startsWith('R212-privacy-or:') && e.operator === 'strictEqual' && e.actual === false && e.expected === true);
});
it('R212 контрфакт нормализации открывает everyone вместо выбранных contacts', () => {
  normalize(load(source)); const from = "v === 'contacts' ? 'contacts' : 'everyone'"; assert.equal(source.split(from).length - 1, 1);
  assert.throws(() => normalize(load(source.replace(from, "v === 'contacts' ? 'everyone' : 'everyone'"))), e => e instanceof assert.AssertionError
    && e.message.startsWith('R212-privacy-normalize:') && e.operator === 'strictEqual' && e.actual === 'everyone' && e.expected === 'contacts');
});
