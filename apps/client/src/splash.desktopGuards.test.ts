import { counterfact } from '../../../packages/shared/test/counterfacts.js';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { it } from 'node:test';
import ts from 'typescript';

const read = (relative: string) => readFileSync(new URL(relative, import.meta.url), 'utf8').replace(/\r\n/g, '\n');
const desktop = read('../../desktop/src-tauri/tauri.conf.json');
const windows = read('../../desktop/src-tauri/tauri.windows.conf.json');
const capability = read('../../desktop/src-tauri/capabilities/splash.json');
const rust = read('../../desktop/src-tauri/src/lib.rs');
const splashRust = read('../../desktop/src-tauri/src/splash.rs');
const main = read('./main.tsx');
const css = read('./styles.css');
const splashScreen = read('./components/SplashScreen.tsx');

function failure(prefix: string) {
  return (error: unknown) => error instanceof assert.AssertionError && error.message.startsWith(prefix);
}

function replaceOnce(source: string, anchor: string, replacement: string) {
  assert.equal(source.split(anchor).length - 1, 1, `R240-mutation-anchor: единственный якорь ${anchor}`);
  return source.replace(anchor, replacement);
}

function checkDesktopConfig(baseRaw = desktop, windowsRaw = windows) {
  const base = JSON.parse(baseRaw);
  const win = JSON.parse(windowsRaw);
  assert.equal(base.plugins?.updater?.windows?.installMode, 'quiet', 'R240-install-mode: тихая установка NSIS');
  const baseMain = base.app?.windows?.find((item: { label?: string }) => item.label === 'main');
  const windowsMain = win.app?.windows?.find((item: { label?: string }) => item.label === 'main');
  assert.ok(baseMain, 'R240-main-base: главное окно есть в общем конфиге');
  assert.ok(windowsMain, 'R240-main-windows: главное окно есть в Windows-конфиге');
  assert.deepEqual(windowsMain, { ...baseMain, visible: false }, 'R240-main-drift: Windows main — общий main плюс visible:false');
  const splash = win.app?.windows?.find((item: { label?: string }) => item.label === 'splash');
  assert.ok(splash, 'R240-splash-window: окно заставки объявлено');
  assert.equal(splash.url, 'index.html?window=splash', 'R240-splash-url: заставка загружает отдельную ветку клиента');
  assert.equal(splash.width, 300, 'R240-splash-width: ширина окна 300');
  assert.equal(splash.height, 340, 'R240-splash-height: высота окна 340');
}

function checkCapability(raw = capability) {
  const parsed = JSON.parse(raw);
  assert.equal(parsed.identifier, 'splash', 'R240-capability-id: capability относится к splash');
  assert.deepEqual(parsed.windows, ['splash'], 'R240-capability-window: доступ только окну splash');
  assert.deepEqual(parsed.platforms, ['windows', 'linux', 'macOS'], 'R240-capability-platforms: capability только desktop');
  assert.deepEqual(parsed.permissions, ['core:default', 'updater:default'], 'R240-capability-rights: ровно базовый и updater permissions');
}

function stripRustComments(source: string) {
  return source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '');
}

function checkRustRegistration(raw = rust) {
  const code = stripRustComments(raw);
  assert.match(code, /#\[cfg\(desktop\)\]\s*mod splash;/, 'R240-splash-module: модуль включён только для desktop');
  const handler = code.match(/generate_handler!\s*\[([\s\S]*?)\]\s*\)/)?.[1] ?? '';
  assert.notEqual(handler, '', 'R240-handler: найден generate_handler');
  const rows = handler.split('\n').map((line) => line.trim());
  const splashRows = rows.flatMap((line, index) => line.includes('splash::') ? [{ line, index }] : []);
  assert.deepEqual(splashRows.map(({ line }) => line).sort(), [
    'splash::gv_launch_splash,',
    'splash::gv_splash_active,',
    'splash::gv_splash_done,',
    'splash::gv_splash_ping,',
    'splash::gv_update_log,',
    'splash::gv_update_test_mode,',
  ], 'R240-handler-commands: зарегистрированы ровно шесть команд заставки');
  for (const { index } of splashRows) {
    const previous = rows.slice(0, index).reverse().find((line) => line.length > 0);
    assert.equal(previous, '#[cfg(desktop)]', 'R240-handler-cfg: каждая команда splash закрыта cfg(desktop)');
  }
}

function checkSplashCommands(raw = splashRust) {
  const commands = ['gv_splash_ping', 'gv_splash_done', 'gv_launch_splash', 'gv_update_test_mode', 'gv_splash_active', 'gv_update_log'];
  for (const command of commands) {
    assert.match(raw, new RegExp(`pub\\s+async\\s+fn\\s+${command}\\s*\\(`), `R240-async-${command}: команда async`);
  }
  const body = raw.match(/pub\s+async\s+fn\s+gv_update_test_mode\s*\([^)]*\)[^{]*\{([\s\S]*?)\n\}/)?.[1] ?? '';
  assert.match(body, /Ok\(v\)\s+if\s+v\s*==\s*"downgrade"\s*=>\s*Some\(v\)/,
    'R240-update-test-mode: разрешено только точное значение downgrade');
  assert.match(body, /_\s*=>\s*None/, 'R240-update-test-fallback: любое другое значение отключает тестовый режим');
}

/** Это страж исходника Rust, не его исполнение: не делаем JS-копию алгоритма вместо проверки Rust. */
function rustFunction(raw: string, name: string) {
  const code = stripRustComments(raw);
  const body = code.match(new RegExp(`(?:pub\\s+)?(?:async\\s+)?fn\\s+${name}\\s*\\([^)]*\\)[^{]*\\{([\\s\\S]*?)\\n\\}`))?.[1];
  assert.notEqual(body, undefined, `R316-rust-function-${name}: найдена настоящая функция`);
  return body!;
}

function checkSplashFinished(raw = splashRust) {
  const code = stripRustComments(raw);
  assert.match(code, /const\s+FINISHED_EVENT:\s*&str\s*=\s*"gv-splash-finished"\s*;/,
    'R316-finished-name: событие совпадает с ожидаемым клиентом');
  const finish = rustFunction(raw, 'finish');
  assert.match(finish, /if\s+!ACTIVE\.swap\(false,\s*Ordering::SeqCst\)\s*\{\s*return;\s*\}/,
    'R316-finished-active: завершение сначала атомарно снимает ACTIVE');
  const mainWindow = finish.match(/if\s+let\s+Some\(w\)\s*=\s*app\.get_webview_window\("main"\)\s*\{([\s\S]*?)\n {4}\}/)?.[1] ?? '';
  assert.notEqual(mainWindow, '', 'R316-finished-main: найдена ветка настоящего главного окна');
  assert.match(mainWindow, /use\s+tauri::Emitter;/, 'R316-finished-emitter: импортирован trait отправки события');
  assert.match(mainWindow, /let\s+_\s*=\s*w\.emit\(FINISHED_EVENT,\s*\(\)\);/,
    'R316-finished-emit: событие отправляется главному окну из finish');
  assert.ok(mainWindow.indexOf('w.show()') >= 0 && mainWindow.indexOf('w.show()') < mainWindow.indexOf('w.emit('),
    'R316-finished-order: событие идёт после показа главного окна');
  assert.match(rustFunction(raw, 'gv_splash_done'), /finish\(&app\);/,
    'R316-finished-done: команда завершения использует тот же finish');
  assert.match(rustFunction(raw, 'gv_splash_active'), /^\s*ACTIVE\.load\(Ordering::SeqCst\)\s*$/,
    'R316-active-current: команда читает текущее ACTIVE, не факт запуска через заставку');
}

function checkUpdateLog(raw = splashRust) {
  const code = stripRustComments(raw);
  const log = rustFunction(raw, 'gv_update_log');
  assert.match(code, /const\s+UPDATE_LOG:\s*&str\s*=\s*"update-log\.txt"\s*;/,
    'R316-log-name: журнал имеет стабильное имя');
  assert.match(code, /const\s+UPDATE_LOG_MAX:\s*u64\s*=\s*128\s*\*\s*1024\s*;/,
    'R316-log-limit: порог 128 КиБ');
  assert.match(log, /let\s+Ok\(dir\)\s*=\s*app\.path\(\)\.app_local_data_dir\(\)\s*else\s*\{\s*return;\s*\}/,
    'R316-log-dir: журнал в локальных данных приложения, ошибка не мешает запуску');
  assert.match(log, /let\s+path\s*=\s*dir\.join\(UPDATE_LOG\);/, 'R316-log-path: запись в выбранный файл');
  assert.match(log, /if\s+std::fs::metadata\(&path\)\.map\(\|m\|\s*m\.len\(\)\s*>\s*UPDATE_LOG_MAX\)\.unwrap_or\(false\)\s*\{/,
    'R316-log-threshold: ровно 128 КиБ не обрезается, превышение обрезается');
  assert.match(log, /if\s+let\s+Ok\(old\)\s*=\s*std::fs::read\(&path\)\s*\{/,
    'R316-log-read: обрезаются реальные байты файла');
  assert.match(log, /let\s+tail\s*=\s*&old\[old\.len\(\)\s*\/\s*2\.\.\];/,
    'R316-log-half: сохраняется свежая половина, а не начало файла');
  assert.match(log, /let\s+cut\s*=\s*tail\.iter\(\)\.position\(\|&b\|\s*b\s*==\s*b'\\n'\)\.map\(\|i\|\s*i\s*\+\s*1\)/,
    'R316-log-whole-line: начало хвоста пропускается до байта после первого LF');
  assert.match(log, /std::fs::write\(&path,\s*&tail\[cut\.\.\]\);/,
    'R316-log-tail-write: в файл возвращается только выровненный свежий хвост');
  assert.match(log, /let\s+line:\s*String\s*=\s*line\.chars\(\)\.filter\(\|c\|\s*\*c\s*!=\s*'\\n'\s*&&\s*\*c\s*!=\s*'\\r'\)\.take\(500\)\.collect\(\);/,
    'R316-log-sanitize: CR и LF удалены до ограничения в 500 символов');
  assert.match(log, /std::fs::OpenOptions::new\(\)\.create\(true\)\.append\(true\)\.open\(&path\)/,
    'R316-log-append: новая запись дополняет журнал, не перетирает его');
  assert.match(log, /writeln!\(f,\s*"\{\} pid=\{\} v\{\} \{\}",\s*now_ms\(\),\s*std::process::id\(\),\s*app\.package_info\(\)\.version,\s*line\);/,
    'R316-log-entry: очищенная строка имеет время, PID и версию');
  assert.ok(log.indexOf('std::fs::write(') < log.indexOf('OpenOptions::new()'),
    'R316-log-rotation-order: старый хвост сохраняется до добавления новой записи');
}

function splashBranch(source: string) {
  const file = ts.createSourceFile('main.tsx', source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  const branches: ts.IfStatement[] = [];
  for (const statement of file.statements) {
    let node: ts.Statement | undefined = statement;
    while (node && ts.isIfStatement(node)) {
      const condition = node.expression;
      if (ts.isBinaryExpression(condition) && ts.isIdentifier(condition.left) && condition.left.text === 'gvWindow' &&
        condition.operatorToken.kind === ts.SyntaxKind.EqualsEqualsEqualsToken &&
        ts.isStringLiteral(condition.right) && condition.right.text === 'splash') branches.push(node);
      node = node.elseStatement;
    }
  }
  assert.equal(branches.length, 1, 'R240-main-splash-branch: одна живая верхнеуровневая ветка splash');
  return { file, branch: branches[0].thenStatement };
}

function checkSplashRoute(source = main) {
  const { file, branch } = splashBranch(source);
  const tags: string[] = [];
  const updaterCalls: string[] = [];
  function visit(node: ts.Node) {
    if (ts.isJsxSelfClosingElement(node) || ts.isJsxOpeningElement(node)) tags.push(node.tagName.getText(file));
    if (ts.isCallExpression(node) && ts.isIdentifier(node.expression) &&
      ['runLaunchUpdate', 'runDesktopUpdateCheck', 'startUpdatePolling', 'notifyIfJustUpdated'].includes(node.expression.text)) {
      updaterCalls.push(node.expression.text);
    }
    ts.forEachChild(node, visit);
  }
  visit(branch);
  assert.equal(tags.includes('SplashScreen'), true, 'R240-main-splash-component: splash монтирует SplashScreen');
  assert.equal(tags.includes('App'), false, 'R240-main-no-app: splash не монтирует главное приложение');
  assert.deepEqual(updaterCalls, [], 'R240-main-splash-updater: ветка splash не запускает апдейтер главного окна');
}

function cssRule(source: string, selector: string) {
  const clean = source.replace(/\/\*[\s\S]*?\*\//g, '');
  for (const match of clean.matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
    const selectors = match[1].trim().split(',').map((item) => item.trim());
    if (selectors.includes(selector)) return match[2];
  }
  return '';
}

function cssBlockBody(source: string, openingBrace: number) {
  let depth = 0;
  for (let index = openingBrace; index < source.length; index++) {
    if (source[index] === '{') depth++;
    if (source[index] === '}' && --depth === 0) return source.slice(openingBrace + 1, index);
  }
  return '';
}

function checkSplashCss(source = css) {
  const gooseRule = cssRule(source, '.splash-goose-img');
  const animation = gooseRule.match(/(?:^|;)\s*animation\s*:\s*([^;]+);/i)?.[1] ?? '';
  assert.notEqual(animation, '', 'R240-css-animation: гусь заставки имеет анимацию');
  assert.equal(/\binfinite\b/i.test(animation), false, 'R240-css-finite: анимация гуся конечная');
  const clean = source.replace(/\/\*[\s\S]*?\*\//g, '');
  const reducedBlocks = [...clean.matchAll(/@media\s*\(prefers-reduced-motion:\s*reduce\)\s*\{/g)]
    .map((match) => cssBlockBody(clean, (match.index ?? 0) + match[0].lastIndexOf('{')));
  assert.notEqual(reducedBlocks.length, 0, 'R240-css-reduced-scope: есть reduced-motion блок');
  for (const selector of ['.splash-goose-img', '.splash .update-shimmer', '.splash .update-progress-bar.indeterminate']) {
    const reducedRule = reducedBlocks.map((block) => cssRule(block, selector)).find(Boolean) ?? '';
    assert.notEqual(reducedRule, '', `R240-css-reduced-selector: правило выключает ${selector}`);
    assert.equal(reducedRule.match(/(?:^|;)\s*animation\s*:\s*([^;]+);/i)?.[1]?.trim(), 'none',
      `R240-css-reduced-animation: при reduced-motion анимация ${selector} выключена`);
  }
}

it('R240 тихая установка, main без дрейфа и splash с правильным адресом и размером', () => {
  checkDesktopConfig();
});

it('R240 capability splash имеет только необходимые права, а все handler-команды desktop-scoped', () => {
  checkCapability();
  checkRustRegistration();
});

it('R240 команды splash асинхронны, тестовый режим принимает только downgrade', () => {
  checkSplashCommands();
});

it('R240 splash-ветка монтирует только заставку и не запускает апдейтер главного окна', () => {
  checkSplashRoute();
});

it('R240 анимация гуся заставки конечная и выключается при reduced-motion', () => {
  checkSplashCss();
});

it('R240 контрфакты дрейфа main, лишних прав и неограниченной регистрации ловятся точными проверками', () => {
  checkDesktopConfig();
  counterfact(() => {
    const changedWindows = JSON.parse(windows);
    changedWindows.app.windows.find((item: { label: string }) => item.label === 'main').minWidth++;
    assert.throws(() => checkDesktopConfig(desktop, JSON.stringify(changedWindows)), failure('R240-main-drift:'));
  });

  checkCapability();
  counterfact(() => {
    const widened = JSON.parse(capability);
    widened.permissions.push('process:default');
    assert.throws(() => checkCapability(JSON.stringify(widened)), failure('R240-capability-rights:'));
  });

  checkRustRegistration();
  counterfact(() => {
    const unscoped = replaceOnce(rust, '#[cfg(desktop)]\n            splash::gv_splash_done,', 'splash::gv_splash_done,');
    assert.throws(() => checkRustRegistration(unscoped), failure('R240-handler-cfg:'));
  });
});

it('R240 контрфакты async, расширения test mode и смешения splash с App/updater обнаруживаются', () => {
  checkSplashCommands();
  counterfact(() => {
    assert.throws(() => checkSplashCommands(replaceOnce(splashRust, 'pub async fn gv_splash_done(', 'pub fn gv_splash_done(')),
      failure('R240-async-gv_splash_done:'));
  });
  counterfact(() => {
    assert.throws(() => checkSplashCommands(replaceOnce(splashRust, 'v == "downgrade"', 'v == "preview"')),
      failure('R240-update-test-mode:'));
  });

  checkSplashRoute();
  counterfact(() => {
    assert.throws(() => checkSplashRoute(replaceOnce(main, '<SplashScreen />', '<App />')), failure('R240-main-splash-component:'));
  });
  counterfact(() => {
    const updater = replaceOnce(main, "document.documentElement.classList.add('splash-window');", "runLaunchUpdate();\n  document.documentElement.classList.add('splash-window');");
    assert.throws(() => checkSplashRoute(updater), failure('R240-main-splash-updater:'));
  });
  counterfact(() => {
    const desktopUpdater = replaceOnce(main, "document.documentElement.classList.add('splash-window');", "runDesktopUpdateCheck();\n  document.documentElement.classList.add('splash-window');");
    assert.throws(() => checkSplashRoute(desktopUpdater), failure('R240-main-splash-updater:'));
  });
});

it('R240 контрфакты infinite и удалённого reduced-motion правила ловятся CSS-стражем', () => {
  checkSplashCss();
  counterfact(() => {
    const finite = 'splashBob 2.4s ease-in-out 0.28s 5';
    const infinite = replaceOnce(css, finite, 'splashBob 2.4s ease-in-out 0.28s infinite');
    assert.throws(() => checkSplashCss(infinite), failure('R240-css-finite:'));
  });
  counterfact(() => {
    const noReducedMotion = replaceOnce(css, '  .splash-goose-img,\n  .splash .update-shimmer {\n    animation: none;',
      '  .splash-goose-img,\n  .splash .update-shimmer {\n    animation: splashPoseIn 0.28s ease-out both;');
    assert.throws(() => checkSplashCss(noReducedMotion), failure('R240-css-reduced-animation:'));
  });
  counterfact(() => {
    const missingShimmerRule = replaceOnce(css, '.splash .update-shimmer {', '.splash .update-shimmer:hover {');
    assert.throws(() => checkSplashCss(missingShimmerRule), failure('R240-css-reduced-selector:'));
  });
  counterfact(() => {
    const animatedProgress = replaceOnce(css, '.splash .update-progress-bar.indeterminate {\n    animation: none;',
      '.splash .update-progress-bar.indeterminate {\n    animation: splashBob 2s infinite;');
    assert.throws(() => checkSplashCss(animatedProgress), failure('R240-css-reduced-animation:'));
  });
});

it('R316 новые active и log остаются async и каждая отдельно закрыта desktop cfg в handler', () => {
  checkRustRegistration();
  checkSplashCommands();
  counterfact(() => {
    for (const command of ['gv_splash_active', 'gv_update_log']) {
      const unscoped = replaceOnce(rust,
        `#[cfg(desktop)]\n            splash::${command},`, `splash::${command},`);
      assert.throws(() => checkRustRegistration(unscoped), failure('R240-handler-cfg:'));
      const sync = replaceOnce(splashRust, `pub async fn ${command}(`, `pub fn ${command}(`);
      assert.throws(() => checkSplashCommands(sync), failure(`R240-async-${command}:`));
    }
  });
});

it('R316 исходник finish шлёт gv-splash-finished именно главному окну, active читает текущее состояние', () => {
  checkSplashFinished();
});

it('R316 страж finish ловит удалённое событие, broadcast вместо main и чтение LAUNCHED вместо ACTIVE', () => {
  checkSplashFinished();
  counterfact(() => {
    const noEvent = replaceOnce(splashRust, '        let _ = w.emit(FINISHED_EVENT, ());\n', '');
    assert.throws(() => checkSplashFinished(noEvent), failure('R316-finished-emit:'));
  });
  counterfact(() => {
    const broadcast = replaceOnce(splashRust, 'w.emit(FINISHED_EVENT, ())', 'app.emit(FINISHED_EVENT, ())');
    assert.throws(() => checkSplashFinished(broadcast), failure('R316-finished-emit:'));
  });
  counterfact(() => {
    const wrongState = replaceOnce(splashRust,
      'pub async fn gv_splash_active() -> bool {\n    ACTIVE.load(Ordering::SeqCst)',
      'pub async fn gv_splash_active() -> bool {\n    LAUNCHED.load(Ordering::SeqCst)');
    assert.throws(() => checkSplashFinished(wrongState), failure('R316-active-current:'));
  });
});

it('R316 исходник журнала ограничивает старый файл, выравнивает свежий хвост и очищает входную строку', () => {
  checkUpdateLog();
});

it('R316 страж журнала различает обе границы размера, свежую половину и срез после первого LF', () => {
  checkUpdateLog();
  const mutations = [
    ['m.len() > UPDATE_LOG_MAX', 'm.len() >= UPDATE_LOG_MAX', 'R316-log-threshold:'],
    ['m.len() > UPDATE_LOG_MAX', 'm.len() < UPDATE_LOG_MAX', 'R316-log-threshold:'],
    ['const UPDATE_LOG_MAX: u64 = 128 * 1024;', 'const UPDATE_LOG_MAX: u64 = 128 * 1000;', 'R316-log-limit:'],
    ['&old[old.len() / 2..]', '&old[..old.len() / 2]', 'R316-log-half:'],
    ['&old[old.len() / 2..]', '&old[old.len() / 3..]', 'R316-log-half:'],
    ["position(|&b| b == b'\\n')", "position(|&b| b == b'\\r')", 'R316-log-whole-line:'],
    ['.map(|i| i + 1).unwrap_or(0)', '.map(|i| i).unwrap_or(0)', 'R316-log-whole-line:'],
    ['std::fs::write(&path, &tail[cut..])', 'std::fs::write(&path, tail)', 'R316-log-tail-write:'],
  ] as const;
  counterfact(() => {
    for (const [anchor, replacement, prefix] of mutations) {
      assert.throws(() => checkUpdateLog(replaceOnce(splashRust, anchor, replacement)), failure(prefix));
    }
  });
});

it('R316 страж очистки ловит оставленный CR или LF, перестановку ограничения и потерю очищенного line', () => {
  checkUpdateLog();
  const mutations = [
    ["*c != '\\n' && *c != '\\r'", "*c != '\\r'", 'R316-log-sanitize:'],
    ["*c != '\\n' && *c != '\\r'", "*c != '\\n'", 'R316-log-sanitize:'],
    ["line.chars().filter(|c| *c != '\\n' && *c != '\\r').take(500)",
      "line.chars().take(500).filter(|c| *c != '\\n' && *c != '\\r')", 'R316-log-sanitize:'],
    ['.take(500).collect()', '.take(501).collect()', 'R316-log-sanitize:'],
    ['app.package_info().version, line);', 'app.package_info().version, "unfiltered");', 'R316-log-entry:'],
  ] as const;
  counterfact(() => {
    for (const [anchor, replacement, prefix] of mutations) {
      assert.throws(() => checkUpdateLog(replaceOnce(splashRust, anchor, replacement)), failure(prefix));
    }
  });
});

const CVE = 'R365/updater/check/';
function boundedSource(raw: string): string {
  if (raw.length > 1_000_000) throw new Error('R365/updater/budget/source');
  return raw;
}

function checkDowngradeHelper(raw = splashRust) {
  const code = stripRustComments(boundedSource(raw));
  const declarations = [...code.matchAll(/pub\s+fn\s+update_test_downgrade\s*\(\s*\)\s*->\s*bool\s*\{/g)];
  assert.equal(declarations.length, 1, CVE + 'one-helper');
  const start = declarations[0].index! + declarations[0][0].length;
  const end = code.indexOf('}', start);
  assert.ok(end >= start, CVE + 'helper-body');
  const body = code.slice(start, end);
  // Один matches! одновременно фиксирует переменную, точное значение и false для любого иного/отсутствующего значения.
  assert.match(body, /^\s*matches!\(\s*std::env::var\("GV_UPDATE_TEST"\)\.as_deref\(\),\s*Ok\("downgrade"\)\s*\)\s*$/,
    CVE + 'exact-downgrade-mode');
}

function checkVersionComparator(raw = rust) {
  const code = stripRustComments(boundedSource(raw));
  assert.equal([...code.matchAll(/\.default_version_comparator\s*\(/g)].length, 1, CVE + 'one-comparator');
  // Реальный .plugin({ ... }). Alias создан plain Builder::new и между ним и if нет никаких изменений.
  // Это равносильно Builder::new() в else, а не требование копировать конструктор во вторую ветку.
  const configured = code.match(/\.plugin\(\{\s*let\s+([A-Za-z_]\w*)\s*=\s*tauri_plugin_updater::Builder::new\(\);\s*if\s+([^{}]+)\{([^{}]*)\}\s*else\s*\{([^{}]*)\}\s*\.build\(\)\s*\}\)/);
  assert.ok(configured, CVE + 'guarded-plain-builder');
  const [, alias, condition, branch, fallback] = configured;
  assert.equal(condition.replace(/\s/g, ''), 'splash::update_test_downgrade()', CVE + 'only-helper-gate');
  assert.match(branch, new RegExp(`^\\s*${alias}\\.default_version_comparator\\(\\|current,\\s*remote\\|\\s*remote\\.version\\s*!=\\s*current\\)\\s*$`),
    CVE + 'different-version-not-only-newer');
  const plain = fallback.replace(/\s/g, '');
  assert.ok(plain === alias || plain === 'tauri_plugin_updater::Builder::new()', CVE + 'default-unchanged-builder');
}

function checkUpdaterFeed(raw = splashScreen) {
  boundedSource(raw);
  const ast = ts.createSourceFile('SplashScreen.tsx', raw, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  const diagnostics = (ast as ts.SourceFile & { parseDiagnostics: readonly unknown[] }).parseDiagnostics;
  assert.equal(diagnostics.length, 0, 'R365/updater/setup/TSX');
  const functions = ast.statements.filter((node): node is ts.FunctionDeclaration => ts.isFunctionDeclaration(node) && node.name?.text === 'checkFeed');
  assert.equal(functions.length, 1, CVE + 'one-check-feed');
  const fn = functions[0];
  assert.ok(fn.body, CVE + 'real-check-feed');
  let visited = 0;
  const calls: ts.CallExpression[] = [];
  const options: ts.Identifier[] = [];
  const visit = (node: ts.Node) => {
    if (++visited > 20_000) throw new Error('R365/updater/budget/AST');
    if (ts.isCallExpression(node) && ts.isIdentifier(node.expression) && node.expression.text === 'check') calls.push(node);
    if (ts.isIdentifier(node) && node.text === 'allowDowngrades') options.push(node);
    ts.forEachChild(node, visit);
  };
  visit(fn.body);
  const variables = fn.body.statements.filter(ts.isVariableStatement).flatMap(statement => [...statement.declarationList.declarations]);
  const binding = variables.find(node => ts.isObjectBindingPattern(node.name)
    && node.name.elements.some(element => ts.isIdentifier(element.name) && element.name.text === 'check'
      && (!element.propertyName || ts.isIdentifier(element.propertyName) && element.propertyName.text === 'check')));
  assert.ok(binding?.initializer && ts.isAwaitExpression(binding.initializer), CVE + 'plugin-binding');
  const imported = binding.initializer.expression;
  assert.ok(ts.isCallExpression(imported) && imported.expression.kind === ts.SyntaxKind.ImportKeyword && imported.arguments.length === 1
    && ts.isStringLiteral(imported.arguments[0]) && imported.arguments[0].text === '@tauri-apps/plugin-updater', CVE + 'real-plugin-import');
  assert.equal(calls.length, 1, CVE + 'one-real-check');
  assert.equal(calls[0].arguments.length, 0, CVE + 'check-without-options');
  const awaited = calls[0].parent;
  assert.ok(ts.isAwaitExpression(awaited) && ts.isVariableDeclaration(awaited.parent) && awaited.parent.initializer === awaited
    && ts.isVariableDeclarationList(awaited.parent.parent) && ts.isVariableStatement(awaited.parent.parent.parent)
    && awaited.parent.parent.parent.parent === fn.body, CVE + 'check-is-live-statement');
  assert.equal(options.length, 0, CVE + 'no-js-downgrade-option');
}

it('R365 Rust разрешает пробный откат только при точном GV_UPDATE_TEST=downgrade', () => {
  checkDowngradeHelper();
  const helper = 'matches!(std::env::var("GV_UPDATE_TEST").as_deref(), Ok("downgrade"))';
  for (const replacement of [
    'matches!(std::env::var("GV_UPDATE_TEST").as_deref(), Ok("preview"))',
    'matches!(std::env::var("OTHER_UPDATE_TEST").as_deref(), Ok("downgrade"))',
    'matches!(std::env::var("GV_UPDATE_TEST").as_deref(), Ok("downgrade" | "preview"))',
  ]) {
    counterfact(() => {
      assert.throws(() => checkDowngradeHelper(replaceOnce(splashRust, helper, replacement)), failure(CVE + 'exact-downgrade-mode'));
    });
    checkDowngradeHelper();
  }
});

it('R365 только пробный Rust-плагин меняет comparator, обычный получает неизменённый plain builder', () => {
  checkVersionComparator();
  const gate = 'if splash::update_test_downgrade() {\n                    updater.default_version_comparator(|current, remote| remote.version != current)\n                } else {\n                    updater\n                }';
  counterfact(() => {
    assert.throws(() => checkVersionComparator(replaceOnce(rust, gate,
      'updater.default_version_comparator(|current, remote| remote.version != current)')), failure(CVE + 'guarded-plain-builder'));
  });
  counterfact(() => {
    assert.throws(() => checkVersionComparator(replaceOnce(rust, 'remote.version != current', 'remote.version > current')),
      failure(CVE + 'different-version-not-only-newer'));
  });
  counterfact(() => {
    assert.throws(() => checkVersionComparator(replaceOnce(rust, 'if splash::update_test_downgrade() {', 'if true {')),
      failure(CVE + 'only-helper-gate'));
  });
  counterfact(() => {
    assert.throws(() => checkVersionComparator(replaceOnce(rust, 'let updater = tauri_plugin_updater::Builder::new();',
      'let updater = tauri_plugin_updater::Builder::new().pubkey("synthetic");')), failure(CVE + 'guarded-plain-builder'));
  });
  const directPlainElse = replaceOnce(rust, '} else {\n                    updater\n                }',
    '} else {\n                    tauri_plugin_updater::Builder::new()\n                }');
  checkVersionComparator(directPlainElse);
  checkVersionComparator();
});

it('R365 checkFeed вызывает настоящий plugin-updater check без JS-параметра allowDowngrades', () => {
  checkUpdaterFeed();
  counterfact(() => {
    assert.throws(() => checkUpdaterFeed(replaceOnce(splashScreen, 'const update = await check();',
      'const update = await check({ allowDowngrades: true });')), failure(CVE + 'check-without-options'));
  });
  counterfact(() => {
    assert.throws(() => checkUpdaterFeed(replaceOnce(splashScreen, "await import('@tauri-apps/plugin-updater')",
      "await import('./synthetic-updater')")), failure(CVE + 'real-plugin-import'));
  });
  checkUpdaterFeed();
});
