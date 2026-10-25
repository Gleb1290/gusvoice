import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { it } from 'node:test';
import ts from 'typescript';

const read = (path: string) => readFileSync(new URL(path, import.meta.url), 'utf8');
const rust = read('../../desktop/src-tauri/src/titlebar.rs');
const main = read('./main.tsx');
const component = read('./components/WindowTitleBar.tsx');
const css = read('./styles.css').replace(/\/\*[\s\S]*?\*\//g, '');
// Комментарии объясняют запрещённые Win32-флаги: запрет проверяем в коде, а не в объяснениях.
const rustCode = (text: string) => text.replace(/\/\/[^\r\n]*/g, '');
const compact = (node: ts.Node) => node.getText().replace(/\s+/g, '');
function nodes<T extends ts.Node>(root: ts.Node, predicate: (node: ts.Node) => node is T): T[] {
  const out: T[] = [];
  const visit = (node: ts.Node) => { if (predicate(node)) out.push(node); ts.forEachChild(node, visit); };
  visit(root);
  return out;
}
function parse(raw: string, filename: string) {
  const file = ts.createSourceFile(filename, raw, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  assert.equal((file as ts.SourceFile & { parseDiagnostics: readonly ts.Diagnostic[] }).parseDiagnostics.length, 0);
  return file;
}
function changed(raw: string, before: string, after: string) {
  assert.equal(raw.split(before).length - 1, 1, `единственная точка мутации: ${before}`);
  return raw.replace(before, after);
}
const callName = (call: ts.CallExpression) => compact(call.expression);
const hasTag = (scope: ts.Node, tag: string) =>
  nodes(scope, ts.isJsxSelfClosingElement).some(n => n.tagName.getText() === tag) ||
  nodes(scope, ts.isJsxOpeningElement).some(n => n.tagName.getText() === tag);

function hitTest(raw = rust) {
  assert.match(rustCode(raw), /WM_NCHITTEST\s*=>\s*LRESULT\(HTMAXBUTTON\s+as\s+isize\)/,
    'R268:hit-test-это-кнопка-развернуть');
}
function mouseWiring(raw = component) {
  const file = parse(raw, 'WindowTitleBar.tsx');
  const roots = nodes(file, ts.isJsxOpeningElement).filter(n =>
    n.attributes.properties.some(a => ts.isJsxAttribute(a) && a.name.getText() === 'className' &&
      a.initializer?.getText().includes("'gv-titlebar'")));
  assert.equal(roots.length, 1, 'одна полоса с классом gv-titlebar');
  const mouse = roots[0].attributes.properties.find(a => ts.isJsxAttribute(a) && a.name.getText() === 'onMouseDown');
  // PointerEvent.detail не гарантирует счётчик щелчков: правильное правило бесполезно на неверном событии.
  assert.equal(!!mouse, true, 'R268:полоса-слушает-mousedown-для-detail');
  assert.ok(mouse && ts.isJsxAttribute(mouse) && mouse.initializer && ts.isJsxExpression(mouse.initializer));
  assert.equal(compact(mouse.initializer.expression!), '(e)=>titleBarPointerDown(e)');
  assert.equal(roots[0].attributes.properties.some(a => ts.isJsxAttribute(a) && a.name.getText() === 'onPointerDown'), false);

  const buttonContainers = nodes(file, ts.isJsxOpeningElement).filter(n =>
    n.attributes.properties.some(a => ts.isJsxAttribute(a) && a.name.getText() === 'className' &&
      a.initializer && ts.isStringLiteral(a.initializer) && a.initializer.text === 'gv-titlebar-btns'));
  assert.equal(buttonContainers.length, 1);
  const stop = buttonContainers[0].attributes.properties.find(a => ts.isJsxAttribute(a) && a.name.getText() === 'onMouseDown');
  assert.ok(stop && ts.isJsxAttribute(stop) && stop.initializer && ts.isJsxExpression(stop.initializer));
  assert.equal(compact(stop.initializer.expression!), '(e)=>e.stopPropagation()', 'кнопки не начинают перетаскивание полосы');
}
function independentRoot(raw = main) {
  const file = parse(raw, 'main.tsx');
  const calls = nodes(file, ts.isCallExpression);
  const titleRoots = calls.filter(n => callName(n) === 'createRoot(bar).render' && hasTag(n, 'WindowTitleBar'));
  // Падение App не должно отнять у пользователя крестик и возможность закрыть окно.
  assert.equal(titleRoots.length, 1, 'R268:полоса-в-отдельном-корне');
  const titleRoot = titleRoots[0];
  assert.equal(hasTag(titleRoot, 'App'), false, 'полоса не делит корень с App');
  const appRoots = calls.filter(n => callName(n) === 'root.render' && hasTag(n, 'App'));
  assert.equal(appRoots.length, 1);
  assert.equal(hasTag(appRoots[0], 'WindowTitleBar'), false, 'корень App не содержит полосу');
  assert.ok(titleRoot.end < appRoots[0].getStart(), 'крестик монтируется прежде App');
  assert.ok(titleRoot.arguments[0] && hasTag(titleRoot.arguments[0], 'ErrorBoundary'));
  assert.ok(nodes(titleRoot, ts.isJsxAttribute).some(n => n.name.getText() === 'silent'));

  const guards = nodes(file, ts.isIfStatement).filter(n => compact(n.expression) === 'hasOwnTitleBar()');
  assert.equal(guards.length, 1);
  assert.ok(titleRoot.getStart() >= guards[0].thenStatement.getStart() && titleRoot.end <= guards[0].thenStatement.end,
    'веб и Android не монтируют полосу');
  const body = guards[0].thenStatement;
  const bodyCalls = nodes(body, ts.isCallExpression);
  const insertion = bodyCalls.find(n => callName(n) === 'document.body.insertBefore');
  assert.ok(insertion);
  assert.deepEqual(insertion.arguments.map(compact), ['bar', 'document.body.firstChild'], 'полоса стоит в DOM перед #root');
  assert.ok(insertion.end < titleRoot.getStart());
  assert.ok(bodyCalls.some(n => callName(n) === 'document.createElement' && compact(n.arguments[0]) === "'div'"));
  assert.ok(nodes(body, ts.isBinaryExpression).some(n => compact(n) === "bar.id='gv-titlebar-root'"));
  assert.ok(bodyCalls.some(n => callName(n) === 'document.documentElement.classList.add' &&
    compact(n.arguments[0]) === "'gv-frameless'"));
}
function cssBlock(selector: string) {
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const match = css.match(new RegExp(`(?:^|\\n)${escaped}\\s*\\{([^}]*)\\}`));
  assert.ok(match, `есть CSS ${selector}`);
  return match[1];
}

// Страж Rust-проводки, не эмуляция Win32: ограничиваемся телом parent_proc и действующим if.
// В этой функции нет строковых литералов со скобками; комментарии удаляем до поиска границ.
function rustBlock(code: string, open: number) {
  assert.equal(code[open], '{', 'R285 найдена открывающая скобка Rust-блока');
  let depth = 1, end = open + 1;
  while (end < code.length && depth > 0) {
    if (code[end] === '{') depth++;
    else if (code[end] === '}') depth--;
    end++;
  }
  assert.equal(depth, 0, 'R285 Rust-блок закрыт');
  return { body: code.slice(open + 1, end - 1), end };
}
function fullscreenBranch(raw: string) {
  const code = rustCode(raw.replace(/\/\*[\s\S]*?\*\//g, '')).replace(/\r\n/g, '\n');
  const functions = [...code.matchAll(/\bfn\s+parent_proc\s*\([^)]*\)\s*->\s*LRESULT\s*\{/g)];
  assert.equal(functions.length, 1, 'R285 один настоящий parent_proc');
  const fn = functions[0];
  const body = rustBlock(code, fn.index! + fn[0].length - 1).body;
  const guards = [...body.matchAll(/\bif\s+([^{}]+)\{/g)].filter(m => /\bWM_NCCALCSIZE\b/.test(m[1]));
  assert.equal(guards.length, 1, 'R285 одна ветка расчёта клиентской области внутри parent_proc');
  const guard = guards[0], start = guard.index!;
  const prefix = body.slice(0, start);
  assert.equal([...prefix].reduce((depth, ch) => depth + (ch === '{' ? 1 : ch === '}' ? -1 : 0), 0), 0,
    'R285 перехват не спрятан во вложенном условии');
  const branch = rustBlock(body, start + guard[0].length - 1);
  return { body, condition: guard[1].replace(/\s+/g, ''), start, end: branch.end, thenBody: branch.body,
    block: body.slice(start, branch.end) };
}
const fullscreenMarkers = {
  order: 'R285 полный экран перехватывается до DefSubclassProc',
  zero: 'R285 ветка возвращает ноль без обращения к tao',
  wparam: 'R285 перехват требует wparam.0 != 0',
  caption: 'R285 полный экран определяется отсутствием WS_CAPTION, а не IsZoomed',
};
function fullscreenOrder(raw = rust) {
  const branch = fullscreenBranch(raw);
  const fallback = [...branch.body.matchAll(/\bDefSubclassProc\s*\(/g)];
  assert.equal(fallback.length, 1, 'R285 остаётся один базовый обработчик обычных сообщений');
  assert.equal(branch.end <= fallback[0].index!, true, fullscreenMarkers.order);
  assert.equal(branch.thenBody.replace(/\s+/g, ''), 'returnLRESULT(0);', fullscreenMarkers.zero);
}
function fullscreenCondition(raw = rust) {
  const terms = fullscreenBranch(raw).condition.split('&&');
  assert.equal(terms.includes('msg==WM_NCCALCSIZE'), true, 'R285 перехват ограничен WM_NCCALCSIZE');
  assert.equal(terms.includes('wparam.0!=0'), true, fullscreenMarkers.wparam);
  assert.equal(terms.includes('(GetWindowLongW(hwnd,GWL_STYLE)asu32&WS_CAPTION.0)==0'), true, fullscreenMarkers.caption);
  assert.equal(terms.length, 3, 'R285 три условия объединены И без альтернативного обхода');
}
function fullscreenFailure(marker: string) {
  return (error: unknown) => error instanceof assert.AssertionError && error.message.split('\n')[0] === marker;
}

for (const filename of ['tauri.conf.json', 'tauri.windows.conf.json']) {
  it(`R268 main в ${filename} без системной полосы, но с тенью`, () => {
    const config = JSON.parse(read(`../../desktop/src-tauri/${filename}`)) as {
      app: { windows: Array<{ label: string; decorations?: boolean; shadow?: boolean }> };
    };
    const mains = config.app.windows.filter(w => w.label === 'main');
    assert.equal(mains.length, 1);
    assert.equal(mains[0].decorations, false);
    assert.equal(mains[0].shadow, true);
  });
}
it('R268 главное окно имеет права свернуть, развернуть, закрыть и перетаскивать', () => {
  const capability = JSON.parse(read('../../desktop/src-tauri/capabilities/desktop.json')) as {
    windows: string[]; permissions: string[];
  };
  assert.ok(capability.windows.includes('main'));
  for (const operation of ['minimize', 'toggle-maximize', 'close', 'start-dragging']) {
    assert.ok(capability.permissions.includes(`core:window:allow-${operation}`), `разрешена операция ${operation}`);
  }
});
it('R268 Win32 hit-test возвращает кнопку разворачивания для Snap Layouts', () => hitTest());
it('R268 дочернее Win32-окно не теряет мышь из-за layered или transparent', () => {
  const code = rustCode(rust);
  assert.doesNotMatch(code, /\bWS_EX_(?:LAYERED|TRANSPARENT)\b/);
  assert.match(code, /CreateWindowExW\(\s*WINDOW_EX_STYLE::default\(\),\s*CLASS,/);
  assert.match(code, /WS_CHILD\s*\|\s*WS_CLIPSIBLINGS/);
  assert.match(code, /hbrBackground:\s*HBRUSH\(GetStockObject\(NULL_BRUSH\)\.0\)/);
});
it('R268 нативная сторона слушает глобальное событие координат через listen_any', () => {
  const code = rustCode(rust);
  assert.match(code, /EVENT_RECT:\s*&str\s*=\s*"gv-titlebar-max-rect"/);
  assert.match(code, /window\.app_handle\(\)\.listen_any\(EVENT_RECT,\s*\|event\|/);
  assert.match(code, /parse_spot\(event\.payload\(\)\)/);
  assert.match(code, /EVENT_STATE:\s*&str\s*=\s*"gv-titlebar-max-state"/);
  for (const state of ['enter', 'leave', 'down', 'up']) assert.ok(code.includes(`emit_state("${state}")`));
});
it('R268 Snap-окно стоит ниже TAURI_DRAG_RESIZE_BORDERS, а не перекрывает изменение размера', () => {
  const code = rustCode(rust);
  assert.match(code, /TAURI_BORDERS:[^;]+w!\("TAURI_DRAG_RESIZE_BORDERS"\)/);
  assert.match(code, /let above = FindWindowExW\(Some\(parent\), None, TAURI_BORDERS, None\)\.ok\(\)\.unwrap_or\(HWND_TOP\)/);
  assert.match(code, /SetWindowPos\(\s*child,\s*Some\(above\),\s*x,\s*y,\s*w,\s*h,/);
});
it('R268 модуль подключён в pip только для Windows после сборки main и не добавлен в lib', () => {
  const pip = rustCode(read('../../desktop/src-tauri/src/pip.rs'));
  assert.match(pip, /#\[cfg\(windows\)\]\s*#\[path = "titlebar\.rs"\]\s*mod titlebar;/);
  assert.match(pip, /let _main = WebviewWindowBuilder::from_config[\s\S]*?\.build\(\)\?;\s*#\[cfg\(windows\)\]\s*titlebar::attach\(&_main\);/);
  assert.doesNotMatch(rustCode(read('../../desktop/src-tauri/src/lib.rs')), /\btitlebar\b/);
});
it('R268 нативный щелчок разворачивает и восстанавливает через системную команду', () => {
  const code = rustCode(rust);
  assert.match(code, /if was && parent != 0\s*\{/);
  assert.match(code, /if IsZoomed\(parent\)\.as_bool\(\)\s*\{ SC_RESTORE \}\s*else\s*\{ SC_MAXIMIZE \}/);
  assert.match(code, /PostMessageW\(Some\(parent\), WM_SYSCOMMAND, WPARAM\(cmd as usize\), LPARAM\(0\)\)/);
  assert.match(code, /WM_NCRBUTTONDOWN\s*\|\s*WM_NCRBUTTONUP\s*=>\s*LRESULT\(0\)/);
});
it('R268 CSS задаёт полосу 32 пикселя и кнопки 46 × 32 без наложения на приложение', () => {
  assert.match(cssBlock('html.gv-frameless'), /--gv-titlebar-h:\s*32px\s*;/);
  const bar = cssBlock('.gv-titlebar');
  assert.match(bar, /height:\s*var\(--gv-titlebar-h,\s*32px\)\s*;/);
  assert.match(bar, /position:\s*fixed\s*;/);
  assert.match(cssBlock('html.gv-frameless body'), /padding-top:\s*var\(--gv-titlebar-h\)\s*;/);
  const button = cssBlock('.gv-titlebar-btn');
  assert.match(button, /width:\s*46px\s*;/);
  assert.match(button, /height:\s*100%\s*;/);
});
it('R268 полоса слушает мышь с номером щелчка, а кнопки останавливают перетаскивание', () => mouseWiring());
it('R268 отдельный корень полосы монтируется перед App и имеет свой ErrorBoundary', () => independentRoot());
it('R268 App не импортирует и не содержит полосу окна', () => {
  const file = parse(read('./App.tsx'), 'App.tsx');
  assert.equal(hasTag(file, 'WindowTitleBar'), false);
  assert.equal(nodes(file, ts.isImportDeclaration).some(n =>
    ts.isStringLiteral(n.moduleSpecifier) && n.moduleSpecifier.text.includes('WindowTitleBar')), false);
});
it('R268 место кнопки перемеряется при размере, DPI и fullscreen и очищается при снятии полосы', () => {
  const file = parse(component, 'WindowTitleBar.tsx');
  const calls = nodes(file, ts.isCallExpression);
  const text = calls.map(compact);
  assert.ok(text.includes('reportMaxSpot(maxButtonSpot(r,window.innerWidth,window.devicePixelRatio))'));
  assert.ok(nodes(file, ts.isConditionalExpression).some(n =>
    compact(n) === 'document.fullscreenElement?null:el.getBoundingClientRect()'));
  assert.ok(nodes(file, ts.isNewExpression).some(n => compact(n) === 'newResizeObserver(report)'));
  assert.ok(text.includes('ro.observe(el)'));
  for (const event of ['window.addEventListener(\'resize\',report)', 'document.addEventListener(\'fullscreenchange\',report)',
    'window.removeEventListener(\'resize\',report)', 'document.removeEventListener(\'fullscreenchange\',report)',
    'mq.addEventListener(\'change\',onDpr)', 'mq?.removeEventListener(\'change\',onDpr)', 'ro.disconnect()', 'reportMaxSpot(null)']) {
    assert.ok(text.includes(event), `жизненный цикл координат: ${event}`);
  }
  assert.ok(calls.some(n => callName(n) === 'window.matchMedia' && n.arguments[0].getText().includes('window.devicePixelRatio')));
});

it('R268 original-first мутант HTCAPTION не выдаётся за исправный hit-test Snap Layouts', () => {
  hitTest();
  const mutant = changed(rust, 'WM_NCHITTEST => LRESULT(HTMAXBUTTON as isize)', 'WM_NCHITTEST => LRESULT(HTCAPTION as isize)');
  assert.throws(() => hitTest(mutant), e => e instanceof assert.AssertionError &&
    e.message.startsWith('R268:hit-test-это-кнопка-развернуть'));
});
it('R268 original-first мутант pointerdown теряет счётчик щелчков и отвергается стражем', () => {
  mouseWiring();
  const mutant = changed(component, 'onMouseDown={(e) => titleBarPointerDown(e)}', 'onPointerDown={(e) => titleBarPointerDown(e)}');
  assert.throws(() => mouseWiring(mutant), e => e instanceof assert.AssertionError &&
    e.message.startsWith('R268:полоса-слушает-mousedown-для-detail'));
});
it('R268 original-first мутант полосы в корне App теряет независимый крестик и отвергается стражем', () => {
  independentRoot();
  const file = parse(main, 'main.tsx');
  const own = nodes(file, ts.isCallExpression).find(n => callName(n) === 'createRoot(bar).render');
  assert.ok(own);
  // Переносим JSX в главный root, а не делаем синтаксически битый модуль: падение обязано быть предметным.
  const withoutRoot = main.slice(0, own.getStart()) + 'void 0' + main.slice(own.end);
  const mutant = changed(withoutRoot, '<App />', '<WindowTitleBar /><App />');
  assert.throws(() => independentRoot(mutant), e => e instanceof assert.AssertionError &&
    e.message.startsWith('R268:полоса-в-отдельном-корне'));
});

it('R285 полный экран получает всю клиентскую область до tao и сразу возвращает ноль', () => {
  // Иначе tao успевает урезать развёрнутое окно до rcWork и оставляет полосу панели задач.
  fullscreenOrder();
});
it('R285 обычное окно с WS_CAPTION и расчёт с нулевым wparam не попадают в полноэкранный перехват', () => {
  // IsZoomed остаётся истинным и при fullscreen: отличать его надо от обычного maximized по стилю.
  fullscreenCondition();
});
it('R285 перенос ветки после DefSubclassProc обнаруживается даже при правильном комментарии', () => {
  // Наличие правильного return ниже базового обработчика уже не предотвращает изменение клиентской области.
  fullscreenOrder();
  const normalized = rust.replace(/\r\n/g, '\n');
  const branch = fullscreenBranch(normalized).block;
  const withoutBranch = changed(normalized, branch, '');
  const call = 'let result = DefSubclassProc(hwnd, msg, wparam, lparam);';
  const mutant = changed(withoutBranch, call, `${call}\n    ${branch}`) + `\n/* ${branch} */`;
  assert.throws(() => fullscreenOrder(mutant), fullscreenFailure(fullscreenMarkers.order));
});
it('R285 потеря проверки wparam не превращает любой WM_NCCALCSIZE в полноэкранный', () => {
  // Нулевой wparam означает другой контракт сообщения; обход tao там не разрешён.
  fullscreenCondition();
  const mutant = changed(rust, ' && wparam.0 != 0', '');
  assert.throws(() => fullscreenCondition(mutant), fullscreenFailure(fullscreenMarkers.wparam));
});
it('R285 IsZoomed вместо WS_CAPTION не выдаётся за определение полного экрана', () => {
  // Обычное развёрнутое окно должно по-прежнему ограничиваться рабочей областью монитора.
  fullscreenCondition();
  const mutant = changed(rust, '(GetWindowLongW(hwnd, GWL_STYLE) as u32 & WS_CAPTION.0) == 0', 'IsZoomed(hwnd).as_bool()');
  assert.throws(() => fullscreenCondition(mutant), fullscreenFailure(fullscreenMarkers.caption));
});
it('R285 перевёрнутая проверка WS_CAPTION не перехватывает обычное окно вместо полного экрана', () => {
  // Перепутанный знак одновременно ломает fullscreen и отнимает обработку обычного окна у tao.
  fullscreenCondition();
  const mutant = changed(rust, '& WS_CAPTION.0) == 0', '& WS_CAPTION.0) != 0');
  assert.throws(() => fullscreenCondition(mutant), fullscreenFailure(fullscreenMarkers.caption));
});
it('R285 ненулевой ответ не подменяет разрешение клиентской области во весь монитор', () => {
  // Порядок и правильное условие недостаточны, если ранний return имеет другой Win32-контракт.
  fullscreenOrder();
  const normalized = rust.replace(/\r\n/g, '\n');
  const branch = fullscreenBranch(normalized).block;
  const mutant = changed(normalized, branch, changed(branch, 'return LRESULT(0);', 'return LRESULT(1);'));
  assert.throws(() => fullscreenOrder(mutant), fullscreenFailure(fullscreenMarkers.zero));
});
