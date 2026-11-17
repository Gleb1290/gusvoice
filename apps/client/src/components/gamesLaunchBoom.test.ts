import { counterfact } from "../../../../packages/shared/test/counterfacts.js";
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { it } from 'node:test';
import { runInNewContext } from 'node:vm';
import ts from 'typescript';
import type { Boom, BoomEls, startBoom } from './gamesLaunchBoom';

const source = readFileSync(new URL('./gamesLaunchBoom.ts', import.meta.url), 'utf8').replace(/\r\n/g, '\n');
const flush = async () => { for (let i = 0; i < 100; i++) await Promise.resolve(); };
// Неразрывный пробел/word-joiner управляют переносом реплики, не меняя её произносимый текст.
const readable = (text: string) => text.replace(/\u2060/g, '').replace(/\u00a0/g, ' ');
class Element {
  clientWidth = 360; clientHeight = 640; offsetWidth = 280; offsetHeight = 140; offsetTop = 480;
  width = 360; height = 640; className = ''; textContent = ''; src = ''; alt = ''; draggable = false;
  complete = true; naturalWidth = 560; naturalHeight = 399; removed = false;
  children: Element[] = [];
  style: Record<string, string | ((key: string, value: string) => void)> = {
    setProperty: (key, value) => { this.style[key] = value; },
  };
  private classes = new Set<string>();
  classList = {
    add: (name: string) => { this.classes.add(name); },
    remove: (name: string) => { this.classes.delete(name); },
    contains: (name: string) => this.classes.has(name),
    toggle: (name: string, on: boolean) => { if (on) this.classes.add(name); else this.classes.delete(name); },
  };
  appendChild(el: Element) { this.children.push(el); return el; }
  remove() { this.removed = true; }
  draws: unknown[][] = [];
  getContext() {
    const noOp = () => {};
    const gradient = () => ({ addColorStop: noOp });
    return new Proxy<Record<string, unknown>>({
      createLinearGradient: gradient, createRadialGradient: gradient,
      drawImage: (...args: unknown[]) => { this.draws.push(args); },
    }, { get(target, key: string) { return key in target ? target[key] : noOp; },
      set(target, key: string, value) { target[key] = value; return true; } });
  }
}
function fixture(raw = source, reduce = false, size = { w: 360, h: 640 }) {
  const raf = new Map<number, FrameRequestCallback>();
  const externalTimers = new Map<number, () => void>();
  let next = 0, time = 100, finals = 0, stops = 0;
  const sounds: string[] = [];
  const errors: unknown[] = [];
  const request = (callback: FrameRequestCallback) => { const id = ++next; raf.set(id, callback); return id; };
  const cancel = (id: number) => { raf.delete(id); };
  const setTimeout = (callback: () => void) => { const id = ++next; externalTimers.set(id, callback); return id; };
  const els = Object.fromEntries([
    'stage', 'cam', 'sea', 'fx', 'deck', 'sway', 'worldB', 'worldF', 'actors', 'glow', 'veil', 'veilC',
    'flashAll', 'plaque', 'plWho', 'plLine', 'barT', 'barB', 'card', 'hint',
  ].map(key => [key, new Element()])) as Record<keyof BoomEls, Element>;
  for (const el of [els.stage, els.sea, els.fx, els.veilC]) {
    el.clientWidth = size.w; el.clientHeight = size.h; el.width = size.w; el.height = size.h;
  }
  els.card.offsetTop = size.h - 160;
  const module = { exports: {} as { startBoom: typeof startBoom } };
  runInNewContext(ts.transpileModule(raw, { compilerOptions: {
    module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022,
  } }).outputText, {
    module, exports: module.exports, requestAnimationFrame: request, cancelAnimationFrame: cancel, setTimeout,
    window: { devicePixelRatio: 1, requestAnimationFrame: request, cancelAnimationFrame: cancel, setTimeout },
    document: { createElement: () => new Element() },
    console: { error: (...args: unknown[]) => { errors.push(args); } },
    Math: Object.assign(Object.create(Math), { random: () => 0.5 }),
  }, { timeout: 2_000 });
  const hull = new Element(); hull.src = 'hull.webp';
  const boom: Boom = module.exports.startBoom(els as unknown as BoomEls, {
    reduce, images: { hull: hull as unknown as HTMLImageElement },
    sound: key => { sounds.push(key); }, stopHorn: () => { stops++; }, onFinal: () => { finals++; },
  });
  async function step(ms = 50) {
    assert.ok(raf.size <= 1, 'R351/boom/single-raf');
    const callbacks = [...raf.values()]; raf.clear(); time += ms;
    for (const callback of callbacks) callback(time);
    await flush();
    assert.equal(errors.length, 0, 'R351/boom/setup/canvas-errors');
    assert.ok(raf.size <= 1, 'R351/boom/single-raf');
  }
  return { boom, els, sounds, raf, externalTimers, step, time: () => time,
    counts: () => ({ finals, stops }),
    async frames(n: number) { for (let i = 0; i < n; i++) await step(); },
    async until(predicate: () => boolean, max = 260) {
      for (let i = 0; i < max && !predicate(); i++) await step();
      assert.ok(predicate(), 'R351/boom/setup/reached-stage');
    },
  };
}
type Fixture = ReturnType<typeof fixture>;
type Edit = [from: string, to: string, address: string];
function paired(title: string, check: (f: Fixture) => Promise<void>, edits: Edit[], reduce = false) {
  it(title, async () => {
    async function run(raw: string) { const f = fixture(raw, reduce); try { await check(f); } finally { f.boom.destroy(); } }
    await run(source);
    await counterfact(async () => {
      for (const [from, to, address] of edits) {
        assert.equal(source.split(from).length, 2, 'R351/boom/setup/unique-edit');
        await assert.rejects(() => run(source.replace(from, to)), (error: unknown) =>
          error instanceof assert.AssertionError && error.message.split('\n')[0] === address);
      }
    });
    await run(source);
  });
}

// Второй rAF удвоил бы море, ожидания и звук; таймер стены не должен идти, пока сцена стоит.
paired('R351 ожидание горна живёт на часах сцены: одна очередь rAF, пауза не расходует ожидание', async f => {
  assert.equal(f.raf.size, 1, 'R351/boom/single-raf');
  assert.equal(f.externalTimers.size, 0, 'R351/boom/no-wall-wait');
  await f.frames(9);
  assert.deepEqual(f.sounds, [], 'R351/boom/wait-before');
  const stale = [...f.raf.values()][0]!;
  const transform = f.els.cam.style.transform;
  f.boom.setPaused(true); assert.equal(f.raf.size, 0, 'R351/boom/pause-cancels');
  stale(f.time() + 100_000); await flush();
  assert.deepEqual(f.sounds, [], 'R351/boom/paused-wait');
  assert.equal(f.els.cam.style.transform, transform, 'R351/boom/paused-tween');
  await f.step(100_000);
  f.boom.setPaused(false);
  await f.step(100_000);
  assert.deepEqual(f.sounds, [], 'R351/boom/resume-no-fast-forward');
  await f.frames(3);
  assert.deepEqual(f.sounds, ['horn'], 'R351/boom/wait-after');
}, [
  ['if (!raf && !paused && !dead) raf = requestAnimationFrame(loop);',
    'if (!raf && !paused && !dead) { raf = requestAnimationFrame(loop); requestAnimationFrame(loop); }', 'R351/boom/single-raf'],
  ['timers.add(tm);', 'setTimeout(done, ms);', 'R351/boom/no-wall-wait'],
]);

// Остановленный tween не должен незаметно закончить подход и запустить залп/следующий акт.
paired('R351 твин подхода заморожен на паузе и продолжается после неё без прыжка', async f => {
  await f.frames(20);
  const transform = f.els.cam.style.transform;
  const stale = [...f.raf.values()][0]!;
  f.boom.setPaused(true); stale(f.time() + 60_000); await flush(); await f.step(60_000);
  assert.equal(f.els.cam.style.transform, transform, 'R351/boom/tween-pause');
  f.boom.setPaused(false); await f.step(60_000);
  assert.equal(f.sounds.includes('cannon'), false, 'R351/boom/tween-resume');
  await f.frames(5);
  assert.notEqual(f.els.cam.style.transform, transform, 'R351/boom/tween-progress');
}, [['if (dead || paused) return;', 'if (dead) return;', 'R351/boom/tween-pause']]);

// Удаление DOM должно также обезвредить уже доставленный callback браузера и асинхронные продолжения.
paired('R351 destroy отменяет rAF, ожидания и твины, поздний кадр не вызывает звук или финал', async f => {
  await f.frames(5);
  const stale = [...f.raf.values()][0]!;
  const before = f.els.cam.style.transform;
  f.boom.destroy();
  assert.equal(f.raf.size, 0, 'R351/boom/destroy-cancel');
  stale(f.time() + 100_000); await flush();
  for (const callback of f.externalTimers.values()) callback();
  await flush(); f.boom.skip(); f.boom.advance();
  assert.equal(f.raf.size, 0, 'R351/boom/destroy-no-tail');
  assert.equal(f.els.cam.style.transform, before, 'R351/boom/destroy-no-draw');
  assert.deepEqual(f.sounds, [], 'R351/boom/destroy-no-sound');
  assert.equal(f.counts().finals, 0, 'R351/boom/destroy-no-final');
  assert.ok(f.els.actors.children.every(el => el.removed));
  for (const canvas of [f.els.sea, f.els.fx, f.els.veilC]) assert.equal(canvas.width + canvas.height, 0);
}, [['if (dead || paused) return;', 'if (paused) return;', 'R351/boom/destroy-no-tail']]);

// «Пропустить» завершает сценарий без тысяч миллисекунд ожидания и останавливает длинный горн.
paired('R351 skip доводит сцену до единственного onFinal и останавливает горн без залпа', async f => {
  f.boom.skip(); await flush();
  assert.equal(f.counts().finals, 1, 'R351/boom/skip-final');
  assert.equal(f.counts().stops, 1, 'R351/boom/skip-horn');
  assert.equal(f.els.card.classList.contains('on'), true);
  assert.equal(f.sounds.includes('cannon'), false);
  f.boom.skip(); await flush();
  assert.equal(f.counts().finals, 1); assert.equal(f.counts().stops, 1);
}, [['O.stopHorn();', 'void 0;', 'R351/boom/skip-horn']]);

// Клик во время входа капитана лишь дотягивает движение; клик в воротах переводит к следующей реплике.
paired('R351 advance дотягивает твин, затем каждый отдельный шаг открывает следующую реплику', async f => {
  await f.until(() => f.els.deck.classList.contains('on'));
  // Проходим входное wait300 и попадаем именно внутрь hop950, не просто в ожидание до твина.
  await f.frames(7);
  assert.equal(f.els.plLine.textContent, '');
  f.boom.advance(); await flush();
  assert.equal(f.els.plLine.textContent, 'Добро пожаловать на борт!', 'R351/boom/advance-tween');
  assert.equal(f.els.veil.style.opacity, '0', 'R351/boom/advance-tween-end');
  assert.equal(f.els.hint.classList.contains('on'), true);
  await f.step();
  assert.match(String(f.els.actors.children[0]!.style.transform), /^translate\(-10\.00px,/, 'R351/boom/advance-tween-position');
  f.boom.advance(); await flush();
  // Поза present сначала ждёт 70мс: это уже новая анимация, а не лишний пропущенный шаг.
  f.boom.advance(); await flush();
  assert.equal(readable(f.els.plLine.textContent), 'Знакомьтесь — моя команда!', 'R351/boom/advance-gate');
  assert.equal(f.els.hint.classList.contains('on'), true);
}, [
  ['if (gateRes) {', 'if (false && gateRes) {', 'R351/boom/advance-gate'],
  ['if (fin) return;\n        fn(1);\n        finish();', 'if (fin) return;\n        finish();', 'R351/boom/advance-tween-position'],
]);

it('R351 ватерлиния ставит корпус на 90 процентов высоты изображения', async () => {
  // Проверяется настоящий drawImage, не число в комментарии: неправильная доля утопила бы пушечные порты.
  const f = fixture(source, true);
  try {
    await f.step();
    const hull = f.els.sea.draws.find(args => (args[0] as Element).src === 'hull.webp');
    assert.ok(hull);
    assert.ok(Math.abs(Number(hull[2]) / Number(hull[4]) + 0.9) < 1e-12, 'R351/boom/waterline');
  } finally { f.boom.destroy(); }
});

function numeric(node: ts.Expression): number {
  if (ts.isNumericLiteral(node)) return Number(node.text);
  assert.ok(ts.isPrefixUnaryExpression(node) && node.operator === ts.SyntaxKind.MinusToken && ts.isNumericLiteral(node.operand));
  return -Number(node.operand.text);
}
function contract(raw: string) {
  const file = ts.createSourceFile('gamesLaunchBoom.ts', raw, ts.ScriptTarget.Latest, true);
  const variables: ts.VariableDeclaration[] = [], calls: ts.CallExpression[] = [];
  function visit(node: ts.Node) {
    if (ts.isVariableDeclaration(node)) variables.push(node);
    if (ts.isCallExpression(node)) calls.push(node);
    ts.forEachChild(node, visit);
  }
  visit(file);
  const value = (name: string) => {
    const matches = variables.filter(v => ts.isIdentifier(v.name) && v.name.text === name);
    assert.equal(matches.length, 1, `R351/boom/setup/variable/${name}`); return matches[0]!.initializer!;
  };
  const ports = value('PORTS'); assert.ok(ts.isArrayLiteralExpression(ports));
  assert.deepEqual(ports.elements.map(node => numeric(node as ts.Expression)), [-0.295, -0.18, -0.06, 0.02, 0.11], 'R351/boom/ports');
  const who = value('WHO'); assert.ok(ts.isObjectLiteralExpression(who));
  const actual = Object.fromEntries(who.properties.map(prop => {
    assert.ok(ts.isPropertyAssignment(prop) && ts.isArrayLiteralExpression(prop.initializer));
    return [prop.name.getText(file), prop.initializer.elements.map(item => { assert.ok(ts.isStringLiteral(item)); return item.text; })];
  }));
  assert.deepEqual(actual, { cap: ['Капитан', '#f2b53c'], red: ['Казначей', '#ff7d68'],
    judge: ['Квартирмейстер', '#5fdc9a'], host: ['Впередсмотрящий', '#6cc4ff'] }, 'R351/boom/roles');
  for (const line of ['Добро пожаловать на борт!', 'Знакомьтесь — моя команда!',
    'Колесо гусей-пиратов — я кручу удачу!', 'Дуэли — я слежу за честностью!',
    'Ставки на события — угадывай и забирай долю банка!']) {
    assert.ok(calls.some(call => ['say', 'parrotIn'].includes(call.expression.getText(file))
      && call.arguments.some(arg => ts.isStringLiteral(arg) && readable(arg.text) === line)), 'R351/boom/lines');
  }
  assert.equal(numeric(value('stiff')), 2.2, 'R351/boom/spring');
  assert.equal(numeric(value('damp')), 2.6, 'R351/boom/damping');
  assert.equal(value('calmK').getText(file).replace(/\s+/g, ''),
    '(x:number)=>(CALM.on?1-0.6*Math.exp(-(((x-CALM.cx)/(0.55*CALM.sw))**2)):1)', 'R351/boom/calm');
}
it('R351 порты залпа, роли, реплики и численный контракт моря сохранены', () => {
  // Формулы внутри движка не экспортируются: AST проверяет исполняемые узлы, а не комментарии/копии функций.
  contract(source);
  counterfact(() => {
    for (const [from, to, address] of [
      ['stiff = 2.2', 'stiff = 22', 'R351/boom/spring'],
      ['damp = 2.6', 'damp = 26', 'R351/boom/damping'],
      ['1 - 0.6 * Math.exp', '1 - 0.3 * Math.exp', 'R351/boom/calm'],
      ['0.55 * CALM.sw', '0.5 * CALM.sw', 'R351/boom/calm'],
      ['[-0.295, -0.18, -0.06, 0.02, 0.11]', '[-0.295, -0.18, -0.06, 0.02, 0.12]', 'R351/boom/ports'],
      ["red: ['Казначей'", "red: ['Капитан'", 'R351/boom/roles'],
    ]) {
      assert.equal(source.split(from!).length, 2);
      assert.throws(() => contract(source.replace(from!, to!)), (error: unknown) =>
        error instanceof assert.AssertionError && error.message.split('\n')[0] === address);
    }
  });
});

it('R354 корабль не растягивается шире натуральных 1120 пикселей даже в высоком широком окне', async () => {
  // Проверяем реальный размер в drawImage: одна константа не защищает от её удаления из Math.min.
  const check = async (raw: string) => {
    for (const size of [{ w: 360, h: 640 }, { w: 1280, h: 720 }, { w: 3840, h: 2160 }]) {
      const f = fixture(raw, true, size);
      try {
        await f.step();
        const draw = f.els.sea.draws.find(args => (args[0] as Element).src === 'hull.webp');
        assert.ok(draw, 'R354/boom/setup/hull-drawn');
        assert.equal(Number(draw[3]), Math.min(size.w * 0.7, Math.max(440, size.h * 0.8), 1120), 'R354/boom/ship-max-width');
      } finally { f.boom.destroy(); }
    }
  };
  await check(source);
  await counterfact(async () => {
    const from = 'Math.min(w * 0.7, Math.max(440, h * 0.8), SHIP_MAX_W)';
    assert.equal(source.split(from).length, 2, 'R354/boom/setup/unique-ship-width');
    await assert.rejects(() => check(source.replace(from, 'Math.min(w * 0.7, Math.max(440, h * 0.8))')), error =>
      error instanceof assert.AssertionError && error.message.split('\n')[0] === 'R354/boom/ship-max-width');
  });
  await check(source);
});

it('R354 передние актёры остаются над нижней кинополосой в портретных и сверхшироких окнах', async () => {
  // Якорь лап (408 px в холсте актёра) виден в настоящем DOM-transform; happy-dom не должен выдумывать раскладку.
  const check = async (raw: string) => {
    for (const size of [{ w: 360, h: 640 }, { w: 1280, h: 720 }, { w: 1920, h: 720 }, { w: 2560, h: 1080 }, { w: 3440, h: 1440 }]) {
      const f = fixture(raw, false, size);
      try {
        await f.until(() => f.els.deck.classList.contains('on'));
        // Первый кадр акта 2: CAPT уже виден на wy=612, но ещё не начался прыжок после wait300.
        await f.step();
        const captain = f.els.actors.children[0]!;
        assert.equal(captain.style.display, 'block', 'R354/boom/setup/front-actor-visible');
        const transform = String(captain.style.transform).match(/^translate\([-\d.]+px, ([-\d.]+)px\)/);
        assert.ok(transform, 'R354/boom/setup/actor-transform');
        const footY = Number(transform[1]) + 408;
        const worldScale = Math.max(size.w / 1280, size.h / 720) * 1.05;
        const expected = size.h / 2 + (612 - 360) * Math.min(worldScale, (size.h * (0.92 - 0.5) - 10) / (612 - 360));
        assert.ok(Math.abs(footY - expected) <= 0.011, 'R354/boom/deck-front-compressed');
        assert.ok(footY <= size.h * 0.92 - 10 + 0.011, 'R354/boom/deck-feet-above-bars');
      } finally { f.boom.destroy(); }
    }
  };
  await check(source);
  await counterfact(async () => {
    const from = 'Math.min(S, (H * (DECK_FLOOR - 0.5) - 10) / (FRONT_WY - 360))';
    assert.equal(source.split(from).length, 2, 'R354/boom/setup/unique-deck-depth');
    await assert.rejects(() => check(source.replace(from, 'S')), error => error instanceof assert.AssertionError
      && error.message.split('\n')[0] === 'R354/boom/deck-front-compressed');
  });
  await check(source);
});
