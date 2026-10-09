import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { it } from 'node:test';
import { runInNewContext } from 'node:vm';
import ts from 'typescript';

function read(name: string) { return readFileSync(new URL(`./${name}.tsx`, import.meta.url), 'utf8').replace(/\r\n/g, '\n'); }
function handler(source: string, name: string, inline = false) {
  const ast = ts.createSourceFile('component.tsx', source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  let result = '';
  function visit(n: ts.Node) {
    if (!inline && ts.isFunctionDeclaration(n) && n.name?.text === name) result = n.getText(ast);
    if (inline && ts.isJsxAttribute(n) && n.name.getText(ast) === name && n.initializer && ts.isJsxExpression(n.initializer))
      result = n.initializer.expression!.getText(ast);
    ts.forEachChild(n, visit);
  }
  visit(ast); assert.ok(result, `найден настоящий ${name}`);
  return inline ? result : `(${result})`;
}
function checkMutant(source: string, check: (s: string) => void, from: string, to: string) {
  check(source);
  assert.equal(source.split(from).length - 1, 1, 'мутант имеет единственный точный якорь');
  const changed = source.replace(from, to);
  assert.notEqual(changed, source);
  assert.throws(() => check(changed), assert.AssertionError);
}

it('R117 волна в выборе пропускает нажатие строке без перемотки и захвата; обычно перематывает', () => {
  checkMutant(read('VoiceMessage'), source => {
    for (const selected of [true, false]) {
      let seeks = 0; let captures = 0; let stops = 0; let plays = 0;
      const dragRef = { current: false };
      const e = { pointerId: 1, currentTarget: { closest: () => selected ? {} : null,
        setPointerCapture() { captures++; } }, stopPropagation() { stops++; } };
      runInNewContext(ts.transpileModule(`(${handler(source, 'onPointerDown', true)})(e)`,
        { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText,
        { e, dragRef, seek() { seeks++; }, playVoice() { plays++; } });
      assert.equal(seeks, selected ? 0 : 1); assert.equal(captures, selected ? 0 : 1);
      assert.equal(dragRef.current, !selected); assert.equal(stops, 0, 'нажатие может всплыть к строке');
      assert.equal(plays, 0);
    }
  }, "if (e.currentTarget.closest('.messages.sel-mode')) return;", '/* режим выбора проигнорирован */');
});

it('R117 кольцо в выборе не начинает тягу или перемотку и пропускает pointer строке', () => {
  checkMutant(read('RoundVideo'), source => {
    for (const selected of [true, false]) {
      let seeks = 0; let begins = 0; let stops = 0; let plays = 0;
      const drag = { current: null as unknown };
      const e = { button: 0, pointerId: 1, clientX: 200, clientY: 100, timeStamp: 1000,
        currentTarget: { closest: () => selected ? {} : null, getBoundingClientRect: () => ({}) },
        stopPropagation() { stops++; } };
      runInNewContext(ts.transpileModule(`${handler(source, 'onPointerDown')}(e)`,
        { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText,
        { e, mode: 'sound', ref: { current: { paused: true, play() { plays++; } } }, drag,
          inSeekBand: () => true, beginSeek() { begins++; }, seekShare: () => 0.25, seekShareTo() { seeks++; } });
      assert.equal(seeks, selected ? 0 : 1); assert.equal(begins, selected ? 0 : 1);
      assert.equal(stops, selected ? 0 : 1, 'в выборе pointer всплывает, обычная тяга принадлежит кольцу');
      assert.equal(drag.current === null, selected); assert.equal(plays, 0);
    }
  }, "if (e.currentTarget.closest('.messages.sel-mode')) return;", '/* режим выбора проигнорирован */');
});

it('R117 touch кольца в выборе всплывает строке, обычное удержание кольца не выбирает сообщение', () => {
  checkMutant(read('RoundVideo'), source => {
    for (const selected of [true, false]) {
      let stops = 0;
      const e = { touches: [{ clientX: 200, clientY: 100 }],
        currentTarget: { closest: () => selected ? {} : null, getBoundingClientRect: () => ({}) },
        stopPropagation() { stops++; } };
      runInNewContext(ts.transpileModule(`${handler(source, 'onTouchStart')}(e)`,
        { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText, { e, mode: 'sound', inSeekBand: () => true });
      assert.equal(stops, selected ? 0 : 1);
    }
  }, " || e.currentTarget.closest('.messages.sel-mode')", '');
});

it('R117 картинка аватара явно запрещает нативное перетаскивание', () => {
  checkMutant(read('Avatar'), source => {
    const ast = ts.createSourceFile('avatar.tsx', source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
    let images = 0;
    function visit(n: ts.Node) {
      if ((ts.isJsxSelfClosingElement(n) || ts.isJsxOpeningElement(n)) && n.tagName.getText(ast) === 'img') {
        images++;
        const draggable = n.attributes.properties.find(p => ts.isJsxAttribute(p) && p.name.getText(ast) === 'draggable');
        assert.ok(draggable && ts.isJsxAttribute(draggable) && draggable.initializer && ts.isJsxExpression(draggable.initializer));
        assert.equal(draggable.initializer.expression?.kind, ts.SyntaxKind.FalseKeyword);
      }
      ts.forEachChild(n, visit);
    }
    visit(ast); assert.equal(images, 1);
  }, 'draggable={false}', 'draggable={true}');
});
