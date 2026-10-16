import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { describe, it } from 'node:test';
import { runInNewContext } from 'node:vm';
import ts from 'typescript';
import * as rules from '../attachRules';

const source = readFileSync(new URL('./CameraScreen.tsx', import.meta.url), 'utf8').replace(/\r\n/g, '\n');
type Handlers = { onClick(): void; onPointerDown?(): void; onPointerUp?(): void; onPointerCancel?(): void; onPointerLeave?(): void; onContextMenu?(e: { preventDefault(): void }): void };
function cell(text: string, withHold = true) {
  let now = 0, seq = 0, opened = 0, held = 0;
  const timers = new Map<number, { at: number; fn: () => void }>();
  const cleanup: (() => void)[] = [];
  const module = { exports: {} };
  const jsx = (_tag: unknown, props: unknown) => ({ props });
  runInNewContext(ts.transpileModule(text, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, jsx: ts.JsxEmit.ReactJSX } }).outputText, {
    module, exports: module.exports,
    require(id: string) {
      if (id === 'react') return { useRef: (current: unknown) => ({ current }), useEffect(fn: () => (() => void) | void) { const c = fn(); if (c) cleanup.push(c); }, useState: (v: unknown) => [v, () => {}] };
      if (id === 'react/jsx-runtime') return { jsx, jsxs: jsx };
      if (id === '../attachRules') return rules;
      if (id === 'react-dom' || id === '../cameraCapture' || id === './Icon') return {};
      assert.fail(`неожиданный импорт ${id}`);
    },
    window: { setTimeout(fn: () => void, ms: number) { timers.set(++seq, { at: now + ms, fn }); return seq; }, clearTimeout(id: number) { timers.delete(id); } },
  });
  const api = module.exports as { CameraCell(props: unknown): { props: Handlers } };
  const props = api.CameraCell({ stream: null, facing: 'environment', onOpen: () => opened++, onHold: withHold ? () => held++ : undefined }).props;
  return { props, advance(ms: number) { now += ms; for (const [id, t] of timers) if (t.at <= now) { timers.delete(id); t.fn(); } },
    counts: () => [opened, held], unmount() { cleanup.forEach(c => c()); } };
}
function boundary(text: string) {
  const c = cell(text); c.props.onPointerDown!(); c.advance(299); assert.deepEqual(c.counts(), [0, 0]);
  c.advance(1); assert.deepEqual(c.counts(), [0, 1]); c.props.onPointerUp!(); c.props.onClick();
  assert.deepEqual(c.counts(), [0, 1], 'click после hold не делает дополнительный снимок');
  c.props.onPointerDown!(); c.props.onPointerUp!(); c.props.onClick(); assert.deepEqual(c.counts(), [1, 1]);
}
describe('R150 CameraCell: жест системной камеры', () => {
  it('299 мс ещё не видео, ровно 300 мс видео; следующий click погашен, новый тап открывает фото', () => boundary(source));
  it('короткий тап и отпускание на 299 мс отменяют таймер видео', () => {
    const c = cell(source); c.props.onPointerDown!(); c.advance(299); c.props.onPointerUp!(); c.props.onClick(); c.advance(1);
    assert.deepEqual(c.counts(), [1, 0]);
  });
  it('уход указателя, отмена и размонтирование не оставляют отложенного видео', () => {
    for (const end of ['onPointerLeave', 'onPointerCancel', 'unmount'] as const) {
      const c = cell(source); c.props.onPointerDown!(); c.advance(299);
      if (end === 'unmount') c.unmount(); else c.props[end]!();
      c.advance(1); assert.deepEqual(c.counts(), [0, 0]);
    }
  });
  it('без onHold резервная камера не получает pointer/contextmenu обработчиков и открывается кликом', () => {
    const c = cell(source, false);
    for (const key of ['onPointerDown', 'onPointerUp', 'onPointerCancel', 'onPointerLeave', 'onContextMenu'] as const) assert.equal(c.props[key], undefined);
    c.props.onClick(); assert.deepEqual(c.counts(), [1, 0]);
  });
  it('контекстное меню системного жеста подавляется', () => {
    const c = cell(source); let prevented = false; c.props.onContextMenu!({ preventDefault() { prevented = true; } }); assert.equal(prevented, true);
  });
  for (const [name, from, to] of [
    ['задержка 301', '}, HOLD_TO_RECORD_MS);', '}, HOLD_TO_RECORD_MS + 1);'],
    ['click не погашен', 'if (held.current) {', 'if (false) {'],
  ] as const) it(`контрфакт ${name} нарушает сценарий после оригинала`, () => {
    boundary(source); assert.equal(source.split(from).length - 1, name === 'задержка 301' ? 2 : 1);
    // Первый таймер принадлежит CameraCell, второй — затвору CameraScreen; модуль исполняется целиком.
    assert.throws(() => boundary(source.replace(from, to)), assert.AssertionError);
  });
});
