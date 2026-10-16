import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { describe, it } from 'node:test';
import ts from 'typescript';

const root = new URL('../../../../', import.meta.url);
const android = 'apps/desktop/src-tauri/gen/android/app/src/main/';
const kotlin = `${android}java/tech/gusik/gusvoice/`;
const read = (path: string) => readFileSync(new URL(path, root), 'utf8').replace(/\r\n/g, '\n');
const appSource = () => read('apps/client/src/App.tsx');
const settingsSource = () => read('apps/client/src/components/DataStorageSettings.tsx');
const mainSource = () => read(`${kotlin}MainActivity.kt`);
const callSource = () => read(`${kotlin}CallAudio.kt`);
const earSource = () => read(`${kotlin}RaiseToEar.kt`);
function replaceOne(raw: string, from: string, to: string) {
  assert.equal(raw.split(from).length - 1, 1, 'единственный адресный якорь');
  return raw.replace(from, to);
}
function killed(check: () => void, message: string, actual: unknown, expected: unknown) {
  assert.throws(check, (e: unknown) => e instanceof assert.AssertionError && e.message.startsWith(message)
    && e.operator === 'strictEqual' && Object.is(e.actual, actual) && Object.is(e.expected, expected));
}

function all<T extends ts.Node>(node: ts.Node, predicate: (n: ts.Node) => n is T): T[] {
  const found: T[] = [];
  function walk(n: ts.Node) { if (predicate(n)) found.push(n); ts.forEachChild(n, walk); }
  walk(node); return found;
}
function jsxTags(expression: ts.Node): string[] {
  const names: string[] = [];
  function walk(n: ts.Node) {
    if (ts.isArrowFunction(n) || ts.isFunctionExpression(n) || ts.isFunctionDeclaration(n)) return;
    if ((ts.isJsxSelfClosingElement(n) || ts.isJsxOpeningElement(n)) && ts.isIdentifier(n.tagName)) names.push(n.tagName.text);
    ts.forEachChild(n, walk);
  }
  walk(expression); return names;
}
function rendered(raw: string, entry: string, imported: string, modulePath: string): number {
  const file = ts.createSourceFile('actual.tsx', raw, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  const bindings = file.statements.flatMap(statement => {
    if (!ts.isImportDeclaration(statement) || !ts.isStringLiteral(statement.moduleSpecifier) || statement.moduleSpecifier.text !== modulePath
      || statement.importClause?.isTypeOnly || !statement.importClause?.namedBindings || !ts.isNamedImports(statement.importClause.namedBindings)) return [];
    return statement.importClause.namedBindings.elements.filter(binding => !binding.isTypeOnly && (binding.propertyName ?? binding.name).text === imported).map(binding => binding.name.text);
  });
  assert.equal(bindings.length, 1, `${imported} импортируется для исполнения из своего модуля`);
  const functions = new Map(file.statements.filter(ts.isFunctionDeclaration).filter(n => n.name && n.body).map(n => [n.name!.text, n]));
  assert.equal(functions.has(entry), true, `${entry} — настоящий компонент этого файла`);
  const visit = (name: string, stack: ReadonlySet<string>): number => {
    if (stack.has(name)) return 0;
    const fn = functions.get(name); if (!fn?.body) return 0;
    const next = new Set([...stack, name]);
    return fn.body.statements.filter(ts.isReturnStatement).flatMap(r => r.expression ? jsxTags(r.expression) : [])
      .reduce((count, tag) => count + (tag === bindings[0] ? 1 : visit(tag, next)), 0);
  };
  return visit(entry, new Set());
}
function appGuard(raw: string) {
  assert.equal(rendered(raw, 'App', 'RaiseToEarHost', './components/RaiseToEarHost'), 1, 'App действительно монтирует один RaiseToEarHost');
}
function settingGuard(raw: string) {
  assert.equal(rendered(raw, 'DataStorageSettings', 'RaiseToEarSetting', './RaiseToEarSetting'), 1, 'настройка достижима из DataStorageSettings');
}
function removeJsx(raw: string, tag: string) {
  const file = ts.createSourceFile('actual.tsx', raw, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  const found = all(file, ts.isJsxSelfClosingElement).filter(n => ts.isIdentifier(n.tagName) && n.tagName.text === tag);
  assert.equal(found.length, 1, `единственный настоящий JSX ${tag}`);
  return raw.slice(0, found[0].getStart(file)) + raw.slice(found[0].end);
}

// Лексическая проверка всего Kotlin-файла: комментарии, строки и ${...} не служат доказательством объявления/вызова.
// Kotlin не компилируется и не исполняется; токены нужны только для границ классов, методов и инициализаторов.
type Token = { text: string; start: number; end: number };
function tokens(raw: string): Token[] {
  const out: Token[] = [];
  const comment = (start: number): number => {
    if (raw.startsWith('//', start)) { const end = raw.indexOf('\n', start + 2); return end < 0 ? raw.length : end; }
    let i = start + 2, depth = 1;
    while (i < raw.length && depth) {
      if (raw.startsWith('/*', i)) { depth++; i += 2; }
      else if (raw.startsWith('*/', i)) { depth--; i += 2; }
      else i++;
    }
    assert.equal(depth, 0, 'закрытый комментарий Kotlin'); return i;
  };
  const quoted = (start: number): number => {
    if (raw.startsWith('"""', start)) { const end = raw.indexOf('"""', start + 3); assert.ok(end >= 0); return end + 3; }
    const quote = raw[start]; let i = start + 1;
    while (i < raw.length) {
      if (raw[i] === '\\') { i += 2; continue; }
      if (quote === '"' && raw.startsWith('${', i)) {
        let depth = 1; i += 2;
        while (i < raw.length && depth) {
          if (raw.startsWith('//', i) || raw.startsWith('/*', i)) i = comment(i);
          else if (raw[i] === '"' || raw[i] === "'") i = quoted(i);
          else { if (raw[i] === '{') depth++; else if (raw[i] === '}') depth--; i++; }
        }
        assert.equal(depth, 0, 'закрытая интерполяция Kotlin'); continue;
      }
      if (raw[i] === quote) return i + 1;
      i++;
    }
    assert.fail('незакрытая строка Kotlin');
  };
  for (let i = 0; i < raw.length;) {
    if (/\s/.test(raw[i])) { i++; continue; }
    if (raw.startsWith('//', i) || raw.startsWith('/*', i)) { i = comment(i); continue; }
    if (raw[i] === '"' || raw[i] === "'") { i = quoted(i); continue; }
    const word = /^[A-Za-z_][A-Za-z0-9_]*/.exec(raw.slice(i))?.[0];
    const number = /^\d[\d_]*(?:\.[\d_]+)?[Lf]?/.exec(raw.slice(i))?.[0];
    const pair = ['>=', '<=', '==', '!=', '&&', '||', '->', '?.', '?:'].find(p => raw.startsWith(p, i));
    const text = word ?? number ?? pair ?? raw[i]; out.push({ text, start: i, end: i + text.length }); i += text.length;
  }
  return out;
}
type Range = { open: number; close: number };
function parsed(raw: string) {
  const list = tokens(raw), pairs = new Map<number, number>(), stack: number[] = [];
  const closeFor: Record<string, string> = { '(': ')', '{': '}', '[': ']' };
  list.forEach((t, i) => {
    if (Object.hasOwn(closeFor, t.text)) stack.push(i);
    else if ([')', '}', ']'].includes(t.text)) {
      const start = stack.pop(); assert.notEqual(start, undefined, 'Kotlin скобки имеют начало');
      assert.equal(closeFor[list[start!].text], t.text, 'Kotlin скобки совпадают'); pairs.set(start!, i);
    }
  });
  assert.equal(stack.length, 0, 'Kotlin скобки закрыты'); return { list, pairs };
}
type Parsed = ReturnType<typeof parsed>;
function sequence(p: Parsed, values: readonly string[], range: Range = { open: -1, close: p.list.length }): number[] {
  return p.list.flatMap((_t, i) => i > range.open && i + values.length <= range.close
    && values.every((value, j) => p.list[i + j].text === value) ? [i] : []);
}
function block(p: Parsed, kind: 'class' | 'fun', name: string): Range {
  const found = sequence(p, [kind, name]); assert.equal(found.length, 1, `один Kotlin ${kind} ${name}`);
  const open = p.list.findIndex((t, i) => i > found[0] && t.text === '{');
  assert.ok(open >= 0 && p.pairs.has(open), `блок ${name} существует`); return { open, close: p.pairs.get(open)! };
}
function field(p: Parsed, range: Range, name: string): number | undefined {
  let depth = 0;
  for (let i = range.open + 1; i < range.close; i++) {
    const text = p.list[i].text;
    if (depth === 0 && (text === 'val' || text === 'var') && p.list[i + 1]?.text === name) return i;
    if (text === '{') depth++; else if (text === '}') depth--;
  }
  return undefined;
}
function initializer(p: Parsed, range: Range, name: string): { marker: string; index: number } | null {
  const start = field(p, range, name); if (start === undefined) return null;
  for (let i = start + 2; i < range.close; i++) {
    if (['=', 'by'].includes(p.list[i].text)) return { marker: p.list[i].text, index: i + 1 };
    if (['{', 'val', 'var', 'fun'].includes(p.list[i].text)) return null;
  }
  return null;
}
function lazy(p: Parsed, range: Range, name: string) {
  const init = initializer(p, range, name); return !!init && p.list[init.index]?.text === 'lazy' && p.list[init.index + 1]?.text === '{';
}
function lazyBody(p: Parsed, range: Range, name: string): Range {
  const init = initializer(p, range, name); assert.ok(init && p.list[init.index + 1]?.text === '{');
  const open = init.index + 1; assert.ok(p.pairs.has(open)); return { open, close: p.pairs.get(open)! };
}
function activityLazyGuard(raw: string) {
  const p = parsed(raw), activity = block(p, 'class', 'MainActivity');
  for (const name of ['callAudioLazy', 'raiseToEarLazy']) assert.equal(lazy(p, activity, name), true, `${name} создаётся отложенно, не при конструировании Activity`);
  assert.equal(initializer(p, activity, 'callAudio')?.index !== undefined && p.list[initializer(p, activity, 'callAudio')!.index].text === 'callAudioLazy', true);
  assert.equal(initializer(p, activity, 'raiseToEar')?.index !== undefined && p.list[initializer(p, activity, 'raiseToEar')!.index].text === 'raiseToEarLazy', true);
}
function earLazyGuard(raw: string) {
  const p = parsed(raw), ear = block(p, 'class', 'RaiseToEar');
  for (const name of ['app', 'sensors', 'am', 'proximity', 'accelerometer', 'wakeLock']) assert.equal(lazy(p, ear, name), true, `RaiseToEar.${name} обращается к контексту только лениво`);
}
function constant(p: Parsed, name: string): string | null {
  const matches = sequence(p, ['const', 'val', name, '=']); assert.equal(matches.length, 1, `константа ${name} объявлена один раз`);
  return p.list[matches[0] + 4]?.text ?? null;
}
function forceGuard(raw: string) { assert.equal(constant(parsed(raw), 'FORCE_COMM_MODE'), 'false', 'обычный звонок не навязывает MODE_IN_COMMUNICATION'); }
function permissionGuard(raw: string) {
  const live = raw.replace(/<!--[\s\S]*?-->/g, '');
  const permissions = [...live.matchAll(/<uses-permission\b[^>]*\bandroid:name\s*=\s*["']([^"']+)["'][^>]*\/?\s*>/g)].map(m => m[1]);
  assert.equal(permissions.includes('android.permission.WAKE_LOCK'), true, 'WAKE_LOCK объявлен настоящим разрешением манифеста');
}
function apiGate(p: Parsed, call: number, within: Range) {
  return sequence(p, ['if', '(', 'Build', '.', 'VERSION', '.', 'SDK_INT', '>=', 'Build', '.', 'VERSION_CODES', '.', 'S', ')', '{'], within)
    .some(start => { const open = start + 14; return call > open && call < p.pairs.get(open)!; });
}
function listenerGuard(raw: string) {
  const p = parsed(raw), api = block(p, 'class', 'Api31');
  const listeners = sequence(p, ['AudioManager', '.', 'OnCommunicationDeviceChangedListener', '{']);
  assert.equal(listeners.length, 1, 'слушатель смены устройства реально создаётся');
  assert.equal(listeners.every(i => i > api.open && i < api.close), true, 'слушатель создаётся только внутри Api31');
  assert.equal(sequence(p, ['@', 'RequiresApi', '(', 'Build', '.', 'VERSION_CODES', '.', 'S', ')', 'private', 'inner', 'class', 'Api31']).length, 1);
  for (const [method, call] of [['start', 'addOnCommunicationDeviceChangedListener'], ['stop', 'removeOnCommunicationDeviceChangedListener']]) {
    const scope = block(p, 'fun', method), calls = sequence(p, ['am', '.', call, '('], scope);
    assert.equal(calls.length, 1, `${call} подключён к жизненному циклу`);
    assert.equal(apiGate(p, calls[0], scope), true, `${call} защищён Android API31`);
  }
}

describe('R216 Android: подключение и исходниковые предохранители поднесения к уху', () => {
  it('App монтирует Host, а импорт и JSX в недостижимой функции этого не заменяют', () => {
    const raw = appSource(); appGuard(raw);
    const mutant = `${removeJsx(raw, 'RaiseToEarHost')}\nfunction UnreachableEarHost() { return <RaiseToEarHost />; }\n`;
    killed(() => appGuard(mutant), 'App действительно монтирует один RaiseToEarHost', 0, 1);
  });
  it('настройка достижима через AutoDownloadPanel, удаление его JSX не прячется наличием компонента в файле', () => {
    const raw = settingsSource(); settingGuard(raw);
    killed(() => settingGuard(removeJsx(raw, 'AutoDownloadPanel')), 'настройка достижима из DataStorageSettings', 0, 1);
  });
  it('манифест даёт WAKE_LOCK, комментарий с тем же разрешением не считается', () => {
    const raw = read(`${android}AndroidManifest.xml`); permissionGuard(raw);
    const line = '<uses-permission android:name="android.permission.WAKE_LOCK" />';
    killed(() => permissionGuard(replaceOne(raw, line, `<!-- ${line} -->`)), 'WAKE_LOCK объявлен настоящим разрешением манифеста', false, true);
  });
  it('обычный звонок не включает опасный для Samsung разговорный режим принудительно', () => {
    const raw = callSource(); forceGuard(raw);
    killed(() => forceGuard(replaceOne(raw, 'private const val FORCE_COMM_MODE = false', 'private const val FORCE_COMM_MODE = true')),
      'обычный звонок не навязывает MODE_IN_COMMUNICATION', 'true', 'false');
  });
  it('переутверждение вывода ограничено положительными числом и окном, пределы реально используются', () => {
    const p = parsed(callSource()), verify = block(p, 'fun', 'verifyRoute');
    for (const name of ['REASSERT_MAX', 'REASSERT_WINDOW_MS']) {
      assert.equal(Number(constant(p, name)?.replace(/_/g, '').replace(/L$/, '')) > 0, true, `${name} положителен`);
      assert.equal(sequence(p, [name], verify).length > 0, true, `${name} участвует в проверке маршрута`);
    }
  });
  it('слушатель выбора изолирован в Api31, его регистрация и снятие не вызываются на старом Android', () => {
    const raw = callSource(); listenerGuard(raw);
    const p = parsed(raw), start = block(p, 'fun', 'start');
    const text = raw.slice(p.list[start.open].start, p.list[start.close].end);
    const changed = replaceOne(text, 'if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) {', 'if (true) {');
    const mutant = raw.slice(0, p.list[start.open].start) + changed + raw.slice(p.list[start.close].end);
    killed(() => listenerGuard(mutant), 'addOnCommunicationDeviceChangedListener защищён Android API31', false, true);
  });
  it('в NativeBridge три метода имеют JavascriptInterface, нужные параметры и делегируют реальным сервисам', () => {
    const p = parsed(mainSource()), bridge = block(p, 'class', 'NativeBridge');
    for (const [name, params] of [['raiseToEarSupported', []], ['raiseToEarSet', ['on', ':', 'Boolean']], ['callAudioSetCommMode', ['on', ':', 'Boolean']]] as const) {
      const at = sequence(p, ['fun', name, '('], bridge); assert.equal(at.length, 1, `${name} объявлен в NativeBridge`);
      assert.equal(p.list[at[0] - 2]?.text === '@' && p.list[at[0] - 1]?.text === 'JavascriptInterface', true, `${name} доступен JavaScript`);
      const end = p.pairs.get(at[0] + 2)!; assert.deepEqual(p.list.slice(at[0] + 3, end).map(t => t.text), [...params]);
    }
    assert.equal(sequence(p, ['fun', 'raiseToEarSupported', '(', ')', ':', 'Boolean', '=', 'raiseToEar', '.', 'supported', '(', ')'], bridge).length, 1);
    assert.equal(sequence(p, ['raiseToEar', '.', 'enable', '(', 'on', ')'], bridge).length, 1);
    assert.equal(sequence(p, ['callAudio', '.', 'commMode', '=', 'on'], bridge).length, 1);
  });
  it('Activity создаёт CallAudio и RaiseToEar лениво, lazyOf с уже созданным объектом не подходит', () => {
    const raw = mainSource(); activityLazyGuard(raw);
    for (const name of ['callAudioLazy', 'raiseToEarLazy']) {
      const p = parsed(raw), range = lazyBody(p, block(p, 'class', 'MainActivity'), name), fieldAt = field(p, block(p, 'class', 'MainActivity'), name)!;
      const text = raw.slice(p.list[fieldAt].start, p.list[range.close].end);
      const eager = replaceOne(text, '= lazy {', '= lazyOf(run {') + ')';
      const mutant = raw.slice(0, p.list[fieldAt].start) + eager + raw.slice(p.list[range.close].end);
      killed(() => activityLazyGuard(mutant), `${name} создаётся отложенно, не при конструировании Activity`, false, true);
    }
  });
  it('закрытие Activity не создаёт ни один сервис ради очистки', () => {
    const p = parsed(mainSource()), scope = block(p, 'fun', 'onDestroy');
    for (const [lazyName, service, call] of [['callAudioLazy', 'callAudio', 'stop'], ['raiseToEarLazy', 'raiseToEar', 'shutdown']])
      assert.equal(sequence(p, ['if', '(', lazyName, '.', 'isInitialized', '(', ')', ')', service, '.', call, '(', ')'], scope).length, 1);
  });
  it('контекст, датчики, AudioManager и wakeLock в RaiseToEar доступны только через lazy', () => {
    const raw = earSource(); earLazyGuard(raw);
    killed(() => earLazyGuard(replaceOne(raw, 'private val app: Context by lazy {', 'private val app: Context = run {')),
      'RaiseToEar.app обращается к контексту только лениво', false, true);
  });
  it('wakeLock гасит экран по приближению только при поддержке нужного уровня, не подменяется обычным замком', () => {
    const guard = (raw: string) => {
      const p = parsed(raw), scope = lazyBody(p, block(p, 'class', 'RaiseToEar'), 'wakeLock');
      assert.equal(sequence(p, ['pm', '.', 'isWakeLockLevelSupported', '(', 'PowerManager', '.', 'PROXIMITY_SCREEN_OFF_WAKE_LOCK', ')'], scope).length, 1,
        'уровень proximity screen-off проверяется до создания замка');
      assert.equal(sequence(p, ['pm', '.', 'newWakeLock', '(', 'PowerManager', '.', 'PROXIMITY_SCREEN_OFF_WAKE_LOCK', ','], scope).length, 1,
        'создаётся именно proximity screen-off замок');
    };
    const raw = earSource(); guard(raw);
    killed(() => guard(replaceOne(raw, 'pm.newWakeLock(PowerManager.PROXIMITY_SCREEN_OFF_WAKE_LOCK,', 'pm.newWakeLock(PowerManager.PARTIAL_WAKE_LOCK,')),
      'создаётся именно proximity screen-off замок', 0, 1);
  });
});
