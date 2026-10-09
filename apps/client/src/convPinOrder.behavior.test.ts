import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import { it } from 'node:test';
import ts from 'typescript';
import type { ConvSummary, DmChannel } from '@gusvoice/shared';
import * as sync from './convSyncRules';
import * as list from './dmListRules';
import * as React from 'react';
import * as jsx from 'react/jsx-runtime';
import { createRoot } from 'react-dom/client';
import { GlobalRegistrator } from '@happy-dom/global-registrator';

const store = readFileSync(new URL('./store.ts', import.meta.url), 'utf8').replace(/\r\n/g, '\n');
const drag = readFileSync(new URL('./components/DmPinDrag.tsx', import.meta.url), 'utf8');
const rowMenu = readFileSync(new URL('./components/DmRowMenu.tsx', import.meta.url), 'utf8');
function ast(source: string) { return ts.createSourceFile('source.tsx', source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX); }
function declaration(source: string, name: string) {
  const tree = ast(source);
  const fn = tree.statements.find(n => ts.isFunctionDeclaration(n) && n.name?.text === name);
  assert.ok(fn, `найдена настоящая функция ${name}`);
  return fn.getText(tree).replace(/^export\s+/, '');
}
function evaluate<T>(source: string, globals: Record<string, unknown>): T {
  const context = { ...globals, result: undefined };
  runInNewContext(ts.transpileModule(source, { compilerOptions: {
    target: ts.ScriptTarget.ES2022, jsx: ts.JsxEmit.ReactJSX, module: ts.ModuleKind.CommonJS,
  } }).outputText, { ...context, exports: {}, require: (id: string) => { assert.equal(id, 'react/jsx-runtime'); return jsx; },
    take: (result: T) => { context.result = result as never; } });
  return context.result as T;
}
function actionSource(source: string) {
  const tree = ast(source); let expression: ts.Expression | undefined;
  const visit = (n: ts.Node) => {
    if (ts.isPropertyAssignment(n) && n.name.getText(tree) === 'reorderConvPins') expression = n.initializer;
    ts.forEachChild(n, visit);
  }; visit(tree); assert.ok(expression, 'настоящее действие reorderConvPins найдено');
  return expression.getText(tree);
}
function summary(id: string, pinnedAt: string | null): ConvSummary {
  return { id, kind: 'direct', createdAt: '2026-01-01T00:00:00.000Z', lastMessageAt: null,
    otherUser: { id: `peer-${id}`, username: id, displayName: id, avatarUrl: null },
    unread: 0, pinnedAt, pts: 0, lastReadKey: 0, lastMessage: null } as ConvSummary;
}
async function storeCase(fail: boolean, source = store) {
  const a = summary('a', '2026-01-03T00:00:00.000Z'), b = summary('b', '2026-01-02T00:00:00.000Z');
  const c = summary('c', '2026-01-01T00:00:00.000Z');
  let state = { conv: { ...sync.emptyConvState(), summaries: { a, b, c } }, dms: sync.summariesToDms({ a, b, c }) };
  let resolve!: (v: { pins: { id: string; pinnedAt: string }[] }) => void, reject!: (e: Error) => void;
  const pending = new Promise<{ pins: { id: string; pinnedAt: string }[] }>((yes, no) => { resolve = yes; reject = no; });
  const requests: string[][] = [], toasts: string[] = [];
  const action = evaluate<(ids: string[]) => Promise<void>>(`take(${actionSource(source)});`, {
    get: () => state, set: (patch: Partial<typeof state>) => { state = { ...state, ...patch }; },
    pinOrderStamps: list.pinOrderStamps, patchConvPinOrder: sync.patchConvPinOrder, summariesToDms: sync.summariesToDms,
    Date: class extends Date { static now() { return Date.UTC(2026, 9, 9); } },
    api: { convPinOrder: (ids: string[]) => { requests.push([...ids]); return pending; } },
  });
  const stamps = () => ['a', 'b'].map(id => state.conv.summaries[id as 'a' | 'b'].pinnedAt);
  if (fail) {
    let actionWork!: Promise<void>;
    const reorder = evaluate<(ids: string[]) => void>(`${declaration(drag, 'reorderDmPins')}\ntake(reorderDmPins);`, {
      useStore: { getState: () => ({ reorderConvPins: (ids: string[]) => (actionWork = action(ids)) }) },
      toast: (_kind: string, message: string) => toasts.push(message),
    });
    reorder(['b', 'a']);
    assert.ok(Date.parse(stamps()[1]!) > Date.parse(stamps()[0]!), 'порядок меняется оптимистично до ответа');
    reject(new Error('отказ сервера'));
    // Ждём завершения самого действия, а не предполагаем число микрозадач между VM и хостом.
    await assert.rejects(actionWork, /отказ сервера/);
    assert.deepEqual(stamps(), [a.pinnedAt, b.pinnedAt], 'при отказе прежние отметки обоих закрепов восстановлены');
    assert.equal(toasts.length, 1, 'отказ сообщён человеку ровно один раз');
    assert.equal(toasts[0], 'Не удалось изменить порядок закреплённых бесед', 'тост объясняет отказ перестановки');
  } else {
    const work = action(['b', 'a']);
    assert.ok(Date.parse(stamps()[1]!) > Date.parse(stamps()[0]!), 'порядок меняется оптимистично до ответа');
    resolve({ pins: [{ id: 'a', pinnedAt: '2026-10-10T00:00:00.000Z' }, { id: 'b', pinnedAt: '2026-10-10T00:00:00.001Z' }] });
    await work;
    assert.deepEqual(stamps(), ['2026-10-10T00:00:00.000Z', '2026-10-10T00:00:00.001Z'], 'подтверждение заменяет локальные отметки серверными');
  }
  assert.deepEqual(requests, [['b', 'a']]);
  assert.equal(state.conv.summaries.c, c, 'неназванная сводка не переписана локальным действием');
  assert.deepEqual(state.dms.map(dm => [dm.id, dm.pinnedAt]), sync.summariesToDms(state.conv.summaries).map(dm => [dm.id, dm.pinnedAt]));
}

it('R115 порядок закрепов оптимистичен, успех принимает серверные отметки, отказ откатывает и показывает тост', async () => {
  await storeCase(false); await storeCase(true);
  const noRollback = store.replace('      put(before);\n      throw e;', '      throw e;');
  assert.notEqual(noRollback, store);
  await assert.rejects(storeCase(true, noRollback), (e: unknown) => e instanceof assert.AssertionError && e.message.includes('прежние отметки'));
});

it('R126 sidebar включает drag с pinorder1 вне поиска в архиве, дома и своей pinFolder', () => {
  const source = readFileSync(new URL('./components/DmSidebar.tsx', import.meta.url), 'utf8');
  const check = (raw: string) => {
    const tree = ast(raw); let call: ts.CallExpression | undefined;
    const visit = (n: ts.Node) => { if (ts.isCallExpression(n) && n.expression.getText(tree) === 'useDmPinDrag') call = n; ts.forEachChild(n, visit); };
    visit(tree); assert.ok(call);
    assert.match(raw, /const pinOrderOn = useStore\(\(s\) => s\.convActive && serverPinOrder\(s\.serverFeatures\)\)/);
    assert.ok(ts.isObjectLiteralExpression(call.arguments[0]));
    const props = new Map(call.arguments[0].properties.filter(ts.isPropertyAssignment).map(p => [p.name.getText(tree), p.initializer.getText(tree).replace(/\s/g, '')]));
    // AST-страж вместо исполнения фрагмента: разрешённые области и все гейты видны в настоящем аргументе хука.
    assert.equal(props.get('enabled'), 'pinOrderOn&&!q&&listRows.length>0&&(inArchive||folderUi.home||!!folderUi.pinFolder)&&pinnedIds.length>1', 'drag ограничен признаком и областью списка');
    assert.equal(props.get('touchOk'), 'phone', 'палец переставляет только в телефонной раскладке');
  };
  check(source);
  const mutant = source.replace('enabled: pinOrderOn && !q', 'enabled: true && !q'); assert.notEqual(mutant, source);
  assert.throws(() => check(mutant), /drag ограничен признаком/);
  const touchMutant = source.replace('touchOk: phone', 'touchOk: true'); assert.notEqual(touchMutant, source);
  assert.throws(() => check(touchMutant), /палец переставляет/);
  const folderMutant = source.replace(' || !!folderUi.pinFolder', ''); assert.notEqual(folderMutant, source);
  assert.throws(() => check(folderMutant), /drag ограничен признаком/);
});

it('R126 sidebar передаёт id своей папки, но архив переставляется в общем порядке', () => {
  // Архив поверх выбранной папки не должен записывать свой порядок в оставшуюся под ним вкладку.
  const raw = readFileSync(new URL('./components/DmSidebar.tsx', import.meta.url), 'utf8');
  const check = (source: string) => {
    const tree = ast(source); let call: ts.CallExpression | undefined;
    const visit = (n: ts.Node) => { if (ts.isCallExpression(n) && n.expression.getText(tree) === 'useDmPinDrag') call = n; ts.forEachChild(n, visit); };
    visit(tree); assert.ok(call && ts.isObjectLiteralExpression(call.arguments[0]));
    const prop = call.arguments[0].properties.find(p => ts.isPropertyAssignment(p) && p.name.getText(tree) === 'folderId');
    assert.ok(prop && ts.isPropertyAssignment(prop));
    assert.equal(prop.initializer.getText(tree).replace(/\s/g, ''), 'inArchive?null:(folderUi.pinFolder?.id??null)', 'архив общий, своя папка с id');
    assert.match(source.replace(/\s/g, ''), /reorderHereRef\.current=inArchive\|\|folderUi\.home\?true:folderUi\.pinFolder\?\{folderId:folderUi\.pinFolder\.id,ids:q\?\[\]:pinnedIds,own:q\?null:folderUi\.ownPins\}:false;/, 'меню получает ids и свой набор папки и блокируется поиском');
  };
  check(raw);
  const mutant = raw.replace('folderId: inArchive ? null : (folderUi.pinFolder?.id ?? null)', 'folderId: null');
  assert.notEqual(mutant, raw); assert.throws(() => check(mutant), /архив общий/);
});

it('R117 широкая раскладка игнорирует палец и перо, мышь разрешена, телефон принимает касание после удержания', () => {
  const check = (source: string) => {
    for (const touchOk of [false, true]) for (const pointerType of ['touch', 'pen', 'mouse']) {
      const handlers = new Map<string, (e: unknown) => void>();
      const classes = new Set<string>();
      const row = (id: string, top: number) => ({
        dataset: { swipeRow: id }, style: {},
        classList: { add() {}, remove() {} },
        getBoundingClientRect: () => ({ top, height: 60 }),
      });
      const rows = [row('a', 100), row('b', 160)];
      const listElement = {
        scrollTop: 0, contains: () => true,
        querySelector: (selector: string) => selector.includes('"a"') ? rows[0] : rows[1],
        getBoundingClientRect: () => ({ top: 100, bottom: 500 }), setPointerCapture() {},
        classList: { add: (name: string) => classes.add(name), remove: (name: string) => classes.delete(name) },
        addEventListener: (name: string, fn: (e: unknown) => void) => handlers.set(name, fn), removeEventListener() {},
      };
      let now = 0;
      let cleanup: (() => void) | undefined;
      const hook = evaluate<(a: unknown) => void>(`${declaration(source, 'useDmPinDrag')}\ntake(useDmPinDrag);`, {
        useRef: (value: unknown) => ({ current: value }),
        useEffect: (effect: () => (() => void)) => { cleanup = effect(); },
        ...list, CSS: { escape: (id: string) => id }, Date: { now: () => now },
        dragShift: () => 0, movedIds: () => null, reorderDmPins() {},
        window: { addEventListener() {}, removeEventListener() {}, requestAnimationFrame: () => 1, cancelAnimationFrame() {}, setTimeout() {} },
      });
      hook({ listRef: { current: listElement }, enabled: true, pinnedIds: ['a', 'b'], touchOk });
      const target = { closest: (selector: string) => selector === '[data-swipe-row]' ? rows[0] : null };
      handlers.get('pointerdown')!({ pointerType, button: 0, pointerId: 1, clientX: 20, clientY: 130, target });
      now = list.DM_ROW_HOLD_MS;
      handlers.get('pointermove')!({ pointerId: 1, clientX: 20, clientY: 190 });
      assert.equal(classes.has('pin-drag-on'), pointerType === 'mouse' || touchOk, `${pointerType}/${touchOk}: начало drag`);
      let prevented = false;
      handlers.get('touchmove')!({ cancelable: true, preventDefault: () => { prevented = true; }, stopPropagation() {} });
      assert.equal(prevented, pointerType !== 'mouse' && touchOk, 'игнорируемое касание не блокирует прокрутку');
      cleanup?.();
    }
  };
  check(drag);
  const mutant = drag.replace('if (touch && live.current.touchOk === false) return;', '');
  assert.notEqual(mutant, drag);
  assert.throws(() => check(mutant), /начало drag/);
});

it('R115 меню закреплённой строки показывает только доступный шаг, старый сервер и незакреплённая без шагов', async () => {
  GlobalRegistrator.register(); Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  try {
    for (const feature of [false, true]) for (const allowed of [false, true]) for (const archived of [false, true]) for (const id of ['a', 'b', 'c', 'free']) {
      const dms: DmChannel[] = ['a', 'b', 'c', 'free'].map((key, index) => sync.summaryToDm(summary(key, index < 3 ? new Date(3000 - index).toISOString() : null)));
      dms.forEach(dm => { dm.archived = archived; });
      dms.push({ ...dms[0], id: 'opposite', archived: !archived, pinnedAt: new Date(9999).toISOString() });
      const moves: string[][] = [];
      const state = { convActive: true, serverFeatures: feature ? ['conv11', 'pinorder1'] : ['conv11'], dms,
        conv: { summaries: {} }, blockedUsers: [], pushMutedDmUsers: [], pushMuteUntil: {}, pushAlwaysTargets: [], user: null };
      const useStore = Object.assign((select: (s: typeof state) => unknown) => select(state), { getState: () => state });
      const hook = evaluate<(ref: { current: boolean }) => { openDmMenu: (dm: DmChannel, pos: { x: number; y: number }) => void; menu: React.ReactNode }>(
        `${declaration(rowMenu, 'useDmRowMenu')}\ntake(useDmRowMenu);`, {
          useCallback: React.useCallback, useState: React.useState, useStore, ...sync, ...list,
          useFoldersOn: () => false, notifyAlwaysAction: () => null, reorderDmPins: (ids: string[]) => moves.push([...ids]),
          ContextMenu: ({ children }: { children: React.ReactNode }) => React.createElement('div', null, children),
          MenuItem: ({ label, onClick }: { label: string; onClick?: () => void }) => React.createElement('button', { onClick }, label),
          MenuDivider: () => null, toggleDmPinned: () => {}, switchDmBlock: () => {},
        });
      let view!: ReturnType<typeof hook>;
      const ref = { current: allowed };
      function Harness() { view = hook(ref); return view.menu; }
      const host = document.createElement('div'); document.body.append(host); const root = createRoot(host);
      try {
        await React.act(async () => root.render(React.createElement(Harness)));
        await React.act(async () => view.openDmMenu(dms.find(dm => dm.id === id)!, { x: 10, y: 10 }));
        for (const [caption, dir] of [['Поднять выше', -1], ['Опустить ниже', 1]] as const) {
          await React.act(async () => view.openDmMenu(dms.find(dm => dm.id === id)!, { x: 10, y: 10 }));
          const button = [...host.querySelectorAll('button')].find(b => b.textContent === caption);
          const expected = feature && allowed && id !== 'free' ? list.pinnedStep(['a', 'b', 'c'], id, dir) : null;
          assert.equal(!!button, !!expected, `${id}/${feature}: ${caption} есть только если можно двигать`);
          if (button) { await React.act(async () => button.click()); assert.deepEqual(moves.at(-1), expected); }
        }
      } finally { await React.act(async () => root.unmount()); host.remove(); }
    }
  } finally { GlobalRegistrator.unregister(); }
});
