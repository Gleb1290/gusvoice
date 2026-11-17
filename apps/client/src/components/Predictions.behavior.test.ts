import assert from 'node:assert/strict';
import { before, after, it } from 'node:test';
import { GlobalRegistrator } from '@happy-dom/global-registrator';
import * as React from 'react';
import { jsx, jsxs } from 'react/jsx-runtime';
import { createRoot } from 'react-dom/client';
import { Simulate } from 'react-dom/test-utils';
import * as shared from '@gusvoice/shared';
import * as rules from '../predictionRules';
import * as wheel from '../wheelRules';
import { sourceOf, load, pairedAsync, event, question, normal, noop, type Edit } from '../predictions.harness';

const source = sourceOf('./components/Predictions.tsx'), P = 'R338 UI: ';
before(() => { GlobalRegistrator.register({ url: 'http://localhost/' }); Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true }); });
after(() => { GlobalRegistrator.unregister(); });
type Editor = React.ComponentType<{ serverId: string; onDone(): void }>;
type Question = React.ComponentType<{ serverId: string; ev: shared.PredictionEventDto; q: shared.PredictionQuestionDto; meId: string | null; canBet: boolean }>;
type PrivateModule = { PredictionFeed: React.ComponentType<{ serverId: string; onNew(): void }>; EventCard: React.ComponentType<{ serverId: string; ev: shared.PredictionEventDto; now: number }>; PredictionEditor: Editor; QuestionBlock: Question;
  SettleForm: React.ComponentType<{ serverId: string; ev: shared.PredictionEventDto; onDone(): void }> };
function emitter() {
  const handlers = new Map<string, Set<EventListener>>();
  return {
    addEventListener(name: string, fn: EventListener) { if (!handlers.has(name)) handlers.set(name, new Set()); handlers.get(name)!.add(fn); },
    removeEventListener(name: string, fn: EventListener) { handlers.get(name)?.delete(fn); },
    fire(name = 'resize') { for (const fn of [...(handlers.get(name) ?? [])]) fn(new Event(name)); },
    count: () => [...handlers.values()].reduce((sum, set) => sum + set.size, 0),
  };
}
function fixture(raw: string, viewport: boolean = true, pending = false, identity: { userId: string | null; canManage: boolean } = { userId: 'me', canManage: false }) {
  const winEvents = emitter(), vvEvents = emitter();
  const vv = { ...vvEvents, offsetTop: 20, height: 280 };
  const win = { ...winEvents, innerHeight: 600, visualViewport: viewport ? vv : null };
  const frames = new Map<number, FrameRequestCallback>(); let nextFrame = 0;
  const apiCalls: Array<{ method: string; args: unknown[] }> = [], applied: unknown[] = [];
  let failure: Error | undefined;
  let release: (() => void) | undefined;
  const waiting = pending ? new Promise<void>((resolve) => { release = resolve; }) : Promise.resolve();
  const api = Object.fromEntries(['createPrediction', 'settlePrediction', 'betPrediction', 'predictionAction'].map(method => [method, async (...args: unknown[]) => {
    apiCalls.push({ method, args: normal(args) });
    await waiting;
    if (failure) throw failure;
    return { event: event(), serverNow: '2026-10-28T12:00:00.000Z' };
  }]));
  const state = { user: identity.userId ? { id: identity.userId } : null, voice: null, predictions: { s: { betMax: 300, canManage: identity.canManage, skewMs: 0, enabled: true, events: [] as shared.PredictionEventDto[] } }, economy: { s: { wallet: { balance: 1_000 }, settings: { gamesFeePercent: 10 }, iconUrl: null } },
    applyPredictionEvent: (msg: unknown) => { applied.push(msg); return true; } };
  const useStore = Object.assign((selector: (s: typeof state) => unknown) => selector(state), { getState: () => state });
  const dependencies = {
    react: React, 'react/jsx-runtime': { jsx, jsxs, Fragment: React.Fragment }, '@gusvoice/shared': shared,
    '../api': { api }, '../assets/predictions/host.png': { default: 'host-test.png' }, '../assets/guscoin.svg': { default: 'coin-test.svg' },
    '../benchMock': { isMockEconomy: () => false }, '../confirm': { confirmAction: async () => true },
    '../economy': { gamesView: () => ({ games: { effectiveLimit: null, lossToday: 0 } }) }, '../economyClient': { ensurePredictions: noop },
    '../phoneLayout': { usePhoneLayout: () => false }, '../predictionRules': rules, '../store': { useStore, voiceIsHere: () => true },
    '../wheelRules': wheel, './BottomSheet': { BottomSheet: ({ children }: { children: React.ReactNode }) => children },
    './Duel': { useDuelPeople: () => () => ({ name: 'Участник' }), useNowTick: () => Date.now() },
    './Icon': { Icon: () => null },
  };
  // Добавлен только test-export приватных компонентов. Весь TSX остаётся в одном модуле, вычисления не вырезаются.
  const component = load<PrivateModule>(raw + '\nexport { PredictionFeed, EventCard, PredictionEditor, QuestionBlock, SettleForm };\n', dependencies, {
    window: win, document, requestAnimationFrame: (fn: FrameRequestCallback) => { const id = ++nextFrame; frames.set(id, fn); return id; },
    cancelAnimationFrame: (id: number) => { frames.delete(id); },
  });
  return { ...component, state, win, vv, frames, apiCalls, applied, release: () => release?.(), fail: (error: Error) => { failure = error; },
    runFrames() { const pending = [...frames.values()]; frames.clear(); pending.forEach(fn => fn(0)); } };
}
async function mounted(element: React.ReactNode, check: (host: HTMLDivElement) => void | Promise<void>) {
  const host = document.createElement('div'); document.body.append(host); const root = createRoot(host);
  try {
    await React.act(async () => { root.render(element); });
    await check(host);
  } finally { await React.act(async () => { root.unmount(); }); host.remove(); }
}
function inputGeometry(el: HTMLElement, top: number, bottom: number) {
  Object.defineProperty(el, 'getBoundingClientRect', { configurable: true, value: () => ({ top, bottom, left: 0, right: 200, width: 200, height: bottom - top }) });
  const calls: ScrollIntoViewOptions[] = [];
  Object.defineProperty(el, 'scrollIntoView', { configurable: true, value: (options: ScrollIntoViewOptions) => { calls.push(options); } });
  return calls;
}
function test(title: string, check: (raw: string) => Promise<void>, edits: readonly Edit[], prefix = P) {
  it(title, () => pairedAsync(source, check, edits, prefix));
}
async function fillEditor(host: HTMLElement) {
  const values = ['  Финал\n матча ', ' Кто\t победит? ', ' Альфа ', ' Бета '];
  const inputs = host.querySelectorAll<HTMLInputElement>('.pr-input');
  assert.equal(inputs.length, values.length, 'R338 setup: реальные поля редактора');
  for (let i = 0; i < inputs.length; i++) {
    await React.act(async () => { Simulate.change(inputs[i], { target: { value: values[i] } } as unknown as Parameters<typeof Simulate.change>[1]); });
  }
}

test('R338 редактор не отправляет пустой черновик, а указывает конкретное поле', async raw => {
  const f = fixture(raw); let done = 0;
  await mounted(React.createElement(f.PredictionEditor, { serverId: 's', onDone: () => { done++; } }), async host => {
    await React.act(async () => { host.querySelector<HTMLButtonElement>('.wh-place')!.click(); });
    assert.equal(f.apiCalls.length, 0, P + 'пустой черновик не отправлен');
    assert.equal(host.querySelector('#pr-ed-title')?.classList.contains('bad'), true, P + 'ошибка на заголовке');
    assert.equal(done, 0, P + 'ошибка не закрывает редактор');
  });
}, [['    if (problem) return;', '']]);

test('R338 редактор отправляет очищенное тело, применяет ответ и закрывается только после успеха', async raw => {
  const f = fixture(raw); let done = 0;
  await mounted(React.createElement(f.PredictionEditor, { serverId: 's', onDone: () => { done++; } }), async host => {
    await fillEditor(host);
    await React.act(async () => { host.querySelector<HTMLButtonElement>('.wh-place')!.click(); });
    assert.deepEqual(f.apiCalls, [{ method: 'createPrediction', args: ['s', { title: 'Финал матча', lockInSec: 300,
      questions: [{ question: 'Кто победит?', options: ['Альфа', 'Бета'] }] }] }], P + 'очищенный create');
    assert.equal(f.applied.length, 1, P + 'ответ применён тем же action');
    assert.equal(done, 1, P + 'успех закрывает редактор');
  });
}, [['api.createPrediction(serverId, draftBody(d))', 'api.createPrediction(serverId, d)'],
  ['const r = await api.createPrediction(serverId, draftBody(d));\n      applyReply(serverId, r);',
    'const r = await api.createPrediction(serverId, draftBody(d));\n      void r;']]);

test('R338 отказ сервера с field подсвечивает нужный вариант с нуля и оставляет редактор', async raw => {
  const f = fixture(raw); f.fail(Object.assign(new Error('bad_draft'), { field: 'q0.o1' })); let done = 0;
  await mounted(React.createElement(f.PredictionEditor, { serverId: 's', onDone: () => { done++; } }), async host => {
    await fillEditor(host);
    await React.act(async () => { host.querySelector<HTMLButtonElement>('.wh-place')!.click(); });
    assert.deepEqual([...host.querySelectorAll('.pr-input.bad')].map(n => n.getAttribute('aria-label')), ['Вопрос 1, вариант 2'], P + 'серверный field адресный');
    assert.match(host.querySelector('[role="alert"]')?.textContent ?? '', /Вопрос 1, вариант 2/, P + 'объяснение человеку');
    assert.equal(f.applied.length, 0, P + 'отказ не применяется'); assert.equal(done, 0, P + 'отказ не закрывает');
  });
}, [['if (er?.field) setField(er.field);', 'if (er?.field) setErr(er.message);']]);

test('R338 итог требует исход каждого вопроса и отправляет «не состоялся» как null', async raw => {
  const f = fixture(raw); let done = 0; const ev = event(); ev.questions.push(question('q2'));
  await mounted(React.createElement(f.SettleForm, { serverId: 's', ev, onDone: () => { done++; } }), async host => {
    const submit = () => host.querySelector<HTMLButtonElement>('.pr-actions button:last-child')!;
    assert.equal(submit().disabled, true, P + 'без исходов итог выключен');
    await React.act(async () => { host.querySelector<HTMLButtonElement>('.pr-q button')!.click(); });
    assert.equal(submit().disabled, true, P + 'одного исхода мало');
    await React.act(async () => { host.querySelectorAll<HTMLButtonElement>('.pr-void')[1].click(); });
    assert.equal(submit().disabled, false, P + 'null — выбранный исход');
    await React.act(async () => { submit().click(); });
    assert.deepEqual(f.apiCalls, [{ method: 'settlePrediction', args: ['s', 'event', { q: 'a', q2: null }] }], P + 'все исходы и null дошли до API');
    assert.equal(done, 1, P + 'успешный итог закрывает форму');
  });
}, [['const ready = ev.questions.every(', 'const ready = ev.questions.some('],
  ['setWinners((w) => ({ ...w, [q.id]: null }))', "setWinners((w) => ({ ...w, [q.id]: 'void' }))"]]);

test('R338 собственная ставка не добавляется в пул второй раз при прикидке выплаты', async raw => {
  const f = fixture(raw), q = question(); q.mine = { optionId: 'a', amount: 100, payout: null, refunded: false };
  await mounted(React.createElement(f.QuestionBlock, { serverId: 's', ev: event(), q, meId: 'me', canBet: true }), host => {
    assert.match(host.querySelector('.pr-mine')?.textContent ?? '', /если сыграет — ~280/, P + 'прикидка с вычетом своей ставки');
    assert.equal(host.querySelectorAll('.pr-opt:disabled').length, 2, P + 'повторная ставка недоступна');
  });
}, [['pool: Math.max(0, o.pool - mine.amount)', 'pool: Math.max(0, o.pool)']]);

test('R338 новая ставка при выборе варианта показывает прикидку без вычета ещё не сделанной ставки', async raw => {
  const f = fixture(raw);
  await mounted(React.createElement(f.QuestionBlock, { serverId: 's', ev: event(), q: question(), meId: 'me', canBet: true }), async host => {
    const options = host.querySelectorAll<HTMLButtonElement>('.pr-opt');
    assert.equal(options[0].disabled, false, P + 'новая ставка доступна');
    await React.act(async () => { options[0].click(); });
    assert.equal(host.querySelector('.pr-est b')?.textContent, '~26', P + 'новая ставка считается по полному текущему пулу');
  });
}, [['predictionEstimate(q.options, pick, amount, ev.feePercent)', 'predictionEstimate(q.options.map(o => ({ ...o, pool: 0 })), pick, amount, ev.feePercent)']]);

const SCROLL = "if (r.bottom > bottom - 8 || r.top < top) a.scrollIntoView({ block: 'center' });";
for (const row of [
  { name: 'visualViewport: поле под клавиатурой', viewport: true, top: 260, bottom: 293, edit: [SCROLL, "if (r.bottom > bottom || r.top < top) a.scrollIntoView({ block: 'center' });"] },
  { name: 'visualViewport: поле выше видимого offsetTop', viewport: true, top: 19, bottom: 50, edit: [SCROLL, "if (r.bottom > bottom - 8) a.scrollIntoView({ block: 'center' });"] },
  { name: 'window.resize без visualViewport', viewport: false, top: 580, bottom: 601, edit: ["const bottom = vv ? vv.offsetTop + vv.height : window.innerHeight;", 'const bottom = 1000;'] },
] satisfies Array<{ name: string; viewport: boolean; top: number; bottom: number; edit: Edit }>) {
  test(`Stage7 редактор возвращает в середину: ${row.name}`, async raw => {
    const f = fixture(raw, row.viewport);
    await mounted(React.createElement(f.PredictionEditor, { serverId: 's', onDone: noop }), host => {
      const input = host.querySelector<HTMLInputElement>('#pr-ed-title')!;
      const calls = inputGeometry(input, row.top, row.bottom); input.focus();
      (row.viewport ? f.vv : f.win).fire(); f.runFrames();
      assert.deepEqual(normal(calls), [{ block: 'center' }], 'Stage7 editor: поле возвращается в центр');
    });
  }, [row.edit], 'Stage7 editor: ');
}
test('Stage7 редактор не прокручивает видимое поле, чужой фокус и элемент без ввода', async raw => {
  const f = fixture(raw);
  await mounted(React.createElement(f.PredictionEditor, { serverId: 's', onDone: noop }), host => {
    const input = host.querySelector<HTMLInputElement>('#pr-ed-title')!, box = host.querySelector<HTMLElement>('.pr-editor')!;
    const visible = inputGeometry(input, 20, 292); input.focus(); f.vv.fire(); f.runFrames();
    assert.equal(visible.length, 0, 'Stage7 editor: видимое поле не трогаем');
    const outside = document.createElement('input'); document.body.append(outside);
    try {
      const calls = inputGeometry(outside, 500, 530); outside.focus(); f.win.fire(); f.runFrames();
      assert.equal(calls.length, 0, 'Stage7 editor: чужое поле не трогаем');
      const button = document.createElement('button'); box.append(button);
      const btnCalls = inputGeometry(button, 500, 530); button.focus(); f.vv.fire(); f.runFrames();
      assert.equal(btnCalls.length, 0, 'Stage7 editor: не ввод не трогаем');
    } finally { outside.remove(); }
  });
}, [[SCROLL, "a.scrollIntoView({ block: 'center' });"],
  ["!box.current?.contains(a) || ", ''], ["(a.tagName !== 'INPUT' && a.tagName !== 'TEXTAREA')", 'false']], 'Stage7 editor: ');

test('Stage7 resize обоих источников склеивается в кадр; cleanup снимает оба слушателя и pending RAF', async raw => {
  const f = fixture(raw);
  let pendingCalls: ScrollIntoViewOptions[] = [];
  await mounted(React.createElement(f.PredictionEditor, { serverId: 's', onDone: noop }), host => {
    const input = host.querySelector<HTMLInputElement>('#pr-ed-title')!;
    pendingCalls = inputGeometry(input, 500, 530); input.focus(); f.vv.fire(); f.win.fire();
    assert.equal(f.frames.size, 1, 'Stage7 editor: один RAF после двух resize');
    assert.equal(f.vv.count(), 1, 'Stage7 editor: vv listener установлен');
    assert.equal(f.win.count(), 1, 'Stage7 editor: window listener установлен');
  });
  assert.equal(f.win.count(), 0, 'Stage7 editor: window listener снят');
  assert.equal(f.vv.count(), 0, 'Stage7 editor: vv listener снят');
  assert.equal(f.frames.size, 0, 'Stage7 editor: pending RAF отменён');
  f.win.fire(); f.vv.fire(); f.runFrames();
  assert.equal(pendingCalls.length, 0, 'Stage7 editor: после unmount никакой прокрутки');
}, [["window.removeEventListener('resize', keep);", ''], ["vv?.removeEventListener('resize', keep);", ''],
  ['      cancelAnimationFrame(raf);\n      window.removeEventListener', '      window.removeEventListener'],
  ['      cancelAnimationFrame(raf);\n      raf = requestAnimationFrame', '      raf = requestAnimationFrame']], 'Stage7 editor: ');


it('ставка блокирует варианты и сумму до ответа, затем снимает блокировку при ошибке', async () => {
  const f = fixture(source, true, true);
  f.fail(new Error('failed'));
  await mounted(React.createElement(f.QuestionBlock, { serverId: 's', ev: event(), q: question(), meId: 'me', canBet: true }), async host => {
    const submit = () => host.querySelector<HTMLButtonElement>('.pr-stake .wh-place')!;
    assert.equal(submit().disabled, true);
    await React.act(async () => { host.querySelector<HTMLButtonElement>('.pr-opt')!.click(); });
    assert.equal(submit().disabled, false);
    await React.act(async () => { submit().click(); submit().click(); });
    assert.equal(f.apiCalls.length, 1);
    assert.ok([...host.querySelectorAll<HTMLButtonElement>('.pr-opt, .pr-stake button')].every(b => b.disabled));
    assert.equal(host.querySelector<HTMLInputElement>('.pr-stake input')!.disabled, true);
    await React.act(async () => { f.release(); });
    assert.equal(host.querySelector<HTMLButtonElement>('.pr-opt')!.disabled, false);
    assert.equal(submit().disabled, false);
  });
});

it('отправка итога блокирует выбор исхода и повтор до ответа', async () => {
  const f = fixture(source, true, true);
  f.fail(new Error('failed'));
  await mounted(React.createElement(f.SettleForm, { serverId: 's', ev: event(), onDone: noop }), async host => {
    await React.act(async () => { host.querySelector<HTMLButtonElement>('.pr-q button')!.click(); });
    const submit = host.querySelector<HTMLButtonElement>('.pr-actions button:last-child')!;
    await React.act(async () => { submit.click(); submit.click(); });
    assert.equal(f.apiCalls.length, 1);
    assert.ok([...host.querySelectorAll<HTMLButtonElement>('.pr-q button')].every(b => b.disabled));
    await React.act(async () => { f.release(); });
    assert.ok([...host.querySelectorAll<HTMLButtonElement>('.pr-q button')].every(b => !b.disabled));
    assert.equal(submit.disabled, false);
  });
});

it('только создатель видит закрытие и итог; модератору остаётся отмена, а событие без автора закрыть некому', async () => {
  for (const row of [
    { userId: 'creator', canManage: false, createdBy: 'creator', creator: true, cancel: true },
    { userId: 'runner', canManage: true, createdBy: 'creator', creator: false, cancel: true },
    { userId: 'owner', canManage: true, createdBy: 'creator', creator: false, cancel: true },
    { userId: 'a', canManage: false, createdBy: 'creator', creator: false, cancel: false },
    { userId: 'owner', canManage: true, createdBy: null, creator: false, cancel: true },
    { userId: null, canManage: false, createdBy: null, creator: false, cancel: false },
  ]) {
    for (const state of ['open', 'locked'] as const) {
      const f = fixture(source, true, false, row);
      const ev = event('event', { state, createdBy: row.createdBy });
      await mounted(React.createElement(f.EventCard, { serverId: 's', ev, now: Date.now() }), async host => {
        const button = (label: string) => [...host.querySelectorAll<HTMLButtonElement>('.pr-actions button')].find(b => b.textContent?.trim() === label);
        const context = `${row.userId}/${row.createdBy}/${state}`;
        assert.equal(!!button('Закрыть приём'), row.creator && state === 'open', context);
        assert.equal(!!button('Подвести итог'), row.creator && state === 'locked', context);
        assert.equal(!!button('Отменить'), row.cancel, context);
        if (row.creator && state === 'open') {
          await React.act(async () => { button('Закрыть приём')!.click(); });
          assert.deepEqual(f.apiCalls, [{ method: 'predictionAction', args: ['s', ev.id, 'close'] }]);
          assert.equal(f.applied.length, 1);
        } else if (row.userId === 'runner' && state === 'open') {
          await React.act(async () => { button('Отменить')!.click(); });
          assert.deepEqual(f.apiCalls, [{ method: 'predictionAction', args: ['s', ev.id, 'cancel'] }]);
          assert.equal(f.applied.length, 1);
        }
      });
    }
  }
});

it('отказ закрытия объясняет требование авторства и не применяет ответ как успешное изменение', async () => {
  const f = fixture(source, true, false, { userId: 'creator', canManage: false });
  f.fail(Object.assign(new Error('forbidden'), { reason: 'forbidden' }));
  await mounted(React.createElement(f.EventCard, { serverId: 's', ev: event(), now: Date.now() }), async host => {
    const button = [...host.querySelectorAll<HTMLButtonElement>('.pr-actions button')].find(b => b.textContent?.trim() === 'Закрыть приём')!;
    await React.act(async () => { button.click(); });
    assert.equal(host.querySelector('[role="alert"]')?.textContent?.trim(), 'Закрыть приём может только создатель события');
    assert.equal(f.applied.length, 0);
    assert.equal(button.disabled, false);
    assert.ok(host.querySelector('.pr-open'));
  });
});


it('лента показывает три новейших события и прячет остальные в раскрываемой истории', async () => {
  const f = fixture(source);
  const rows = [0, 4, 1, 3, 2].map(i => event(`e${i}`, { createdAt: new Date(2026, 0, i + 1).toISOString(), lockAt: null, state: i === 0 ? 'open' : i === 1 ? 'locked' : 'settled' }));
  const original = [...rows];
  const host = document.createElement('div'); document.body.append(host); const root = createRoot(host);
  const render = async () => React.act(async () => { root.render(React.createElement(f.PredictionFeed, { serverId: 's', onNew: noop })); });
  try {
    await render();
    assert.equal(host.querySelector('details'), null);
    assert.match(host.textContent ?? '', /Событий пока нет/);
    f.state.predictions.s.events = rows.slice(0, 3); await render();
    assert.equal(host.querySelector('details'), null);
    f.state.predictions.s.events = rows; await render();
    const details = host.querySelector('details')!;
    assert.equal(details.open, false);
    assert.match(details.querySelector('summary')!.textContent!, /Ещё события \(2\) · Приём открыт: 1/);
    assert.deepEqual([...host.querySelectorAll('.pr-feed > [id^="pr-ev-"]')].map(n => n.id), ['pr-ev-e4', 'pr-ev-e3', 'pr-ev-e2']);
    assert.deepEqual([...details.querySelectorAll('[id^="pr-ev-"]')].map(n => n.id), ['pr-ev-e1', 'pr-ev-e0']);
    assert.deepEqual(rows, original);
    await React.act(async () => { details.open = true; });
    assert.equal(details.open, true);
    assert.equal(host.querySelectorAll('[id^="pr-ev-"]').length, 5);
  } finally { await React.act(async () => { root.unmount(); }); host.remove(); }
});

it('обновление событий сохраняет состояние истории и существующие видимые карточки', async () => {
  const f = fixture(source);
  f.state.predictions.s.events = [1, 2, 3, 4].map(i => event(`e${i}`, { createdAt: new Date(2026, 0, i).toISOString(), lockAt: null }));
  const host = document.createElement('div'); document.body.append(host); const root = createRoot(host);
  const render = async () => React.act(async () => { root.render(React.createElement(f.PredictionFeed, { serverId: 's', onNew: noop })); });
  try {
    await render();
    const details = host.querySelector('details')!, card = host.querySelector('#pr-ev-e4');
    f.state.predictions.s.events = [...f.state.predictions.s.events, event('e5', { createdAt: new Date(2026, 0, 5).toISOString(), lockAt: null })];
    await render();
    assert.equal(details.open, false);
    assert.equal(host.querySelector('#pr-ev-e4'), card);
    await React.act(async () => { details.open = true; });
    f.state.predictions.s.events = [...f.state.predictions.s.events, event('e6', { createdAt: new Date(2026, 0, 6).toISOString(), lockAt: null })];
    await render();
    assert.equal(host.querySelector('details'), details);
    assert.equal(details.open, true);
    assert.match(details.querySelector('summary')!.textContent!, /Ещё события \(3\) · Приём открыт: 3/);
  } finally { await React.act(async () => { root.unmount(); }); host.remove(); }
});


it('история не считает открытым приём после дедлайна по часам сервера', async () => {
  const f = fixture(source);
  f.state.predictions.s.skewMs = 60_000;
  f.state.predictions.s.events = [0, 1, 2, 3, 4].map(i => event(`deadline${i}`, {
    createdAt: new Date(2026, 0, i + 1).toISOString(),
    lockAt: i === 0 ? new Date(Date.now() + 30_000).toISOString() : null,
    state: i === 1 ? 'locked' : 'open',
  }));
  await mounted(React.createElement(f.PredictionFeed, { serverId: 's', onNew: noop }), host => {
    assert.match(host.querySelector('summary')!.textContent!, /Ещё события \(2\) · Приём открыт: 0/);
  });
});
