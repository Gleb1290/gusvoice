import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import { it } from 'node:test';
import ts from 'typescript';
import * as React from 'react';
import { createRoot } from 'react-dom/client';
import { GlobalRegistrator } from '@happy-dom/global-registrator';
import * as rules from './stageLayoutRules';
import type { StageLayout } from './stageLayoutRules';

const source = readFileSync(new URL('./stageLayoutPrefs.ts', import.meta.url), 'utf8').replace(/\r\n/g, '\n');
const key = 'gv_stage_layout';
type Prefs = {
  getStageLayout(): StageLayout;
  setStageLayout(layout: StageLayout): void;
  onStageLayout(fn: () => void): () => void;
  useStageLayout(): StageLayout;
};

function load(initial?: string, failures: readonly ('get' | 'set' | 'remove')[] = [], raw = source,
  hookRuntime: unknown = { useSyncExternalStore: (_subscribe: unknown, snapshot: () => StageLayout) => snapshot() }) {
  const values = new Map<string, string>(initial === undefined ? [] : [[key, initial]]);
  values.set('unrelated', 'keep');
  const storage = {
    getItem: (name: string) => { if (failures.includes('get')) throw Error('storage unavailable'); return values.get(name) ?? null; },
    setItem: (name: string, value: string) => { if (failures.includes('set')) throw Error('storage unavailable'); values.set(name, value); },
    removeItem: (name: string) => { if (failures.includes('remove')) throw Error('storage unavailable'); values.delete(name); },
  };
  const module = { exports: {} as Prefs };
  const compiled = ts.transpileModule(raw, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText;
  runInNewContext(compiled, { module, exports: module.exports, localStorage: storage,
    require: (id: string) => {
      if (id === 'react') return hookRuntime;
      if (id === './stageLayoutRules') return rules;
      throw new Error(`Неописанная зависимость ${id}`);
    },
  });
  return { ...module.exports, values };
}

// Класс ошибки: stale-ключ переживает возврат к Авто или удаляется настройка другого ключа.
it('R248 без сохранённого выбора действует Авто, а выбор Авто удаляет только свой ключ', () => {
  const prefs = load();
  assert.equal(prefs.getStageLayout(), 'auto');
  assert.equal(prefs.useStageLayout(), 'auto');
  prefs.setStageLayout('grid'); assert.equal(prefs.values.get(key), 'grid');
  prefs.setStageLayout('auto');
  assert.equal(prefs.values.has(key), false);
  assert.equal(prefs.values.get('unrelated'), 'keep');
});

// Класс ошибки: неизвестный формат выбрасывает исключение или подменяет безопасный режим.
it('R248 неизвестные и испорченные сохранённые режимы безопасно становятся Авто', () => {
  for (const value of ['future', 'GRID', '', '{bad', 'grid ']) {
    const prefs = load(value);
    assert.equal(prefs.getStageLayout(), 'auto', `битое значение ${JSON.stringify(value)} не должно ломать сцену`);
    assert.equal(prefs.useStageLayout(), 'auto');
  }
});

// Класс ошибки: сбой localStorage ломает экран или не меняет действующий выбор сессии.
it('R248 недоступное хранилище не ломает чтение и всё равно обновляет выбор до перезагрузки', () => {
  const prefs = load('side', ['get', 'set', 'remove']);
  assert.equal(prefs.getStageLayout(), 'auto');
  prefs.setStageLayout('focus'); assert.equal(prefs.useStageLayout(), 'focus');
  prefs.setStageLayout('auto'); assert.equal(prefs.useStageLayout(), 'auto');
  assert.equal(prefs.values.get('unrelated'), 'keep');
});

// Класс ошибки: один обработчик глушит соседей либо утёкшая подписка продолжает получать события.
it('R248 исключение слушателя изолировано, а отписка прекращает его вызовы', () => {
  const prefs = load(); const seen: StageLayout[] = [];
  const offBad = prefs.onStageLayout(() => { throw Error('listener failed'); });
  const offGood = prefs.onStageLayout(() => seen.push(prefs.getStageLayout()));
  assert.doesNotThrow(() => prefs.setStageLayout('focus'));
  assert.deepEqual(seen, ['focus']);
  offGood(); prefs.setStageLayout('speaker');
  assert.deepEqual(seen, ['focus']);
  offBad();
});

// Класс ошибки: сохранение меняет только внутренний снимок, оставляя интерфейс со старым режимом.
it('R248 useStageLayout реактивно перерисовывает подписанный компонент при смене режима', async () => {
  const prefs = load(undefined, [], source, React);
  GlobalRegistrator.register({ url: 'http://localhost/' });
  const previous = Object.getOwnPropertyDescriptor(globalThis, 'IS_REACT_ACT_ENVIRONMENT');
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  const host = document.createElement('div'); document.body.append(host);
  const root = createRoot(host);
  function Probe() { return React.createElement('output', null, prefs.useStageLayout()); }
  try {
    await React.act(async () => { root.render(React.createElement(Probe)); });
    assert.equal(host.querySelector('output')?.textContent, 'auto');
    await React.act(async () => { prefs.setStageLayout('side'); });
    assert.equal(host.querySelector('output')?.textContent, 'side');
    await React.act(async () => { prefs.setStageLayout('auto'); });
    assert.equal(host.querySelector('output')?.textContent, 'auto');
    assert.equal(prefs.values.has(key), false, 'возврат к Авто удаляет сохранённую раскладку');
  } finally {
    await React.act(async () => { root.unmount(); });
    host.remove(); await GlobalRegistrator.unregister();
    if (previous) Object.defineProperty(globalThis, 'IS_REACT_ACT_ENVIRONMENT', previous);
    else Reflect.deleteProperty(globalThis, 'IS_REACT_ACT_ENVIRONMENT');
  }
});

// Класс ошибки: визуально выбранное Авто после перезапуска внезапно возвращает прежнюю раскладку.
it('R248 мутант «Авто» без удаления ключа убивается исходным сценарием сохранения', () => {
  const anchor = "if (layout === 'auto') localStorage.removeItem(LAYOUT_KEY);";
  assert.equal(source.split(anchor).length - 1, 1);
  const roundTrip = (raw = source) => {
    const prefs = load(undefined, [], raw);
    prefs.setStageLayout('focus'); assert.equal(prefs.values.get(key), 'focus');
    prefs.setStageLayout('auto'); assert.equal(prefs.values.has(key), false);
  };
  roundTrip();
  assert.throws(() => roundTrip(source.replace(anchor, "if (layout === 'auto') {}")), assert.AssertionError);
});

function listenerIsolation(raw = source) {
  const prefs = load(undefined, [], raw); const seen: StageLayout[] = [];
  const offBad = prefs.onStageLayout(() => { throw Error('listener failed'); });
  const offGood = prefs.onStageLayout(() => seen.push(prefs.getStageLayout()));
  prefs.setStageLayout('focus'); assert.deepEqual(seen, ['focus']);
  offGood(); prefs.setStageLayout('speaker'); assert.deepEqual(seen, ['focus']);
  offBad();
}

// Класс ошибки: необработанный сбой одного слушателя останавливает остальных, а unsubscribe оставляет утечку.
it('R248 изоляция и отписка слушателей обнаруживают исходные мутанты реализации', () => {
  listenerIsolation();
  const loop = `for (const fn of layoutListeners) {
    try {
      fn();
    } catch {
      /* один слушатель не должен ронять остальных */
    }
  }`;
  assert.equal(source.split(loop).length - 1, 1);
  assert.throws(() => listenerIsolation(source.replace(loop, 'for (const fn of layoutListeners) fn();')), /listener failed/);
  const unsubscribe = 'return () => layoutListeners.delete(fn);';
  assert.equal(source.split(unsubscribe).length - 1, 1);
  assert.throws(() => listenerIsolation(source.replace(unsubscribe, 'return () => layoutListeners.add(fn);')),
    assert.AssertionError, 'без удаления подписки прежний слушатель вызывается повторно');
});
