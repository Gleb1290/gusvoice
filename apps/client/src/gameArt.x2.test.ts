import { counterfact } from '../../../packages/shared/test/counterfacts.js';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { test } from 'node:test';
import { runInNewContext } from 'node:vm';
import ts from 'typescript';
import type { CoinLayer, CoinSpec, FxLoop, FxTrack } from './wheelFx';

const css = readFileSync(new URL('./styles.css', import.meta.url), 'utf8').replace(/\r\n/g, '\n');
const fxSource = readFileSync(new URL('./wheelFx.ts', import.meta.url), 'utf8').replace(/\r\n/g, '\n');
const boomSource = readFileSync(new URL('./components/gamesLaunchBoom.ts', import.meta.url), 'utf8').replace(/\r\n/g, '\n');
const png = (name: string) => readFileSync(new URL(`./assets/${name}`, import.meta.url));
const MARK = 'R354/art/';

function dimensions(bytes: Buffer, name: string) {
  assert.ok(bytes.length >= 24 && bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])), `${MARK}png/${name}`);
  assert.equal(bytes.toString('ascii', 12, 16), 'IHDR', `${MARK}ihdr/${name}`);
  return { w: bytes.readUInt32BE(16), h: bytes.readUInt32BE(20) };
}
function declarations(selector: string) {
  const rules = [...css.replace(/\/\*[\s\S]*?\*\//g, '').matchAll(/([^{}]+)\{([^{}]*)\}/g)]
    .filter(match => match[1].split(',').some(part => part.trim() === selector));
  assert.ok(rules.length, `${MARK}css/${selector}`);
  return rules.map(rule => new Map([...rule[2].matchAll(/([\w-]+)\s*:\s*([^;]+);/g)].map(match => [match[1], match[2].trim()])));
}
function property(selector: string, name: string) {
  const value = declarations(selector).map(rule => rule.get(name)).find(value => value !== undefined);
  assert.ok(value, `${MARK}css/${selector}/${name}`); return value;
}
function ratio(selector: string) {
  const match = property(selector, 'aspect-ratio').match(/^(\d+)\s*\/\s*(\d+)$/);
  assert.ok(match, `${MARK}ratio/${selector}`); return Number(match[1]) / Number(match[2]);
}
function matchesRatio(bytes: Buffer, name: string, expected: number, minWidth: number) {
  const { w, h } = dimensions(bytes, name);
  assert.ok(Math.abs(w / h / expected - 1) <= 0.005, `${MARK}aspect/${name}`);
  assert.ok(w >= minWidth, `${MARK}resolution/${name}`);
  return { w, h };
}
function stageSizes() {
  // Размеры берутся из настоящей вёрстки: ПК 340 px, телефон ограничен min(300px, …), не шириной всего экрана.
  const desktop = property('.wh-body', 'grid-template-columns').match(/^(\d+)px\b/);
  const phone = property('.wh-stage', 'width').match(/^min\((\d+)px,/);
  assert.ok(desktop && phone, `${MARK}stage-widths`);
  const percentages = (selector: string) => declarations(selector).map(rule => rule.get('width')).filter((value): value is string => !!value)
    .map(value => { assert.match(value, /^\d+(?:\.\d+)?%$/, `${MARK}width/${selector}`); return Number.parseFloat(value) / 100; });
  return { desktop: Number(desktop[1]), phone: Number(phone[1]), percentages };
}

test('R354 кадры капитана сохраняют пропорцию CSS и двойной запас для самого крупного показа', () => {
  // Старый цельный captain.png — облегчённый запасной кадр до загрузки; ×2 обязателен для новых анимационных кадров и sad.
  const geometry = stageSizes();
  const widths = geometry.percentages('.wh-captain');
  assert.equal(widths.length, 2, `${MARK}captain/desktop-phone`);
  const largest = Math.max(geometry.desktop * widths[0], geometry.phone * widths[1]);
  assert.ok(largest >= 102, `${MARK}captain/display-at-least-102`);
  for (const file of ['captain-idle', 'captain-dance-1', 'captain-dance-2', 'captain-peak', 'captain-helm', 'captain-sad']) {
    assert.deepEqual(matchesRatio(png(`wheel/${file}.png`), file, ratio('.wh-cap-rig'), largest * 2), { w: 530, h: 768 }, `${MARK}captain/${file}`);
  }
  assert.deepEqual(dimensions(png('wheel/captain.png'), 'captain-fallback'), { w: 265, h: 384 });
});

test('R354 сундук и лучи совпадают с CSS по пропорции и не возвращаются к прежнему разрешению', () => {
  // Один лишь aspect-ratio не отличит старый размытый 429×384 от нового 858×768: проверяем также натуральную ширину.
  const geometry = stageSizes();
  const widths = geometry.percentages('.wh-fx-box');
  assert.equal(widths.length, 2, `${MARK}chest/desktop-phone`);
  const largest = Math.max(geometry.desktop * widths[0], geometry.phone * widths[1]);
  assert.ok(largest * 2 >= 530, `${MARK}chest/display-at-least-265`);
  const expected = ratio('.wh-fx-box');
  assert.equal(ratio('.wh-chest-glow'), expected, `${MARK}chest/rays-ratio`);
  const check = (name: string, bytes = png(`wheel/${name}.png`)) =>
    matchesRatio(bytes, name, expected, largest * 2);
  for (const name of ['chest-closed', 'chest-crack', 'chest-half', 'chest-open', 'chest-burst', 'chest-rays']) {
    assert.deepEqual(check(name), { w: 858, h: 768 }, `${MARK}chest/${name}`);
  }
  const old = Buffer.from(png('wheel/chest-open.png'));
  old.writeUInt32BE(429, 16); old.writeUInt32BE(384, 20);
  assert.throws(() => check('chest-open', old), error => error instanceof assert.AssertionError
    && error.message.startsWith(`${MARK}resolution/chest-open`));
  check('chest-open');
});

test('R354 все восемь кадров казначея имеют двойной холст и ту же пропорцию, что CSS', () => {
  // Общий холст не даёт позам подпрыгивать из-за разного обрезания кадра при смене эмоции.
  const expected = ratio('.wh-parrot');
  for (const name of ['red-sit-1', 'red-sit-2', 'red-sit-3', 'red-watch', 'red-cheer', 'red-sad', 'red-jackpot-1', 'red-jackpot-2']) {
    assert.deepEqual(matchesRatio(png(`wheel/${name}.png`), name, expected, 858), { w: 858, h: 1120 }, `${MARK}parrot/${name}`);
  }
});

function coinCrop(raw: string, cell: number, phase: number) {
  // Весь настоящий wheelFx.ts, не вырезанная функция. Цикл и Canvas — IO-границы, шаг вызывается явно без rAF/таймеров.
  const module = { exports: {} as { CoinLayer: typeof CoinLayer; COIN_FRAMES: number } };
  runInNewContext(ts.transpileModule(raw, { compilerOptions: {
    module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022,
  } }).outputText, { module, exports: module.exports, window: { devicePixelRatio: 2 } }, { timeout: 2_000 });
  const draws: unknown[][] = [];
  let track: FxTrack | undefined;
  const loop = { add(fn: FxTrack) { assert.equal(track, undefined, `${MARK}coin/one-track`); track = fn; } };
  const context = { globalAlpha: 1, setTransform() {}, clearRect() {}, drawImage: (...args: unknown[]) => { draws.push(args); } };
  const canvas = { clientWidth: 320, clientHeight: 240, width: 0, height: 0, getContext: () => context };
  const sheet = { naturalWidth: 12 * cell, naturalHeight: cell };
  const layer = new module.exports.CoinLayer(loop as unknown as FxLoop, canvas as unknown as HTMLCanvasElement, sheet as HTMLImageElement);
  const spec: CoinSpec = { x: 100, y: 80, vx: 0, vy: 0, size: 24, g: 0, floor: 1000,
    fps: 0, phase, life: 10, delay: 0, bounce: 0.5, wind: 0 };
  layer.add([spec]);
  assert.ok(track, `${MARK}coin/track`); track(0, 0);
  assert.equal(draws.length, 1, `${MARK}coin/draw`);
  assert.equal(draws[0].length, 9, `${MARK}coin/source-crop`);
  return { crop: draws[0].slice(1, 5), size: [canvas.width, canvas.height], frames: module.exports.COIN_FRAMES };
}
function unique(raw: string, from: string, to: string) {
  assert.equal(raw.split(from).length, 2, `${MARK}setup/unique`); return raw.replace(from, to);
}

test('R354 полоса монеты состоит из 12 квадратов и последний кадр не заворачивается раньше времени', () => {
  const { w, h } = dimensions(png('wheel/coin-spin.png'), 'coin-spin');
  assert.equal(w, h * 12, `${MARK}coin/twelve-square-cells`);
  const check = (raw: string) => {
    const drawn = coinCrop(raw, h, 11);
    assert.deepEqual(drawn.crop, [11 * h, 0, h, h], `${MARK}coin/last-frame`);
    assert.equal(drawn.frames, 12, `${MARK}coin/frame-count`);
    assert.deepEqual(coinCrop(raw, h, 12).crop, [0, 0, h, h], `${MARK}coin/next-cycle`);
  };
  check(fxSource);
  counterfact(() => {
    const mutant = unique(fxSource, 'export const COIN_FRAMES = 12;', 'export const COIN_FRAMES = 11;');
    assert.throws(() => check(mutant), error => error instanceof assert.AssertionError && error.message.startsWith(`${MARK}coin/last-frame`));
  });
  check(fxSource);
});

test('R354 CoinLayer вырезает клетку по naturalHeight, а не по старым 64 пикселям', () => {
  const check = (raw: string) => {
    for (const cell of [96, 128, 192]) {
      const drawn = coinCrop(raw, cell, 3);
      assert.deepEqual(drawn.crop, [3 * cell, 0, cell, cell], `${MARK}coin/natural-height`);
      assert.deepEqual(drawn.size, [640, 480], `${MARK}coin/dpr-size`);
    }
  };
  check(fxSource);
  counterfact(() => {
    const mutant = unique(fxSource, 'const cell = this.sheet.naturalHeight || 64;', 'const cell = 64;');
    assert.throws(() => check(mutant), error => error instanceof assert.AssertionError && error.message.startsWith(`${MARK}coin/natural-height`));
  });
  check(fxSource);
});

test('R354 сцена БУМ загружает настоящие PNG нужных размеров, а не WebP или уменьшенные копии', () => {
  const scene = readFileSync(new URL('./components/GamesLaunchScene.tsx', import.meta.url), 'utf8');
  const ast = ts.createSourceFile('GamesLaunchScene.tsx', scene, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  const globs: string[] = [];
  const visit = (node: ts.Node) => {
    if (ts.isCallExpression(node) && ts.isPropertyAccessExpression(node.expression) && node.expression.name.text === 'glob'
      && node.expression.expression.kind === ts.SyntaxKind.MetaProperty && node.arguments[0] && ts.isStringLiteral(node.arguments[0])) {
      globs.push(node.arguments[0].text);
    }
    ts.forEachChild(node, visit);
  };
  visit(ast);
  assert.deepEqual(globs, ['../assets/launch/boom/*.png'], `${MARK}boom/png-glob`);
  const directory = new URL('./assets/launch/boom/', import.meta.url);
  const files = readdirSync(directory).filter(name => /\.(?:png|webp)$/i.test(name));
  assert.ok(files.length >= 31, `${MARK}boom/frames-present`);
  const special: Record<string, [number, number]> = {
    'crew-wave': [1800, 760], 'deck-bg': [1672, 940], 'deck-front': [1672, 941], 'deck-glow': [1280, 720],
  };
  for (const file of files) {
    assert.match(file, /\.png$/, `${MARK}boom/no-webp/${file}`);
    const name = file.slice(0, -4);
    const expected = /^(?:cap|red|judge|host)-/.test(name) ? [760, 840]
      : /^(?:hull|sails-\d|flag-\d|lanterns)$/.test(name) ? [1120, 798]
        : /^bow-\d$/.test(name) ? [180, 90]
          : /^crest-\d$/.test(name) ? [260, 40]
            : /^wake-\d$/.test(name) ? [320, 70] : special[name];
    assert.ok(expected, `${MARK}boom/known-frame/${name}`);
    const actual = dimensions(png(`launch/boom/${file}`), file);
    assert.deepEqual([actual.w, actual.h], expected, `${MARK}boom/dimensions/${file}`);
  }
});

test('R354 корабль заставки имеет двойной холст, а движок ограничивает растяжение и видимую палубу', () => {
  assert.deepEqual(dimensions(png('launch/ship.png'), 'launch-ship'), { w: 1120, h: 798 }, `${MARK}ship/dimensions`);
  const ast = ts.createSourceFile('gamesLaunchBoom.ts', boomSource, ts.ScriptTarget.Latest, true);
  const values = new Map<string, number>();
  for (const statement of ast.statements) if (ts.isVariableStatement(statement)) {
    for (const declaration of statement.declarationList.declarations) {
      if (ts.isIdentifier(declaration.name) && declaration.initializer && ts.isNumericLiteral(declaration.initializer))
        values.set(declaration.name.text, Number(declaration.initializer.text));
    }
  }
  assert.equal(values.get('SHIP_MAX_W'), 1120, `${MARK}ship/max-width`);
  assert.equal(values.get('DECK_FLOOR'), 0.92, `${MARK}deck/floor`);
  assert.equal(values.get('FRONT_WY'), 612, `${MARK}deck/front`);
});
