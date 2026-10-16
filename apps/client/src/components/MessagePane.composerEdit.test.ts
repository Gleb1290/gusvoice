import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import ts from 'typescript';
import { it } from 'node:test';
import { act } from 'react';
import { Simulate } from 'react-dom/test-utils';
import type { Message } from '@gusvoice/shared';
import { setupHarness } from './MessagePane.behavior.harness';

const h = setupHarness(import.meta.url);


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
    } finally { restore(); }
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
    } finally { useToasts.setState({ toasts: oldToasts }); }
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
      runInNewContext(ts.transpileModule(code + '\nstartComposerEdit(m);', { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText, context);
      const busy = state.recording || !!state.preview;
      assert.equal(edits.length, busy ? 0 : 1, 'занятое голосовым поле не переходит в правку');
      assert.deepEqual(toasts, busy ? ['Нельзя изменить сообщение, пока не отправлено голосовое'] : []);
    }
  };
  check(body);
  const changed = body.replace("if (recording || preview) return void toast('info', 'Нельзя изменить сообщение, пока не отправлено голосовое');", '');
  assert.notEqual(changed, body);
  assert.throws(() => check(changed), (e: unknown) => e instanceof assert.AssertionError && e.message.includes('занятое голосовым поле не переходит в правку'));
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
    } finally { useStore.setState(old); }
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
  } finally { h.unmount(); restore(); h.desktop(); }
  }, 'удержание текста открывает меню сообщения');
});

h.mutantTest('R110 Выделить текст есть только на телефоне после копирования и только у текста', async () => {
  await h.rejectMutant((s) => s.replaceAll('{isMobile() && m.content && (', '{m.content && ('), async (component) => {
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
      h.host.querySelector<HTMLElement>('.messages')!.getBoundingClientRect = () => new DOMRect(0, 80, 400, 500);
      const restoreRects = h.mockTextRangeRects(body.firstChild as Text);
      try { await act(async () => { buttons[select].click(); await h.flush(); }); assert.ok(document.querySelector('.tsel-bar'), 'пункт открывает выделение всего тела'); }
      finally { restoreRects(); }
      h.unmount();
      await h.mount({ messages: [{ ...h.msg('menu-text'), content: '', attachments: [{ url: '/file.txt', name: 'file.txt', size: 1, contentType: 'text/plain' }] } as Message] }, component); await open();
      assert.ok(!document.querySelector('.ctx-menu')?.textContent?.includes('Выделить текст'), 'одни вложения не предлагают выделять отсутствующий текст');
    } finally { h.unmount(); restore(); h.desktop(); }
  }, 'ПК не предлагает телефонное выделение текста');
});

h.textSelMutantTest('R110 allTextSel выбирает всё тело с краевыми пробелами, пустое тело не выбирает', () => {
  const body = document.createElement('div'); body.innerHTML = '  первое <b>второе🙂</b>  <span class="bub-meta">12:34</span><span class="spoiler">секрет</span>';
  const sel = h.allTextSel(body); assert.ok(sel); assert.equal(sel.body === body, true); assert.equal(sel.start, 0); assert.equal(sel.end, '  первое второе🙂  '.length, 'весь текст выбран включая краевые пробелы');
  for (const text of ['', ' \n\t ']) { body.textContent = text; assert.equal(h.allTextSel(body) === null, true); }
  body.innerHTML = '<span class="ts">12:34</span><span class="spoiler">секрет</span>'; assert.equal(h.allTextSel(body) === null, true);
}, 'весь текст выбран включая краевые пробелы');
