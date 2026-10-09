import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { after, before, it } from 'node:test';
import { runInNewContext } from 'node:vm';
import { GlobalRegistrator } from '@happy-dom/global-registrator';
import ts from 'typescript';
import * as pinchRules from './pinchRules.js';

type Attach = (list: HTMLElement, onStart?: () => void) => () => void;
let registered = false;
before(() => { GlobalRegistrator.register({ url: 'http://localhost/' }); registered = true; });
after(() => { if (registered) GlobalRegistrator.unregister(); });

function loadAttach(change?: (source: string) => string): Attach {
  let source = readFileSync(new URL('./feedPinch.ts', import.meta.url), 'utf8').replace(/\r\n/g, '\n');
  if (change) {
    const changed = change(source);
    assert.notEqual(changed, source, 'мутант удаляет проверку двух пальцев об одну фотографию');
    source = changed;
  }
  const module = { exports: {} as Record<string, unknown> };
  const js = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText;
  runInNewContext(js, {
    module, exports: module.exports, document, window, Element, getComputedStyle,
    require: (id: string) => { assert.equal(id, './pinchRules', 'жест использует только чистые правила щипка'); return pinchRules; },
  });
  return module.exports.attachFeedPinch as Attach;
}

function touch(id: number, x: number, y: number, target: HTMLImageElement) {
  return { identifier: id, clientX: x, clientY: y, target } as unknown as Touch;
}
function event(type: string, touches: Touch[]) {
  const e = new Event(type, { bubbles: true, cancelable: true });
  Object.defineProperty(e, 'touches', { configurable: true, value: touches });
  return e;
}
function photo(list: HTMLElement) {
  const img = document.createElement('img'); img.className = 'att-img'; img.src = '/photo.jpg'; list.append(img);
  Object.defineProperty(img, 'complete', { configurable: true, value: true });
  Object.defineProperty(img, 'naturalWidth', { configurable: true, value: 300 });
  img.getBoundingClientRect = () => new DOMRect(10, 20, 300, 200);
  return img;
}

it('щипок по одной загруженной фотографии создаёт слой, гасит отпускной клик и убирает слой', () => {
  const list = document.createElement('div'); list.className = 'messages'; document.body.append(list);
  const img = photo(list); let started = 0;
  const detach = loadAttach()(list, () => started++);
  try {
    list.dispatchEvent(event('touchstart', [touch(1, 20, 30, img), touch(2, 120, 30, img)]));
    const smallMove = event('touchmove', [touch(1, 20, 30, img), touch(2, 120, 30, img)]);
    list.dispatchEvent(smallMove); assert.equal(smallMove.defaultPrevented, true, 'щипок не отдаётся браузерному масштабированию');
    list.dispatchEvent(event('touchmove', [touch(1, 20, 30, img), touch(2, 180, 30, img)]));
    list.dispatchEvent(event('touchmove', [touch(1, 20, 30, img), touch(2, 220, 30, img)]));
    const layer = document.querySelector<HTMLImageElement>('.gv-pinch-layer'); assert.ok(layer, 'слой создан после заметного раскрытия пальцев');
    assert.equal(started, 1, 'лента прекращает прежний жест ровно при начале pinch');
    assert.match(layer.style.transform, /scale\(1\.25\)/, 'после создания слоя масштаб считается от новой точки отсчёта');
    list.dispatchEvent(event('touchend', [touch(1, 20, 30, img)]));
    assert.ok(layer.style.transition.includes('220ms'), 'после отпускания фото возвращается к исходному размеру');
    const click = new MouseEvent('click', { bubbles: true, cancelable: true }); img.dispatchEvent(click);
    assert.equal(click.defaultPrevented, true, 'click того же жеста не открывает просмотр под пальцем');
    layer.dispatchEvent(new Event('transitionend'));
    assert.equal(document.querySelector('.gv-pinch-layer'), null, 'конец анимации очищает временную копию');
  } finally { detach(); list.remove(); }
});

it('пальцы на разных фотографиях не создают общий слой даже у двух готовых кадров', () => {
  const check = (attach: Attach) => {
    const list = document.createElement('div'); list.className = 'messages'; document.body.append(list);
    const first = photo(list); const second = photo(list); let started = 0;
    const detach = attach(list, () => started++);
    try {
      list.dispatchEvent(event('touchstart', [touch(1, 20, 30, first), touch(2, 120, 30, second)]));
      list.dispatchEvent(event('touchmove', [touch(1, 20, 30, first), touch(2, 220, 30, second)]));
      assert.equal(document.querySelector('.gv-pinch-layer'), null, 'две отдельные картинки не образуют щипок');
      assert.equal(started, 0, 'чужой жест остаётся доступен родительскому поведению строки');
    } finally { detach(); list.remove(); }
  };
  check(loadAttach());
  const mutant = loadAttach(source => source.replace(
    'if (!img || photoOf(b) !== img) return;',
    'if (!img) return; if (photoOf(b) !== img) { onStart?.(); return; }',
  ));
  assert.throws(() => check(mutant), assert.AssertionError, 'исполняемый мутант принимает пальцы с разных изображений');
});
