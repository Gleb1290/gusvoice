import { counterfact } from "../../../../packages/shared/test/counterfacts.js";
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { it } from 'node:test';
import { runInNewContext } from 'node:vm';
import ts from 'typescript';
import type { GamesLaunchSceneProps } from './GamesLaunchScene';
import type { BoomOpts } from './gamesLaunchBoom';

const source = readFileSync(new URL('./GamesLaunchScene.tsx', import.meta.url), 'utf8').replace(/\r\n/g, '\n');
type Tree = { type: unknown; props: Record<string, unknown> };
function nodes(tree: unknown): Tree[] {
  if (Array.isArray(tree)) return tree.flatMap(nodes);
  if (!tree || typeof tree !== 'object' || !('props' in tree)) return [];
  const node = tree as Tree;
  return [node, ...nodes(node.props.children)];
}
const flush = async () => { for (let i = 0; i < 12; i++) await Promise.resolve(); };

interface FontEnvironment {
  fonts?: { load: (font: string, text: string) => Promise<unknown> };
  documentPresent?: boolean;
}
function fixture(raw = source, environment: FontEnvironment = {}) {
  // Исполняется весь модуль, не вырезанный обработчик; DOM, IO и React hooks подконтрольны проверке.
  const file = ts.createSourceFile('GamesLaunchScene.tsx', raw, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  const globs: ts.CallExpression[] = [];
  function visit(node: ts.Node) {
    if (ts.isCallExpression(node) && ts.isPropertyAccessExpression(node.expression)
      && node.expression.getText(file) === 'import.meta.glob') globs.push(node);
    ts.forEachChild(node, visit);
  }
  visit(file);
  assert.equal(globs.length, 1, 'R351/scene/setup/frame-glob');
  const glob = globs[0]!;
  raw = raw.slice(0, glob.getStart(file)) + '{}' + raw.slice(glob.end);
  const slots: unknown[] = [];
  let cursor = 0;
  const effects: Array<{ deps: unknown[]; cleanup?: () => void }> = [];
  let pending: Array<() => void> = [];
  const listeners = new Set<(event: unknown) => void>();
  const timers = new Map<number, () => void>();
  let nextTimer = 0, updatesAfterUnmount = 0;
  let disposed = false;
  const pauses: boolean[] = [];
  let skipped = 0, advanced = 0, destroyed = 0, closed = 0, launched = 0;
  let engine: BoomOpts | undefined;
  const motion = { covered: false, gameFg: false };
  const settings = { enabled: true, events: { gamesLaunch: true }, volume: 1 };
  const audios: Audio[] = [];
  class Audio {
    paused = true; src = ''; preload = ''; volume = 1; plays = 0; pauses = 0; loads = 0;
    constructor(src = '') { this.src = src; audios.push(this); }
    play() { this.paused = false; this.plays++; return Promise.resolve(); }
    pause() { this.paused = true; this.pauses++; }
    load() { this.loads++; }
    removeAttribute(name: string) { assert.equal(name, 'src'); this.src = ''; }
    addEventListener() {}
  }
  const props: GamesLaunchSceneProps = {
    mine: 0, iconUrl: null, ship: 'ship.webp', sound: true,
    onClose: () => { closed++; }, onLaunch: () => { launched++; },
  };
  const jsx = (type: unknown, props: Record<string, unknown>) => ({ type, props });
  const deps: Record<string, unknown> = {
    react: {
      useState(initial: unknown) {
        const index = cursor++;
        if (!(index in slots)) slots[index] = initial;
        return [slots[index], (value: unknown) => {
          if (disposed) updatesAfterUnmount++;
          slots[index] = typeof value === 'function' ? value(slots[index]) : value;
        }];
      },
      useRef(initial: unknown) {
        const index = cursor++;
        if (!(index in slots)) slots[index] = { current: initial };
        return slots[index];
      },
      useEffect(effect: () => void | (() => void), values: unknown[]) {
        const index = cursor++;
        const prev = effects[index];
        if (prev && prev.deps.length === values.length && prev.deps.every((v, i) => Object.is(v, values[i]))) return;
        pending.push(() => {
          prev?.cleanup?.();
          effects[index] = { deps: [...values], cleanup: effect() || undefined };
        });
      },
    },
    'react/jsx-runtime': { jsx, jsxs: jsx },
    '../assets/guscoin.svg': { default: 'coin.svg' },
    '../assets/sounds/prediction-closed.mp3': { default: 'bell.mp3' },
    '../assets/sounds/cannon-shot.mp3': { default: 'cannon.mp3' },
    '../assets/sounds/games-launch.mp3': { default: 'horn.mp3' },
    '../sounds': { getSoundSettings: () => settings },
    '../windowCovered': { useWindowMotion: () => motion },
    './Icon': { Icon: () => null },
    './gamesLaunchBoom': { startBoom(_els: unknown, options: BoomOpts) {
      engine = options;
      return { skip: () => { skipped++; }, advance: () => { advanced++; }, destroy: () => { destroyed++; },
        setPaused: (paused: boolean) => { pauses.push(paused); } };
    } },
  };
  const module = { exports: {} as { default: (props: GamesLaunchSceneProps) => unknown } };
  runInNewContext(ts.transpileModule(raw, { compilerOptions: {
    module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, jsx: ts.JsxEmit.ReactJSX,
  } }).outputText, {
    module, exports: module.exports, Audio,
    ...(environment.documentPresent === false ? {} : { document: { fonts: environment.fonts } }),
    window: {
      matchMedia: () => ({ matches: false }),
      setTimeout(callback: () => void) { const id = ++nextTimer; timers.set(id, callback); return id; },
      clearTimeout(id: number) { timers.delete(id); },
      addEventListener(type: string, callback: (event: unknown) => void) {
        assert.equal(type, 'keydown'); listeners.add(callback);
      },
      removeEventListener(type: string, callback: (event: unknown) => void) {
        assert.equal(type, 'keydown'); listeners.delete(callback);
      },
    },
    require(id: string) { assert.ok(Object.hasOwn(deps, id), `R351/scene/setup/import/${id}`); return deps[id]; },
  }, { timeout: 2_000 });
  function render() {
    cursor = 0; pending = [];
    const tree = module.exports.default(props);
    for (const node of nodes(tree)) {
      const ref = node.props.ref;
      const el = { focus() {} };
      if (typeof ref === 'function') ref(el);
      else if (ref && typeof ref === 'object') (ref as { current: unknown }).current = el;
    }
    for (const effect of pending) effect();
    return tree;
  }
  function cleanup() { disposed = true; for (const effect of effects) effect?.cleanup?.(); effects.length = 0; }
  return {
    props, motion, settings, audios, pauses, listeners, timers, render, cleanup,
    lateUpdates: () => updatesAfterUnmount,
    async ready() { render(); await flush(); const tree = render(); assert.ok(engine, 'R351/scene/setup/engine-started'); return tree; },
    engine: () => engine!, counts: () => ({ skipped, advanced, destroyed, closed, launched }),
    key(key: string, interactive = false) {
      let prevented = false;
      const event = { key, target: { closest: (selector: string) => {
        assert.equal(selector, 'button, a, input, textarea, select'); return interactive ? {} : null;
      } }, preventDefault() { prevented = true; } };
      for (const callback of listeners) callback(event);
      return prevented;
    },
  };
}
type Edit = [from: string, to: string, address: string];
function paired(title: string, check: (f: ReturnType<typeof fixture>) => Promise<void>, edits: Edit[]) {
  it(title, async () => {
    async function run(raw: string) { const f = fixture(raw); try { await check(f); } finally { f.cleanup(); } }
    await run(source);
    await counterfact(async () => {
      for (const [from, to, address] of edits) {
        assert.equal(source.split(from).length, 2, 'R351/scene/setup/unique-edit');
        await assert.rejects(() => run(source.replace(from, to)), (error: unknown) =>
          error instanceof assert.AssertionError && error.message.split('\n')[0] === address);
      }
    });
    await run(source);
  });
}

// Общая раздача не должна обещать монеты человеку с нулевой/отрицательной личной долей.
paired('R351 строка подарка появляется только для положительного mine и сохраняет личную сумму', async f => {
  await f.ready();
  for (const mine of [-1, 0, 1, 500]) {
    f.props.mine = mine;
    const gift = nodes(f.render()).find(node => node.props.className === 'boom-gift');
    assert.equal(!!gift, mine > 0, 'R351/scene/gift-positive');
    if (gift) assert.equal((gift.props.children as unknown[]).includes(mine), true, 'R351/scene/gift-value');
  }
}, [['{mine > 0 && (', '{mine >= 0 && (', 'R351/scene/gift-positive']]);

// Esc не должен закрыть непросмотренную сцену, но обязан закрыть готовую карточку.
paired('R351 Escape в play пропускает сцену, после финала закрывает', async f => {
  await f.ready();
  assert.equal(f.key('Escape'), true);
  assert.equal(f.counts().skipped, 1, 'R351/scene/escape-skip');
  assert.equal(f.counts().closed, 0, 'R351/scene/escape-play-close');
  f.engine().onFinal(); f.render(); f.key('Escape');
  assert.equal(f.counts().closed, 1, 'R351/scene/escape-final-close');
}, [["phaseRef.current === 'play'", "phaseRef.current === 'never'", 'R351/scene/escape-skip']]);

// Кнопка/поле сами обрабатывают Enter/пробел: глобальный слушатель не должен делать второй шаг.
paired('R351 Enter и Пробел на кнопке или в поле не продвигают сцену, вне контрола продвигают', async f => {
  await f.ready();
  for (const key of ['Enter', ' ']) assert.equal(f.key(key, true), false, 'R351/scene/interactive-key');
  assert.equal(f.counts().advanced, 0, 'R351/scene/interactive-key');
  for (const key of ['Enter', ' ']) assert.equal(f.key(key), true);
  assert.equal(f.counts().advanced, 2, 'R351/scene/plain-key');
  f.key('a'); assert.equal(f.counts().advanced, 2);
}, [["if (t?.closest?.('button, a, input, textarea, select')) return;", '', 'R351/scene/interactive-key']]);

// Ни один из трёх выключателей не обходится собственными Audio сцены.
paired('R351 звук подчиняется sound, общему выключателю и событию gamesLaunch', async f => {
  await f.ready();
  for (const [sound, enabled, event] of [[false, true, true], [true, false, true], [true, true, false]]) {
    f.props.sound = sound!; f.settings.enabled = enabled!; f.settings.events.gamesLaunch = event!; f.render();
    for (const key of ['horn', 'cannon', 'bell'] as const) f.engine().sound(key, 0.7);
  }
  assert.equal(f.audios.reduce((n, audio) => n + audio.plays, 0), 0, 'R351/scene/sound-muted');
  f.props.sound = true; f.settings.enabled = true; f.settings.events.gamesLaunch = true; f.render();
  for (const key of ['horn', 'cannon', 'bell'] as const) f.engine().sound(key, 0.7);
  assert.deepEqual(f.audios.filter(audio => audio.plays).map(audio => audio.src), ['horn.mp3', 'cannon.mp3', 'bell.mp3']);
  assert.ok(f.audios.filter(audio => audio.plays).every(audio => Math.abs(audio.volume - 0.55) < 1e-12));
}, [
  ['if (!k.alive || !soundRef.current) return;', 'if (!k.alive) return;', 'R351/scene/sound-muted'],
  ['if (!s.enabled || !s.events.gamesLaunch) return;', 'if (!s.events.gamesLaunch) return;', 'R351/scene/sound-muted'],
  ['if (!s.enabled || !s.events.gamesLaunch) return;', 'if (!s.enabled) return;', 'R351/scene/sound-muted'],
]);

// Скрытое/накрытое окно и игра останавливают и движок, и уже начатое аудио, не проматывая сцену.
paired('R351 useWindowMotion ставит движок на паузу и возобновляет удержанный звук', async f => {
  await f.ready(); f.engine().sound('horn', 0.7);
  const horn = f.audios.find(audio => audio.plays)!;
  for (const kind of ['covered', 'gameFg'] as const) {
    f.motion[kind] = true; f.render();
    assert.equal(f.pauses.at(-1), true, 'R351/scene/motion-pause');
    assert.equal(horn.paused, true, 'R351/scene/motion-audio');
    f.motion[kind] = false; f.render();
    assert.equal(f.pauses.at(-1), false); assert.equal(horn.paused, false);
  }
}, [['const paused = motion.covered || motion.gameFg;', 'const paused = false;', 'R351/scene/motion-pause']]);

// После размонтирования не остаются активные звук, клавиатура, таймаут загрузки и движок.
paired('R351 размонтирование уничтожает движок, глушит Audio и снимает keydown', async f => {
  await f.ready();
  for (const key of ['horn', 'cannon', 'bell'] as const) f.engine().sound(key, 0.7);
  const played = f.audios.filter(audio => audio.plays);
  f.engine().stopHorn();
  assert.equal(played[0]!.paused, true, 'R351/scene/horn-stop');
  assert.equal(f.listeners.size, 1); f.cleanup();
  assert.equal(f.counts().destroyed, 1, 'R351/scene/destroy');
  assert.ok(played.every(audio => audio.paused && audio.src === '' && audio.loads === 1), 'R351/scene/audio-cleanup');
  assert.ok(f.audios.every(audio => audio.paused), 'R351/scene/all-audio-paused');
  assert.equal(f.listeners.size, 0, 'R351/scene/keydown-cleanup');
  assert.equal(f.timers.size, 0);
  f.engine().sound('horn', 0.7); f.engine().onFinal();
  assert.equal(f.audios.filter(audio => audio.plays).length, 3);
}, [
  ['boomRef.current?.destroy();', 'void boomRef.current;', 'R351/scene/destroy'],
  ['k.horn?.pause();', 'void k.horn;', 'R351/scene/horn-stop'],
  ["el.pause();\n          el.removeAttribute('src');", "el.removeAttribute('src');", 'R351/scene/audio-cleanup'],
  ["return () => window.removeEventListener('keydown', onKey);", 'return () => {};', 'R351/scene/keydown-cleanup'],
]);

paired('R351 поздняя загрузка кадров после размонтирования не начинает сцену', async f => {
  // Завершение Promise загрузки не должно оживить закрытую сцену до первого рендера play.
  f.render(); f.cleanup(); await flush();
  assert.equal(f.lateUpdates(), 0, 'R351/scene/loading-after-close');
  assert.equal(f.engine(), undefined);
}, [["if (k.alive) setPhase((p) => (p === 'loading' ? 'play' : p));",
  "setPhase((p) => (p === 'loading' ? 'play' : p));", 'R351/scene/loading-after-close']]);

it('R352 загрузка сцены ждёт Ruslan Display, а не показывает таблички запасным шрифтом', async () => {
  // Без ожидания FontFaceSet картинки готовы раньше шрифта и первая реплика заметно меняет ширину.
  async function check(raw: string) {
    let release!: () => void;
    const pendingFont = new Promise<void>(resolve => { release = resolve; });
    const calls: Array<[string, string]> = [];
    const f = fixture(raw, { fonts: { load(font, text) { calls.push([font, text]); return pendingFont; } } });
    try {
      f.render(); await flush(); f.render();
      assert.deepEqual(calls, [['1em "Ruslan Display"', 'Капитан']], 'R352/scene/font-request');
      assert.equal(f.engine(), undefined, 'R352/scene/font-wait');
      release(); await flush(); f.render();
      assert.ok(f.engine(), 'R352/scene/font-ready');
    } finally { release(); f.cleanup(); }
  }
  await check(source);
  await counterfact(async () => {
    const from = `waits.push(document.fonts.load('1em "Ruslan Display"', 'Капитан').catch(() => undefined));`;
    assert.equal(source.split(from).length, 2, 'R352/scene/setup/font-wait-edit');
    const mutant = source.replace(from, `void document.fonts.load('1em "Ruslan Display"', 'Капитан').catch(() => undefined);`);
    await assert.rejects(() => check(mutant), (error: unknown) =>
      error instanceof assert.AssertionError && error.message.split('\n')[0] === 'R352/scene/font-wait');
  });
  await check(source);
});

it('R352 отсутствие document.fonts и отказ загрузки шрифта не блокируют готовую сцену', async () => {
  // Старый WebView без FontFaceSet и недоступный файл всё равно должны оставить рабочую сцену и «Пропустить».
  for (const environment of [
    { documentPresent: false },
    {},
    { fonts: { load: () => Promise.reject(new Error('тест: шрифт недоступен')) } },
  ] satisfies FontEnvironment[]) {
    const f = fixture(source, environment);
    try { await f.ready(); assert.ok(f.engine(), 'R352/scene/font-fallback'); }
    finally { f.cleanup(); }
  }
});

paired('R352 финальная карточка не отрывает тире и «в Активностях» переносом строки', async f => {
  // Проверяем отрисованный текст обоих абзацев: буквальный NBSP в JSX и escaped NBSP равноценны.
  await f.ready(); f.props.mine = 1; f.engine().onFinal();
  const tree = nodes(f.render());
  function text(value: unknown): string {
    if (typeof value === 'string' || typeof value === 'number') return String(value);
    if (Array.isArray(value)) return value.map(text).join('');
    if (value && typeof value === 'object' && 'props' in value) return text((value as Tree).props.children);
    return '';
  }
  const body = tree.find(node => node.props.className === 'boom-text');
  const gift = tree.find(node => node.props.className === 'boom-gift');
  assert.ok(body && gift, 'R352/scene/setup/card-paragraphs');
  assert.ok(text(body).includes('\u00a0—'), 'R352/scene/card-text-dash');
  assert.ok(text(gift).includes('\u00a0—'), 'R352/scene/card-gift-dash');
  assert.ok(text(body).includes('в\u00a0«Активностях»'), 'R352/scene/card-activities');
}, [
  ["события{'\\u00a0'}—", "события{' '}—", 'R352/scene/card-text-dash'],
  ["монет{'\\u00a0'}—", "монет{' '}—", 'R352/scene/card-gift-dash'],
  ["— в{'\\u00a0'}«Активностях»", "— в{' '}«Активностях»", 'R352/scene/card-activities'],
]);
