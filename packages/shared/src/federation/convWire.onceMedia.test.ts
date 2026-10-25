import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { it } from 'node:test';
import { runInNewContext } from 'node:vm';
import ts from 'typescript';
import * as fields from './fieldRules.js';
import * as wire from './convWire.js';

const attachment = (onceTtl?: number): wire.FedConvAttachmentWire => ({
  id: 'once-photo', name: 'photo.jpg', contentType: 'image/jpeg', size: 10,
  width: 800, height: 600, durationMs: null, waveform: null, asFile: false,
  spoiler: false, sha256: null, once: true, ...(onceTtl === undefined ? {} : { onceTtl }),
});
function roundTrip(ttl: number, api = wire) {
  const json = api.serializeConvAttachmentWire(attachment(ttl));
  assert.equal(json.once_ttl, ttl, 'R262_WIRE_TTL: таймер сохраняется в snake_case проводе');
  assert.equal(Object.hasOwn(json, 'onceTtl'), false);
  const parsed = api.parseConvAttachmentWire(json);
  assert.ok(parsed); assert.equal(parsed.once, true); assert.equal(parsed.onceTtl, ttl);
}
for (const ttl of [1, 60]) it(`R262 таймер${ttl}с переживает сериализацию и разбор вложения`, () => roundTrip(ttl));

it('R262 некорректный таймер не отбрасывает валидное вложение, но не принимается как время', () => {
  const base = wire.serializeConvAttachmentWire(attachment(1));
  for (const once_ttl of [0, 61, -1, 1.5, '1', null, Number.NaN, Number.POSITIVE_INFINITY]) {
    const parsed = wire.parseConvAttachmentWire({ ...base, once_ttl });
    assert.ok(parsed); assert.equal(parsed.once, true); assert.equal(Object.hasOwn(parsed, 'onceTtl'), false);
  }
  assert.equal(wire.parseConvAttachmentWire({ ...base, once_ttl: 1 })?.onceTtl, 1);
  assert.equal(wire.parseConvAttachmentWire({ ...base, once_ttl: 60 })?.onceTtl, 60);
});

it('R262 таймер без once не попадает в провод и игнорируется при чтении', () => {
  const json = wire.serializeConvAttachmentWire({ ...attachment(60), once: false });
  assert.equal(Object.hasOwn(json, 'once'), false); assert.equal(Object.hasOwn(json, 'once_ttl'), false);
  const parsed = wire.parseConvAttachmentWire({ ...json, once_ttl: 60 });
  assert.ok(parsed); assert.equal(Object.hasOwn(parsed, 'onceTtl'), false);
  assert.equal(wire.parseConvAttachmentWire({ ...json, once: true, once_ttl: 60 })?.onceTtl, 60);
});

it('R262 историческое once без таймера остаётся одноразовым и не получает нового поля', () => {
  const json = wire.serializeConvAttachmentWire(attachment());
  assert.equal(json.once, true); assert.equal(Object.hasOwn(json, 'once_ttl'), false);
  const parsed = wire.parseConvAttachmentWire(json);
  assert.ok(parsed); assert.equal(parsed.once, true); assert.equal(Object.hasOwn(parsed, 'onceTtl'), false);
});

it('R262 потеря once_ttl ловится на значении провода, а не ошибке загрузки модуля', () => {
  roundTrip(60);
  const raw = readFileSync(new URL('./convWire.ts', import.meta.url), 'utf8').replace(/\r\n/g, '\n');
  const anchor = '...(a.once && a.onceTtl ? { once_ttl: a.onceTtl } : {}),';
  assert.equal(raw.split(anchor).length - 1, 1);
  const module = { exports: {} };
  runInNewContext(ts.transpileModule(raw.replace(anchor, ''), { compilerOptions: {
    module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022,
  } }).outputText, { module, exports: module.exports,
    require(id: string) { assert.equal(id, './fieldRules'); return fields; },
  });
  assert.throws(() => roundTrip(60, module.exports as typeof wire),
    error => error instanceof assert.AssertionError && error.message.includes('R262_WIRE_TTL'));
});
