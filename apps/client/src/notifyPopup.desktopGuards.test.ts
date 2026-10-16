import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { it } from 'node:test';
import ts from 'typescript';

const read = (relative: string) => readFileSync(new URL(relative, import.meta.url), 'utf8').replace(/\r\n/g, '\n');
const rust = read('../../desktop/src-tauri/src/notify_popup.rs');
const lib = read('../../desktop/src-tauri/src/lib.rs');
const overlay = read('../../desktop/src-tauri/src/overlay.rs');
it('R223 Windows показывает именно окно notify без активации; .show разрешён главному окну, но не Windows place', () => {
  const windowsPlace = rust.match(/#\[cfg\(target_os = "windows"\)\]\nfn place\([^]*?(?=\n#\[cfg)/)?.[0];
  assert.ok(windowsPlace, 'найдена Windows-ветка place целиком');
  const code = windowsPlace.replace(/\/\/[^\n]*/g, '');
  assert.match(code, /SetWindowPos\(hwnd, Some\(HWND_TOPMOST\), x, y, w, h, SWP_NOACTIVATE \| SWP_SHOWWINDOW\)/);
  assert.match(code, /guard_hwnd\(NOTIFY, hwnd\.0 as isize\)/); assert.doesNotMatch(code, /\.show\(/);
  assert.match(rust, /get_webview_window\(NOTIFY\)/); assert.match(overlay, /pub const NOTIFY: &str = "notify"/);
});
it('R223 все четыре popup-команды зарегистрированы только под cfg desktop, модуль тоже закрыт от Android', () => {
  for (const cmd of ['push', 'action', 'layout', 'monitors']) {
    assert.equal(lib.split(`notify_popup::gv_notify_popup_${cmd},`).length - 1, 1);
    assert.match(lib, new RegExp(`#\\[cfg\\(desktop\\)\\]\\s+notify_popup::gv_notify_popup_${cmd},`));
  }
  assert.match(lib, /#\[cfg\(desktop\)\]\s*mod notify_popup;/);
});
it('R223 capability ограничена окном notify и desktop платформами без plugin permissions', () => {
  const capability = JSON.parse(read('../../desktop/src-tauri/capabilities/notify.json'));
  assert.equal(capability.identifier, 'notify'); assert.deepEqual(capability.windows, ['notify']);
  assert.deepEqual(capability.platforms, ['windows', 'linux', 'macOS']); assert.deepEqual(capability.permissions, ['core:default']);
});
it('R223 ветка notify в main действительно монтирует NotifyPopups отдельно от обычного приложения', () => {
  const file = ts.createSourceFile('main.tsx', read('./main.tsx'), ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  let branch: ts.IfStatement | undefined;
  function visit(node: ts.Node) {
    if (ts.isIfStatement(node) && ts.isBinaryExpression(node.expression)
      && ts.isIdentifier(node.expression.left) && node.expression.left.text === 'gvWindow'
      && node.expression.operatorToken.kind === ts.SyntaxKind.EqualsEqualsEqualsToken
      && ts.isStringLiteral(node.expression.right) && node.expression.right.text === 'notify') branch = node;
    ts.forEachChild(node, visit);
  }
  visit(file); assert.ok(branch);
  const tags: string[] = [];
  function collect(node: ts.Node) {
    if (ts.isJsxSelfClosingElement(node) || ts.isJsxOpeningElement(node)) tags.push(node.tagName.getText(file));
    ts.forEachChild(node, collect);
  }
  collect(branch.thenStatement); assert.ok(tags.includes('NotifyPopups')); assert.equal(tags.includes('App'), false);
});

const main = read('./main.tsx');
const compact = (value: string) => value.replace(/\s+/g, '');
const rustCode = (value: string) => value.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '');
function replaceOnce(source: string, anchor: string, replacement: string): string {
  assert.equal(source.split(anchor).length - 1, 1, `уникальный якорь ${anchor}`);
  return source.replace(anchor, replacement);
}
function rustBody(source: string, anchor: string) {
  assert.equal(source.split(anchor).length - 1, 1, `единственный Rust-блок ${anchor}`);
  const start = source.indexOf('{', source.indexOf(anchor));
  assert.notEqual(start, -1);
  let end = start + 1, depth = 1;
  while (end < source.length && depth) {
    if (source[end] === '{') depth++;
    if (source[end] === '}') depth--;
    end++;
  }
  assert.equal(depth, 0, 'Rust-блок сбалансирован');
  return source.slice(start + 1, end - 1);
}
function exactFailure(prefix: string, actual: unknown, expected: unknown) {
  return (error: unknown) => error instanceof assert.AssertionError && error.message.startsWith(prefix) &&
    error.operator === 'strictEqual' && error.actual === actual && error.expected === expected;
}
function checkOffsets(raw = rust) {
  const code = rustCode(raw);
  assert.equal(code.match(/^const DELTA_Y: f64 = ([\d.]+);$/m)?.[1], '7.0', 'R233-offset: вертикальный отступ равен семи логическим px');
  const body = rustBody(code, 'pub async fn gv_notify_popup_layout(');
  const assignment = (name: string) => compact(body.match(new RegExp(`let ${name} = ([^;]+);`))?.[1] ?? '');
  assert.equal(assignment('dy'), '(DELTA_Y*scale).round()asi32', 'R233-scale: отступ масштабируется монитором и округляется');
  assert.equal(assignment('x'), '(ifleft{ax+dx}else{ax+aw-pw-dx}).max(ax)', 'R233-x: оба угла и clamp горизонтали');
  assert.equal(assignment('y'), '(iftop{ay+dy}else{ay+ah-ph-dy}).max(ay)', 'R233-y: оба угла и clamp вертикали');
  assert.equal(compact(body).includes('place(&win,x,y,pw,ph);'), true, 'R233-place: рассчитанный прямоугольник передаётся окну');
}
it('R233 отступ окна семь логических px масштабируется, оба края и слишком большая стопка учитывают рабочую область', () => {
  // Это страж исходника Rust, не симуляция Win32: реальные координаты монитора здесь недоступны.
  checkOffsets();
});
it('R233 потеря масштаба отступа одного края или clamp обнаруживается даже с правильным комментарием', () => {
  const cases = [
    ['const DELTA_Y: f64 = 7.0;', 'const DELTA_Y: f64 = 0.0;', 'R233-offset:', '0.0', '7.0'],
    ['(DELTA_Y * scale).round() as i32', 'DELTA_Y.round() as i32', 'R233-scale:', 'DELTA_Y.round()asi32', '(DELTA_Y*scale).round()asi32'],
    ['ay + dy', 'ay', 'R233-y:', '(iftop{ay}else{ay+ah-ph-dy}).max(ay)', '(iftop{ay+dy}else{ay+ah-ph-dy}).max(ay)'],
    ['ay + ah - ph - dy', 'ay + ah - ph', 'R233-y:', '(iftop{ay+dy}else{ay+ah-ph}).max(ay)', '(iftop{ay+dy}else{ay+ah-ph-dy}).max(ay)'],
    ['}).max(ay)', '})', 'R233-y:', '(iftop{ay+dy}else{ay+ah-ph-dy})', '(iftop{ay+dy}else{ay+ah-ph-dy}).max(ay)'],
    ['}).max(ax)', '})', 'R233-x:', '(ifleft{ax+dx}else{ax+aw-pw-dx})', '(ifleft{ax+dx}else{ax+aw-pw-dx}).max(ax)'],
  ] as const;
  for (const [anchor, replacement, prefix, actual, expected] of cases) {
    checkOffsets();
    assert.throws(() => checkOffsets(replaceOnce(rust, anchor, replacement) + `\n// ${anchor}`), exactFailure(prefix, actual, expected));
  }
});

const placeAnchor = '#[cfg(target_os = "windows")]\nfn place(';
const retryCall = 'let _ = SetWindowPos(hwnd, Some(HWND_TOPMOST), x, y, w, h, SWP_NOACTIVATE);';
const rectCondition = 'GetWindowRect(hwnd, &mut r).is_ok() && (r.left != x || r.top != y || r.right - r.left != w || r.bottom - r.top != h)';
function checkRectRetry(raw = rust) {
  const body = rustBody(rustCode(raw), placeAnchor);
  const calls = [...body.matchAll(/SetWindowPos\([^;]+\);/g)];
  assert.equal(calls.length, 2, 'R233-retry-count: Windows ставит прямоугольник второй раз');
  assert.equal(compact(calls[0][0]), 'SetWindowPos(hwnd,Some(HWND_TOPMOST),x,y,w,h,SWP_NOACTIVATE|SWP_SHOWWINDOW);',
    'R233-first-show: первый показ не активирует окно');
  assert.equal(compact(calls[1][0]), 'SetWindowPos(hwnd,Some(HWND_TOPMOST),x,y,w,h,SWP_NOACTIVATE);',
    'R233-retry-flags: повтор не активирует и не показывает окно заново');
  const condition = body.match(/if (GetWindowRect[^{}]+)\{/);
  assert.equal(compact(condition?.[1] ?? ''), compact(rectCondition), 'R233-retry-condition: только успешное чтение и несовпадение любой стороны');
  const retry = rustBody(body, 'if GetWindowRect');
  assert.equal(compact(retry).includes(compact(retryCall)), true, 'R233-retry-scope: повтор внутри проверки фактического прямоугольника');
  assert.equal((calls[0].index ?? Infinity) < body.indexOf('if GetWindowRect') &&
    (calls[1].index ?? -1) > body.indexOf('if GetWindowRect'), true, 'R233-retry-order: чтение прямоугольника между постановками');
  assert.equal(/\.show\s*\(/.test(body), false, 'R233-retry-focus: Windows не пользуется активирующим show');
}
it('R233 Windows после первого показа читает настоящий прямоугольник и исправляет его без активации только при несовпадении', () => {
  checkRectRetry();
});
it('R233 потеря повторной постановки её охраны порядка или безопасных флагов обнаруживается по точной причине', () => {
  const cases: [string, string, string, unknown, unknown][] = [
    [retryCall, '', 'R233-retry-count:', 1, 2],
    [retryCall, retryCall.replace('SWP_NOACTIVATE', 'SWP_SHOWWINDOW'), 'R233-retry-flags:',
      'SetWindowPos(hwnd,Some(HWND_TOPMOST),x,y,w,h,SWP_SHOWWINDOW);', 'SetWindowPos(hwnd,Some(HWND_TOPMOST),x,y,w,h,SWP_NOACTIVATE);'],
    [retryCall, retryCall.replace('SWP_NOACTIVATE', 'SWP_NOACTIVATE | SWP_SHOWWINDOW'), 'R233-retry-flags:',
      'SetWindowPos(hwnd,Some(HWND_TOPMOST),x,y,w,h,SWP_NOACTIVATE|SWP_SHOWWINDOW);', 'SetWindowPos(hwnd,Some(HWND_TOPMOST),x,y,w,h,SWP_NOACTIVATE);'],
    [rectCondition, rectCondition.replace('.is_ok()', '.is_err()'), 'R233-retry-condition:',
      compact(rectCondition.replace('.is_ok()', '.is_err()')), compact(rectCondition)],
    [rectCondition, rectCondition.replace(' || r.bottom - r.top != h', ''), 'R233-retry-condition:',
      compact(rectCondition.replace(' || r.bottom - r.top != h', '')), compact(rectCondition)],
    [`if ${rectCondition} {\n            ${retryCall}\n        }`, `${retryCall}\n        if ${rectCondition} {}`, 'R233-retry-scope:', false, true],
    [retryCall, `${retryCall}\n            let _ = win.show();`, 'R233-retry-focus:', true, false],
  ];
  for (const [anchor, replacement, prefix, actual, expected] of cases) {
    checkRectRetry();
    assert.throws(() => checkRectRetry(replaceOnce(rust, anchor, replacement)), exactFailure(prefix, actual, expected));
  }
});

function checkNotifyStorage(raw = main) {
  const file = ts.createSourceFile('main.tsx', raw, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  const branches: ts.IfStatement[] = [];
  for (const statement of file.statements) {
    let node: ts.Statement | undefined = statement;
    // Только живая цепочка верхнего уровня: похожая ветка внутри мёртвой функции не считается.
    while (node && ts.isIfStatement(node)) {
      const condition = node.expression;
      if (ts.isBinaryExpression(condition) && ts.isIdentifier(condition.left) && condition.left.text === 'gvWindow' &&
        condition.operatorToken.kind === ts.SyntaxKind.EqualsEqualsEqualsToken &&
        ts.isStringLiteral(condition.right) && condition.right.text === 'notify') branches.push(node);
      node = node.elseStatement;
    }
  }
  assert.equal(branches.length, 1, 'R233-notify-branch: одна живая ветка окна уведомлений');
  const branch = branches[0].thenStatement;
  assert.ok(ts.isBlock(branch));
  const listeners = branch.statements.filter(ts.isExpressionStatement).map(node => node.expression).filter(ts.isCallExpression)
    .filter(call => ts.isPropertyAccessExpression(call.expression) && ts.isIdentifier(call.expression.expression) &&
      call.expression.expression.text === 'window' && call.expression.name.text === 'addEventListener' &&
      ts.isStringLiteral(call.arguments[0]) && call.arguments[0].text === 'storage');
  assert.equal(listeners.length, 1, 'R233-storage-listener: storage слушается внутри окна notify');
  const callback = listeners[0].arguments[1];
  assert.ok(callback && (ts.isArrowFunction(callback) || ts.isFunctionExpression(callback)) && ts.isBlock(callback.body));
  assert.equal(callback.parameters.length, 1);
  const parameter = callback.parameters[0].name;
  assert.ok(ts.isIdentifier(parameter));
  for (const [key, apply, get] of [['gv_theme', 'applyTheme', 'getTheme'], ['gv_ui_scale', 'applyUiScale', 'getUiScale']]) {
    const expectedCondition = `${parameter.text}.key===null||${parameter.text}.key==='${key}'`;
    const conditions: ts.IfStatement[] = callback.body.statements.filter(ts.isIfStatement).filter(node => compact(node.expression.getText(file)) === expectedCondition);
    assert.equal(conditions.length, 1, `R233-storage-key: ${key} обновляется также при очистке хранилища`);
    const action = conditions[0].thenStatement;
    const expressions: readonly ts.Statement[] = ts.isBlock(action) ? action.statements : [action];
    const calls = expressions.filter((node): node is ts.ExpressionStatement => ts.isExpressionStatement(node)).map(node => node.expression).filter(ts.isCallExpression)
      .filter(call => ts.isIdentifier(call.expression) && call.expression.text === apply && call.arguments.length === 1 &&
        ts.isCallExpression(call.arguments[0]) && ts.isIdentifier(call.arguments[0].expression) &&
        call.arguments[0].expression.text === get && call.arguments[0].arguments.length === 0);
    assert.equal(calls.length, 1, `R233-storage-call: ${apply} читает актуальную настройку внутри storage`);
  }
}
it('R233 окно notify по storage обновляет тему и масштаб из свежих настроек, включая очистку localStorage', () => {
  checkNotifyStorage();
});
it('R233 комментарий внешний или мёртвый вызов не заменяют обновление темы и масштаба внутри storage окна notify', () => {
  for (const [apply, get] of [['applyTheme', 'getTheme'], ['applyUiScale', 'getUiScale']]) {
    const anchor = `${apply}(${get}());`;
    // Стартовый applyTheme тоже есть в файле: уникально адресуем строку callback с его ключом.
    const line = `    if (e.key === null || e.key === '${apply === 'applyTheme' ? 'gv_theme' : 'gv_ui_scale'}') ${anchor}`;
    for (const replacement of [line.replace(anchor, `/* ${anchor} */ {}`), line.replace(anchor, `{ function unused() { ${anchor} } }`)]) {
      checkNotifyStorage();
      assert.throws(() => checkNotifyStorage(replaceOnce(main, line, replacement) + `\n${anchor}`),
        exactFailure(`R233-storage-call: ${apply}`, 0, 1));
    }
  }
  checkNotifyStorage();
  assert.throws(() => checkNotifyStorage(replaceOnce(main, "window.addEventListener('storage', (e) => {", "window.addEventListener('resize', (e) => {")),
    exactFailure('R233-storage-listener:', 0, 1));
  for (const key of ['gv_theme', 'gv_ui_scale']) {
    const anchor = `e.key === null || e.key === '${key}'`;
    checkNotifyStorage();
    assert.throws(() => checkNotifyStorage(replaceOnce(main, anchor, `e.key === '${key}'`)),
      exactFailure(`R233-storage-key: ${key}`, 0, 1));
  }
});
