import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { it } from 'node:test';
import { runInNewContext } from 'node:vm';
import * as React from 'react';
import ts from 'typescript';

const raw = readFileSync(new URL('./geoSystem.ts', import.meta.url), 'utf8');
function fixture(android: boolean, native?: { locationEnabled?: () => boolean; openLocationSettings?: () => boolean }) {
  const asks: unknown[] = [], module = { exports: {} };
  const deps: Record<string, unknown> = { react: React, './hotkeys': { isAndroid: () => android },
    './confirm': { confirmAction: async (value: unknown) => { asks.push(value); return true; } } };
  // Целый модуль; lazy не вызывается, поэтому карта и её тяжёлые зависимости здесь не загружаются.
  runInNewContext(ts.transpileModule(raw, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText,
    { module, exports: module.exports, window: { GusVoiceNative: native }, require(id: string) {
      assert.ok(Object.hasOwn(deps, id), `geoSystem: незаявленный импорт ${id}`); return deps[id];
    } });
  return { api: module.exports as typeof import('./geoSystem'), asks };
}

it('R230 без Android, моста и метода нет ложного сообщения о выключенной геолокации', () => {
  // Старый APK и браузер не должны предлагать неработающие системные настройки.
  for (const [android, native] of [[false, { locationEnabled: () => false, openLocationSettings: () => true }], [true, undefined], [true, {}]] as const) {
    const { api } = fixture(android, native);
    assert.equal(api.systemLocationOff(), false); assert.equal(api.canOpenLocationSettings(), false); assert.equal(api.openLocationSettings(), false);
  }
});
it('R230 достоверный ответ Android различает включённую и выключенную геолокацию', () => {
  for (const enabled of [false, true]) {
    const { api } = fixture(true, { locationEnabled: () => enabled });
    assert.equal(api.systemLocationOff(), !enabled); assert.equal(api.openLocationSettings(), false);
  }
});
it('R230 исключения моста безопасны, а доступные настройки открываются ровно один раз', () => {
  const broken = fixture(true, { locationEnabled() { throw new Error('system'); }, openLocationSettings() { throw new Error('settings'); } }).api;
  assert.equal(broken.systemLocationOff(), false); assert.equal(broken.openLocationSettings(), false);
  for (const result of [false, true]) {
    let calls = 0;
    const { api } = fixture(true, { locationEnabled: () => true, openLocationSettings: () => { calls++; return result; } });
    assert.equal(api.canOpenLocationSettings(), true); assert.equal(api.openLocationSettings(), result); assert.equal(calls, 1);
  }
});
it('R230 системный вопрос содержит действие Включить и возвращает согласие, не открывая настройки сам', async () => {
  let opens = 0;
  const { api, asks } = fixture(true, { locationEnabled: () => false, openLocationSettings: () => { opens++; return true; } });
  assert.equal(await api.geoSystemHooks.ask(), true); assert.equal(opens, 0);
  assert.equal(JSON.stringify(asks), JSON.stringify([{ title: api.GEO_OFF_TITLE, body: api.GEO_OFF_BODY, confirmLabel: 'Включить', cancelLabel: 'Отмена', icon: 'map-pin' }]));
  api.geoSystemHooks.open(); assert.equal(opens, 1);
});
