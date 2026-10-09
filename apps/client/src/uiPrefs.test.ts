import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { it, before, after } from 'node:test';
import { runInNewContext } from 'node:vm';
import { GlobalRegistrator } from '@happy-dom/global-registrator';
import ts from 'typescript';
import * as prefs from './uiPrefs';

type UiPrefsApi = typeof prefs;
let registered = false;
before(() => { GlobalRegistrator.register({ url: 'http://localhost/' }); registered = true; });
after(() => { if (registered) GlobalRegistrator.unregister(); });

function mutantClamp(): UiPrefsApi {
  const source = readFileSync(new URL('./uiPrefs.ts', import.meta.url), 'utf8').replace(/\r\n/g, '\n');
  const changed = source.replace('Math.min(SIDEBAR_MAX, Math.round(px))', 'Math.min(SIDEBAR_MAX + 1, Math.round(px))');
  assert.notEqual(changed, source, 'мутант ослабляет именно верхнюю границу колонки');
  const module = { exports: {} as Record<string, unknown> };
  const js = ts.transpileModule(changed, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText;
  runInNewContext(js, { module, exports: module.exports, require: (id: string) => {
    if (id === 'react') return { useSyncExternalStore: () => false };
    if (id === './dmListView') return { LIST_NARROW_W: 72, effectiveListWidth: (stored: number, allow: boolean, fallback: number) => stored === 72 && !allow ? fallback : stored };
    if (id === './popover') return { installViewportVars() {}, refreshViewportVars() {} };
    throw new Error(`неожиданный импорт ${id}`);
  } });
  return module.exports as UiPrefsApi;
}

it('ширина колонки включает оба предела и сохраняет отдельный режим аватаров', () => {
  assert.equal(prefs.clampWidth(179), 180); assert.equal(prefs.clampWidth(180), 180);
  assert.equal(prefs.clampWidth(480), 480); assert.equal(prefs.clampWidth(481), 480);
  prefs.setSidebarWidth(999);
  assert.equal(prefs.getSidebarWidth(), 480, 'значение из ручки не может расширить колонку за её допустимый максимум');
  prefs.setSidebarWidth(72);
  assert.equal(prefs.getSidebarWidth(), 72, 'узкий режим списка бесед — особое значение, а не ширина для округления до 180');
  prefs.setNarrowAllowed(true);
  assert.equal(document.documentElement.style.getPropertyValue('--sidebar-w'), '72px');
  prefs.setNarrowAllowed(false);
  assert.equal(document.documentElement.style.getPropertyValue('--sidebar-w'), '240px', 'вне списка бесед узкий режим отображается обычной шириной');
  prefs.setSidebarWidth(240);
});

it('масштаб по умолчанию обычный, выбор устройства сохраняет zoom и мусор не применяется', () => {
  localStorage.removeItem('gv_ui_scale');
  assert.equal(prefs.getUiScale(), 'md');
  prefs.setUiScale('lg');
  assert.equal(localStorage.getItem('gv_ui_scale'), 'lg');
  assert.equal((document.documentElement.style as unknown as { zoom: string }).zoom, '1.15');
  localStorage.setItem('gv_ui_scale', 'broken');
  assert.equal(prefs.getUiScale(), 'md', 'неизвестное значение не оставляет сломанную настройку между запусками');
  prefs.setUiScale('md');
});

it('контрольный мутант нарушает верхнюю границу, поэтому тест ловит off-by-one', () => {
  assert.equal(mutantClamp().clampWidth(481), 481, 'мутант принимает пиксель за разрешённым пределом');
  assert.equal(prefs.clampWidth(481), 480, 'настоящая функция удерживает ширину в диапазоне');
});
