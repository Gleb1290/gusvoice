import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import { it } from 'node:test';
import ts from 'typescript';

const read = (file: string) => readFileSync(new URL(file, import.meta.url), 'utf8').replace(/\r\n/g, '\n');
function parsed(file: string, change?: (source: string) => string) {
  const original = read(file), source = change ? change(original) : original;
  if (change) assert.notEqual(source, original, 'исходниковый мутант действительно изменён');
  return ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true, file.endsWith('.tsx') ? ts.ScriptKind.TSX : ts.ScriptKind.TS);
}
function selectNode(file: string, predicate: (node: ts.Node) => boolean, change?: (source: string) => string): string {
  const tree = parsed(file, change); let found: ts.Node | undefined;
  const visit = (node: ts.Node) => { if (!found && predicate(node)) found = node; ts.forEachChild(node, visit); }; visit(tree);
  assert.ok(found, `найден реальный узел ${file}`); return found.getText(tree);
}
function declaration(file: string, name: string, change?: (source: string) => string) {
  return selectNode(file, (n) => ts.isVariableDeclaration(n) && n.name.getText() === name, change);
}
function expression<T>(source: string, globals: Record<string, unknown>): T {
  const context = { ...globals, result: undefined as T };
  runInNewContext(ts.transpileModule(`globalThis.result = (${source});`, { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText, context);
  return context.result;
}
function dmPresent() {
  const fn = selectNode('./dmOnline.ts', (n) => ts.isFunctionDeclaration(n) && n.name?.text === 'dmPresent');
  const context = { result: undefined as unknown as typeof import('./dmOnline').dmPresent };
  runInNewContext(ts.transpileModule(fn.replace('export ', '') + '\nglobalThis.result = dmPresent;', { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText, context);
  return context.result;
}
type State = { onlineUsers: string[]; dmOnlineUsers: string[]; dmAwayUsers: string[] };
function store(change?: (source: string) => string) {
  let state: State = { onlineUsers: [], dmOnlineUsers: [], dmAwayUsers: [] };
  const set = (patch: Partial<State> | ((state: State) => Partial<State>)) => { state = { ...state, ...(typeof patch === 'function' ? patch(state) : patch) }; };
  const method = <T>(name: string) => {
    const node = selectNode('./store.ts', (n) => ts.isPropertyAssignment(n) && n.name.getText() === name, change);
    const tree = ts.createSourceFile('method.ts', `({${node}})`, ts.ScriptTarget.Latest, true);
    let initializer = '';
    const visit = (n: ts.Node) => { if (ts.isPropertyAssignment(n) && n.name.getText() === name) initializer = n.initializer.getText(tree); ts.forEachChild(n, visit); }; visit(tree);
    assert.ok(initializer, 'выполняется initializer настоящего метода Zustand, без копирования логики');
    return expression<T>(initializer, { set });
  };
  return { get: () => state, setDmAway: method<(id: string, away: boolean) => void>('setDmAway'),
    setOnlineSnapshot: method<(ids: string[], dmOnly?: string[], dmAway?: string[]) => void>('setOnlineSnapshot') };
}
function gateway(target: ReturnType<typeof store>, change?: (source: string) => string) {
  const clauses = ['online.away', 'online.snapshot'].map((name) => selectNode('./sockets.ts',
    (n) => ts.isCaseClause(n) && ts.isStringLiteral(n.expression) && n.expression.text === name, change));
  const cleared: string[] = [];
  return { cleared, handle: expression<(msg: object) => void>(`(msg) => { switch (msg.t) { ${clauses.join('\n')} } }`, {
    store: target, clearDmActivity: (id: string) => cleared.push(id),
  }) };
}

it('online.away меняет только dmAwayUsers, повтор не дублирует, возврат снимает только свой away', () => {
  const check = (change?: (s: string) => string) => {
    const s = store(), wire = gateway(s, change);
    wire.handle({ t: 'online.snapshot', users: ['peer'], dmOnly: ['invisible'], dmAway: ['other'] });
    wire.handle({ t: 'online.away', userId: 'peer', away: true });
    assert.deepEqual(Array.from(s.get().dmAwayUsers), ['other', 'peer'], 'кадр away попадает в dmAwayUsers');
    wire.handle({ t: 'online.away', userId: 'peer', away: true });
    assert.deepEqual(Array.from(s.get().dmAwayUsers), ['other', 'peer']);
    wire.handle({ t: 'online.away', userId: 'peer', away: false });
    assert.deepEqual(Array.from(s.get().dmAwayUsers), ['other']);
    assert.deepEqual(s.get().onlineUsers, ['peer']); assert.deepEqual(s.get().dmOnlineUsers, ['invisible']);
    assert.deepEqual(wire.cleared, ['peer', 'peer'], 'скрытие снимает локальные 30 секунд, возвращение не снимает');
  };
  check();
  assert.throws(() => check((s) => s.replace('return store.setDmAway(msg.userId, msg.away);', 'return;')),
    (e: unknown) => e instanceof assert.AssertionError && e.message.includes('кадр away попадает в dmAwayUsers'));
});

it('снимок online.snapshot передаёт dmAway, старый снимок очищает прежний away', () => {
  const check = (change?: (s: string) => string) => {
    const s = store(), wire = gateway(s, change);
    wire.handle({ t: 'online.snapshot', users: ['peer'], dmOnly: ['invisible'], dmAway: ['peer', 'invisible'] });
    assert.deepEqual(Array.from(s.get().dmAwayUsers), ['peer', 'invisible'], 'снимок сохраняет dmAway');
    wire.handle({ t: 'online.snapshot', users: ['next'] });
    assert.deepEqual(s.get().onlineUsers, ['next']); assert.deepEqual(Array.from(s.get().dmAwayUsers), []); assert.deepEqual(Array.from(s.get().dmOnlineUsers), []);
  };
  check();
  assert.throws(() => check((s) => s.replace('store.setOnlineSnapshot(msg.users, msg.dmOnly, msg.dmAway)', 'store.setOnlineSnapshot(msg.users, msg.dmOnly)')),
    (e: unknown) => e instanceof assert.AssertionError && e.message.includes('снимок сохраняет dmAway'));
});

it('серверный список участников оставляет away в сети, шапка ЛС применяет dmPresent', () => {
  const check = (change?: (s: string) => string) => {
    const state: State = { onlineUsers: ['peer'], dmOnlineUsers: ['invisible'], dmAwayUsers: ['peer', 'invisible'] };
    const useStore = (selector: (s: State) => unknown) => selector(state);
    const selectorNode = declaration('./components/ServerMembersPanel.tsx', 'onlineUsers');
    const onlineUsers = expression<string[]>(selectorNode.slice(selectorNode.indexOf('=') + 1), { useStore });
    const setNode = declaration('./components/ServerMembersPanel.tsx', 'onlineSet');
    const onlineSet = expression<Set<string>>(setNode.slice(setNode.indexOf('=') + 1), { onlineUsers });
    assert.equal(onlineSet.has('peer'), true, 'сервер использует открытый сокет, не away');
    assert.equal(onlineSet.has('invisible'), false, 'невидимый в ЛС не появляется на сервере');
    const dmNode = declaration('./components/DmChatView.tsx', 'rawOnline', change);
    const dmOnline = expression<boolean>(dmNode.slice(dmNode.indexOf('=') + 1), { useStore, dm: { otherUser: { id: 'peer' } }, dmPresent: dmPresent() });
    assert.equal(dmOnline, false, 'шапка ЛС исключает away');
    state.dmAwayUsers = []; const back = expression<boolean>(dmNode.slice(dmNode.indexOf('=') + 1), { useStore, dm: { otherUser: { id: 'peer' } }, dmPresent: dmPresent() });
    assert.equal(back, true, 'возвращение в окно возвращает онлайн шапки');
  };
  check();
  assert.throws(() => check((s) => s.replace('dmPresent(s, dm.otherUser.id)', 's.onlineUsers.includes(dm.otherUser.id)')),
    (e: unknown) => e instanceof assert.AssertionError && e.message.includes('шапка ЛС исключает away'));
});

it('серверное автодополнение ChatView берёт onlineUsers, не ЛС-присутствие невидимых', () => {
  const node = declaration('./components/ChatView.tsx', 'autocomplete');
  const api = expression<{ users: { id: string; online: boolean }[] }>(node.slice(node.indexOf('=') + 1), {
    useMemo: (fn: () => unknown) => fn(), onlineUsers: ['peer'], roles: [], channels: [],
    members: ['peer', 'invisible', 'offline'].map((id) => ({ user: { id, username: id, displayName: id, avatarUrl: null }, nickname: null })),
  });
  assert.deepEqual(api.users.map((u) => [u.id, u.online]), [['peer', true], ['invisible', false], ['offline', false]]);
});

it('карточка UserContextMenu спрашивает lastSeen в контексте dm или server, свой профиль не спрашивает', () => {
  const check = (change?: (s: string) => string) => {
    const node = declaration('./components/UserContextMenu.tsx', 'profileSeen', change);
    const calls: unknown[][] = [];
    for (const inDm of [false, true]) for (const isSelf of [false, true]) {
      expression(node.slice(node.indexOf('=') + 1), { inDm, isSelf, target: { userId: 'peer' }, useLastSeen: (...args: unknown[]) => { calls.push(args); return null; } });
      assert.deepEqual(calls.at(-1), [isSelf ? null : 'peer', inDm ? 'dm' : 'server'], 'карточка передаёт реальный контекст lastSeen');
    }
  };
  check();
  assert.throws(() => check((s) => s.replace("inDm ? 'dm' : 'server'", "'dm'")),
    (e: unknown) => e instanceof assert.AssertionError && e.message.includes('карточка передаёт реальный контекст lastSeen'));
});

it('identify текущего шлюза согласует presence5 capability и начальное hidden', () => {
  const source = read('./sockets.ts');
  const check = (code: string) => {
    assert.match(code, /caps\?\.push\(FEATURE_PRESENCE5\)/, 'caps содержат presence5');
    assert.match(code, /t: 'identify'[\s\S]{0,300}presentNow\(\) \? \{\} : \{ hidden: true \}/, 'identify несёт hidden при отсутствии');
    assert.match(code, /watchPresence\(sendGatewayVisible\)/); assert.match(code, /watchPresence\(setBgPresent\)/);
  };
  check(source);
  for (const [from, expected] of [["caps?.push(FEATURE_PRESENCE5)", 'caps содержат presence5'], ['...(presentNow() ? {} : { hidden: true })', 'identify несёт hidden при отсутствии']]) {
    assert.ok(source.includes(from));
    assert.throws(() => check(source.replace(from, '')), (e: unknown) => e instanceof assert.AssertionError && e.message.includes(expected));
  }
});

it('identify фонового шлюза несёт hidden, пока приложение не здесь', () => {
  const source = read('./bgGateways.ts');
  const check = (code: string) => assert.match(code, /t: 'identify'[\s\S]{0,150}bgPresent \? \{\} : \{ hidden: true \}/, 'фоновый identify тоже несёт hidden');
  check(source); const from = '...(bgPresent ? {} : { hidden: true })'; assert.ok(source.includes(from));
  assert.throws(() => check(source.replace(from, '')), (e: unknown) => e instanceof assert.AssertionError && e.message.includes('фоновый identify тоже несёт hidden'));
});
