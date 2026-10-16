import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { it } from 'node:test';

const android = '../../desktop/src-tauri/gen/android/app/src/main/java/tech/gusik/gusvoice/';
const read = (name: string) => readFileSync(new URL(`${android}${name}.kt`, import.meta.url), 'utf8').replace(/\r\n/g, '\n');
const keyboard = read('KeyboardContent'), media = read('MediaBridge'), activity = read('MainActivity');
const config = readFileSync(new URL('../../desktop/src-tauri/.cargo/config.toml', import.meta.url), 'utf8').replace(/\r\n/g, '\n');
// Стражи настоящего Kotlin/конфигурации, не JS-имитация исполнения Android.
function code(raw: string) {
  return raw.replace(/"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'|\/\*[\s\S]*?\*\/|\/\/[^\r\n]*/g, t => t.startsWith('/') ? ' ' : t);
}
function body(raw: string, name: string) {
  const clean = code(raw), start = new RegExp(`\\bfun\\s+${name}\\s*\\([^)]*\\)[^{]*\\{`).exec(clean);
  assert.ok(start, `настоящий метод ${name}`);
  const offset = start.index + start[0].length, tokens = /"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'|[{}]/g;
  tokens.lastIndex = offset; let depth = 1;
  for (let token = tokens.exec(clean); token; token = tokens.exec(clean)) {
    if (token[0] === '{') depth++;
    if (token[0] === '}' && --depth === 0) return clean.slice(offset, token.index);
  }
  assert.fail(`закрытый метод ${name}`);
}
function mutate(raw: string, from: string, to: string) { assert.equal(raw.split(from).length - 1, 1, 'единственный якорь Android-контрфакта'); return raw.replace(from, to); }
function killed(raw: string, from: string, to: string, check: (s: string) => void, prefix: string, actual: unknown, expected: unknown) {
  check(raw);
  assert.throws(() => check(mutate(raw, from, to)), e => e instanceof assert.AssertionError && e.message.startsWith(prefix)
    && e.operator === 'strictEqual' && e.actual === actual && e.expected === expected);
}
function wrapper(raw: string) {
  const wrap = body(raw, 'wrap');
  assert.equal(/if\s*\(ic == null \|\| outAttrs == null\) return ic/.test(wrap), true);
  assert.equal(/EditorInfoCompat\.setContentMimeTypes\(outAttrs, MIME_TYPES\)/.test(wrap), true, 'R218-ime-types: поле объявляет типы клавиатуре');
  assert.equal(/InputConnectionCompat\.createWrapper\([\s\S]*OnCommitContentListener\s*\{\s*info, flags, _ -> commit\(info, flags\)/.test(wrap), true);
  const commit = body(raw, 'commit');
  assert.equal(/if\s*\(!mime\.startsWith\("image\/"\)\) return false/.test(commit), true, 'R218-ime-image: не-картинки не уходят в копирование');
  assert.equal(commit.indexOf('mime.startsWith') < commit.indexOf('media.onKeyboardContent'), true);
  assert.equal(/info\.requestPermission\(\)/.test(commit), true);
  assert.equal(/media\.onKeyboardContent\(info\.contentUri, mime\)\s*\{\s*if\s*\(asked\)\s*\{\s*try\s*\{\s*info\.releasePermission\(\)/.test(commit), true);
  assert.equal(/val MIME_TYPES\s*=\s*arrayOf\([^)]*"image\/\*"/.test(code(raw)), true);
}
it('R218 Android объявляет картинки, оборачивает InputConnection и держит URI permission до конца копирования', () => wrapper(keyboard));
it('R218 Android контрфакт исчезновение объявления MIME не маскируется комментарием', () => killed(keyboard,
  'EditorInfoCompat.setContentMimeTypes(outAttrs, MIME_TYPES)', '// EditorInfoCompat.setContentMimeTypes(outAttrs, MIME_TYPES)', wrapper, 'R218-ime-types:', false, true));
it('R218 Android контрфакт не-картинка не проходит без проверки image MIME', () => killed(keyboard,
  'if (!mime.startsWith("image/")) return false', '', wrapper, 'R218-ime-image:', false, true));
function copying(raw: string) {
  const b = body(raw, 'onKeyboardContent');
  assert.equal(/!ShareIntent\.accepted\(uri, activity\.packageName\)/.test(b), true);
  assert.equal(/copyShared\(uri, dir, 0, fallbackType, job, deadline, ownDirs\)/.test(b), true);
  assert.equal(/shared\s*=\s*Shared\(job\.token, "", "", files, 0\)/.test(b), true);
  assert.equal(b.includes('window.__gvKeyboardContent && window.__gvKeyboardContent()'), true, 'R218-ime-callback: картинка не открывает окно общего share');
  assert.equal(b.includes('__gvShare'), false);
  assert.equal(body(raw, 'onShareIntent').includes('__gvKeyboardContent'), false);
}
function release(raw: string) {
  const b = body(raw, 'onKeyboardContent');
  assert.equal(/if\s*\(bridgeOff \|\| !bridgeSupported\(\) \|\| !ShareIntent\.accepted\(uri, activity\.packageName\)\)\s*\{\s*release\(\)\s*return/.test(b), true,
    'R218-ime-release-reject: ранний отказ освобождает permission');
  assert.equal(/finally\s*\{\s*release\(\)\s*\}/.test(b), true, 'R218-ime-release-finally: завершение или ошибка worker освобождает permission');
  assert.equal(/catch\s*\(e: Exception\)\s*\{\s*Log\.w\(TAG, "keyboard content copy rejected", e\)\s*release\(\)/.test(b), true,
    'R218-ime-release-submit: отказ постановки worker освобождает permission');
  assert.equal([...b.matchAll(/\brelease\(\)/g)].length, 3, 'проверены все три владельца освобождения, не лишний вызов');
}
it('R218 Android копирует через общий безопасный путь, но разносит события keyboard и share', () => copying(media));
it('R218 Android URI permission освобождается при раннем отказе, в finally worker и при отказе executor', () => release(media));
it('R218 Android контрфакт keyboard ошибочно вызывает общее окно Поделиться', () => killed(media,
  'window.__gvKeyboardContent && window.__gvKeyboardContent()', 'window.__gvShare && window.__gvShare()', copying, 'R218-ime-callback:', false, true));
it('R218 Android контрфакт worker теряет finally освобождения permission', () => killed(media,
  '        } finally {\n          release()\n        }', '        } finally {}', release, 'R218-ime-release-finally:', false, true));
function extension(raw: string) {
  const clean = raw.replace(/^\s*#.*$/gm, ''), start = /^\s*\[env\]\s*$/m.exec(clean);
  assert.ok(start, 'настоящий раздел env');
  const tail = clean.slice(start.index + start[0].length), nextSection = /^\s*\[[^\r\n]+\]\s*$/m.exec(tail);
  const env = tail.slice(0, nextSection?.index ?? tail.length);
  const assigned = /^WRY_RUSTWEBVIEW_CLASS_EXTENSION\s*=\s*'''([\s\S]*?)'''/m.exec(env);
  assert.equal(!!assigned, true, 'R218-ime-env: ключ WRY присвоен именно внутри env'); assert.ok(assigned);
  const bodyText = body(assigned[1]!, 'onCreateInputConnection');
  assert.equal(/return\s+KeyboardContent\.wrap\(super\.onCreateInputConnection\(outAttrs\), outAttrs\)/.test(bodyText), true,
    'R218-ime-extension: сгенерированный WebView реально оборачивает родной InputConnection');
}
function binding(raw: string) {
  const b = body(raw, 'onWebViewCreate'), attach = b.indexOf('media.attach(webView)'), bind = b.indexOf('KeyboardContent.bind(media)');
  assert.equal(attach >= 0 && bind > attach, true, 'R218-ime-bind: клавиатура связывается с готовым media bridge');
}
it('R218 wry читает class extension из env и возвращает обёртку родного ввода', () => extension(config));
it('R218 Activity привязывает клавиатуру только после media.attach', () => binding(activity));
it('R218 контрфакт wry возвращает необёрнутый InputConnection', () => killed(config,
  'return KeyboardContent.wrap(super.onCreateInputConnection(outAttrs), outAttrs)', 'return super.onCreateInputConnection(outAttrs)', extension,
  'R218-ime-extension:', false, true));
it('R218 контрфакт отсутствующая привязка Activity не заменяется упоминанием в комментарии', () => killed(activity,
  '    KeyboardContent.bind(media)', '    // KeyboardContent.bind(media)', binding, 'R218-ime-bind:', false, true));
it('R218 контрфакт ключ WRY в другом TOML разделе не считается переменной сборки', () => killed(config,
  '[env]', '[env]\n[not_env]', extension, 'R218-ime-env:', false, true));

// R226: cargo ищет конфигурацию от рабочего каталога вверх. Проверка только src-tauri раньше была зелёной,
// хотя Android-сборка читала другую копию и APK остался без метода клавиатуры.
const desktopConfig = readFileSync(new URL('../../desktop/.cargo/config.toml', import.meta.url), 'utf8').replace(/\r\n/g, '\n');
const androidWorkflow = readFileSync(new URL('../../../.gitea/workflows/android.yaml', import.meta.url), 'utf8').replace(/\r\n/g, '\n');
function extensionLiteral(raw: string): string {
  extension(raw);
  const assignment = /^WRY_RUSTWEBVIEW_CLASS_EXTENSION\s*=\s*'''([\s\S]*?)'''/m.exec(raw);
  assert.ok(assignment, 'литеральное тело WRY найдено без удаления пробелов и комментариев внутри');
  return assignment[1]!;
}
function matchingCopies(root: string) {
  const rootBody = extensionLiteral(root), tauriBody = extensionLiteral(config);
  assert.equal(rootBody === tauriBody, true, 'R226-ime-copies: тела обеих class extension совпадают дословно');
}
it('R226 cargo из apps desktop и из src-tauri читает одинаковое дословное тело подключения клавиатуры', () => matchingCopies(desktopConfig));
it('R226 контрфакт рабочая копия WRY вне env больше не маскируется правильной копией src-tauri', () => killed(desktopConfig,
  '\n[env]\n', '\n[env]\n[not_env]\n', matchingCopies, 'R218-ime-env:', false, true));
it('R226 контрфакт две рабочие class extension не считаются одинаковыми при отличии даже одного пробела', () => killed(desktopConfig,
  'return KeyboardContent.wrap(super.onCreateInputConnection(outAttrs), outAttrs)',
  'return  KeyboardContent.wrap(super.onCreateInputConnection(outAttrs), outAttrs)', matchingCopies, 'R226-ime-copies:', false, true));

type WorkflowStep = { name: string; block: string; start: number; end: number };
function workflowSteps(raw: string): WorkflowStep[] {
  const headers = [...raw.matchAll(/^ {6}- name: ([^\n]+)$/gm)];
  return headers.map((header, index) => ({ name: header[1]!.trim(), block: raw.slice(header.index!, headers[index + 1]?.index ?? raw.length),
    start: header.index!, end: headers[index + 1]?.index ?? raw.length }));
}
const apkCheckName = 'В APK у RustWebView есть подключение клавиатуры';
// Берём пакет из настоящего Android namespace: публичный тест не дублирует литерал частного хоста.
const androidGradle = readFileSync(new URL('../../desktop/src-tauri/gen/android/app/build.gradle.kts', import.meta.url), 'utf8');
const namespaces = [...code(androidGradle).matchAll(/^\s*namespace\s*=\s*"([^"]+)"\s*$/gm)];
assert.equal(namespaces.length, 1, 'единственный namespace настоящего Android-приложения');
const apkClassDescriptor = (name: string) => `L${namespaces[0]![1]!.split('.').join('\\/')}\\/${name};`;
function apkKeyboardGuard(raw: string) {
  const steps = workflowSteps(raw.replace(/^\s*#.*$/gm, ''));
  const find = (name: string) => {
    const matching = steps.filter(step => step.name === name); assert.equal(matching.length, 1, `единственный настоящий шаг ${name}`); return matching[0]!;
  };
  const build = find('Build signed APK'), check = find(apkCheckName), publish = find('Publish to F-Droid repo'), archive = find('Keep the APK for a manual dry-run (no store touched)');
  assert.equal(build.start < check.start && check.start < publish.start && check.start < archive.start, true,
    'R226-apk-order: APK проверяется после сборки до публикации и сохранения сухого прогона');
  assert.equal(build.block.includes('pnpm tauri android build --apk'), true);
  assert.equal(/"\$DEXDUMP" "\$dex" \| awk/.test(check.block), true, 'R226-apk-dexdump: проверяются классы из собранного dex');
  const scripts = [...check.block.matchAll(/\bawk '([^'\n]+)'/g)]; assert.equal(scripts.length, 1);
  const script = scripts[0]![1]!;
  assert.equal(script.includes(`/Class descriptor/ { inside = ($0 ~ /${apkClassDescriptor('RustWebView')}/) }`), true,
    'R226-apk-class: класс ограничен настоящим дескриптором нашего RustWebView');
  assert.equal(script.includes('/name +: .onCreateInputConnection./'), true, 'R226-apk-method: ищется метод подключения клавиатуры');
  assert.equal(script.includes('inside && /name +: .onCreateInputConnection./ { hit = 1 }'), true,
    'R226-apk-scope: метод чужого WebView не засчитывается за наш');
  assert.equal(script.includes('END { exit hit ? 0 : 1 }'), true);
  assert.equal(/\bfound=0\b/.test(check.block) && /then found=1; fi/.test(check.block), true);
  assert.equal(/\[ "\$found" = 1 \] \|\| \{[^\n]*; exit 1; \}/.test(check.block), true,
    'R226-apk-exit: отсутствие метода останавливает сборку кодом один');
}
it('R226 CI проверяет подключение клавиатуры именно в RustWebView собранного APK до обоих способов публикации', () => {
  apkKeyboardGuard(androidWorkflow);
  const steps = workflowSteps(androidWorkflow), check = steps.find(step => step.name === apkCheckName)!;
  const movedBeforeBuild = mutate(androidWorkflow, check.block, '').replace('      - name: Build signed APK', `${check.block}      - name: Build signed APK`);
  assert.throws(() => apkKeyboardGuard(movedBeforeBuild), e => e instanceof assert.AssertionError
    && e.message.startsWith('R226-apk-order:') && e.operator === 'strictEqual' && e.actual === false && e.expected === true);
  for (const [from, to, prefix] of [
    [apkClassDescriptor('RustWebView'), apkClassDescriptor('OtherWebView'), 'R226-apk-class:'],
    ['inside && /name +: .onCreateInputConnection./', '/name +: .onCreateInputConnection./', 'R226-apk-scope:'],
    ['/name +: .onCreateInputConnection./', '/name +: .onKeyDown./', 'R226-apk-method:'],
    ['"$DEXDUMP" "$dex" | awk', 'printf ignored | awk', 'R226-apk-dexdump:'],
  ] as const) killed(androidWorkflow, from, to, apkKeyboardGuard, prefix, false, true);
  const missingLine = /^ {10}\[ "\$found" = 1 \] \|\| \{[^\n]*; exit 1; \}$/m.exec(androidWorkflow);
  assert.ok(missingLine);
  killed(androidWorkflow, missingLine[0], missingLine[0].replace('exit 1;', 'exit 0;'), apkKeyboardGuard, 'R226-apk-exit:', false, true);
});
