import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { describe, it } from 'node:test';
import ts from 'typescript';

const android = '../../desktop/src-tauri/gen/android/app/src/main/';
const main = readFileSync(new URL(`${android}java/tech/gusik/gusvoice/MainActivity.kt`, import.meta.url), 'utf8').replace(/\r\n/g, '\n');
const manifest = readFileSync(new URL(`${android}AndroidManifest.xml`, import.meta.url), 'utf8');
const sidebar = readFileSync(new URL('./components/DmSidebar.tsx', import.meta.url), 'utf8');

// Страж Kotlin, не эмуляция Android: строки сохраняются, комментарии не могут заменить вызов.
function code(source: string): string {
  return source.replace(/"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'|\/\*[\s\S]*?\*\/|\/\/[^\r\n]*/g,
    token => token.startsWith('/') ? ' ' : token);
}

function body(source: string, name: string): string {
  const clean = code(source);
  const match = new RegExp(`\\bfun\\s+${name}\\s*\\([^)]*\\)[^{]*\\{`).exec(clean);
  assert.ok(match, `найдена функция ${name}`);
  const start = match.index + match[0].length;
  const tokens = /"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'|[{}]/g;
  tokens.lastIndex = start;
  let depth = 1;
  for (let token = tokens.exec(clean); token; token = tokens.exec(clean)) {
    if (token[0] === '{') depth++;
    if (token[0] === '}' && --depth === 0) return clean.slice(start, token.index);
  }
  assert.fail(`закрыт блок ${name}`);
}

function rejects(source: string, target: string, replacement: string, check: (value: string) => void): void {
  check(source);
  assert.equal(source.split(target).length - 1, 1, 'контрфакт изменяет ровно одно место');
  assert.throws(() => check(source.replace(target, replacement)), assert.AssertionError);
}

function searchHandler(source: string): { call: ts.CallExpression; file: ts.SourceFile } {
  const file = ts.createSourceFile('DmSidebar.tsx', source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  const found: ts.CallExpression[] = [];
  const visit = (node: ts.Node): void => {
    if (ts.isCallExpression(node) && ts.isIdentifier(node.expression) && node.expression.text === 'pushBackHandler') {
      const fn = node.arguments[0];
      if (fn && ts.isArrowFunction(fn)) {
        let clearsQuery = false;
        const findClear = (child: ts.Node): void => {
          if (ts.isCallExpression(child) && ts.isIdentifier(child.expression) && child.expression.text === 'setQuery') clearsQuery = true;
          ts.forEachChild(child, findClear);
        };
        findClear(fn.body);
        if (clearsQuery) found.push(node);
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(file);
  assert.equal(found.length, 1, 'найден именно обработчик поиска, а не архива/выбора');
  return { call: found[0]!, file };
}

describe('R121 нативная предиктивная «назад»: страж договора с клиентом', () => {
  it('начало и ход передают свою фазу, прогресс, край и высоту пальца в CSS-пикселях', () => {
    // Потерянная фаза оставит экран неподвижным до отпускания пальца.
    const check = (source: string) => {
      for (const [method, phase] of [['handleOnBackStarted', 'start'], ['handleOnBackProgressed', 'progress']]) {
        const fn = body(source, method!);
        assert.match(fn, /if\s*\(Build\.VERSION\.SDK_INT < 34 \|\| textActionMode != null\) return/);
        assert.ok(fn.includes(`sendBackGesture("${phase}", backEvent)`));
      }
      const send = body(source, 'sendBackGesture');
      assert.match(send, /val y = e\.touchY \/ resources\.displayMetrics\.density/);
      assert.ok(send.includes("window.__gvBackGesture('$phase', ${e.progress}, ${e.swipeEdge}, $y)"));
    };
    rejects(main, 'sendBackGesture("start", backEvent)', '', check);
    rejects(main, 'sendBackGesture("progress", backEvent)', 'sendBackGesture("start", backEvent)', check);
    rejects(main, 'e.touchY / resources.displayMetrics.density', 'e.touchY', check);
  });

  it('отмена отправляет cancel, а отпускание сохраняет прежний __gvBack()', () => {
    // Отмена не должна закрывать беседу; отпускание не должно потерять обычную кнопку «назад».
    const check = (source: string) => {
      const cancel = body(source, 'handleOnBackCancelled');
      assert.match(cancel, /if \(Build\.VERSION\.SDK_INT < 34\) return/);
      assert.ok(cancel.includes("window.__gvBackGesture('cancel', 0, 0, 0)"));
      assert.ok(!cancel.includes('window.__gvBack()'));
      const pressed = body(source, 'handleOnBackPressed');
      assert.ok(pressed.includes('window.__gvBack && window.__gvBack()'));
      assert.match(pressed, /textActionMode\?\.let\s*\{\s*it\.finish\(\)\s*return/);
    };
    rejects(main, "window.__gvBackGesture('cancel', 0, 0, 0)", 'window.__gvBack()', check);
    rejects(main, 'window.__gvBack && window.__gvBack()', 'window.__gvBackGesture()', check);
  });

  it('после создания WebView post поднимает свой callback выше позднего обработчика Tauri', () => {
    // Прямой вызов до завершения загрузки плагинов снова отдаст прогресс чужому callback.
    const check = (source: string) => {
      const create = body(source, 'onWebViewCreate');
      assert.match(create, /webViewRef = webView\s*webView\.post\s*\{\s*raiseBackCallback\(\)\s*\}/);
      const raise = body(source, 'raiseBackCallback');
      assert.match(raise, /^\s*if \(Build\.VERSION\.SDK_INT < 34\) return\s*val cb = backCallback \?: return\s*cb\.remove\(\)\s*onBackPressedDispatcher\.addCallback\(this, cb\)\s*$/);
    };
    rejects(main, 'webView.post { raiseBackCallback() }', '', check);
    rejects(main, 'webView.post { raiseBackCallback() }', 'raiseBackCallback()', check);
    rejects(main, 'if (Build.VERSION.SDK_INT < 34) return\n    val cb', 'if (Build.VERSION.SDK_INT <= 34) return\n    val cb', check);
  });

  it('предиктивная доставка разрешена только MainActivity, не всему application', () => {
    // Атрибут application меняет договор других активностей, а не только WebView.
    const check = (source: string) => {
      const xml = source.replace(/<!--[\s\S]*?-->/g, '');
      const app = /<application\b[^>]*>/.exec(xml)?.[0];
      assert.ok(app);
      assert.ok(!app.includes('android:enableOnBackInvokedCallback'));
      const activities = xml.match(/<activity\b[^>]*>/g) ?? [];
      const activity = activities.find(tag => /android:name="\.MainActivity"/.test(tag));
      assert.ok(activity);
      assert.match(activity, /android:enableOnBackInvokedCallback="true"/);
    };
    check(manifest);
    const attribute = 'android:enableOnBackInvokedCallback="true"';
    rejects(manifest, attribute, '', check);
    const moved = manifest.replace(attribute, '').replace('<application', `<application ${attribute}`);
    assert.throws(() => check(moved), assert.AssertionError);
  });

  it('поиск сообщает peek без сброса запроса: скрытый поиск не блокирует выход из беседы', () => {
    // Проверяем AST нужного обработчика: наличие слова peek в комментарии недостаточно.
    const check = (source: string) => {
      const { call, file } = searchHandler(source);
      assert.equal(call.arguments.length, 2);
      const peek = call.arguments[1]!;
      assert.ok(ts.isArrowFunction(peek) && ts.isBlock(peek.body));
      const statements = peek.body.statements;
      assert.equal(statements.length, 2, 'peek только читает состояние и возвращает вердикт');
      assert.ok(ts.isVariableStatement(statements[0]!));
      assert.match(statements[0]!.getText(file), /const st = useStore\.getState\(\)/);
      assert.ok(ts.isReturnStatement(statements[1]!));
      const returned = statements[1]!.expression?.getText(file).replace(/\s+/g, '');
      assert.equal(returned, "!(st.mobilePane==='content'||st.settingsOpen||st.adminOpen||st.mobileProfileOpen)");
    };
    check(sidebar);
    const { call, file } = searchHandler(sidebar);
    const peek = call.arguments[1]!;
    const removed = sidebar.slice(0, call.arguments[0]!.end) + sidebar.slice(peek.end);
    assert.throws(() => check(removed), assert.AssertionError, 'обработчик без peek краснит страж');
    const changed = sidebar.slice(0, peek.getStart(file)) + '() => true' + sidebar.slice(peek.end);
    assert.throws(() => check(changed), assert.AssertionError, 'безусловное поглощение назад краснит страж');
  });
});
