import { counterfact } from '../../../../packages/shared/test/counterfacts.js';
import { it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import ts from 'typescript';
import { act, createElement } from 'react';
import { Simulate } from 'react-dom/test-utils';
import type { BotCommandInfo, ChannelBotsInfo, InlineKeyboard, Message } from '@gusvoice/shared';
import type { ViteDevServer } from 'vite';
import { setupHarness, type Props } from './MessagePane.behavior.harness';
import { assertion, mutate } from './R297.bot.harness';
import { LEAVE_MS } from '../bubbleMotion';

const h = setupHarness(import.meta.url);

// Общая DOM-геометрия всегда снимается после unmount, включая неуспешный сценарий.
function overrideRect(node: Element, rect: DOMRect) {
  const descriptor = Object.getOwnPropertyDescriptor(node, 'getBoundingClientRect');
  Object.defineProperty(node, 'getBoundingClientRect', { configurable: true, value: () => rect });
  return () => {
    if (descriptor) Object.defineProperty(node, 'getBoundingClientRect', descriptor);
    else Reflect.deleteProperty(node, 'getBoundingClientRect');
  };
}

async function composerValue(value: string) {
  const field = h.host.querySelector<HTMLTextAreaElement>('.composer textarea'); assert.ok(field, 'поле composer доступно');
  await act(async () => { Simulate.change(field, { target: { value } as unknown as EventTarget }); await h.flush(); });
  return field;
}
async function messageChoice(id: string, label: string) {
  const row = h.host.querySelector<HTMLElement>(`[data-mid="${id}"]`); assert.ok(row, 'строка для меню существует');
  await act(async () => { row.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true })); await h.flush(); });
  const button = [...document.querySelectorAll<HTMLButtonElement>('.ctx-menu button')].find((b) => b.textContent?.trim() === label);
  assert.ok(button, `меню предлагает ${label}`);
  await act(async () => { button.click(); await h.flush(); });
}
async function openComposerEdit(component = h.Pane, confirm = h.ConfirmHost, draft = 'черновик до правки', controlledClock = false) {
  h.round12(); h.desktop();
  await h.mountWithConfirm({ messages: [h.msg('composer-edit'), h.msg('composer-reply', 'peer')] }, component, confirm);
  if (controlledClock) h.controlUiClock();
  h.host.classList.add('content');
  await composerValue(draft); await messageChoice('composer-edit', 'Изменить');
  if (controlledClock) { await h.runUiTimers(); await h.runUiFrame(); }
  return h.host.querySelector<HTMLTextAreaElement>('.composer textarea')!;
}

h.mutantTest('R109 мышиное Изменить открывает основной composer с кареткой в конце', async () => {
  await h.rejectMutant((s) => s.replace('    startComposerEdit(m);\n  }\n\n  /**\n   * 🔴', '    if (window.matchMedia("(pointer: coarse)").matches) startComposerEdit(m);\n  }\n\n  /**\n   * 🔴'), async (component, confirm) => {
    const restore = h.pointerLayout(false, 1200);
    try {
      const field = await openComposerEdit(component, confirm, undefined, true);
      assert.ok(h.host.querySelector('.edit-strip'), 'мышиная правка открыта в основной полосе');
      assert.match(h.host.querySelector('.edit-strip')?.textContent ?? '', /Редактирование/);
      assert.equal(h.host.querySelector('.edit-box') === null, true);
      assert.equal(field.value, 'composer-edit');
      assert.ok(document.activeElement === field, 'после входа в правку фокус находится в composer');
      assert.equal(field.selectionStart, field.value.length); assert.equal(field.selectionEnd, field.value.length);
      assert.ok(h.host.querySelector('.composer button[title="Сохранить"]'));
    } finally { try { h.unmount(); } finally { restore(); } }
  }, 'мышиная правка открыта в основной полосе');
});

for (const exit of ['крестик', 'Escape'] as const) {
  h.mutantTest(`R109 ${exit} спрашивает об изменённой правке и восстанавливает черновик`, async () => {
    await h.rejectMutant((s) => exit === 'крестик' ? s.replace('onClick={cancelComposerEdit}', 'onClick={finishComposerEdit}') :
      s.replace('return cancelComposerEdit();', 'return finishComposerEdit();'), async (component, confirm) => {
      const field = await openComposerEdit(component, confirm, undefined, true);
      await composerValue('новая версия');
      const close = async () => { await act(async () => {
        if (exit === 'крестик') h.host.querySelector<HTMLButtonElement>('.edit-strip .rs-close')!.click();
        else field.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }));
        await h.flush();
      }); };
      await close(); assert.ok(document.querySelector('.confirm-overlay'), 'выход из изменённой правки спрашивает');
      const resume = [...document.querySelectorAll<HTMLButtonElement>('.confirm-actions button')].find((b) => b.textContent?.includes('Продолжить'))!;
      await h.runUiTimers();
      assert.ok(document.activeElement === resume, 'опасное окно переводит фокус на продолжение, а не оставляет в composer');
      // Сначала promise ответа и commit закрытия окна, затем кадр. Не держим act открытым
      // таймером flush: HappyDOM RAF(setImmediate) иначе обгоняет React commit и теряет фокус.
      await act(async () => { resume.click(); });
      assert.equal(document.querySelector('.confirm-overlay') === null, true, 'окно закрыто до кадра возврата фокуса');
      assert.ok(h.host.querySelector('.edit-strip')); assert.equal(field.value, 'новая версия');
      await h.runUiFrame(); assert.ok(document.activeElement === field, 'после продолжения правки фокус возвращён в composer');
      await close();
      const discard = [...document.querySelectorAll<HTMLButtonElement>('.confirm-actions button')].find((b) => b.textContent?.includes('Отбросить'))!;
      assert.ok(discard, 'изменения можно отбросить'); await act(async () => { discard.click(); await h.flush(); });
      assert.equal(h.host.querySelector('.edit-strip') === null, true); assert.equal(field.value, 'черновик до правки');
      await messageChoice('composer-edit', 'Изменить'); await close();
      assert.equal(document.querySelector('.confirm-overlay') === null, true, 'нет изменений — нет вопроса');
      assert.equal(h.host.querySelector('.edit-strip') === null, true); assert.equal(field.value, 'черновик до правки');
    }, 'выход из изменённой правки спрашивает');
  });
}

it('R113 ручные часы не форсируют фокус, учитывают отмену и оставляют вложенный RAF следующему кадру', async () => {
  const oldFrame = globalThis.requestAnimationFrame, oldSet = globalThis.setTimeout;
  const field = document.createElement('textarea'); document.body.append(field); field.focus();
  const clock = h.controlUiClock(); const calls: string[] = [];
  try {
    const canceledFrame = requestAnimationFrame(() => calls.push('отменённый кадр'));
    cancelAnimationFrame(canceledFrame);
    const canceledTimer = window.setTimeout(() => calls.push('отменённый таймер'), 0);
    clearTimeout(canceledTimer);
    setTimeout(() => calls.push('таймер'), 0);
    const realTimer = window.setTimeout(() => calls.push('отменённая настоящая задержка'), 5);
    window.clearTimeout(realTimer);
    window.requestAnimationFrame(() => { calls.push('кадр'); requestAnimationFrame(() => calls.push('следующий кадр')); });
    await h.delay(10);
    assert.deepEqual(calls, [], 'очередь сама не исполняется в async act');
    clock.runTimers(); assert.deepEqual(calls, ['таймер']);
    clock.runFrame(); assert.deepEqual(calls, ['таймер', 'кадр']);
    assert.ok(document.activeElement === field, 'часы не вызывают focus вместо приложения');
    clock.runFrame(); assert.deepEqual(calls, ['таймер', 'кадр', 'следующий кадр']);
  } finally { clock.restore(); field.remove(); }
  assert.equal(globalThis.requestAnimationFrame, oldFrame); assert.equal(globalThis.setTimeout, oldSet);
});

for (const exit of ['крестик', 'Escape'] as const) {
  h.mutantTest(`R113 ${exit}: отсутствие RAF возврата фокуса поймано настоящим activeElement`, async () => {
    await h.rejectMutant((source) => source.replace('else requestAnimationFrame(() => inputRef.current?.focus());',
      '/* mutant: после отказа фокус не возвращается в composer */'), async (component, confirm) => {
      const field = await openComposerEdit(component, confirm, undefined, true);
      await composerValue('изменение перед отказом');
      // Иначе useFocusTrap может самостоятельно вернуть focus на поле и спрятать удалённый RAF.
      // Реальный сценарий: Tab на «Сохранить», затем Escape/крестик вместо сохранения.
      const sourceButton = h.host.querySelector<HTMLButtonElement>('.composer button[title="Сохранить"]');
      assert.ok(sourceButton, 'в правке можно перевести фокус на кнопку сохранения');
      sourceButton.focus(); assert.ok(document.activeElement === sourceButton);
      await act(async () => {
        if (exit === 'крестик') h.host.querySelector<HTMLButtonElement>('.edit-strip .rs-close')!.click();
        else sourceButton.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }));
      });
      assert.ok(document.querySelector('.confirm-overlay'), 'изменённая правка спрашивает перед выходом');
      await h.runUiTimers();
      const resume = [...document.querySelectorAll<HTMLButtonElement>('.confirm-actions button')].find((b) => b.textContent?.includes('Продолжить'))!;
      assert.ok(document.activeElement === resume, 'фокус действительно ушёл в окно подтверждения');
      await act(async () => { resume.click(); });
      assert.equal(document.querySelector('.confirm-overlay') === null, true, 'commit снял окно до возвратного кадра');
      assert.ok(h.host.querySelector('.edit-strip')); assert.equal(field.value, 'изменение перед отказом');
      assert.ok(document.activeElement !== field, 'до кадра ловушка сама не вернула focus в composer');
      await h.runUiFrame();
      assert.ok(document.activeElement === field, 'RAF после отказа возвращает настоящий фокус в composer');
    }, 'RAF после отказа возвращает настоящий фокус в composer');
  });
}

it('R109 сохранить вызывает onEdit только для нового текста и возвращает черновик', async () => {
  h.round12(); h.desktop(); const edits: string[] = [];
  await h.mount({ messages: [h.msg('save-edit')], onEdit: async (m, text) => { edits.push(`${m.id}:${text}`); } });
  await composerValue('мой черновик'); await messageChoice('save-edit', 'Изменить');
  await composerValue('исправлено');
  await act(async () => { h.host.querySelector<HTMLButtonElement>('.composer button[title="Сохранить"]')!.click(); await h.flush(); });
  assert.deepEqual(edits, ['save-edit:исправлено']); assert.equal(h.host.querySelector('.edit-strip') === null, true);
  assert.equal(h.host.querySelector<HTMLTextAreaElement>('.composer textarea')!.value, 'мой черновик');
  await messageChoice('save-edit', 'Изменить');
  await act(async () => { h.host.querySelector<HTMLButtonElement>('.composer button[title="Сохранить"]')!.click(); await h.flush(); });
  assert.deepEqual(edits, ['save-edit:исправлено'], 'нет изменений — нет запроса');
  assert.equal(h.host.querySelector<HTMLTextAreaElement>('.composer textarea')!.value, 'мой черновик');
});

h.mutantTest('R109 ответ во время правки откладывается до отмены и не сбрасывает текст', async () => {
  await h.rejectMutant((s) => s.replace('    if (composerEdit) {\n      if (draftBeforeEdit.current)', '    if (composerEdit) finishComposerEdit();\n    if (false) {\n      if (draftBeforeEdit.current)'), async (component, confirm) => {
    const field = await openComposerEdit(component, confirm); await composerValue('исправление');
    await messageChoice('composer-reply', 'Ответить');
    assert.ok(h.host.querySelector('.edit-strip'), 'ответ сохраняет активную правку'); assert.equal(field.value, 'исправление');
    await act(async () => { h.host.querySelector<HTMLButtonElement>('.edit-strip .rs-close')!.click(); await h.flush(); });
    const discard = [...document.querySelectorAll<HTMLButtonElement>('.confirm-actions button')].find((b) => b.textContent?.includes('Отбросить'))!;
    await act(async () => { discard.click(); await h.flush(); });
    assert.equal(field.value, 'черновик до правки'); assert.equal(h.host.querySelector('.edit-strip') === null, true);
    assert.match(h.host.querySelector('.reply-strip')?.textContent ?? '', /composer-reply/);
  }, 'ответ сохраняет активную правку');
});

h.mutantTest('R109 вложения скрыты в правке, новые отклоняются с тостом, прежние возвращаются', async () => {
  await h.rejectMutant((s) => s.replace("    if (composerEdit) return void toast('info', 'Во время правки сообщения вложения не добавить');", ''), async (component, confirm, _answer, runtime = h.server) => {
    const field = await openComposerEdit(component, confirm);
    // Сначала вернёмся, чтобы добавить файл в обычный черновик; FileList читается настоящим onChange.
    await act(async () => { h.host.querySelector<HTMLButtonElement>('.edit-strip .rs-close')!.click(); await h.flush(); });
    const input = h.host.querySelector<HTMLInputElement>('.composer input[type="file"]')!;
    const add = async (name: string) => {
      Object.defineProperty(input, 'files', { configurable: true, value: [new File(['file'], name, { type: 'text/plain' })] });
      await act(async () => { input.dispatchEvent(new Event('change', { bubbles: true })); await h.flush(); });
    };
    const oldFiles = Object.getOwnPropertyDescriptor(input, 'files');
    try {
      await add('before-edit.txt'); assert.match(h.host.querySelector('.pending-atts')?.textContent ?? '', /before-edit.txt/);
      await messageChoice('composer-edit', 'Изменить'); assert.equal(h.host.querySelector('.pending-atts') === null, true);
      const { useToasts } = await runtime.ssrLoadModule('/src/toast.ts') as typeof import('../toast');
      const oldToasts = useToasts.getState().toasts;
      try {
        await add('during-edit.txt');
        assert.equal(useToasts.getState().toasts.at(-1)?.title, 'Во время правки сообщения вложения не добавить', 'правка отклоняет новый файл с тостом');
        await act(async () => { h.host.querySelector<HTMLButtonElement>('.edit-strip .rs-close')!.click(); await h.flush(); });
        assert.match(h.host.querySelector('.pending-atts')?.textContent ?? '', /before-edit.txt/);
        assert.doesNotMatch(h.host.querySelector('.pending-atts')?.textContent ?? '', /during-edit.txt/);
        assert.equal(field.value, 'черновик до правки');
      } finally { try { h.unmount(); } finally { useToasts.setState({ toasts: oldToasts }); } }
    } finally {
      try { h.unmount(); } finally {
        if (oldFiles) Object.defineProperty(input, 'files', oldFiles); else Reflect.deleteProperty(input, 'files');
      }
    }
  }, 'правка отклоняет новый файл с тостом');
});

it('R109 запись и прослушивание не допускают правку, свободное поле допускает', () => {
  // Исполняем неизменённое тело startComposerEdit с состояниями контроллера: без искусственной камеры/кодека.
  const source = readFileSync(new URL('./MessagePane.tsx', import.meta.url), 'utf8');
  const parsed = ts.createSourceFile('MessagePane.tsx', source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  let body = '';
  const visit = (n: ts.Node) => { if (ts.isFunctionDeclaration(n) && n.name?.text === 'startComposerEdit') body = n.getText(parsed); ts.forEachChild(n, visit); }; visit(parsed);
  assert.ok(body, 'найдена настоящая функция входа в правку');
  const check = (code: string) => {
    for (const state of [{ recording: true, preview: null }, { recording: false, preview: {} }, { recording: false, preview: null }]) {
      const edits: unknown[] = [], toasts: string[] = [];
      const context = { ...state, composerEdit: null, text: 'черновик', replyingTo: null, draftBeforeEdit: { current: null }, inputRef: { current: null },
        setReplyingTo: () => {}, setComposerEdit: (m: unknown) => edits.push(m), setText: () => {}, requestAnimationFrame: () => {},
        toast: (_kind: string, title: string) => toasts.push(title), m: h.msg('voice-edit') };
      runInNewContext(ts.transpileModule(code + '\nstartComposerEdit(m);', { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText, context, { timeout: 1000 });
      const busy = state.recording || !!state.preview;
      assert.equal(edits.length, busy ? 0 : 1, 'занятое голосовым поле не переходит в правку');
      assert.deepEqual(toasts, busy ? ['Нельзя изменить сообщение, пока не отправлено голосовое'] : []);
    }
  };
  check(body);
  counterfact(() => {
    const changed = body.replace("if (recording || preview) return void toast('info', 'Нельзя изменить сообщение, пока не отправлено голосовое');", '');
    assert.notEqual(changed, body);
    assert.throws(() => check(changed), (e: unknown) => e instanceof assert.AssertionError && e.message.includes('занятое голосовым поле не переходит в правку'));
  }, { timeoutMs: 60000 });
});

for (const regression of ['правка без вопроса', 'ответ с вопросом'] as const) {
h.mutantTest(`R110 Android Назад: ${regression} пойман, повтор закрывает только окно`, async () => {
  await h.rejectMutant((s) => regression === 'правка без вопроса'
    ? s.replace('if (composerEdit) cancelEditRef.current();', 'if (composerEdit) finishComposerEdit();')
    : s.replace('else setReplyingTo(null);\n      return true;', 'else void askDiscardEdit().then((ok) => { if (ok) setReplyingTo(null); });\n      return true;'), async (component, confirm, _answer, runtime = h.server) => {
    const field = await openComposerEdit(component, confirm);
    const { useStore } = await runtime.ssrLoadModule('/src/store.ts') as typeof import('../store');
    const { stepBack } = await runtime.ssrLoadModule('/src/androidBack.ts') as typeof import('../androidBack');
    const old = useStore.getState();
    useStore.setState({ mobilePane: 'content', adminOpen: false, settingsOpen: false, mobileProfileOpen: false, mobileMembersOpen: false }); h.mobile();
    const back = async () => { await act(async () => { assert.equal(stepBack(), true); await h.flush(); }); };
    try {
      await composerValue('изменено после открытия'); await back();
      assert.ok(document.querySelector('.confirm-overlay'), 'Android Назад спрашивает об изменённой правке');
      await back(); assert.equal(document.querySelector('.confirm-overlay') === null, true, 'повтор закрывает только окно');
      assert.ok(h.host.querySelector('.edit-strip')); assert.equal(field.value, 'изменено после открытия');
      await composerValue('composer-edit'); await back();
      assert.equal(h.host.querySelector('.edit-strip') === null, true); assert.equal(field.value, 'черновик до правки');
      assert.equal(document.querySelector('.confirm-overlay') === null, true, 'нет изменения — нет вопроса');
      await messageChoice('composer-reply', 'Ответить'); await back();
      assert.ok(!h.host.querySelector('.reply-strip'), 'ответ снимается молча'); assert.ok(!document.querySelector('.confirm-overlay'), 'ответ не спрашивает подтверждения');
      assert.equal(useStore.getState().mobilePane, 'content', 'назад не уводит в список');
    } finally { try { h.unmount(); } finally { useStore.setState(old); h.desktop(); } }
  }, regression === 'правка без вопроса' ? 'Android Назад спрашивает об изменённой правке' : 'ответ снимается молча');
});
}

h.mutantTest('R109 edit-last в пустом поле действительно начинает правку, непустое поле остаётся черновиком', async () => {
  await h.rejectMutant((s) => s.replace('              startComposerEdit(lastOwn);', '              /* mutant: edit-last ничего не делает */'), async (component) => {
    h.round12(); h.desktop(); await h.mount({ messages: [h.msg('arrow-own')] }, component);
    const field = await composerValue('непустой черновик');
    const up = async () => { await act(async () => { field.setSelectionRange(0, 0); field.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowUp', bubbles: true, cancelable: true })); await h.flush(); }); };
    await up(); assert.equal(h.host.querySelector('.edit-strip') === null, true, 'непустой черновик не становится правкой'); assert.equal(field.value, 'непустой черновик');
    await composerValue(''); await up(); assert.ok(h.host.querySelector('.edit-strip'), 'edit-last открывает правку своего сообщения'); assert.equal(field.value, 'arrow-own');
  }, 'edit-last открывает правку своего сообщения');
});

h.mutantTest('R110 удержание самого текста открывает меню сообщения, а не выбор слова', async () => {
  await h.rejectMutant((s) => s.replace('      open();\n    };\n    // Прежний таймер', '      if (selectMessageText(messages.find((m) => m.id === id)!)) return;\n      open();\n    };\n    // Прежний таймер'), async (component) => {
  h.mobile(); h.round12(); const restore = h.pointerLayout(true, 390);
  try {
    await h.mount({ messages: [h.msg('long-text')], batch: { forward: async () => {}, deleteMany: async () => {}, peerName: () => 'Друг', open: () => {} } }, component);
    const body = h.host.querySelector<HTMLElement>('.message-body')!;
    await act(async () => { h.touch(body, 'touchstart', 25, 25); await h.delay(510); await h.flush(); });
    assert.ok(document.querySelector('.ctx-menu'), 'удержание текста открывает меню сообщения');
    assert.equal(h.host.querySelector('.sel-head') === null, true, 'само удержание не выбирает сообщение');
    assert.equal(document.querySelector('.tsel-bar') === null, true, 'панель слова не открыта');
    await act(async () => { h.touch(body, 'touchend', 25, 25); body.click(); await h.flush(); });
  } finally { try { h.unmount(); } finally { restore(); h.desktop(); } }
  }, 'удержание текста открывает меню сообщения');
});

h.mutantTest('R110 Выделить текст есть только на телефоне после копирования и только у текста', async () => {
  await h.rejectMutant((s) => s.replaceAll('{phoneUi() && m.content && (', '{m.content && ('), async (component) => {
    h.round12(); h.desktop(); const restore = h.pointerLayout(false, 1200);
    try {
      await h.mount({ messages: [h.msg('menu-text')] }, component);
      const open = async () => { await act(async () => { h.host.querySelector<HTMLElement>('[data-mid="menu-text"]')!.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true })); await h.flush(); }); };
      await open();
      assert.ok(!document.querySelector('.ctx-menu')?.textContent?.includes('Выделить текст'), 'ПК не предлагает телефонное выделение текста');
      h.unmount(); h.mobile(); await h.mount({ messages: [h.msg('menu-text')] }, component); await open();
      const buttons = [...document.querySelectorAll<HTMLButtonElement>('.ctx-menu button')];
      const labels = buttons.map((b) => b.textContent?.trim()); const select = labels.indexOf('Выделить текст');
      assert.equal(select, labels.indexOf('Скопировать текст') + 1); assert.ok(select > 0);
      const body = h.host.querySelector<HTMLElement>('.message-body')!;
      const restoreFeedRect = overrideRect(h.host.querySelector<HTMLElement>('.messages')!, new DOMRect(0, 80, 400, 500));
      const restoreRects = h.mockTextRangeRects(body.firstChild as Text);
      try { await act(async () => { buttons[select].click(); await h.flush(); }); assert.ok(document.querySelector('.tsel-bar'), 'пункт открывает выделение всего тела'); }
      finally { try { h.unmount(); } finally { restoreRects(); restoreFeedRect(); } }
      h.unmount();
      await h.mount({ messages: [{ ...h.msg('menu-text'), content: '', attachments: [{ url: '/file.txt', name: 'file.txt', size: 1, contentType: 'text/plain' }] } as Message] }, component); await open();
      assert.ok(!document.querySelector('.ctx-menu')?.textContent?.includes('Выделить текст'), 'одни вложения не предлагают выделять отсутствующий текст');
      h.unmount();
      // В браузере телефона isMobile() ложен: прежний тест видел только APK и пропускал эту регрессию.
      for (const width of [384, 760, 761, 1200]) {
        h.desktop(); const restoreWidth = h.pointerLayout(width <= 760, width);
        try {
          await h.mount({ messages: [h.msg('menu-text')] }, component); await open();
          const browserLabels = [...document.querySelectorAll<HTMLButtonElement>('.ctx-menu button')].map(b => b.textContent?.trim());
          const textAt = browserLabels.indexOf('Выделить текст');
          assert.equal(textAt >= 0, width <= 760, `R345 браузер ${width}: телефонный пункт зависит от границы 760`);
          if (width <= 760) {
            assert.ok(browserLabels.indexOf('Скопировать текст') >= 0, 'R345 телефон сохраняет копирование');
            assert.equal(textAt, browserLabels.indexOf('Скопировать текст') + 1, 'R345 выделение идёт сразу после копирования');
            h.unmount();
            await h.mount({ messages: [{ ...h.msg('menu-text'), content: '', attachments: [{ url: '/file.txt', name: 'file.txt', size: 1, contentType: 'text/plain' }] } as Message] }, component); await open();
            assert.ok(!document.querySelector('.ctx-menu')?.textContent?.includes('Выделить текст'), 'R345 браузер с одними вложениями не предлагает выделение');
          }
        } finally { try { h.unmount(); } finally { restoreWidth(); } }
      }
      const restoreNarrow = h.pointerLayout(true, 384);
      Object.defineProperty(window, '__TAURI_INTERNALS__', { configurable: true, value: {} });
      try {
        await h.mount({ messages: [h.msg('menu-text')] }, component); await open();
        assert.ok(!document.querySelector('.ctx-menu')?.textContent?.includes('Выделить текст'), 'R345 узкий desktop Tauri остаётся ПК');
      } finally { try { h.unmount(); } finally { restoreNarrow(); h.desktop(); } }
    } finally { try { h.unmount(); } finally { restore(); h.desktop(); } }
  }, 'ПК не предлагает телефонное выделение текста');
});

const browserSelectName = 'R345 браузер телефона не теряет Выделить текст при откате phoneUi к isMobile';
h.mutantTest(browserSelectName, async () => {
  const expected = 'R345 браузер выделение: пункт доступен при ложном isMobile';
  const check = async (component: typeof h.Pane) => {
    h.desktop(); const restore = h.pointerLayout(true, 384);
    try {
      await h.mount({ messages: [h.msg('browser-select')] }, component);
      const row = h.host.querySelector<HTMLElement>('[data-mid="browser-select"]'); assert.ok(row, 'R345 setup: сообщение браузера смонтировано');
      await act(async () => { row.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true })); await h.flush(); });
      assert.ok([...document.querySelectorAll<HTMLButtonElement>('.ctx-menu button')].some(button => button.textContent?.trim() === 'Выделить текст'), expected);
    } finally { try { h.unmount(); } finally { restore(); h.desktop(); } }
  };
  await h.rejectMutant(raw => raw.replaceAll('{phoneUi() && m.content && (', '{isMobile() && m.content && ('), check, expected);
  if (process.env.GUSVOICE_PANE_MUTANT === browserSelectName) {
    // В child после адресного AssertionError — новый исходный Vite-модуль и DOM, не повтор мутанта.
    const fresh = await h.paneServer();
    try { await check((await fresh.ssrLoadModule('/src/components/MessagePane.tsx')).MessagePane); }
    finally { try { h.unmount(); } finally { await fresh.close(); } }
  }
});

h.textSelMutantTest('R110 allTextSel выбирает всё тело с краевыми пробелами, пустое тело не выбирает', () => {
  const body = document.createElement('div'); body.innerHTML = '  первое <b>второе🙂</b>  <span class="bub-meta">12:34</span><span class="spoiler">секрет</span>';
  const sel = h.allTextSel(body); assert.ok(sel); assert.equal(sel.body === body, true); assert.equal(sel.start, 0); assert.equal(sel.end, '  первое второе🙂  '.length, 'весь текст выбран включая краевые пробелы');
  for (const text of ['', ' \n\t ']) { body.textContent = text; assert.equal(h.allTextSel(body) === null, true); }
  body.innerHTML = '<span class="ts">12:34</span><span class="spoiler">секрет</span>'; assert.equal(h.allTextSel(body) === null, true);
}, 'весь текст выбран включая краевые пробелы');

// Клавиатура, отправка и вложения: тот же основной Vite runtime.
// R375: fake browser timers after mount; Vite, React's scheduler and harness delays retain native timers.
function suggestionClock() {
  const saved: Array<[object, string, PropertyDescriptor | undefined]> = [];
  const timers = new Map<number, { at: number; run(): void }>();
  const frames = new Map<number, FrameRequestCallback>();
  let now = 0, frameTime = 0, nextId = -1_000_000, steps = 0;
  const step = () => { if (++steps > 200) throw new Error('Превышен бюджет часов подсказок'); };
  const patch = (target: object, key: string, value: unknown) => {
    saved.push([target, key, Object.getOwnPropertyDescriptor(target, key)]);
    Object.defineProperty(target, key, { configurable: true, writable: true, value });
  };
  const clearTimer = window.clearTimeout.bind(window);
  patch(window, 'setTimeout', (callback: TimerHandler, delay = 0, ...args: unknown[]) => {
    step();
    if (typeof callback !== 'function' || !Number.isFinite(delay) || delay < 0) throw new Error('Неподдерживаемый браузерный таймер');
    const id = nextId--;
    timers.set(id, { at: now + delay, run: () => callback(...args) });
    return id;
  });
  patch(window, 'clearTimeout', (id: number) => { if (!timers.delete(id)) clearTimer(id); });
  for (const target of new Set([globalThis, window])) {
    const cancelFrame = target.cancelAnimationFrame.bind(target);
    patch(target, 'requestAnimationFrame', (callback: FrameRequestCallback) => {
      step(); const id = nextId--; frames.set(id, callback); return id;
    });
    patch(target, 'cancelAnimationFrame', (id: number) => { if (!frames.delete(id)) cancelFrame(id); });
  }
  return {
    advance(ms: number) {
      if (!Number.isFinite(ms) || ms < 0) throw new Error('Недопустимый шаг часов');
      const until = now + ms;
      for (;;) {
        const due = [...timers].filter(([, timer]) => timer.at <= until).sort((a, b) => a[1].at - b[1].at);
        if (!due.length) break;
        step();
        const [id, timer] = due[0];
        timers.delete(id); now = timer.at; timer.run();
      }
      now = until;
    },
    frame() {
      frameTime += 16;
      for (const [id, callback] of [...frames]) {
        step(); if (frames.delete(id)) callback(frameTime);
      }
    },
    restore() {
      timers.clear(); frames.clear();
      for (const [target, key, descriptor] of saved.reverse()) {
        if (descriptor) Object.defineProperty(target, key, descriptor);
        else Reflect.deleteProperty(target, key);
      }
    },
  };
}

async function sendWord(word: 'fire' | 'да', touch: boolean, waitForStrip: boolean) {
  const oldSuggest = localStorage.getItem('gv_emoji_suggest');
  const oldSendMode = localStorage.getItem('gv_send_mode');
  const sent: string[] = [];
  let finish!: () => void;
  const network = new Promise<void>(resolve => { finish = resolve; });
  let clock: ReturnType<typeof suggestionClock> | undefined;
  let field: HTMLTextAreaElement | undefined;
  let oldSet: PropertyDescriptor | undefined, watching = false;
  h.desktop(); h.round12();
  const restoreLayout = h.pointerLayout(touch, touch ? 390 : 1024);
  try {
    localStorage.setItem('gv_emoji_suggest', 'on');
    localStorage.setItem('gv_send_mode', 'enter');
    const emojiIndex = await h.server.ssrLoadModule('/src/emojiIndex.ts') as typeof import('../emojiIndex');
    await emojiIndex.loadEmojiIndex();
    const emoji = await h.server.ssrLoadModule('/src/emojiShortcodes.ts') as typeof import('../emojiShortcodes');
    assert.ok(emoji.exactEmojiEntries(word).length > 0, 'живой каталог даёт точную подсказку для введённого слова');
    await h.mount({ feedId: 'suggestion-send-chat', onSend: async text => { sent.push(text); await network; } });
    field = h.host.querySelector<HTMLTextAreaElement>('.composer-input') ?? undefined;
    assert.ok(field, 'настоящий composer содержит поле ввода');
    field.focus(); field.setAttribute('autocapitalize', 'sentences');
    clock = suggestionClock();
    await act(async () => {
      Simulate.change(field!, { target: { value: word, selectionStart: word.length } as unknown as EventTarget });
      await h.flush();
    });
    assert.equal(field.value, word);
    assert.equal(h.host.querySelectorAll('.ac-pop').length, 0, 'до задержки полоса ещё не показана');
    if (waitForStrip) {
      await act(async () => { clock!.advance(299); await h.flush(); });
      assert.equal(h.host.querySelectorAll('.ac-pop').length, 0, 'на 299 мс подсказки ещё скрыты');
      await act(async () => { clock!.advance(1); await h.flush(); });
      assert.ok(h.host.querySelectorAll('[data-testid="emoji-suggest"] .ac-item').length > 0,
        'на 300 мс полоса действительно появляется до отправки');
      assert.equal(h.host.querySelectorAll('.ac-item.active').length, 0, 'слово целиком не выбирает эмодзи за человека');
    }

    const writes: string[] = [];
    oldSet = Object.getOwnPropertyDescriptor(field, 'setAttribute');
    const setAttribute = field.setAttribute.bind(field);
    Object.defineProperty(field, 'setAttribute', { configurable: true, value(name: string, value: string) {
      if (name === 'autocapitalize') writes.push(value);
      setAttribute(name, value);
    } });
    watching = true;
    const form = field.closest('form');
    assert.ok(form);
    await act(async () => {
      if (touch) Simulate.submit(form);
      else field!.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }));
      await h.flush();
    });
    assert.equal(field.value, '', 'поле очищено до ответа сервера');
    assert.deepEqual(sent, [word], 'отправлено само слово ровно один раз, а не выбранный эмодзи');
    assert.equal(h.host.querySelectorAll('.ac-pop').length, 0, 'сразу после отправки над пустым полем полосы нет');
    assert.equal(document.activeElement === field, true, 'отправка не закрывает клавиатуру через blur');
    assert.equal(field.getAttribute('autocapitalize'), touch ? 'off' : 'sentences');
    assert.deepEqual(writes, touch ? ['off'] : [], 'сброс Shift относится только к сенсорному полю');
    await act(async () => { clock!.frame(); await h.flush(); });
    assert.equal(field.getAttribute('autocapitalize'), 'sentences', 'кадр возвращает прежний режим клавиатуры');
    assert.deepEqual(writes, touch ? ['off', 'sentences'] : []);
    assert.equal(document.activeElement === field, true);
    await act(async () => { clock!.advance(400); await h.flush(); });
    assert.equal(field.value, '');
    assert.equal(h.host.querySelectorAll('.ac-pop').length, 0, 'отложенный показ через 400 мс не возвращает полосу над пустым полем');
    finish(); await h.flush();
    assert.equal(h.host.querySelectorAll('.ac-pop').length, 0, 'ответ сервера тоже не воскрешает подсказки');
    assert.deepEqual(sent, [word]);
  } finally {
    finish();
    try { await h.flush(); } finally {
      try { h.unmount(); } finally {
        clock?.restore();
        if (field && watching) {
          if (oldSet) Object.defineProperty(field, 'setAttribute', oldSet);
          else Reflect.deleteProperty(field, 'setAttribute');
        }
        restoreLayout(); h.desktop();
        if (oldSuggest === null) localStorage.removeItem('gv_emoji_suggest'); else localStorage.setItem('gv_emoji_suggest', oldSuggest);
        if (oldSendMode === null) localStorage.removeItem('gv_send_mode'); else localStorage.setItem('gv_send_mode', oldSendMode);
      }
    }
  }
}

// R292/R375: сохраняет исходное поведение сброса Shift и закрытия уже видимой полосы.
it('отправка с телефона закрывает видимые подсказки и сбрасывает Shift без потери фокуса', async () => {
  await sendWord('fire', true, true);
});

// R375: регрессия владельца — Enter раньше 300 мс, затем отложенный показ над уже пустым полем.
it('быстрое «да» и Enter до задержки не поднимают подсказки через 400 мс', async () => {
  await sendWord('да', false, false);
});

// Парный позитив доказывает, что «да» действительно может показать полосу, а не является пустым тестовым словом.
it('«да» показывает подсказки ровно через 300 мс, но Enter отправляет слово и убирает полосу', async () => {
  await sendWord('да', false, true);
});

// Один сценарий вместо трёх одинаковых baseline для разных исходниковых мутантов.
it('кнопка вложений показывает скрепку и открывает выбор фото, видео и файлов', async () => {
  // Проверяем настоящую кнопку, а не строку исходника: click обязан открыть существующий sheet/popup.
  const restore = h.pointerLayout(false, 1024);
  h.mobile();
  const reference = document.createElement('div');
  const { createRoot } = await import('react-dom/client');
  const iconRoot = createRoot(reference);
  try {
    await h.mount();
    const button = h.host.querySelector<HTMLButtonElement>('.att-btn.plus'); assert.ok(button);
    assert.equal(button.title, 'Прикрепить', 'подсказка объясняет действие вложения');
    const { Icon } = await h.server.ssrLoadModule('/src/components/Icon.tsx') as typeof import('./Icon');
    await act(async () => { iconRoot.render(createElement(Icon, { name: 'paperclip', size: 22 })); });
    assert.equal(button.querySelector('svg')?.outerHTML, reference.querySelector('svg')?.outerHTML, 'иконка кнопки — скрепка, не плюс');
    assert.equal(button.getAttribute('aria-expanded'), 'false');
    await act(async () => { button.click(); await h.flush(); });
    assert.equal(button.getAttribute('aria-expanded'), 'true', 'клик раскрывает выбор вложений');
    const actions = [...document.querySelectorAll<HTMLButtonElement>('.sheet-row,.ctx-menu button')].map(b => b.textContent);
    assert.ok(actions.some(text => text?.includes('Фото или видео')), 'открыт выбор фото и видео');
    assert.ok(actions.some(text => text === 'Файл' || text?.trim() === 'Файл'), 'открыт выбор файла');
  } finally {
    try { await act(async () => { iconRoot.unmount(); }); } finally {
      try { h.unmount(); } finally { h.desktop(); restore(); }
    }
  }
});

// Команды ботов в ЛС и каналах; мутанты сохраняют изолированные child runtime.
const commands: BotCommandInfo[] = [
  { command: 'status', description: 'Состояние сервера' },
  { command: 'start', description: 'Начать' },
];
const keyboard: InlineKeyboard = [[{ text: 'Обновить', callback_data: 'refresh' }]];
const channelBots: ChannelBotsInfo['bots'] = [
  { id: 'alpha', username: 'AlphaBot', displayName: 'Альфа', avatarUrl: null,
    commands: [{ command: 'status', description: 'Статус Альфы' }] },
  { id: 'beta', username: 'BetaBot', displayName: 'Бета', avatarUrl: null,
    commands: [{ command: 'help', description: 'Справка Беты' }] },
];
let sequence = 0;
type Options = { bot?: boolean; commands?: BotCommandInfo[]; mobile?: boolean; props?: Partial<Props>;
  channel?: boolean; channelBots?: ChannelBotsInfo['bots'] };
type Scene = { props: Partial<Props>; sent: Array<{ content: string; files: File[]; replyToId: string | null }>;
  pressed: Array<{ channel: string; message: string; data: string }> };

async function fixture(options: Options, check: (scene: Scene) => Promise<void>, runtime = h.server) {
  // Вся лента и её новые импорты настоящие. Только ответ IO и приём очередью подставлены;
  // уникальная беседа исключает влияние 60-секундного кэша соседнего сценария.
  const { api } = await runtime.ssrLoadModule('/src/api.ts') as typeof import('../api');
  const { MessagePane } = await runtime.ssrLoadModule('/src/components/MessagePane.tsx') as typeof import('./MessagePane');
  const original = api.convBotInfo, originalChannelBots = api.channelBots, originalCallback = api.channelBotCallback;
  const feedId = `r302-pane-${++sequence}`;
  const channelId = `r303-channel-${sequence}`;
  let dmCommandRequests = 0;
  api.convBotInfo = async id => {
    dmCommandRequests++;
    assert.equal(id, feedId, 'запрос команд адресован текущей беседе');
    return { id: 'test-bot', description: '', about: '', commands: options.commands ?? commands, commandsUpdatedAt: null };
  };
  api.channelBots = async id => {
    assert.equal(id, channelId, 'боты запрашиваются только для текущего канала');
    return { bots: options.channelBots ?? channelBots };
  };
  const pressed: Scene['pressed'] = [];
  api.channelBotCallback = async (channel, message, data) => { pressed.push({ channel, message, data }); return {}; };
  const sent: Scene['sent'] = [];
  const props: Partial<Props> = { botPeer: options.bot ?? !options.channel, feedId, bubbles: !options.channel,
    ...(options.channel ? { botChannelId: channelId } : {}),
    outbox: { items: [], enqueue: item => { sent.push(item); }, retry: () => {}, discard: () => {} }, ...options.props };
  try {
    if (options.mobile) h.mobile(); else h.desktop();
    await h.mount(props, MessagePane);
    await h.flush();
    await check({ props, sent, pressed });
    if (options.channel) assert.equal(dmCommandRequests, 0, 'канальная лента не запрашивает команды личной беседы');
  } finally {
    try { h.unmount(); } finally {
      api.convBotInfo = original; api.channelBots = originalChannelBots;
      api.channelBotCallback = originalCallback; h.desktop();
    }
  }
}
function field() {
  const node = h.host.querySelector<HTMLTextAreaElement>('.composer-input');
  assert.ok(node, 'настоящее поле ленты смонтировано'); return node;
}
async function input(text: string, caret = text.length) {
  const node = field();
  await act(async () => {
    Simulate.change(node, { target: { value: text, selectionStart: caret } as unknown as EventTarget });
  });
  node.setSelectionRange(caret, caret);
  return node;
}
async function key(name: string) {
  // ReactDOM загружен до before/register DOM и выбирает старый input-polyfill.
  // Native keydown после unmount обращался к его уже снятому activeElementInst (null.tag),
  // не к обработчику приложения. Как и Simulate.change выше, доставляем React-событие
  // настоящему смонтированному компоненту, не запускаем браузерный feature-polyfill HappyDOM.
  await act(async () => { Simulate.keyDown(field(), { key: name }); });
}
async function choose() {
  const node = h.host.querySelector<HTMLButtonElement>('.ac-cmd'); assert.ok(node, 'выбор существует');
  // Команда принимается на mousedown, чтобы blur поля не успел закрыть подсказку.
  await act(async () => { node.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, cancelable: true })); });
}
function botMessage(mine = false, withConversation = true): Message {
  return { ...h.msg('r302-keyboard', mine ? 'me' : 'bot'), content: 'Проверь /status',
    author: { ...h.msg('author').author, id: mine ? 'me' : 'bot', bot: true },
    keyboard, ...(withConversation ? { conversationId: 'r302-message-conversation' } : {}) } as Message;
}
async function keyboardProbe(mode: 'dm' | 'channel' | 'mine' | 'no-conversation', runtime = h.server) {
  await fixture({ props: { bubbles: mode !== 'channel', messages: [botMessage(mode === 'mine', mode !== 'no-conversation')] } }, async () => {
    const row = h.host.querySelector('[data-mid="r302-keyboard"]'); assert.ok(row);
    assert.equal(row.querySelectorAll('.bot-kb').length, mode === 'dm' ? 1 : 0, 'R302-keyboard-location');
    if (mode === 'dm') {
      assert.equal(row.querySelector('.bot-kb-btn')?.textContent, 'Обновить');
      assert.ok(row.querySelector('.bub-stack > .bubble + .bot-kb'), 'клавиатура следует за пузырём в общем стеке');
    }
  }, runtime);
}
for (const [mode, label] of [['dm', 'чужое сообщение ЛС с conversationId показывает клавиатуру'],
  ['channel', 'канал не показывает клавиатуру даже с пришедшими keyboard и conversationId'],
  ['mine', 'своё сообщение не показывает клавиатуру'], ['no-conversation', 'без conversationId клавиатура не появляется']] as const) {
  it(`R302 ${label}`, () => keyboardProbe(mode));
}
it('R302 удалённый пузырь остаётся призраком анимации, но уже без рабочей клавиатуры', async () => {
  const before = h.msg('before', 'peer', 1000, 1), message = botMessage();
  await fixture({ props: { messages: [before, message] } }, async ({ props }) => {
    const row = h.host.querySelector<HTMLElement>('[data-mid="r302-keyboard"]')!;
    const feed = h.host.querySelector<HTMLElement>('.messages')!;
    assert.equal(row.querySelectorAll('.bot-kb').length, 1);
    // HappyDOM не вычисляет layout: задаём только геометрию видимой строки, не результат ветки ghost.
    const restoreRow = overrideRect(row, new DOMRect(0, 50, 300, 50));
    const restoreFeed = overrideRect(feed, new DOMRect(0, 0, 400, 500));
    // Держим только таймер удаления призрака, не Vite/watchdog/flush. Под нагрузкой CI
    // реальные 260 мс иначе могут пройти между commit и проверкой ветки ghost.
    const held = new Set<unknown>();
    const restore: Array<() => void> = [];
    for (const target of [globalThis, window]) {
      const set = target.setTimeout.bind(target), clear = target.clearTimeout.bind(target);
      const oldSet = Object.getOwnPropertyDescriptor(target, 'setTimeout');
      const oldClear = Object.getOwnPropertyDescriptor(target, 'clearTimeout');
      Object.defineProperty(target, 'setTimeout', { configurable: true, writable: true,
        value: (fn: TimerHandler, ms?: number, ...args: unknown[]) => {
          if (ms === LEAVE_MS && typeof fn === 'function') { const id = {}; held.add(id); return id; }
          return set(fn as () => void, ms, ...args);
        } });
      Object.defineProperty(target, 'clearTimeout', { configurable: true, writable: true,
        value: (id: unknown) => { if (!held.delete(id)) clear(id as never); } });
      restore.push(() => {
        if (oldSet) Object.defineProperty(target, 'setTimeout', oldSet); else Reflect.deleteProperty(target, 'setTimeout');
        if (oldClear) Object.defineProperty(target, 'clearTimeout', oldClear); else Reflect.deleteProperty(target, 'clearTimeout');
      });
    }
    try {
      await h.rerender({ ...props, messages: [before] });
      const ghost = h.host.querySelector('.bub-out'); assert.ok(ghost, 'удалённая видимая строка действительно стала призраком');
      assert.ok(held.size > 0, 'настоящая ветка ghost поставила таймер удаления');
      assert.equal(ghost.querySelectorAll('.bot-kb').length, 0);
      assert.equal(ghost.hasAttribute('data-mid'), false);
    } finally {
      try { h.unmount(); } finally { for (const undo of restore.reverse()) undo(); held.clear(); restoreRow(); restoreFeed(); }
    }
  });
});

for (const [bot, nonempty] of [[true, true], [true, false], [false, true], [false, false]] as const) {
  it(`R302 список по /: собеседник-бот=${bot}, команды=${nonempty}`, async () => {
    await fixture({ bot, commands: nonempty ? commands : [] }, async ({ sent }) => {
      await input('/st');
      assert.equal(h.host.querySelectorAll('.ac-cmd').length, bot && nonempty ? 2 : 0);
      if (bot && nonempty) {
        assert.equal(h.host.querySelector('.ac-head')?.textContent, 'Команды бота');
        assert.deepEqual([...h.host.querySelectorAll('.ac-cmd .ac-name')].map(n => n.textContent), ['/status', '/start']);
        assert.equal(h.host.querySelector('.ac-cmd .ac-handle')?.textContent, 'Состояние сервера');
      }
      assert.equal(sent.length, 0);
    });
  });
}
async function acceptanceProbe(action: 'Enter' | 'click' | 'Tab' | 'ArrowRight', argumentsAfter = false, runtime = h.server) {
  await fixture({}, async ({ sent }) => {
    await input(argumentsAfter ? '/st аргумент' : '/st', 3);
    assert.equal(h.host.querySelectorAll('.ac-cmd').length, 2);
    if (action === 'click') await choose(); else await key(action);
    const sends = !argumentsAfter && (action === 'Enter' || action === 'click');
    assert.equal(sent.length, sends ? 1 : 0, 'R302-command-send-count');
    // applyAc всегда добавляет разделитель, а уже набранный пробел аргументов сохраняет.
    assert.equal(field().value, sends ? '' : argumentsAfter ? '/status  аргумент' : '/status ');
    assert.equal(h.host.querySelectorAll('.ac-cmd').length, 0, 'выбор закрывает список');
    if (sends) {
      assert.equal(sent[0].content, '/status');
      assert.deepEqual(sent[0].files, []); assert.equal(sent[0].replyToId, null);
    }
  }, runtime);
}
for (const action of ['Enter', 'click', 'Tab', 'ArrowRight'] as const) {
  it(`R302 ${action}: ${action === 'Enter' || action === 'click' ? 'команда отправляется один раз и поле пустеет' : 'команда только подставляется с пробелом'}`,
    () => acceptanceProbe(action));
}
for (const action of ['Enter', 'click'] as const) {
  it(`R302 ${action} при аргументах после каретки только дополняет команду и сохраняет аргументы`, () => acceptanceProbe(action, true));
}
async function menuProbe(empty: boolean, runtime = h.server) {
  await fixture({ commands: empty ? [] : commands }, async () => {
    assert.equal(h.host.querySelectorAll('.att-btn.botcmd').length, empty ? 0 : 1, 'R302-menu-commands');
  }, runtime);
}
it('R302 без команд Меню отсутствует', () => menuProbe(true));
for (const mobile of [false, true]) {
  it(`R302 ${mobile ? 'телефон сохраняет' : 'ПК скрывает'} Меню при обычном тексте, пустое поле и / сохраняют кнопку`, async () => {
    await fixture({ mobile }, async ({ sent }) => {
      assert.equal(h.host.querySelectorAll('.att-btn.botcmd').length, 1);
      await input('/st'); assert.equal(h.host.querySelectorAll('.att-btn.botcmd').length, 1);
      await input('обычный текст'); assert.equal(h.host.querySelectorAll('.att-btn.botcmd').length, mobile ? 1 : 0);
      assert.equal(sent.length, 0);
    });
  });
  it(`R302 ${mobile ? 'телефон' : 'ПК'} скрывает Меню во время правки`, async () => {
    await fixture({ mobile, props: { messages: [h.msg('edit-me')] } }, async () => {
      assert.equal(h.host.querySelectorAll('.att-btn.botcmd').length, 1);
      // Настоящее действие строки, не искусственный setter состояния composerEdit.
      const edit = h.host.querySelector<HTMLButtonElement>('[data-mid="edit-me"] button[title="Изменить"]'); assert.ok(edit);
      await act(async () => { edit.click(); });
      assert.ok(h.host.querySelector('.edit-strip'), 'режим правки действительно открыт');
      assert.equal(h.host.querySelectorAll('.att-btn.botcmd').length, 0);
    });
  });
}
it('R302 Меню открывает все команды и /, повторный клик закрывает список без отправки', async () => {
  await fixture({}, async ({ sent }) => {
    const menu = h.host.querySelector<HTMLButtonElement>('.att-btn.botcmd'); assert.ok(menu);
    await act(async () => { menu.click(); });
    assert.equal(field().value, '/'); assert.equal(h.host.querySelectorAll('.ac-cmd').length, 2);
    await act(async () => { menu.click(); });
    assert.equal(field().value, '/'); assert.equal(h.host.querySelectorAll('.ac-cmd').length, 0);
    assert.equal(sent.length, 0);
  });
});
for (const bot of [false, true]) for (const mine of [false, true]) {
  it(`R302 команда в тексте кликабельна только у чужого бота: bot=${bot}, mine=${mine}`, async () => {
    const message = botMessage(mine); message.author = { ...message.author, bot: bot || undefined };
    await fixture({ props: { messages: [message] } }, async ({ sent }) => {
      await input('черновик остаётся');
      const links = h.host.querySelectorAll<HTMLButtonElement>('[data-mid="r302-keyboard"] .bot-cmd');
      assert.equal(links.length, bot && !mine ? 1 : 0);
      if (bot && !mine) {
        await act(async () => { links[0].click(); });
        assert.equal(sent.length, 1); assert.equal(sent[0].content, '/status');
        assert.equal(field().value, 'черновик остаётся', 'команда в сообщении не стирает набранный черновик');
      } else assert.equal(sent.length, 0);
    });
  });
}

async function channelKeyboard(bot: boolean, webhook: boolean, withId: boolean, runtime = h.server) {
  const message = botMessage(false, false);
  message.author = { ...message.author, username: 'AlphaBot', bot: bot || undefined };
  if (webhook) message.webhookId = 'synthetic-webhook';
  await fixture({ channel: true, props: { messages: [message], ...(withId ? {} : { botChannelId: undefined }) } }, async ({ pressed, props }) => {
    const row = h.host.querySelector('[data-mid="r302-keyboard"]'); assert.ok(row);
    const expected = bot && !webhook && withId;
    assert.equal(row.querySelectorAll('.bot-kb').length, expected ? 1 : 0, 'R303-channel-клавиатура-только-у-бота');
    if (expected) {
      const button = row.querySelector<HTMLButtonElement>('.bot-kb-btn'); assert.ok(button);
      await act(async () => { button.click(); });
      assert.deepEqual(pressed, [{ channel: props.botChannelId, message: message.id, data: 'refresh' }]);
    } else assert.deepEqual(pressed, []);
  }, runtime);
}
for (const [bot, webhook, withId] of [[true, false, true], [false, false, true], [true, true, true], [true, false, false]] as const) {
  it(`R303 клавиатура канала: бот=${bot}, вебхук=${webhook}, botChannelId=${withId}`,
    () => channelKeyboard(bot, webhook, withId));
}
it('R303 пустая клавиатура бота в канале не оставляет пустой панели', async () => {
  const message = botMessage(false, false); message.keyboard = [];
  await fixture({ channel: true, props: { messages: [message] } }, async () => {
    assert.equal(h.host.querySelectorAll('.bot-kb').length, 0);
  });
});
it('R303 подсказки канала показывают аватар, ник и описание своего бота без HTTP к ЛС', async () => {
  await fixture({ channel: true }, async () => {
    await input('/');
    assert.equal(h.host.querySelector('.ac-head')?.textContent, 'Команды ботов');
    assert.deepEqual([...h.host.querySelectorAll('.ac-cmd .ac-name')].map(n => n.textContent), ['/status', '/help']);
    assert.deepEqual([...h.host.querySelectorAll('.ac-cmd .ac-bot')].map(n => n.textContent), ['@AlphaBot', '@BetaBot']);
    assert.deepEqual([...h.host.querySelectorAll('.ac-cmd .ac-handle')].map(n => n.textContent), ['Статус Альфы', 'Справка Беты']);
    assert.equal(h.host.querySelectorAll('.ac-cmd .ac-role-ico .avatar-letter').length, 2);
  });
});
const conflictBots: ChannelBotsInfo['bots'] = [channelBots[0], { ...channelBots[1], commands: [{ command: 'status', description: 'Статус Беты' }] }];
async function channelCommandProbe(conflict: boolean, action: 'Enter' | 'Tab' | 'click', runtime = h.server) {
  await fixture({ channel: true, channelBots: conflict ? conflictBots : channelBots }, async ({ sent }) => {
    await input('/st');
    assert.equal(h.host.querySelectorAll('.ac-cmd').length, conflict ? 2 : 1);
    if (action === 'click') await choose(); else await key(action);
    const value = conflict ? '/status@AlphaBot' : '/status';
    assert.equal(action === 'Tab' ? field().value : sent[0]?.content, action === 'Tab' ? `${value} ` : value,
      'R303-channel-команда-имеет-правильного-адресата');
    assert.equal(sent.length, action === 'Tab' ? 0 : 1); assert.equal(h.host.querySelectorAll('.ac-cmd').length, 0);
  }, runtime);
}
for (const conflict of [false, true]) for (const action of ['Enter', 'Tab', 'click'] as const) {
  it(`R303 ${action} в канале: ${conflict ? 'конфликт требует @AlphaBot' : 'единственная команда не требует ника'}`,
    () => channelCommandProbe(conflict, action));
}
it('R303 /st@be в канале фильтрует по нику бота, существующие аргументы не теряются', async () => {
  await fixture({ channel: true, channelBots: conflictBots }, async ({ sent }) => {
    await input('/st@be аргумент', 6);
    assert.equal(h.host.querySelectorAll('.ac-cmd').length, 1);
    assert.equal(h.host.querySelector('.ac-cmd .ac-bot')?.textContent, '@BetaBot');
    await key('Enter');
    assert.equal(field().value, '/status@BetaBot  аргумент'); assert.equal(sent.length, 0);
  });
});
it('R303 команда в тексте канального бота адресуется ему при конфликте и не трогает черновик', async () => {
  const message = botMessage(false, false); message.author = { ...message.author, username: 'AlphaBot' };
  await fixture({ channel: true, channelBots: conflictBots, props: { messages: [message] } }, async ({ sent }) => {
    await input('черновик');
    const link = h.host.querySelector<HTMLButtonElement>('[data-mid="r302-keyboard"] .bot-cmd'); assert.ok(link);
    await act(async () => { link.click(); });
    assert.equal(sent[0]?.content, '/status@AlphaBot'); assert.equal(sent.length, 1); assert.equal(field().value, 'черновик');
  });
});

function mutant(name: string, from: string, to: string, probe: (runtime?: ViteDevServer) => Promise<void>, message: string, actual: number, expected: number) {
  h.mutantTest(name, async () => {
    if (process.env.GV_MUTANTS !== '1' || process.env.GUSVOICE_PANE_MUTANT !== name) {
      await probe(); // Оригинал проверяется в parent; child загружает только мутант.
      return;
    }
    const extra = await h.paneServer(source => mutate(source, from, to));
    try { await assert.rejects(() => probe(extra), assertion(message, actual, expected)); }
    finally { await extra.close(); }
  });
}
mutant('R302 контрфакт: клавиатура ошибочно попадает в канал', '<div className="message-main">\n          {quote}',
  '<div className="message-main">{(m as any).keyboard && <MessageKeyboard convId={(m as any).conversationId} messageId={m.id} keyboard={(m as any).keyboard} />}\n          {quote}',
  runtime => keyboardProbe('channel', runtime), 'R302-keyboard-location', 1, 0);
mutant('R302 контрфакт: Tab отправляет вместо подстановки', "item.kind === 'command' && !insert && onlyCommandInField(text)",
  "item.kind === 'command' && onlyCommandInField(text)", runtime => acceptanceProbe('Tab', false, runtime), 'R302-command-send-count', 1, 0);
mutant('R302 контрфакт: Меню появляется без команд', "botCommands?.length && !composerEdit && (isMobile() || !text || text.startsWith('/'))",
  "!composerEdit && (isMobile() || !text || text.startsWith('/'))", runtime => menuProbe(true, runtime), 'R302-menu-commands', 1, 0);
mutant('R303 контрфакт: клавиатура у человека в канале', 'kbChannel && !m.webhookId && m.author.bot && (m as { keyboard?: InlineKeyboard }).keyboard?.length',
  'kbChannel && !m.webhookId && (m as { keyboard?: InlineKeyboard }).keyboard?.length',
  runtime => channelKeyboard(false, false, true, runtime), 'R303-channel-клавиатура-только-у-бота', 1, 0);
