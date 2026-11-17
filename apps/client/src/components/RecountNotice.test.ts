import { counterfact } from '../../../../packages/shared/test/counterfacts.js';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { it } from 'node:test';
import { runInNewContext } from 'node:vm';
import ts from 'typescript';

const source = readFileSync(new URL('./RecountNotice.tsx', import.meta.url), 'utf8').replace(/\r\n/g, '\n');
type Props = Record<string, unknown>;
type Element = { type: unknown; props: Props };
const jsx = (type: unknown, props: Props): Element => ({ type, props });
function elements(tree: unknown): Element[] {
  if (Array.isArray(tree)) return tree.flatMap(elements);
  if (!tree || typeof tree !== 'object' || !('props' in tree)) return [];
  const node = tree as Element;
  return [node, ...elements(node.props.children)];
}
function replaceOnce(raw: string, needle: string, next: string): string {
  assert.equal(raw.split(needle).length, 2, `R318/подготовка/якорь/${needle}`);
  return raw.replace(needle, next);
}
function killed(check: () => void, address: string) {
  assert.throws(check, (e: unknown) => e instanceof assert.AssertionError && e.message.split('\n')[0] === address);
}

/** Весь TSX-модуль, замкнутый список границ, реальные JSX и обработчики. Без браузерного layout. */
function fixture(raw: string, markSeenOn: string | undefined, reject = false) {
  const calls: string[] = [];
  const events: string[] = [];
  const listeners = new Set<(e: { key: string }) => void>();
  const cleanups: Array<() => void> = [];
  const Goose = () => null;
  const deps: Record<string, unknown> = {
    react: { useEffect(effect: () => () => void) { cleanups.push(effect()); } },
    'react/jsx-runtime': { jsx, jsxs: jsx },
    '../api': { api: { markRecountSeen(id: string) {
      calls.push(id); events.push('api');
      return reject ? Promise.reject(new Error('offline')) : Promise.resolve();
    } } },
    '../assets/guscoin.svg': { default: 'coin.svg' }, './Goose': { Goose }, './Icon': { Icon: () => null },
  };
  const module = { exports: {} as { RecountNotice: (p: Props) => unknown } };
  runInNewContext(ts.transpileModule(raw, { compilerOptions: {
    module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, jsx: ts.JsxEmit.ReactJSX,
  } }).outputText, {
    module, exports: module.exports,
    window: {
      addEventListener(name: string, fn: (e: { key: string }) => void) { assert.equal(name, 'keydown'); listeners.add(fn); },
      removeEventListener(name: string, fn: (e: { key: string }) => void) { assert.equal(name, 'keydown'); listeners.delete(fn); },
    },
    require(id: string) { assert.ok(Object.hasOwn(deps, id), `R318/подготовка/импорт/${id}`); return deps[id]; },
  });
  const tree = module.exports.RecountNotice({ amount: 37, currencyName: 'Перья', iconUrl: null,
    seasonName: 'Октябрь', markSeenOn, onClose() { events.push('close'); } });
  const all = elements(tree);
  function click(target: Element) {
    // Всплывание идёт через настоящее JSX-дерево: потеря stopPropagation удвоила бы закрытие кнопкой.
    const path = (node: unknown): Element[] | null => {
      if (Array.isArray(node)) { for (const child of node) { const p = path(child); if (p) return p; } return null; }
      if (!node || typeof node !== 'object' || !('props' in node)) return null;
      const e = node as Element;
      if (e === target) return [e];
      const p = path(e.props.children);
      return p ? [...p, e] : null;
    };
    let stopped = false;
    for (const e of path(tree) ?? []) {
      (e.props.onClick as ((e: unknown) => void) | undefined)?.({ stopPropagation() { stopped = true; } });
      if (stopped) break;
    }
  }
  return { all, Goose, calls, events, listeners, click,
    key(key: string) { for (const listener of listeners) listener({ key }); },
    cleanup() { for (const cleanup of cleanups) cleanup(); },
  };
}
const actions = ['button', 'cross', 'overlay', 'Escape'] as const;
type Action = typeof actions[number];
function closeCheck(raw: string, action: Action, mark = true, reject = false) {
  const f = fixture(raw, mark ? 'server-a' : undefined, reject);
  try {
    if (action === 'Escape') f.key('Escape');
    else {
      const target = f.all.find(e => action === 'button' ? e.props.className === 'ew-btn ew-btn-main'
        : action === 'cross' ? e.props.className === 'icon-close' : e.props.className === 'modal-overlay recount-overlay');
      assert.ok(target, `R318/подготовка/${action}`); f.click(target);
    }
    assert.equal(f.events.filter(x => x === 'close').length, 1, `R318/close/${action}/once`);
    assert.equal(JSON.stringify(f.calls), JSON.stringify(mark ? ['server-a'] : []), `R318/close/${action}/seen`);
    assert.equal(f.events[0], 'close', `R318/close/${action}/before-api`);
  } finally { f.cleanup(); }
  assert.equal(f.listeners.size, 0, 'R318/close/unsubscribe');
}

for (const action of actions) it(`R318 карточка: ${action} закрывает авто-показ и ставит одну отметку`, () => {
  closeCheck(source, action);
});
for (const action of actions) it(`R318 карточка: ${action} при повторном показе не отмечает просмотр`, () => {
  closeCheck(source, action, false);
});
it('R318 карточка закрывается немедленно при отказе API без необработанного rejection', async () => {
  for (const action of actions) closeCheck(source, action, true, true);
  await Promise.resolve(); await Promise.resolve();
});
function cardCheck(raw: string) {
  const f = fixture(raw, 'server-a');
  try {
    const dialog = f.all.find(e => e.props.role === 'dialog'); assert.ok(dialog);
    assert.equal(dialog.props['aria-modal'], 'true');
    assert.equal(f.all.find(e => e.type === f.Goose)?.props.pose, 'sorry', 'R318/card/sorry');
    assert.equal(f.all.find(e => e.props.className === 'rn-amount')?.props['aria-label'], 'Начислено 37');
    assert.equal(Array.isArray(f.all.find(e => e.props.className === 'ew-eyebrow')?.props.children), true);
    f.click(dialog); f.key('Enter');
    assert.equal(f.events.length, 0, 'R318/card/inside');
  } finally { f.cleanup(); }
}
it('R318 текст карточки, сумма и поза sorry связаны с настоящим JSX; клик внутри и другая клавиша не закрывают', () => {
  cardCheck(source);
});
it('R318 контрфакт карточки: изображение извиняющегося гуся не заменяется другой позой', () => {
  cardCheck(source);
  counterfact(() => {
    killed(() => cardCheck(replaceOnce(source, 'pose="sorry"', 'pose="head"')), 'R318/card/sorry');
  });
});

for (const [name, needle, next, action, address] of [
  ['основная кнопка', 'onClick={close} autoFocus', 'onClick={() => {}} autoFocus', 'button', 'once'],
  ['крестик', 'title="Закрыть" onClick={close}', 'title="Закрыть" onClick={() => {}}', 'cross', 'once'],
  ['подложка', 'className="modal-overlay recount-overlay" onClick={close}', 'className="modal-overlay recount-overlay" onClick={() => {}}', 'overlay', 'once'],
  ['Escape', "if (e.key === 'Escape') close();", "if (e.key === 'Enter') close();", 'Escape', 'once'],
  ['всплывание', 'onClick={(e) => e.stopPropagation()}', 'onClick={() => {}}', 'button', 'once'],
  ['двойная отметка', 'api.markRecountSeen(markSeenOn).catch(() => {});', 'api.markRecountSeen(markSeenOn).catch(() => {}); if (markSeenOn) api.markRecountSeen(markSeenOn).catch(() => {});', 'button', 'seen'],
] as const) it(`R318 контрфакт карточки: ${name}`, () => {
  closeCheck(source, action);
  counterfact(() => {
    killed(() => closeCheck(replaceOnce(source, needle, next), action), `R318/close/${action}/${address}`);
  });
});
it('R318 контрфакт карточки: повторный показ не имеет права писать отметку', () => {
  closeCheck(source, 'button', false);
  counterfact(() => {
    killed(() => closeCheck(replaceOnce(source, 'if (markSeenOn) api.', 'api.'), 'button', false), 'R318/close/button/seen');
  });
});
it('R318 контрфакт карточки: закрытие не ждёт ответа сервера', () => {
  closeCheck(source, 'button');
  counterfact(() => {
    const mutant = replaceOnce(source, '    onClose();', '    Promise.resolve().then(onClose);');
    killed(() => closeCheck(mutant, 'button'), 'R318/close/button/once');
  });
});
