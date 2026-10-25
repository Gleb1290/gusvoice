import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { it } from 'node:test';
import { runInNewContext } from 'node:vm';
import ts from 'typescript';
import * as React from 'react';
import * as jsx from 'react/jsx-runtime';
import { createRoot } from 'react-dom/client';
import { GlobalRegistrator } from '@happy-dom/global-registrator';

const source = readFileSync(new URL('./VoiceChannelView.tsx', import.meta.url), 'utf8').replace(/\r\n/g, '\n');
const css = readFileSync(new URL('../styles.css', import.meta.url), 'utf8').replace(/\r\n/g, '\n');
type Input = { width: number; height: number; count: number; gap: number; aspect?: number; minTileW?: number };
type Layout = { cols: number; scroll: boolean; rowH: number };
type FitProps = { 'data-fit'?: string; style?: React.CSSProperties };
type Exports = { fitWatchGrid(input: Input): Layout | null;
  useWatchFit(ref: React.RefObject<HTMLDivElement>, count: number): FitProps };

// Весь модуль исполняется без доступа к настоящим store/LiveKit/API. Неизвестный импорт — ошибка,
// а не скрытое подключение приложения. Компоненты сцены здесь не вызываются, только чистый расчёт и хук.
const dormantImports = new Set(`@livekit/components-react livekit-client ../api ../hotkeys ../cameraSettings
../memberName ../economyClient ../store ../streamAudioRules ../streamPipRules ../streamCardRules ../toast
../tipMode ../tipGesture ../voiceSelf ./Avatar ./Crown ../avatarAnimation ./BottomSheet ./Goose ./Icon
./UserContextMenu ./VoiceParticipants ../localUserAudio ./StreamTipFeed ./StreamVolumeControl ./StreamPipView
../pendingWatch ../streamCue ../watchGrace ../streamQuality ../windowCovered ../badPicture ./ContextMenu
../stageGridRules ../stageViewPrefs ../stageLayoutPrefs ../stageLayoutRules ../useStageSpeaker ./StageLayoutPicker
../phoneLayout ../stageAutoShowRules ../useStageAutoShow ../stageOrderRules ../stageOrderPrefs ../useStageDrag`.split(/\s+/));
function load(raw = source, globals: Record<string, unknown> = {}): Exports {
  const module = { exports: {} as Exports };
  runInNewContext(ts.transpileModule(raw + '\nexport { useWatchFit };', { compilerOptions: {
    target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.ReactJSX,
  } }).outputText, { module, exports: module.exports, console, ...globals,
    require(id: string) {
      if (id === 'react') return React;
      if (id === 'react/jsx-runtime') return jsx;
      assert.ok(dormantImports.has(id), `Неописанная граница сцены: ${id}`);
      return Object.freeze({});
    },
  });
  return module.exports;
}
const input = (changes: Partial<Input> = {}): Input => ({ width: 1100, height: 800, count: 3, gap: 12, ...changes });
// Объекты из VM имеют другой prototype; сравниваем публичные поля, а не идентичность realm.
const plain = (value: Layout | null) => value && { cols: value.cols, scroll: value.scroll, rowH: value.rowH };
function replaceOnce(raw: string, anchor: string, replacement: string) {
  assert.equal(raw.split(anchor).length - 1, 1, `Однозначный якорь мутанта: ${anchor}`);
  return raw.replace(anchor, replacement);
}
const killed = (marker: string) => (error: unknown) => error instanceof assert.AssertionError && error.message.includes(marker);

it('R261 ноль и один показ оставляют CSS; два показа уже получают прокрутку при нехватке места', () => {
  const { fitWatchGrid: fit } = load();
  for (const count of [0, 1]) assert.equal(fit(input({ count, width: 300, height: 80 })), null);
  assert.deepEqual(plain(fit(input({ count: 2, width: 300, height: 80 }))), { cols: 1, scroll: true, rowH: 168 });
});

it('R261 три показа в широком окне 1100×800 не меняют прежние две колонки', () => {
  assert.equal(load().fitWatchGrid(input()), null);
});

it('R261 пустой контейнер не навязывает раскладку, а положительные размеры разрешают её', () => {
  const fit = load().fitWatchGrid;
  for (const changes of [{ width: 0 }, { height: 0 }, { width: -1 }, { height: -1 }])
    assert.equal(fit(input(changes)), null);
  assert.notEqual(fit(input({ width: 436, height: 268, count: 7 })), null);
});

function scrollContract(raw = source) {
  assert.deepEqual(plain(load(raw).fitWatchGrid(input({ width: 468, height: 300, count: 7 }))),
    { cols: 2, scroll: true, rowH: 128 }, 'R261_SCROLL: семь показов листаются, не сжимаются в ленты');
}
it('R261 семь показов в полезной области 468×300 получают два столбца и ряды 16:9', () => scrollContract());

function minContract(raw = source) {
  const fit = load(raw).fitWatchGrid;
  assert.equal(fit(input({ width: 320, height: 90, count: 2, gap: 0 })), null,
    'R261_MIN: ровно 160px ещё не требуют прокрутки');
  assert.deepEqual(plain(fit(input({ width: 320, height: 89, count: 2, gap: 0 }))),
    { cols: 2, scroll: true, rowH: 90 }, 'R261_MIN: ниже минимального размера нужна прокрутка');
}
it('R261 картинка шириной ровно 160px допустима; на пиксель меньшая высота включает прокрутку', () => minContract());

it('R261 ширина для двух минимальных колонок принимается на границе и отвергается на пиксель ниже', () => {
  const fit = load().fitWatchGrid;
  assert.deepEqual(plain(fit(input({ width: 332, height: 1, count: 7 }))), { cols: 2, scroll: true, rowH: 90 });
  assert.deepEqual(plain(fit(input({ width: 331, height: 1, count: 7 }))), { cols: 1, scroll: true, rowH: 186 });
});

function gainContract(raw = source) {
  const fit = load(raw).fitWatchGrid;
  // Квадратный aspect из публичного входа делает границу точной: 352 / 320 = 1.1.
  assert.equal(fit(input({ width: 1056, height: 641, gap: 0, aspect: 1 })), null,
    'R261_GAIN: выигрыш менее 10% сохраняет CSS');
  for (const height of [640, 639]) assert.deepEqual(plain(fit(input({ width: 1056, height, gap: 0, aspect: 1 }))),
    { cols: 3, scroll: false, rowH: 0 }, 'R261_GAIN: ровно 10% и больше меняют колонки');
}
it('R261 мёртвая зона сохраняет CSS ниже 10%, но ровно 10% и выше меняет колонки', () => gainContract());

it('R261 минимальная ширина настраивается явно, а нулевой aspect возвращает стандарт 16:9', () => {
  const fit = load().fitWatchGrid;
  assert.deepEqual(plain(fit(input({ width: 436, height: 268, count: 7, minTileW: 1 }))),
    { cols: 3, scroll: false, rowH: 0 });
  assert.deepEqual(plain(fit(input({ width: 436, height: 268, count: 7, aspect: 0 }))),
    { cols: 2, scroll: true, rowH: 119 });
});

type Geometry = { width: number; height: number; padding: number; zoom: number; gap: number };
async function fixture(check: (f: { host: HTMLDivElement; geometry: Geometry; observers: FakeObserver[];
  render(count: number): Promise<void>; resize(): Promise<void> }) => Promise<void>,
raw = source, options: { count?: number; observer?: boolean } = {}) {
  GlobalRegistrator.register({ url: 'http://localhost/' });
  const previous = Object.getOwnPropertyDescriptor(globalThis, 'IS_REACT_ACT_ENVIRONMENT');
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  const geometry: Geometry = { width: 468, height: 300, padding: 16, zoom: 1, gap: 12 };
  const observers: FakeObserver[] = [];
  class Observer implements FakeObserver {
    disconnected = false;
    targets: Element[] = [];
    constructor(readonly callback: () => void) { observers.push(this); }
    observe(el: Element) { this.targets.push(el); }
    disconnect() { this.disconnected = true; }
  }
  const host = document.createElement('div'); document.body.append(host);
  const root = createRoot(host);
  try {
    const mod = load(raw, { document, window,
      ...(options.observer === false ? {} : { ResizeObserver: Observer }),
      getComputedStyle: () => ({ paddingLeft: `${geometry.padding}px`, paddingRight: `${geometry.padding}px`,
        paddingTop: `${geometry.padding}px`, paddingBottom: `${geometry.padding}px`,
        columnGap: `${geometry.gap}px`, zoom: String(geometry.zoom) }),
    });
    function Probe({ count }: { count: number }) {
      const ref = React.useRef<HTMLDivElement>(null);
      const fit = mod.useWatchFit(ref, count);
      const attach = React.useCallback((el: HTMLDivElement | null) => {
        (ref as React.MutableRefObject<HTMLDivElement | null>).current = el;
        if (el) el.getBoundingClientRect = () => ({ x: 0, y: 0, top: 0, left: 0,
          width: geometry.width, height: geometry.height, right: geometry.width, bottom: geometry.height,
          toJSON: () => ({}) });
      }, []);
      return React.createElement('div', { ref: attach, ...fit });
    }
    const render = async (count: number) => {
      await React.act(async () => { root.render(React.createElement(Probe, { count })); });
    };
    const resize = async () => {
      await React.act(async () => { for (const ro of observers) if (!ro.disconnected) ro.callback(); });
    };
    await render(options.count ?? 7);
    await check({ host, geometry, observers, render, resize });
  } finally {
    await React.act(async () => root.unmount());
    assert.equal(observers.every(ro => ro.disconnected), true, 'очистка отключает ResizeObserver');
    host.remove(); await GlobalRegistrator.unregister();
    if (previous) Object.defineProperty(globalThis, 'IS_REACT_ACT_ENVIRONMENT', previous);
    else Reflect.deleteProperty(globalThis, 'IS_REACT_ACT_ENVIRONMENT');
  }
}
type FakeObserver = { disconnected: boolean; targets: Element[]; callback(): void };

async function hookScrollContract(raw = source) {
  await fixture(async ({ host, observers }) => {
    const grid = host.firstElementChild as HTMLDivElement;
    assert.equal(grid.getAttribute('data-fit'), 'scroll', 'R261_DATA_FIT: хук передаёт режим CSS');
    assert.equal(grid.style.getPropertyValue('--watch-cols'), '2');
    // 468×300 — внешняя рамка. Полезная область после padding16 = 436×268, отсюда floor(212/(16/9)) = 119.
    assert.equal(grid.style.getPropertyValue('--watch-row'), '119px');
    assert.equal(observers.length, 1); assert.equal(observers[0].targets[0] === grid, true);
  }, raw);
}
it('R261 хук на внешней рамке 468×300 с отступами передаёт scroll, две колонки и ряд119px', () => hookScrollContract());

it('R261 без ResizeObserver хук оставляет CSS нетронутым', () => fixture(async ({ host, observers }) => {
  assert.equal(observers.length, 0);
  assert.equal(host.firstElementChild!.getAttribute('data-fit'), null);
  assert.equal(host.firstElementChild!.getAttribute('style'), null);
}, source, { observer: false }));

it('R261 один показ не наблюдается; второй включает расчёт; возврат к одному снимает атрибуты и observer', () => fixture(
  async ({ host, observers, render }) => {
    assert.equal(observers.length, 0); assert.equal(host.firstElementChild!.getAttribute('data-fit'), null);
    await render(0); assert.equal(observers.length, 0);
    assert.equal(host.firstElementChild!.getAttribute('data-fit'), null);
    await render(7); assert.equal(observers.length, 1);
    assert.equal(host.firstElementChild!.getAttribute('data-fit'), 'scroll');
    await render(1); assert.equal(observers[0].disconnected, true);
    assert.equal(host.firstElementChild!.getAttribute('data-fit'), null);
    assert.equal((host.firstElementChild as HTMLDivElement).style.getPropertyValue('--watch-cols'), '');
  }, source, { count: 1 }));

it('R261 ресайз и CSS zoom пересчитывают полезную область, широкое окно снимает override', () => fixture(
  async ({ host, geometry, render, resize }) => {
    geometry.width *= 1.25; geometry.height *= 1.25; geometry.zoom = 1.25;
    await resize();
    assert.equal((host.firstElementChild as HTMLDivElement).style.getPropertyValue('--watch-row'), '119px');
    geometry.width = 1100; geometry.height = 800; geometry.padding = 0; geometry.zoom = 1;
    await render(3); await resize();
    assert.equal(host.firstElementChild!.getAttribute('data-fit'), null);
    assert.equal((host.firstElementChild as HTMLDivElement).style.getPropertyValue('--watch-row'), '');
  }));

it('R261 высокий контейнер передаёт режим cols без прокрутки и нулевой фиксированной высоты', () => fixture(
  async ({ host, geometry, resize }) => {
    geometry.width = 400; geometry.height = 800; geometry.padding = 0;
    await resize();
    const grid = host.firstElementChild as HTMLDivElement;
    assert.equal(grid.getAttribute('data-fit'), 'cols');
    assert.equal(grid.style.getPropertyValue('--watch-cols'), '1');
    assert.equal(grid.style.getPropertyValue('--watch-row'), '0px');
  }, source, { count: 3 }));

it('R261 сценическая сетка получает результат хука от того же ref, который наблюдает drag', () => {
  const ast = ts.createSourceFile('VoiceChannelView.tsx', source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  let calls = 0; let spreads = 0;
  function visit(node: ts.Node) {
    if (ts.isVariableDeclaration(node) && node.name.getText(ast) === 'watchFit') {
      assert.equal(node.initializer?.getText(ast), 'useWatchFit(watchDnd.ref, watchedScreens.length)'); calls++;
    }
    if (ts.isJsxOpeningElement(node) && node.attributes.properties.some(p => ts.isJsxSpreadAttribute(p) && p.expression.getText(ast) === 'watchFit')) {
      const attrs = node.attributes.getText(ast);
      assert.ok(attrs.includes('stage-watch-grid')); assert.ok(attrs.includes('ref={watchDnd.ref}')); spreads++;
    }
    ts.forEachChild(node, visit);
  }
  visit(ast); assert.equal(calls, 1); assert.equal(spreads, 1);
});

it('R261 удаление порога выигрыша обнаруживается именно потерей мёртвой зоны', () => {
  gainContract();
  const mutant = replaceOnce(source, 'score(dflt) * WATCH_GAIN', 'score(dflt)');
  assert.throws(() => gainContract(mutant), killed('R261_GAIN'));
});
it('R261 замена минимальной ширины160 на ноль обнаруживается пропавшей прокруткой', () => {
  minContract();
  const mutant = replaceOnce(source, 'input.minTileW ?? WATCH_TILE_MIN_W', 'input.minTileW ?? 0');
  assert.throws(() => minContract(mutant), killed('R261_MIN'));
});
it('R261 потеря ветки scroll обнаруживается проверкой публичной раскладки', () => {
  scrollContract();
  const mutant = replaceOnce(source, 'if (bestScore < minW) {', 'if (false) {');
  assert.throws(() => scrollContract(mutant), killed('R261_SCROLL'));
});
it('R261 потеря data-fit обнаруживается на DOM-атрибуте, а не случайной ошибкой загрузки', async () => {
  await hookScrollContract();
  const mutant = replaceOnce(source, "'data-fit': layout.scroll ? 'scroll' : 'cols'", "'data-lost': layout.scroll ? 'scroll' : 'cols'");
  await assert.rejects(() => hookScrollContract(mutant), killed('R261_DATA_FIT'));
});

// CSS-проверки читают только декларации. happy-dom не рассчитывает layout и не служит оракулом геометрии.
function cssRules(raw: string) {
  const clean = raw.replace(/\/\*[\s\S]*?\*\//g, '');
  return [...clean.matchAll(/([^{}]+)\{([^{}]*)\}/g)].map(match => ({
    selectors: match[1].trim().split(',').map(s => s.trim()),
    declarations: new Map(match[2].split(';').map(d => {
      const colon = d.indexOf(':'); return [d.slice(0, colon).trim(), d.slice(colon + 1).trim()] as [string, string];
    })),
  }));
}
function mobileBody(raw: string): string {
  const clean = raw.replace(/\/\*[\s\S]*?\*\//g, '');
  const bodies: string[] = [];
  for (const match of clean.matchAll(/@media\s*\(max-width:\s*760px\)\s*\{/g)) {
    const start = match.index! + match[0].length;
    let depth = 1; let end = start;
    while (end < clean.length && depth) { if (clean[end] === '{') depth++; if (clean[end] === '}') depth--; end++; }
    bodies.push(clean.slice(start, end - 1));
  }
  return bodies.join('\n');
}
it('R261 CSS применяет число колонок из хука только к сетке с data-fit', () => {
  const rule = cssRules(css).find(r => r.selectors.includes('.stage-watch-grid[data-fit]'));
  assert.equal(rule?.declarations.get('grid-template-columns'), 'repeat(var(--watch-cols, 2), minmax(0, 1fr))');
});
it('R261 scroll оставляет ряды фиксированной высоты, выравнивает вверх и разрешает вертикальную прокрутку', () => {
  const rule = cssRules(css).find(r => r.selectors.includes(".stage-watch-grid[data-fit='scroll']"));
  assert.equal(rule?.declarations.get('grid-auto-rows'), 'var(--watch-row, 90px)');
  assert.equal(rule?.declarations.get('align-content'), 'start');
  assert.equal(rule?.declarations.get('overflow-y'), 'auto');
});
it('R261 телефон отдаёт прокручиваемым показам три доли площади только в мобильном content', () => {
  const selector = ".app.m-content .voice-stage.watching .stage-watch-grid[data-fit='scroll']";
  const rule = cssRules(mobileBody(css)).find(r => r.selectors.includes(selector));
  assert.equal(rule?.declarations.get('flex-grow'), '3');
});
