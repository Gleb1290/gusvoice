import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { it } from 'node:test';
import { runInNewContext } from 'node:vm';
import ts from 'typescript';
import { create } from 'zustand';
import { emptyConvState } from './convSyncRules';
import * as streamAudioRules from './streamAudioRules';

// Для деклараций/сбросов — AST; действия исполняются только в составе целого store.ts с настоящим Zustand.
const source = readFileSync(new URL('./store.ts', import.meta.url), 'utf8').replace(/\r\n/g, '\n');
const compact = (node: ts.Node) => node.getText().replace(/\s+/g, '');
type Store = typeof import('./store').useStore;

function loadStore(raw: string): Store {
  const unexpected = (boundary: string) => () => assert.fail(`Неожиданное исполнение ${boundary}`);
  const dependencies: Record<string, unknown> = {
    zustand: { create },
    './api': { api: {} },
    './convSyncRules': { emptyConvState },
    './streamAudioRules': streamAudioRules,
    './instanceScope': { scopedGetItem: () => null },
    // Беседы не участвуют в действиях PiP: отделяем их инициализацию, не подменяя set/subscribe.
    './convStore': { createConvActions: () => ({}) },
    './hotkeys': { isMobile: unexpected('isMobile') },
    './channelPrefs': { markChannelSeen: unexpected('markChannelSeen') },
  };
  for (const id of ['./config', './convCacheRules', './channelRules', './dmListRules', './convCache', './historyPage',
    './lastPlace', './tabSync', './nativeUnifiedPush', './sounds', './tipHints', './toastRules', './profilePatch', './voiceCueRules', './voiceSession']) {
    dependencies[id] = new Proxy({}, { get: (_target, key) => assert.fail(`Неожиданное обращение ${id}.${String(key)}`) });
  }
  const module = { exports: {} as { useStore: Store } };
  // В VM уходит весь модуль, без вырезания callback, копии алгоритма или поддельного set.
  runInNewContext(ts.transpileModule(raw, { compilerOptions: {
    module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022,
  } }).outputText, { module, exports: module.exports, localStorage: { getItem: () => null },
    require: (id: string) => {
      assert.ok(Object.hasOwn(dependencies, id), `Неописанный импорт стора PiP: ${id}`);
      return dependencies[id];
    },
  });
  return module.exports.useStore;
}

function observer(useStore: Store) {
  const notifications: { current: ReturnType<Store['getState']>; previous: ReturnType<Store['getState']> }[] = [];
  const unsubscribe = useStore.subscribe((current, previous) => notifications.push({ current, previous }));
  return {
    unsubscribe,
    step(run: () => void, ids: string[], changes: 0 | 1, message: string) {
      const before = useStore.getState(), listBefore = before.pipStreams;
      notifications.length = 0;
      run();
      const after = useStore.getState();
      assert.equal(notifications.length, changes, message);
      // Массив создан в VM: Array.from переносит результат в realm assertion, не меняя состояние стора.
      assert.deepEqual(Array.from(after.pipStreams), ids, message);
      if (changes === 0) {
        assert.equal(after, before, `${message}: то же состояние`);
        assert.equal(after.pipStreams, listBefore, `${message}: тот же список`);
      } else {
        assert.notEqual(after, before, `${message}: новое состояние`);
        assert.notEqual(after.pipStreams, listBefore, `${message}: новый список`);
        assert.equal(notifications[0].current, after);
        assert.equal(notifications[0].previous, before);
      }
    },
  };
}

function addProbe(raw: string): void {
  const useStore = loadStore(raw), check = observer(useStore);
  const add = (id: string, max = 4) => () => useStore.getState().addPipStream(id, max);
  try {
    check.step(add(''), [], 0, 'R256 пустое добавление не уведомляет');
    check.step(add('a'), ['a'], 1, 'R256 первое добавление уведомляет один раз');
    check.step(add('a'), ['a'], 0, 'R256 дубль не уведомляет');
    check.step(add('b'), ['a', 'b'], 1, 'R256 новый показ добавлен после существующего');
    check.step(add('c'), ['a', 'b', 'c'], 1, 'R256 третий показ сохраняет порядок');
    check.step(add('d'), ['a', 'b', 'c', 'd'], 1, 'R256 четыре показа ещё помещаются');
    check.step(add('a'), ['a', 'b', 'c', 'd'], 0, 'R256 дубль при полном списке не обновляет порядок');
    check.step(add('e'), ['b', 'c', 'd', 'e'], 1, 'R256 при переполнении сохраняется хвост, а не старейшие показы');
    check.step(add('f', 0), ['f'], 1, 'R256 нулевой лимит оставляет новый показ');
    check.step(add('f', 0), ['f'], 0, 'R256 дубль при нулевом лимите не уведомляет');
    check.step(add('g', 2.99), ['f', 'g'], 1, 'R256 дробный лимит округляется вниз');
    check.step(add('h', 2.99), ['g', 'h'], 1, 'R256 дробный лимит сохраняет новые показы');
    check.step(add('i', -1), ['i'], 1, 'R256 отрицательный лимит оставляет один новый показ');
  } finally { check.unsubscribe(); }
}

function removeProbe(raw: string): void {
  const useStore = loadStore(raw);
  const initial = Object.freeze(['a', 'a#screen', 'b']);
  useStore.setState({ pipStreams: [...initial] });
  const check = observer(useStore), beforeList = useStore.getState().pipStreams;
  try {
    check.step(() => useStore.getState().removePipStream('missing'), [...initial], 0, 'R256 отсутствующий показ не уведомляет');
    check.step(() => useStore.getState().removePipStream('a'), ['a#screen', 'b'], 1, 'R256 удаление одного identity уведомляет один раз');
    assert.deepEqual(beforeList, [...initial], 'R256 удаление не мутирует прежний список');
    check.step(() => useStore.getState().removePipStream('a'), ['a#screen', 'b'], 0, 'R256 повторное удаление не уведомляет');
    check.step(() => useStore.getState().clearPipStreams(), [], 1, 'R256 очистка непустого списка уведомляет один раз');
    check.step(() => useStore.getState().clearPipStreams(), [], 0, 'R256 пустая очистка не уведомляет');
    check.step(() => useStore.getState().removePipStream('b'), [], 0, 'R256 удаление из пустого списка не уведомляет');
  } finally { check.unsubscribe(); }
}

function descendants(node: ts.Node, predicate: (node: ts.Node) => boolean): ts.Node[] {
  const result: ts.Node[] = [];
  function visit(next: ts.Node) {
    if (predicate(next)) result.push(next);
    ts.forEachChild(next, visit);
  }
  visit(node);
  return result;
}

function unwrap(node: ts.Expression): ts.Expression {
  return ts.isParenthesizedExpression(node) ? unwrap(node.expression) : node;
}

function store(raw: string) {
  const file = ts.createSourceFile('store.ts', raw, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  const declarations = descendants(file, n => ts.isVariableDeclaration(n) && n.name.getText() === 'useStore') as ts.VariableDeclaration[];
  assert.equal(declarations.length, 1, 'R256 один настоящий useStore');
  const init = declarations[0].initializer;
  assert.ok(init && ts.isCallExpression(init) && init.expression.getText() === 'create');
  const creator = init.arguments[0];
  assert.ok(creator && ts.isArrowFunction(creator));
  assert.equal(creator.parameters.map(p => p.name.getText()).join(','), 'set,get');
  assert.ok(!ts.isBlock(creator.body));
  const state = unwrap(creator.body);
  assert.ok(ts.isObjectLiteralExpression(state));
  return { file, state };
}

function property(object: ts.ObjectLiteralExpression, name: string): ts.PropertyAssignment {
  const entries = object.properties.filter(p => ts.isPropertyAssignment(p) && p.name.getText() === name);
  assert.equal(entries.length, 1, `R256 единственное поле ${name}`);
  return entries[0] as ts.PropertyAssignment;
}

function action(raw: string, name: string): ts.ArrowFunction {
  const fn = property(store(raw).state, name).initializer;
  assert.ok(ts.isArrowFunction(fn), `R256 действие ${name} объявлено в настоящем сторе`);
  return fn;
}

function resetGuard(raw: string, name: 'leaveVoice' | 'switchedInstance'): void {
  const fn = action(raw, name);
  assert.ok(ts.isBlock(fn.body));
  // Только прямой set в теле действия: сброс под if/вложенной функцией не считается безусловным.
  const calls = fn.body.statements.filter(ts.isExpressionStatement).map(s => s.expression)
    .filter((n): n is ts.CallExpression => ts.isCallExpression(n) && n.expression.getText() === 'set');
  assert.equal(calls.length, 1, `R256 ${name} имеет один прямой сброс состояния`);
  let payload = calls[0].arguments[0];
  assert.ok(payload);
  if (ts.isArrowFunction(payload)) {
    assert.ok(!ts.isBlock(payload.body));
    payload = unwrap(payload.body);
  }
  assert.ok(ts.isObjectLiteralExpression(payload));
  const fields = payload.properties.filter(p => ts.isPropertyAssignment(p) && p.name.getText() === 'pipStreams') as ts.PropertyAssignment[];
  assert.equal(fields.length, 1, `R256 ${name} очищает показы PiP`);
  assert.equal(compact(fields[0].initializer), '[]', `R256 ${name} не переносит старые показы`);
}

function rejects(from: string, to: string, check: (raw: string) => void, message: string): void {
  check(source); // Original-first: поломка стража на исходнике не выдаётся за найденную регрессию.
  assert.equal(source.split(from).length - 1, 1, 'R256 единственный точный якорь мутации стора');
  assert.throws(() => check(source.replace(from, to)), (error: unknown) =>
    error instanceof assert.AssertionError && error.message.startsWith(message));
}

it('R256 список PiP объявлен строковым массивом и изначально пуст', () => {
  // Старое одиночное поле не должно пережить переход к нескольким показам.
  const { file, state } = store(source);
  const interfaces = file.statements.filter(ts.isInterfaceDeclaration).filter(n => n.name.text === 'State');
  assert.equal(interfaces.length, 1);
  const fields = interfaces[0].members.filter(n => ts.isPropertySignature(n) && n.name.getText() === 'pipStreams') as ts.PropertySignature[];
  assert.equal(fields.length, 1);
  assert.ok(fields[0].type);
  assert.equal(compact(fields[0].type), 'string[]');
  assert.equal(compact(property(state, 'pipStreams').initializer), '[]');
  assert.equal(state.properties.filter(p => ts.isPropertyAssignment(p) && p.name.getText() === 'pipStream').length, 0);
});

it('R256 добавление в стор отсекает пустое и дубль, сохраняет порядок и ограничивает хвостом', () => {
  // Чистое pipAdd и AST не доказывают отсутствие нотификации: наблюдаем реальный subscribe.
  addProbe(source);
  rejects('if (!id || s.pipStreams.includes(id)) return s;', 'if (!id || s.pipStreams.includes(id)) return {};',
    addProbe, 'R256 пустое добавление не уведомляет');
  rejects('if (!id || s.pipStreams.includes(id)) return s;',
    'if (!id) return s; if (s.pipStreams.includes(id)) return {};', addProbe, 'R256 дубль не уведомляет');
});

it('R256 удаление фильтрует только выбранный identity, а очистка сбрасывает весь список', () => {
  // Фильтрация не должна затронуть спутник, а холостые действия — будить подписчиков комнаты.
  removeProbe(source);
  rejects('s.pipStreams.filter((x) => x !== id) } : s', 's.pipStreams.filter((x) => x !== id) } : {}',
    removeProbe, 'R256 отсутствующий показ не уведомляет');
  rejects('s.pipStreams.length === 0 ? s : { pipStreams: [] }', 's.pipStreams.length === 0 ? {} : { pipStreams: [] }',
    removeProbe, 'R256 пустая очистка не уведомляет');
});

it('R256 выход из голоса и смена инстанса безусловно очищают список PiP', () => {
  // Identity старой комнаты нельзя подписать в новой, даже если хост окна ещё не размонтировался.
  resetGuard(source, 'leaveVoice');
  resetGuard(source, 'switchedInstance');
});

it('R256 потеря очистки PiP при выходе из голоса обнаруживается после проверки оригинала', () => {
  // Соседняя исправная очистка switchedInstance не должна скрыть забытый leaveVoice.
  rejects("set({ voice: null, liveVoice: {}, voiceState: 'disconnected', pipStreams: [] });",
    "set({ voice: null, liveVoice: {}, voiceState: 'disconnected' });",
    raw => resetGuard(raw, 'leaveVoice'), 'R256 leaveVoice очищает показы PiP');
});

it('R256 сохранение старейших вместо новых показов обнаруживается после проверки оригинала', () => {
  // Размер списка останется верным, но человек потеряет только что добавленный показ.
  rejects('next.slice(next.length - keep)', 'next.slice(0, keep)', addProbe,
    'R256 при переполнении сохраняется хвост, а не старейшие показы');
});
