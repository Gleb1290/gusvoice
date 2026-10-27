import assert from 'node:assert/strict';
import { it } from 'node:test';
import { act } from 'react';
import { Simulate } from 'react-dom/test-utils';
import type { ViteDevServer } from 'vite';
import ts from 'typescript';
import { setupHarness } from './MessagePane.behavior.harness';

const h = setupHarness(import.meta.url);
const CLOSED = 'R292 после отправки над пустым полем нет полосы подсказок';
const RESET = 'R292 сброс клавиатуры меняет именно сфокусированное поле composer до кадра';

async function sendWithSuggestions(component = h.Pane, runtime: ViteDevServer = h.server) {
  const restoreLayout = h.pointerLayout(true, 390);
  const oldSuggest = localStorage.getItem('gv_emoji_suggest');
  const sent: string[] = [];
  let finish!: () => void;
  const network = new Promise<void>(resolve => { finish = resolve; });
  let field: HTMLTextAreaElement | undefined;
  let oldSet: PropertyDescriptor | undefined;
  let watching = false;
  try {
    h.desktop(); h.round12();
    localStorage.setItem('gv_emoji_suggest', 'on');
    // Никакой выдуманной строки подсказок: используем настоящий загруженный каталог и его индекс.
    const emojiIndex = await runtime.ssrLoadModule('/src/emojiIndex.ts') as typeof import('../emojiIndex');
    await emojiIndex.loadEmojiIndex();
    const emoji = await runtime.ssrLoadModule('/src/emojiShortcodes.ts') as typeof import('../emojiShortcodes');
    assert.ok(emoji.exactEmojiEntries('fire').some(item => item.codes.includes('fire')),
      'реальные данные содержат точную подсказку для слова fire');
    await h.mount({ feedId: 'r292-chat', onSend: async text => { sent.push(text); await network; } }, component);
    field = h.host.querySelector<HTMLTextAreaElement>('.composer-input') ?? undefined;
    assert.ok(field, 'настоящий composer содержит поле ввода');
    field.focus();
    field.setAttribute('autocapitalize', 'sentences');
    await act(async () => {
      Simulate.change(field!, { target: { value: 'fire', selectionStart: 4 } as unknown as EventTarget });
      await h.flush();
    });
    // Слово целиком появляется с задержкой 300 мс; без двоеточия ни одна подсказка не выбрана.
    await act(async () => { await h.delay(350); });
    assert.equal(field.value, 'fire');
    assert.ok(h.host.querySelector('[data-testid="emoji-suggest"] .ac-item'), 'перед отправкой полоса действительно открыта');
    assert.equal(h.host.querySelector('.ac-item.active'), null, 'это точная подсказка слова, не выбранный :код');
    assert.equal(document.activeElement, field, 'пользователь вводит текст в сфокусированное поле');

    const writes: string[] = [];
    oldSet = Object.getOwnPropertyDescriptor(field, 'setAttribute');
    const setAttribute = field.setAttribute.bind(field);
    Object.defineProperty(field, 'setAttribute', { configurable: true, value(name: string, value: string) {
      if (name === 'autocapitalize') writes.push(value);
      setAttribute(name, value);
    } });
    watching = true;
    h.controlUiClock();
    const form = field.closest('form');
    assert.ok(form, 'отправка проходит через настоящую форму MessagePane');
    await act(async () => { Simulate.submit(form); await h.flush(); });

    assert.equal(field.value, '', 'поле очищено до ответа сервера');
    // При мутанте здесь живой DOM-узел: его dump в AssertionError может заблокировать event loop.
    // Счётчик сохраняет ту же проверку закрытия, но адресная ошибка остаётся маленькой (1 !== 0).
    assert.equal(h.host.querySelectorAll('[data-testid="emoji-suggest"]').length, 0, CLOSED);
    assert.deepEqual(sent, ['fire'], 'отправлен текст, а не подставленный эмодзи');
    // Наблюдаем настоящий helper на настоящем поле, не подменяем resetKeyboardShift фиктивной функцией.
    assert.equal(field.getAttribute('autocapitalize'), 'off', RESET);
    assert.deepEqual(writes, ['off'], 'до кадра клавиатуре дан только временный режим');
    assert.equal(document.activeElement, field, 'отправка не закрывает клавиатуру через blur');
    await h.runUiFrame();
    assert.equal(field.getAttribute('autocapitalize'), 'sentences', 'после кадра возвращён прежний режим клавиатуры');
    assert.deepEqual(writes, ['off', 'sentences']);
    assert.equal(document.activeElement, field, 'кадр восстановления не перемещает фокус');
    assert.equal(h.host.querySelector('[data-testid="emoji-suggest"]'), null, 'полоса не воскресла после кадра');
  } finally {
    finish();
    await h.flush();
    if (field && watching) {
      if (oldSet) Object.defineProperty(field, 'setAttribute', oldSet);
      else Reflect.deleteProperty(field, 'setAttribute');
    }
    h.unmount();
    restoreLayout();
    if (oldSuggest === null) localStorage.removeItem('gv_emoji_suggest');
    else localStorage.setItem('gv_emoji_suggest', oldSuggest);
  }
}

function omitSendCall(source: string, name: 'setAc' | 'resetKeyboardShift') {
  const tree = ts.createSourceFile('MessagePane.tsx', source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  const sends: ts.FunctionDeclaration[] = [];
  const visit = (node: ts.Node): void => {
    if (ts.isFunctionDeclaration(node) && node.name?.text === 'send') sends.push(node);
    ts.forEachChild(node, visit);
  };
  visit(tree);
  assert.equal(sends.length, 1, 'мутация адресует только настоящий обработчик send');
  const calls = sends[0].body!.statements.filter(ts.isExpressionStatement).filter(statement => {
    const expression = statement.expression;
    return ts.isCallExpression(expression) && ts.isIdentifier(expression.expression) && expression.expression.text === name;
  });
  assert.equal(calls.length, 1, 'удаляется один вызов в send, не другие пути закрытия подсказок');
  const expression = calls[0].expression as ts.CallExpression;
  assert.equal(expression.arguments.length, 1);
  assert.equal(expression.arguments[0].getText(tree), name === 'setAc' ? 'null' : 'inputRef.current');
  return source.slice(0, calls[0].getStart(tree)) + source.slice(calls[0].end);
}

it('R292 отправка слова с телефона закрывает подсказки и сбрасывает Shift до ответа сервера без потери фокуса', async () => {
  await sendWithSuggestions();
});

h.mutantTest('R292 контрфакт: потерян setAc(null) только в send, подсказки висят над пустым полем', async () => {
  await h.rejectMutant(source => omitSendCall(source, 'setAc'),
    async (component, _confirm, _answer, runtime) => {
      assert.ok(runtime);
      await sendWithSuggestions(component, runtime);
    }, CLOSED);
});

h.mutantTest('R292 контрфакт: без resetKeyboardShift в send сфокусированная клавиатура не получает сброс', async () => {
  await h.rejectMutant(source => omitSendCall(source, 'resetKeyboardShift'),
    async (component, _confirm, _answer, runtime) => {
      assert.ok(runtime);
      await sendWithSuggestions(component, runtime);
    }, RESET);
});
