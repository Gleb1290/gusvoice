import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { it } from 'node:test';
import { runInNewContext } from 'node:vm';
import { Children, isValidElement, type ReactElement, type ReactNode } from 'react';
import * as jsxRuntime from 'react/jsx-runtime';
import ts from 'typescript';
import * as rules from './dangerousLinkRules';
import * as safety from './linkSafety';
import * as confirmRules from './confirmRules';
import * as deleteRules from './deleteChoiceRules';
import type { ConfirmSpec } from './confirmRules';

type Node = ReactElement<Record<string, unknown>>;
const source = readFileSync(new URL('./dangerousLink.tsx', import.meta.url), 'utf8');
const guardSource = readFileSync(new URL('./linkGuard.tsx', import.meta.url), 'utf8');
const hostSource = readFileSync(new URL('./components/ConfirmHost.tsx', import.meta.url), 'utf8');
function nodes(tree: ReactNode): Node[] {
  const out: Node[] = [];
  Children.forEach(tree, child => {
    if (!isValidElement<Record<string, unknown>>(child)) return;
    if (typeof child.type === 'function') out.push(...nodes((child.type as (props: unknown) => ReactNode)(child.props)));
    else { out.push(child); out.push(...nodes(child.props.children as ReactNode)); }
  });
  return out;
}
// Все три модуля выполняются целиком. Подменены лишь платформа, hooks и store
// подтверждения; их общий Promise связывает настоящий обработчик с настоящими кнопками.
function load(text = source, guardText = guardSource, hostText = hostSource) {
  const opened: string[] = [];
  const effects: Array<() => unknown> = [];
  const timers: Array<() => void> = [];
  let pending: (ConfirmSpec & { id: number }) | null = null;
  let resolve: (ok: boolean) => void = () => {};
  let focused: Node | undefined;
  const answer = (ok: boolean) => { pending = null; resolve(ok); };
  const deps: Record<string, unknown> = {
    'react/jsx-runtime': jsxRuntime,
    react: { useState: (initial: unknown) => [initial, () => {}], useRef: () => ({ current: null }), useEffect: (fn: () => unknown) => effects.push(fn) },
    'react-dom': { createPortal: (node: unknown) => node },
    './confirm': { confirmAction: (spec: ConfirmSpec) => { pending = { ...spec, id: 1 }; return new Promise<boolean>(r => { resolve = r; }); } },
    './dangerousLinkRules': rules,
    './components/Icon': { Icon: () => null },
    './config': { config: { apiUrl: 'https://api.voice.example' } },
    './hotkeys': { isDesktop: () => false },
    './desktopWindow': { openExternal: () => assert.fail('не desktop') },
    './linkSafety': safety,
    '../confirm': { useConfirmDialog: (select: (state: unknown) => unknown) => select({ pending, answer }) },
    '../focusTrap': { useFocusTrap: () => {} },
    '../confirmRules': confirmRules,
    '../deleteChoiceRules': deleteRules,
    './Icon': { Icon: () => null },
  };
  function evaluate<T>(body: string): T {
    const module = { exports: {} };
    runInNewContext(ts.transpileModule(body, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, jsx: ts.JsxEmit.ReactJSX } }).outputText, {
      module, exports: module.exports, URL, location: { host: 'voice.example' }, document: { body: {} },
      window: { open: (url: string) => opened.push(url), addEventListener: () => {}, removeEventListener: () => {} },
      setTimeout: (fn: () => void) => { timers.push(fn); return timers.length; }, clearTimeout: () => {},
      localStorage: { getItem: () => assert.fail('старое доверие не читается'), setItem: () => assert.fail('доверие не сохраняется') },
      require: (id: string) => { assert.ok(id in deps, `неожиданный импорт ${id}`); return deps[id]; },
    });
    return module.exports as T;
  }
  // Циклическая зависимость реальных модулей разрешается стабильным объектом exports.
  const guard = {} as typeof import('./linkGuard'); deps['./linkGuard'] = guard;
  const danger = evaluate<typeof import('./dangerousLink')>(text); deps['./dangerousLink'] = danger;
  Object.assign(guard, evaluate<typeof import('./linkGuard')>(guardText));
  const host = evaluate<typeof import('./components/ConfirmHost')>(hostText);
  function dialog() {
    effects.length = 0; timers.length = 0;
    const tree = nodes(host.ConfirmHost());
    for (const node of tree) {
      const ref = (node as unknown as { ref?: { current: unknown } }).ref;
      if (ref) ref.current = { focus: () => { focused = node; } };
    }
    for (const effect of effects) effect();
    for (const timer of timers) timer();
    return tree;
  }
  return { danger, guard, opened, dialog, get pending() { return pending; }, get focused() { return focused; } };
}
const url = 'https://evil.com/path?keep=1';
function click(tree: Node[]) {
  const anchor = tree.find(n => n.type === 'a'); assert.ok(anchor);
  let prevented = false;
  (anchor.props.onClick as (event: unknown) => void)({ preventDefault: () => { prevented = true; } });
  assert.equal(prevented, true);
}
function press(tree: Node[], label: string) {
  const button = tree.find(n => n.type === 'button' && Children.toArray(n.props.children as ReactNode).join('') === label);
  assert.ok(button, `есть ${label}`); (button.props.onClick as () => void)();
}
function marked(h: ReturnType<typeof load>) {
  const tree = nodes(h.guard.MessageLink({ url, dangerous: ['evil.com'] }));
  assert.equal(tree.find(n => n.type === 'a')?.props.className, 'msg-link danger-link');
  assert.equal(Array.isArray(tree.find(n => n.props.className === 'danger-link-badge')?.props.children), true);
  assert.equal(tree.some(n => n.props['data-testid'] === 'danger-link-badge'), true);
  click(tree); assert.equal(h.pending?.tone, 'danger'); assert.deepEqual(h.opened, []);
}
it('плашка настоящего компонента содержит предупреждение', () => {
  const tree = nodes(load().danger.DangerousLinkBadge());
  assert.equal(tree[0].props.className, 'danger-link-badge');
  assert.ok(Children.toArray(tree[0].props.children as ReactNode).includes('Опасная ссылка'));
});
it('MessageLink передаёт опасный хост в настоящий компонент с плашкой', () => marked(load()));
it('обычная ссылка без списка или с другим точным хостом сохраняет прежний путь', () => {
  for (const dangerous of [undefined, [], ['not-evil.com']]) {
    const h = load(); const tree = nodes(h.guard.MessageLink({ url, dangerous }));
    assert.equal(tree.find(n => n.type === 'a')?.props.className, 'msg-link');
    assert.equal(tree.some(n => n.props.className === 'danger-link-badge'), false);
    click(tree); assert.deepEqual(h.opened, [url]); assert.equal(h.pending, null);
  }
});
async function decision(h: ReturnType<typeof load>) {
  const cancelled = h.danger.openDangerousLink(url);
  assert.equal(h.pending?.title, 'Опасная ссылка'); assert.equal(h.pending?.body, rules.dangerousLinkBody('evil.com'));
  assert.equal(h.pending?.icon, 'alert-circle'); assert.equal(h.pending?.items?.[0], url);
  const tree = h.dialog();
  assert.equal(h.focused?.props.children, 'Отмена', 'настоящий ConfirmHost фокусирует безопасное действие');
  assert.equal(tree.some(n => n.type === 'input'), false, 'старых галочек доверия нет');
  press(tree, 'Отмена'); await cancelled; assert.deepEqual(h.opened, []);
  const accepted = h.danger.openDangerousLink(url);
  press(h.dialog(), 'Всё равно открыть'); await accepted; assert.deepEqual(h.opened, [url]);
}
it('опасное окно фокусирует Отмену: отказ не открывает, явное подтверждение открывает исходный URL', async () => decision(load()));
it('контрфакт обхода опасного компонента ловится после успешного original', () => {
  marked(load());
  const target = 'if (isDangerousLink(url, dangerous))'; assert.equal(guardSource.split(target).length - 1, 1);
  const mutant = load(source, guardSource.replace(target, 'if (false)'));
  assert.throws(() => marked(mutant), assert.AssertionError);
});
it('контрфакт открытия после отмены ловится тем же сценарием настоящего окна', async () => {
  await decision(load()); const target = 'if (ok) openLink(url);'; assert.equal(source.split(target).length - 1, 1);
  const mutant = load(source.replace(target, 'openLink(url);'));
  await assert.rejects(decision(mutant), assert.AssertionError);
});
it('контрфакт фокуса опасного действия вместо отмены ловится настоящим ConfirmHost', async () => {
  await decision(load()); const target = 'cancelRef.current.focus();'; assert.equal(hostSource.split(target).length - 1, 1);
  const mutant = load(source, guardSource, hostSource.replace(target, 'okRef.current?.focus();'));
  await assert.rejects(decision(mutant), assert.AssertionError);
});
