import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { it } from 'node:test';
import { runInNewContext } from 'node:vm';
import ts from 'typescript';
import * as shared from '@gusvoice/shared';
import * as rules from './mapsStaticRules.js';

const source = readFileSync(new URL('./mapsStaticRules.ts', import.meta.url), 'utf8').replace(/\r\n/g, '\n');
function load(raw = source): typeof rules {
  const module = { exports: {} };
  runInNewContext(ts.transpileModule(raw, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText,
    { module, exports: module.exports, URLSearchParams, require(id: string) { assert.equal(id, '@gusvoice/shared'); return shared; } });
  return module.exports as typeof rules;
}
function killed(from: string, to: string, check: (api: typeof rules) => void, prefix: string, actual: unknown, expected: unknown) {
  check(load()); assert.equal(source.split(from).length - 1, 1, 'один якорь карты');
  assert.throws(() => check(load(source.replace(from, to))), e => e instanceof assert.AssertionError && e.message.startsWith(prefix)
    && e.operator === 'strictEqual' && e.actual === actual && e.expected === expected);
}
it('R220 ключ карты включён только при непустом содержимом, пробелы не объявляют возможность', () => {
  for (const key of [undefined, '', ' \t\n ']) assert.equal(rules.mapsStaticEnabled(key), false);
  for (const key of ['fixture-key', ' fixture-key ']) assert.equal(rules.mapsStaticEnabled(key), true);
});
it('R220 upstream карты передаёт долготу первой, размер, метку, тему и синтетический ключ без scale', () => {
  const url = new URL(rules.mapsStaticUpstreamUrl({ lat: 52.5, lon: 13.4, w: 560, h: 320, theme: 'dark' }, 'fixture key'));
  assert.equal(url.origin + url.pathname, 'https://static-maps.yandex.ru/v1');
  assert.deepEqual(Object.fromEntries(url.searchParams), { ll: '13.4,52.5', z: '16', size: '560,320', pt: '13.4,52.5,pm2rdm', theme: 'dark', lang: 'ru_RU', apikey: 'fixture key' });
  assert.equal(url.searchParams.has('scale'), false);
});
it('R220 PNG, JPEG и WebP принимаются, не 200 и не растровая карта отклоняются', () => {
  for (const type of ['image/png', 'image/jpeg', 'image/webp', ' Image/PNG ; charset=binary']) assert.equal(rules.mapsStaticReplyOk(200, type, null), true);
  for (const type of [null, '', 'text/html', 'application/json', 'image/svg+xml']) assert.equal(rules.mapsStaticReplyOk(200, type, '3'), false);
  for (const status of [199, 201, 204, 301, 400, 500]) assert.equal(rules.mapsStaticReplyOk(status, 'image/png', '3'), false);
});
it('R220 карта ровно два МиБ проходит, два МиБ плюс байт нет; неизвестную длину ограничит поток', () => {
  assert.equal(rules.MAPS_STATIC_MAX_BYTES, 2 * 1024 ** 2);
  assert.equal(rules.mapsStaticReplyOk(200, 'image/png', String(2 * 1024 ** 2)), true);
  assert.equal(rules.mapsStaticReplyOk(200, 'image/png', String(2 * 1024 ** 2 + 1)), false);
  assert.equal(rules.mapsStaticReplyOk(200, 'image/png', null), true); assert.equal(rules.mapsStaticReplyOk(200, 'image/png', ''), true);
  assert.equal(rules.MAPS_STATIC_CACHE_CONTROL, 'private, max-age=3600');
});
it('R220 контрфакт не проверяет MIME и принимает HTML', () => killed('if (!/^image\\/(png|jpeg|webp)$/.test(type)) return false;', '', api => {
  assert.equal(api.mapsStaticReplyOk(200, 'text/html', '3'), false, 'R220-map-type: HTML не картинка');
}, 'R220-map-type:', true, false));
it('R220 контрфакт не проверяет длину и принимает карту больше двух МиБ', () => killed('if (contentLength && Number(contentLength) > MAPS_STATIC_MAX_BYTES) return false;', '', api => {
  assert.equal(api.mapsStaticReplyOk(200, 'image/png', String(2 * 1024 ** 2 + 1)), false, 'R220-map-size: слишком большое тело отклоняется');
}, 'R220-map-size:', true, false));
