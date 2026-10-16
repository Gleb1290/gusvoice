import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { after, before, it } from 'node:test';
import { runInNewContext } from 'node:vm';
import { GlobalRegistrator } from '@happy-dom/global-registrator';
import * as React from 'react';
import { createRoot } from 'react-dom/client';
import * as jsx from 'react/jsx-runtime';
import ts from 'typescript';
import type { MapViewProps } from './MapView';
import type { GeoPickMapProps } from './GeoPickDialog';

const raw = readFileSync(new URL('./GeoPickMap.tsx', import.meta.url), 'utf8');
before(() => { GlobalRegistrator.register({ url: 'https://pick-map.invalid' }); Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true }); });
after(async () => { Reflect.deleteProperty(globalThis, 'IS_REACT_ACT_ENVIRONMENT'); await GlobalRegistrator.unregister(); });
async function fixture(saved: string | null, check: (f: { props(): MapViewProps; render(fix: GeoPickMapProps['fix']): Promise<void> }) => Promise<void>) {
  window.localStorage.clear(); if (saved !== null) window.localStorage.setItem('gv_geo_last', saved);
  let props!: MapViewProps;
  const deps: Record<string, unknown> = { react: React, 'react/jsx-runtime': jsx, './MapView': { MapView: (value: MapViewProps) => { props = value; return null; } } };
  const module = { exports: {} };
  runInNewContext(ts.transpileModule(raw, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, jsx: ts.JsxEmit.ReactJSX } }).outputText,
    { module, exports: module.exports, window, Number, require(id: string) { assert.ok(Object.hasOwn(deps, id), `GeoPickMap: ${id}`); return deps[id]; } });
  const Component = (module.exports as typeof import('./GeoPickMap')).default;
  const host = document.createElement('div'); document.body.append(host); const root = createRoot(host);
  const render = async (fix: GeoPickMapProps['fix']) => { await React.act(async () => root.render(React.createElement(Component, { fix, follow: false, recenter: 3, onUserMove() {}, onFail() {} }))); };
  try { await render(null); await check({ props: () => props, render }); }
  finally { await React.act(async () => root.unmount()); host.remove(); window.localStorage.clear(); }
}

for (const saved of [null, 'мусор', '{"lat":NaN,"lon":37}', '{"lat":1e999,"lon":37}', '{"lat":91,"lon":37}', '{"lat":-91,"lon":37}', '{"lat":55,"lon":181}', '{"lat":"55","lon":37}']) {
  it(`R231 последнее место ${saved ?? 'отсутствует'} не задаёт ложный центр карты`, () => fixture(saved, async f => {
    // Негодная сохранённая точка не должна уводить первую камеру за пределы Земли.
    assert.equal(f.props().emptyCenter, null); assert.equal(f.props().emptyFit, true); assert.equal(f.props().points.length, 0);
  }));
}
it('R231 корректное последнее место задаёт первую камеру, новый fix сохраняется и отмечен как своё место', () => fixture('{"lat":90,"lon":-180}', async f => {
  assert.equal(JSON.stringify(f.props().emptyCenter), '{"lat":90,"lon":-180}');
  await f.render({ lat: 55, lon: 37, accuracy: 8 });
  assert.equal(window.localStorage.getItem('gv_geo_last'), '{"lat":55,"lon":37}');
  assert.equal(JSON.stringify(f.props().points), '[{"id":"me","lat":55,"lon":37,"accuracy":8,"me":true}]');
  assert.equal(JSON.stringify(f.props().emptyCenter), '{"lat":90,"lon":-180}', 'обновление fix не переопределяет первую камеру');
  assert.equal(f.props().interactive, true); assert.equal(f.props().follow, false); assert.equal(f.props().recenter, 3);
  await f.render({ lat: 56, lon: 38, accuracy: null }); assert.equal(window.localStorage.getItem('gv_geo_last'), '{"lat":56,"lon":38}');
}));
