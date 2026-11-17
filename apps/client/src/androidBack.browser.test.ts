import assert from 'node:assert/strict';
import { counterfact } from '../../../packages/shared/test/counterfacts.js';
import { readFileSync } from 'node:fs';
import { it } from 'node:test';
import { runInNewContext } from 'node:vm';
import { GlobalRegistrator } from '@happy-dom/global-registrator';
import ts from 'typescript';

const source = readFileSync(new URL('./androidBack.ts', import.meta.url), 'utf8').replace(/\r\n/g, '\n');
type Edit = { from: string; to: string } | { fn: 'canStepBack'; from: string; to: string };
const PREFIX = 'R345 browser back: ';
function mutate(edit: Edit): string {
  let scope = source, start = 0;
  if ('fn' in edit) {
    const ast = ts.createSourceFile('androidBack.ts', source, ts.ScriptTarget.Latest, true);
    const fn = ast.statements.find(n => ts.isFunctionDeclaration(n) && n.name?.text === edit.fn);
    assert.ok(fn, 'R345 setup: существует полная декларация canStepBack');
    start = fn.getStart(ast); scope = fn.getText(ast);
  }
  assert.equal(scope.split(edit.from).length, 2, 'R345 setup: адресный якорь единственен');
  const changed = scope.replace(edit.from, edit.to);
  return source.slice(0, start) + changed + source.slice(start + scope.length);
}

type Options = { cw?: boolean; width?: number; tauri?: boolean };
function fixture(raw: string, options: Options = {}) {
  // GlobalRegistrator делает window === globalThis и не убирает добавленные после register expando.
  // Без собственной уборки Tauri-case превращал все следующие браузерные cases в оболочку (R347).
  const extraKeys = ['__TAURI_INTERNALS__', 'CloseWatcher'] as const;
  const savedExtras = extraKeys.map(key => [key, Object.getOwnPropertyDescriptor(globalThis, key)] as const);
  GlobalRegistrator.register({ url: 'https://example.test/' });
  let now = 1000, width = options.width ?? 384, backs = 0, nextTimer = 1;
  const actions: string[] = [], pushes: Record<string, unknown>[] = [];
  const timers = new Map<number, { due: number; fn: () => void }>();
  const subscribers = new Set<() => void>();
  const keydowns: ((e: { key: string; isTrusted: boolean }) => void)[] = [];
  const live = new Set<FakeCloseWatcher>(), made: FakeCloseWatcher[] = [];
  const history = { state: { unrelated: 'keep', nested: { value: 7 } } as Record<string, unknown> | null,
    pushState(value: Record<string, unknown>, _title: string) { history.state = value; pushes.push(value); },
    back() { backs++; } };
  const notify = () => { for (const fn of subscribers) fn(); };
  const state = { view: 'dm', currentServerId: null as string | null, serverListOpen: false,
    adminOpen: false, settingsOpen: false, mobileProfileOpen: false, mobileMembersOpen: false, mobilePane: 'list',
    setAdminOpen(value: boolean) { actions.push(`admin:${value}`); state.adminOpen = value; notify(); },
    setSettingsOpen(value: boolean) { actions.push(`settings:${value}`); state.settingsOpen = value; notify(); },
    setMobileProfileOpen(value: boolean) { actions.push(`profile:${value}`); state.mobileProfileOpen = value; notify(); },
    setMobileMembersOpen(value: boolean) { actions.push(`members:${value}`); state.mobileMembersOpen = value; notify(); },
    setMobilePane(value: string) { actions.push(`pane:${value}`); state.mobilePane = value; notify(); },
    setServerListOpen(value: boolean) { actions.push(`servers:${value}`); state.serverListOpen = value; notify(); },
    setView(value: string) { actions.push(`view:${value}`); state.view = value; notify(); },
    loadDms() { actions.push('loadDms'); return Promise.resolve(); } };
  class FakeCloseWatcher {
    onclose: ((e: Event) => void) | null = null;
    constructor() { live.add(this); made.push(this); }
    destroy() { live.delete(this); }
    close() { live.delete(this); this.onclose?.(new window.Event('close')); }
  }
  const win = window as unknown as Record<string, unknown>;
  if (options.tauri) Object.defineProperty(win, '__TAURI_INTERNALS__', { configurable: true, writable: true, value: {} });
  else Reflect.deleteProperty(win, '__TAURI_INTERNALS__');
  if (options.cw !== false) win.CloseWatcher = FakeCloseWatcher;
  else delete win.CloseWatcher;
  window.matchMedia = ((query: string) => ({ matches: query === '(max-width: 760px)' && width <= 760 })) as typeof window.matchMedia;
  window.setTimeout = ((fn: () => void, ms = 0) => {
    const id = nextTimer++; timers.set(id, { due: now + ms, fn }); return id;
  }) as typeof window.setTimeout;
  window.clearTimeout = ((id: number | undefined) => { if (id !== undefined) timers.delete(id); }) as typeof window.clearTimeout;
  const add = window.addEventListener.bind(window);
  window.addEventListener = ((name: string, listener: EventListenerOrEventListenerObject, opts?: AddEventListenerOptions | boolean) => {
    if (name === 'keydown' && typeof listener === 'function') keydowns.push(listener as unknown as (e: { key: string; isTrusted: boolean }) => void);
    add(name, listener, opts);
  }) as typeof window.addEventListener;
  // Настоящий DOM ищет порталы; наблюдение/часы — внешние сигналы, не копия алгоритма «назад».
  let mutation: (() => void) | undefined;
  class Observer { constructor(fn: () => void) { mutation = fn; } observe() {} disconnect() {} }
  let cleaned = false;
  function cleanup() {
    if (cleaned) return;
    cleaned = true;
    timers.clear(); subscribers.clear(); keydowns.length = 0;
    for (const watcher of live) { watcher.onclose = null; watcher.destroy(); }
    try {
      // В этой версии registrator восстановление происходит синхронно, до await happyDOM.close().
      void GlobalRegistrator.unregister();
    } finally {
      for (const [key, descriptor] of savedExtras) {
        if (descriptor) Object.defineProperty(globalThis, key, descriptor);
        else Reflect.deleteProperty(globalThis, key);
        assert.deepEqual(Object.getOwnPropertyDescriptor(globalThis, key), descriptor,
          `R347 setup: фикстура восстановила ${key}`);
      }
    }
  }
  const module = { exports: {} as typeof import('./androidBack') };
  try {
    runInNewContext(ts.transpileModule(raw, { fileName: 'androidBack.ts', compilerOptions: {
      module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022,
    } }).outputText, { module, exports: module.exports, window, document, history,
      KeyboardEvent: window.KeyboardEvent, performance: { now: () => now }, MutationObserver: Observer,
      require(id: string) {
        if (id === './store') return { useStore: { getState: () => state, subscribe: (fn: () => void) => { subscribers.add(fn); return () => subscribers.delete(fn); } } };
        if (id === './hotkeys') return { isAndroid: () => false, isTauri: () => '__TAURI_INTERNALS__' in window };
        assert.fail(`R345 setup: непредусмотренный импорт ${id}`);
      } }, { timeout: 2000 });
  } catch (error) { cleanup(); throw error; }
  const flush = () => {
    let turns = 0;
    while (true) {
      const entry = Array.from(timers).find(([, timer]) => timer.due <= now);
      if (!entry) return;
      assert.ok(++turns < 100, 'R345 setup: таймеры не зациклились');
      timers.delete(entry[0]); entry[1].fn();
    }
  };
  return { api: module.exports, state, actions, history, pushes, made, live,
    notify, flush, backs: () => backs,
    start() { module.exports.installBrowserBack(); flush(); },
    close() { const watcher = Array.from(live).at(-1); assert.ok(watcher, 'R345 setup: перед close есть наблюдатель'); watcher.close(); flush(); },
    touch() { window.dispatchEvent(new window.Event('pointerdown')); flush(); },
    pop(value: Record<string, unknown> | null = { unrelated: 'keep', nested: { value: 7 } }) {
      history.state = value; window.dispatchEvent(new window.PopStateEvent('popstate', { state: value })); flush();
    },
    key(key: string, isTrusted: boolean) { for (const fn of keydowns) fn({ key, isTrusted }); },
    advance(ms: number) { now += ms; flush(); },
    resize(value: number) { width = value; window.dispatchEvent(new window.Event('resize')); flush(); },
    layer(className: string) { const el = document.createElement('div'); el.className = className; document.body.append(el); mutation?.(); return el; },
    cleanup };
}
type Fixture = ReturnType<typeof fixture>;
function run(raw: string, options: Options, check: (f: Fixture) => void) {
  const f = fixture(raw, options);
  try { check(f); } finally { f.cleanup(); }
}
function paired(title: string, check: (raw: string) => void, edits: Edit[]) {
  it(`R345 браузерная назад: ${title}`, () => {
    check(source);
    for (const edit of edits) {
      counterfact(() => {
      assert.throws(() => check(mutate(edit)), error => error instanceof assert.AssertionError && error.message.startsWith(PREFIX));
      });
      check(source);
    }
  });
}
const CAN_WINDOWS = 'if (s.adminOpen || s.settingsOpen || s.mobileProfileOpen || s.mobileMembersOpen) return true;';

paired('корень не перехватывает выход, а вход в беседу создаёт ровно одного наблюдателя', raw => run(raw, {}, f => {
  f.start(); assert.equal(f.live.size, 0, PREFIX + 'на корне наблюдателя нет');
  f.state.mobilePane = 'content'; f.notify(); f.notify(); f.flush();
  assert.equal(f.live.size, 1, PREFIX + 'content перевзводится по стору один раз');
  f.state.mobilePane = 'list'; f.notify(); f.flush();
  assert.equal(f.live.size, 0, PREFIX + 'возврат на корень уничтожает наблюдателя');
  assert.equal(f.pushes.length, 0, PREFIX + 'CloseWatcher никогда не добавляет историю');
}), [{ from: 'const want = !stuck && phoneWidth() && canStepBack();', to: 'const want = !stuck && phoneWidth();' }]);

paired('три закрытия подряд без касаний проходят канал, серверы и корень сообщений', raw => run(raw, {}, f => {
  Object.assign(f.state, { view: 'server', currentServerId: 'srv', mobilePane: 'content' });
  f.start();
  f.close(); assert.equal(f.state.mobilePane, 'list', PREFIX + 'первый close закрывает канал');
  assert.equal(f.live.size, 1, PREFIX + 'после первого close создан следующий наблюдатель');
  f.close(); assert.equal(f.state.serverListOpen, true, PREFIX + 'второй close открывает список серверов');
  assert.equal(f.live.size, 1, PREFIX + 'после второго close снова один наблюдатель');
  f.close(); assert.equal(f.state.view, 'dm', PREFIX + 'третий close открывает сообщения');
  assert.equal(f.live.size, 0, PREFIX + 'на стартовой вкладке четвёртый close больше не ловится');
  assert.equal(f.made.length, 3, PREFIX + 'на каждый шаг один отдельный CloseWatcher');
  assert.equal(f.backs(), 0, PREFIX + 'успешные шаги не покидают сайт');
}), [{ from: '  const onClose = () => {\n    watcher = null;', to: '  const onClose = () => {' }]);

paired('доверенный Escape глушит close через 299 мс, но ровно через 300 мс разрешает шаг', raw => run(raw, {}, f => {
  f.state.mobilePane = 'content'; f.start(); f.key('Escape', true); f.advance(299); f.close();
  assert.equal(f.state.mobilePane, 'content', PREFIX + '299 мс ещё тот же Escape');
  assert.equal(f.live.size, 1, PREFIX + 'после Escape наблюдатель возвращён');
  f.advance(1); f.close();
  assert.equal(f.state.mobilePane, 'list', PREFIX + 'ровно 300 мс уже новая назад');
}), [{ from: 'performance.now() - lastEsc < 300', to: 'performance.now() - lastEsc <= 300' },
  { from: 'if (e.isTrusted && e.key === \'Escape\') lastEsc = performance.now();', to: 'if (false) lastEsc = performance.now();' }]);

paired('синтетический Escape не подавляет настоящую браузерную назад', raw => run(raw, {}, f => {
  f.state.mobilePane = 'content'; f.start(); f.key('Escape', false); f.close();
  assert.equal(f.state.mobilePane, 'list', PREFIX + 'недоверенная клавиша не ставит защитное окно');
}), [{ from: "if (e.isTrusted && e.key === 'Escape') lastEsc = performance.now();", to: "if (e.key === 'Escape') lastEsc = performance.now();" }]);

paired('ширины 761 и 1280 не ловят историю, а граница 760 ещё телефонная', raw => {
  for (const cw of [true, false]) for (const width of [760, 761, 1280]) run(raw, { cw, width }, f => {
    f.state.mobilePane = 'content'; f.start(); f.touch();
    assert.equal(f.live.size, cw && width === 760 ? 1 : 0, PREFIX + `наблюдатели при ширине ${width}`);
    assert.equal(f.pushes.length, !cw && width === 760 ? 1 : 0, PREFIX + `история при ширине ${width}`);
  });
}, [{ from: "return typeof window.matchMedia === 'function' && window.matchMedia('(max-width: 760px)').matches;", to: 'return true;' }]);

paired('мост Tauri исключает и CloseWatcher, и запасную запись истории', raw => {
  for (const cw of [true, false]) run(raw, { cw, tauri: true }, f => {
    f.state.mobilePane = 'content'; f.start(); f.touch(); f.pop();
    assert.equal(f.live.size, 0, PREFIX + 'в оболочке браузерного наблюдателя нет');
    assert.equal(f.pushes.length, 0, PREFIX + 'в оболочке нет записей истории');
    assert.equal(f.state.mobilePane, 'content', PREFIX + 'popstate не меняет экран оболочки');
  });
}, [{ from: "if (isTauri() || typeof window === 'undefined'", to: "if (typeof window === 'undefined'" }]);

paired('отказ перехватчика без peek выпускает историю и застревает только до касания', raw => run(raw, {}, f => {
  let calls = 0;
  f.api.pushBackHandler(() => { calls++; return false; }); f.start();
  f.close(); assert.equal(f.backs(), 1, PREFIX + 'отказавший handler отдаёт назад браузеру');
  assert.equal(calls, 1, PREFIX + 'отказ опрошен один раз');
  f.notify(); f.flush(); assert.equal(f.live.size, 0, PREFIX + 'stuck не проглатывает все следующие назад');
  f.touch(); assert.equal(f.live.size, 1, PREFIX + 'касание снимает stuck');
}), [{ from: '    stuck = true;\n    history.back();', to: '    stuck = false;\n    history.back();' },
  { from: '  const touched = () => {\n    stuck = false;', to: '  const touched = () => {' }]);

paired('расширение окна уничтожает наблюдателя, сужение возвращает его без новой истории', raw => run(raw, {}, f => {
  f.state.mobilePane = 'content'; f.start(); f.resize(761);
  assert.equal(f.live.size, 0, PREFIX + 'на 761 наблюдатель уничтожен');
  f.resize(760); assert.equal(f.live.size, 1, PREFIX + 'на 760 снова перехватываем назад');
  assert.equal(f.pushes.length, 0, PREFIX + 'смена раскладки не мутирует историю');
}), [{ from: 'const want = !stuck && phoneWidth() && canStepBack();', to: 'const want = !stuck && canStepBack();' }]);

paired('canStepBack видит каждый верхний слой и не закрывает его при опросе', raw => {
  for (const className of ['sheet', 'ctx-menu', 'confirm-overlay', 'dd-pop', 'lightbox', 'emoji-backdrop', 'sb-pop', 'status-pop', 'geo-full']) run(raw, {}, f => {
    const el = f.layer(className); let escapes = 0;
    document.addEventListener('keydown', e => { if (e.key === 'Escape') { escapes++; el.remove(); } });
    assert.equal(f.api.canStepBack(), true, PREFIX + `опрос видит ${className}`);
    assert.equal(escapes, 0, PREFIX + 'опрос не рассылает Escape');
    assert.equal(f.api.stepBack(), true, PREFIX + 'настоящий шаг принимает слой');
    assert.equal(escapes, 1, PREFIX + 'один шаг рассылает один Escape');
    assert.equal(f.api.canStepBack(), false, PREFIX + 'после закрытия на корне больше нечего закрыть');
  });
}, [{ fn: 'canStepBack', from: 'if (topLayer()) return true;', to: 'if (topLayer()) return false;' }]);

paired('canStepBack равен шагу для каждого окна, не вызывая ни одного сеттера', raw => {
  for (const key of ['adminOpen', 'settingsOpen', 'mobileProfileOpen', 'mobileMembersOpen'] as const) run(raw, {}, f => {
    f.state[key] = true;
    assert.equal(f.api.canStepBack(), true, PREFIX + `открыт ${key}`);
    assert.deepEqual(f.actions, [], PREFIX + 'опрос не меняет окно, вкладку и список бесед');
    assert.equal(f.api.stepBack(), true, PREFIX + 'шаг закрывает открытое окно');
    assert.equal(f.state[key], false, PREFIX + 'закрыто именно выбранное окно');
    assert.equal(f.api.canStepBack(), false, PREFIX + 'после закрытия остаётся корень ЛС');
  });
}, [{ fn: 'canStepBack', from: CAN_WINDOWS, get to() { return CAN_WINDOWS.replace('return true', 'return false'); } }]);

paired('canStepBack совпадает с шагом в content, корнях сервера и корне ЛС', raw => {
  for (const [view, pane, server, list, expected] of [
    ['dm', 'content', null, false, true], ['dm', 'list', null, false, false],
    ['server', 'list', 'srv', false, true], ['server', 'list', 'srv', true, true],
    ['server', 'list', null, false, true], ['server', 'list', null, true, true],
  ] as const) run(raw, {}, f => {
    Object.assign(f.state, { view, mobilePane: pane, currentServerId: server, serverListOpen: list });
    assert.equal(f.api.canStepBack(), expected, PREFIX + `${view}/${pane}/${server}/${list}: опрос`);
    assert.deepEqual(f.actions, [], PREFIX + 'опрос не делает переходов');
    assert.equal(f.api.stepBack(), expected, PREFIX + 'настоящий шаг подтверждает опрос');
  });
}, [{ fn: 'canStepBack', from: "if (s.mobilePane === 'content') return true;", to: "if (s.mobilePane === 'content') return false;" },
  { fn: 'canStepBack', from: "return s.view === 'server';", to: 'return false;' }]);

paired('canStepBack спрашивает peek сверху вниз и не исполняет действия перехватчиков', raw => run(raw, {}, f => {
  const asks: string[] = []; let actions = 0, takeTop = true;
  const bottom = f.api.pushBackHandler(() => { actions++; return true; }, () => { asks.push('bottom'); return true; });
  const top = f.api.pushBackHandler(() => { actions++; return takeTop; }, () => { asks.push('top'); return takeTop; });
  assert.equal(f.api.canStepBack(), true, PREFIX + 'верхний peek забирает шаг');
  assert.deepEqual(asks, ['top'], PREFIX + 'до нижнего peek не дошли');
  assert.equal(actions, 0, PREFIX + 'canStepBack не исполняет callback');
  assert.equal(f.api.stepBack(), true, PREFIX + 'верхний callback действительно принимает шаг');
  takeTop = false; asks.length = 0;
  assert.equal(f.api.canStepBack(), true, PREFIX + 'false сверху пропускает к нижнему peek');
  assert.deepEqual(asks, ['top', 'bottom'], PREFIX + 'порядок peek совпадает с порядком callback');
  assert.equal(f.api.stepBack(), true, PREFIX + 'нижний callback принимает пропущенный шаг');
  assert.equal(actions, 3, PREFIX + 'два шага вызвали ровно верх, верх и низ');
  top(); bottom();
  const pass = f.api.pushBackHandler(() => false, () => false);
  assert.equal(f.api.canStepBack(), false, PREFIX + 'только отказывающий peek не задерживает выход');
  assert.equal(f.api.stepBack(), false, PREFIX + 'отказ подтверждён callback'); pass();
}), [{ fn: 'canStepBack', from: 'if (!peek || peek()) return true;', to: 'if (!peek || handlers[i]!()) return true;' },
  { fn: 'canStepBack', from: 'for (let i = handlers.length - 1; i >= 0; i--)', to: 'for (let i = 0; i < handlers.length; i++)' }]);

paired('fallback добавляет стража только касанием и сохраняет чужие поля history.state', raw => run(raw, { cw: false }, f => {
  f.start(); assert.equal(f.pushes.length, 0, PREFIX + 'установка сама не пишет историю');
  const before = f.history.state; f.touch(); f.touch();
  assert.equal(f.pushes.length, 1, PREFIX + 'повторное касание не плодит стражей');
  assert.deepEqual(JSON.parse(JSON.stringify(f.history.state)), { unrelated: 'keep', nested: { value: 7 }, gvBackGuard: true }, PREFIX + 'чужое состояние сохранено');
  assert.deepEqual(before, { unrelated: 'keep', nested: { value: 7 } }, PREFIX + 'исходный объект не изменён');
}), [{ from: "history.pushState({ ...state, [BACK_GUARD_KEY]: true }, '');", to: "history.pushState({ [BACK_GUARD_KEY]: true }, '');" }]);

paired('fallback делает шаг в popstate, но новый страж ждёт следующего касания', raw => run(raw, { cw: false }, f => {
  Object.assign(f.state, { view: 'server', currentServerId: 'srv', mobilePane: 'content' });
  f.start(); f.touch(); f.pop();
  assert.equal(f.state.mobilePane, 'list', PREFIX + 'popstate сделал один шаг content → list');
  assert.equal(f.pushes.length, 1, PREFIX + 'popstate не добавляет запись без действия человека');
  f.touch(); assert.equal(f.pushes.length, 2, PREFIX + 'следующее касание перевзводит стража');
  f.pop(); assert.equal(f.state.serverListOpen, true, PREFIX + 'второй popstate не потерян');
  assert.equal(f.pushes.length, 2, PREFIX + 'даже второй popstate не пишет историю');
}), [{ from: '    if (stepBack()) return;\n    leaving = true;', to: '    if (stepBack()) { arm(); return; }\n    leaving = true;' }]);

paired('fallback переход вперёд на стража не закрывает экран', raw => run(raw, { cw: false }, f => {
  f.state.mobilePane = 'content'; f.start(); f.touch();
  f.pop({ gvBackGuard: true, unrelated: 'keep' });
  assert.equal(f.state.mobilePane, 'content', PREFIX + 'страж в popstate означает вперёд, не назад');
  assert.equal(f.backs(), 0, PREFIX + 'переход вперёд не вызывает history.back');
  assert.equal(f.pushes.length, 1, PREFIX + 'вперёд не плодит новых записей');
}), [{ from: 'if (armed() || !phoneWidth()) return;', to: 'if (!phoneWidth()) return;' }]);

paired('fallback на корне выпускает браузер, а leaving снимается ровно через секунду', raw => run(raw, { cw: false }, f => {
  f.start(); f.touch(); f.pop();
  assert.equal(f.backs(), 1, PREFIX + 'на корне история уходит браузеру');
  f.touch(); f.advance(999); f.touch();
  assert.equal(f.pushes.length, 1, PREFIX + 'до секунды leaving не запирает вкладку новым стражем');
  f.advance(1); f.touch();
  assert.equal(f.pushes.length, 2, PREFIX + 'через секунду касание снова ставит стража');
}), [{ from: 'if (leaving || armed() || !phoneWidth()) return;', to: 'if (armed() || !phoneWidth()) return;' },
  { from: '    }, 1000);\n    history.back();', to: '    }, 999);\n    history.back();' }]);
