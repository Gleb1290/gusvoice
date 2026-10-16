import assert from 'node:assert/strict';
import { it } from 'node:test';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import ts from 'typescript';
import * as rules from './chatKeysRules';
import { enterSends, enterBreaksLine } from './messagePaneRules';

it('оба настоящих обработчика поля вызывают перенос для Ctrl+Enter, а удаление вставки ловится', () => {
  // Проверяем неизменённые тела JSX-обработчиков: правка и расписание не должны забыть ветку, уже работающую в composer.
  const handlers: string[] = [];
  for (const file of ['./components/MessagePane.tsx', './components/ScheduledView.tsx']) {
    const source = readFileSync(new URL(file, import.meta.url), 'utf8');
    const parsed = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
    const visit = (node: ts.Node) => {
      if (ts.isJsxAttribute(node) && node.name.getText(parsed) === 'onKeyDown' && node.initializer && ts.isJsxExpression(node.initializer) && node.initializer.expression && ts.isArrowFunction(node.initializer.expression)) {
        const body = node.initializer.expression.getText(parsed);
        if (body.includes('insertLineBreak(e.currentTarget)')) handlers.push(body);
      }
      ts.forEachChild(node, visit);
    }; visit(parsed);
  }
  assert.equal(handlers.length, 2, 'composer (включая правку) и ScheduledView');
  const check = (body: string) => {
    let inserted = 0, sent = 0, prevented = 0;
    const context = { handler: undefined as unknown as (e: object) => void,
      enterSends, enterBreaksLine, getSendMode: () => 'enter', insertLineBreak: () => { inserted++; },
      handleFormatKey: () => false, ac: null, acItems: [], editing: null, m: {}, act: { saveEdit: () => { sent++; } }, submit: () => { sent++; },
      window: { matchMedia: () => ({ matches: false }) } };
    runInNewContext(ts.transpileModule(`globalThis.handler = ${body};`, { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText, context);
    context.handler({ key: 'Enter', ctrlKey: true, shiftKey: false, metaKey: false, nativeEvent: { isComposing: false }, currentTarget: {}, preventDefault: () => { prevented++; } });
    assert.equal(inserted, 1); assert.equal(sent, 0); assert.equal(prevented, 1);
  };
  for (const body of handlers) {
    check(body);
    assert.throws(() => check(body.replace('insertLineBreak(e.currentTarget);', '')), (e: unknown) => e instanceof assert.AssertionError && e.actual === 0 && e.expected === 1);
  }
});

function mutant(a: string,b: string): typeof rules {
  const source = readFileSync(new URL('./chatKeysRules.ts', import.meta.url), 'utf8'); assert.ok(source.includes(a), 'мутант найден');
  const changed = source.replace(a,b); assert.notEqual(changed, source, 'мутант действительно изменил исходник');
  const module = { exports: {} }; runInNewContext(ts.transpileModule(changed, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText, { module, exports: module.exports }); return module.exports as typeof rules;
}
it('прикрепление распознаёт физическую KeyO в русской раскладке, но не чужие сочетания', () => {
  // Ctrl+щ не должен зависеть от раскладки и перехватывать Ctrl+Shift+O браузера.
  const e = { key: 'щ', code: 'KeyO', ctrlKey: true, shiftKey: false, altKey: false, metaKey: false };
  const check = (api: typeof rules) => {
    assert.equal(api.attachKey(e), true);
    for (const key of ['o', 'O']) assert.equal(api.attachKey({ ...e, code: undefined, key }), true);
    for (const patch of [{ ctrlKey: false }, { shiftKey: true }, { altKey: true }, { metaKey: true }, { code: 'KeyP' }]) assert.equal(api.attachKey({ ...e, ...patch }), false);
  };
  check(rules);
  assert.throws(() => check(mutant("e.code === 'KeyO' || ", '')), assert.AssertionError);
});
it('Enter следует режиму отправки, Ctrl+Enter вставляет перенос только в режиме Enter', () => {
  // Ловит случайную отправку вместо переноса: это уже необратимое действие для пользователя.
  for (const mode of ['enter', 'ctrl-enter'] as const) for (const ctrl of [false, true]) for (const shift of [false, true]) {
    const e = { mode, ctrl, shift, composing: false, touchOnly: false };
    const sends = ctrl ? shift || mode === 'ctrl-enter' : mode === 'enter' && !shift;
    assert.equal(enterSends(e), sends, JSON.stringify(e));
    assert.equal(enterBreaksLine(e), ctrl && !shift && mode === 'enter');
    assert.equal(enterSends({ ...e, composing: true }), false);
    assert.equal(enterBreaksLine({ ...e, composing: true }), false);
  }
  assert.equal(enterSends({ shift: false, composing: false, touchOnly: true }), false);
});
it('ответ листается без круга и после последнего снимается, а неизвестный ответ вверх начинает с конца', () => {
  // Ctrl+↓ у последнего ответа обязан снять цитату, а не оставить её залипшей.
  assert.equal(rules.replyNavTarget([], null, 'prev'), null);
  assert.deepEqual(rules.replyNavTarget(['a','b'], null, 'prev'), { reply: 'b' });
  assert.deepEqual(rules.replyNavTarget(['a','b'], 'absent', 'prev'), { reply: 'b' });
  assert.equal(rules.replyNavTarget(['a','b'], 'a', 'prev'), null);
  assert.deepEqual(rules.replyNavTarget(['a','b'], 'a', 'next'), { reply: 'b' });
  assert.equal(rules.replyNavTarget(['a','b'], 'b', 'next'), 'cancel');
  assert.equal(rules.replyNavTarget(['a','b'], null, 'next'), null);
  assert.throws(() => assert.equal(mutant(" : 'cancel'", ' : null').replyNavTarget(['a'], 'a', 'next'), 'cancel'), assert.AssertionError);
});
it('поле отдаёт стрелку ленте лишь на краю без выделения, модификаторы и IME сохраняют поле', () => {
  // Выделенный текст и составной ввод нельзя превращать в правку предыдущего сообщения.
  const p = { key: 'ArrowUp', mods: false, composing: false, value: 'x', selStart: 0, selEnd: 0, replying: false, editing: false, hasOwnEditable: true };
  assert.equal(rules.fieldKeyAction(p), 'line-up');
  assert.equal(rules.fieldKeyAction({ ...p, value: '' }), 'edit-last');
  assert.equal(rules.fieldKeyAction({ ...p, value: '', replying: true }), 'line-up');
  assert.equal(rules.fieldKeyAction({ ...p, value: '', editing: true }), 'line-up');
  for (const patch of [{ mods: true }, { composing: true }, { selEnd: 1 }, { selStart: 1, selEnd: 1 }]) assert.equal(rules.fieldKeyAction({ ...p, ...patch }), null);
  assert.equal(rules.fieldKeyAction({ ...p, key: 'ArrowDown', selStart: 1, selEnd: 1 }), 'line-down');
  assert.equal(rules.fieldKeyAction({ ...p, key: 'PageDown' }), 'page-down');
});
it('Esc уважает приоритет выделения, правки, пустого ответа, записи и закрытия', () => {
  // Непустой ответ не теряется при Esc, а запись не перекрывает пустую цитату.
  const p = { selecting: false, editing: false, draft: ' ', original: '', replying: true, recording: true, canClose: true };
  const check = (api: typeof rules) => {
    assert.equal(api.chatEscape(p), 'reply');
    assert.equal(api.chatEscape({ ...p, draft: 'x' }), 'voice');
    assert.equal(api.chatEscape({ ...p, selecting: true, editing: true }), 'selection');
    assert.equal(api.chatEscape({ ...p, editing: true }), 'edit');
    assert.equal(api.chatEscape({ ...p, editing: true, draft: 'x' }), 'ask-edit');
    assert.equal(api.chatEscape({ ...p, replying: false, recording: false }), 'close');
    assert.equal(api.chatEscape({ ...p, replying: false, recording: false, canClose: false }), 'none');
  }; check(rules);
  assert.throws(() => check(mutant("if (p.replying && p.draft.trim() === '') return 'reply';", "if (p.recording) return 'voice'; if (p.replying && p.draft.trim() === '') return 'reply';")), assert.AssertionError);
  assert.throws(() => check(mutant("p.draft.trim() === ''", "p.draft === ''")), assert.AssertionError);
});
it('Esc снимает пересылку после правки и до пустого ответа', () => {
  // Черновик пересылки — отдельный слой: он не должен теряться за ответом, даже когда поле пусто.
  const p = { selecting: false, editing: false, draft: '', original: '', replying: true, recording: true, canClose: true, forwarding: true };
  const check = (api: typeof rules) => {
    assert.equal(api.chatEscape(p), 'forward');
    assert.equal(api.chatEscape({ ...p, selecting: true, editing: true }), 'selection');
    assert.equal(api.chatEscape({ ...p, canClose: false }), 'forward', 'слой пересылки снимается даже без права закрыть беседу');
    assert.equal(api.chatEscape({ ...p, editing: true }), 'edit');
    assert.equal(api.chatEscape({ ...p, editing: true, draft: 'изменено' }), 'ask-edit');
    assert.equal(api.chatEscape({ ...p, forwarding: false }), 'reply');
    assert.equal(api.chatEscape({ ...p, forwarding: false, replying: false }), 'voice');
    assert.equal(api.chatEscape({ ...p, forwarding: false, replying: false, recording: false }), 'close');
  };
  check(rules);
  const before = "  if (p.forwarding) return 'forward';\n  if (p.replying && p.draft.trim() === '') return 'reply';";
  const after = "  if (p.replying && p.draft.trim() === '') return 'reply';\n  if (p.forwarding) return 'forward';";
  assert.throws(() => check(mutant(before, after)), assert.AssertionError);
});
it('печатный знак принимает Unicode, режим Ctrl+Enter отправляет и с Shift, касание и IME не отправляют', () => {
  // Русская раскладка и emoji остаются вводом, а Enter на телефоне не отправляет случайное сообщение.
  const e = { key: 'я', ctrlKey: false, altKey: false, metaKey: false };
  assert.equal(rules.isTypingKey(e), true); assert.equal(rules.isTypingKey({ ...e, key: '🙂' }), true);
  for (const patch of [{ key: 'Enter' }, { ctrlKey: true }, { altKey: true }, { metaKey: true }, { isComposing: true }]) assert.equal(rules.isTypingKey({ ...e, ...patch }), false);
  const k = { shift: false, composing: false, touchOnly: false };
  assert.equal(enterSends(k), true); assert.equal(enterSends({ ...k, mode: 'ctrl-enter' }), false);
  assert.equal(enterSends({ ...k, mode: 'ctrl-enter', ctrl: true, shift: true }), true);
  assert.equal(enterSends({ ...k, mode: 'ctrl-enter', ctrl: true, composing: true }), false);
  assert.equal(enterSends({ ...k, ctrl: true, touchOnly: true }), false);
});
