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
    'splash::gv_splash_done,',
    'splash::gv_splash_ping,',
    'splash::gv_update_test_mode,',
  ], 'R240-handler-commands: зарегистрированы ровно четыре команды заставки');
  for (const { index } of splashRows) {
    const previous = rows.slice(0, index).reverse().find((line) => line.length > 0);
    assert.equal(previous, '#[cfg(desktop)]', 'R240-handler-cfg: каждая команда splash закрыта cfg(desktop)');
  }
}

function checkSplashCommands(raw = splashRust) {
  const commands = ['gv_splash_ping', 'gv_splash_done', 'gv_launch_splash', 'gv_update_test_mode'];
  for (const command of commands) {
    assert.match(raw, new RegExp(`pub\\s+async\\s+fn\\s+${command}\\s*\\(`), `R240-async-${command}: команда async`);
  }
  const body = raw.match(/pub\s+async\s+fn\s+gv_update_test_mode\s*\([^)]*\)[^{]*\{([\s\S]*?)\n\}/)?.[1] ?? '';
  assert.match(body, /Ok\(v\)\s+if\s+v\s*==\s*"downgrade"\s*=>\s*Some\(v\)/,
    'R240-update-test-mode: разрешено только точное значение downgrade');
  assert.match(body, /_\s*=>\s*None/, 'R240-update-test-fallback: любое другое значение отключает тестовый режим');
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
  const changedWindows = JSON.parse(windows);
  changedWindows.app.windows.find((item: { label: string }) => item.label === 'main').minWidth++;
  assert.throws(() => checkDesktopConfig(desktop, JSON.stringify(changedWindows)), failure('R240-main-drift:'));

  checkCapability();
  const widened = JSON.parse(capability);
  widened.permissions.push('process:default');
  assert.throws(() => checkCapability(JSON.stringify(widened)), failure('R240-capability-rights:'));

  checkRustRegistration();
  const unscoped = replaceOnce(rust, '#[cfg(desktop)]\n            splash::gv_splash_done,', 'splash::gv_splash_done,');
  assert.throws(() => checkRustRegistration(unscoped), failure('R240-handler-cfg:'));
});

it('R240 контрфакты async, расширения test mode и смешения splash с App/updater обнаруживаются', () => {
  checkSplashCommands();
  assert.throws(() => checkSplashCommands(replaceOnce(splashRust, 'pub async fn gv_splash_done(', 'pub fn gv_splash_done(')),
    failure('R240-async-gv_splash_done:'));
  assert.throws(() => checkSplashCommands(replaceOnce(splashRust, 'v == "downgrade"', 'v == "preview"')),
    failure('R240-update-test-mode:'));

  checkSplashRoute();
  assert.throws(() => checkSplashRoute(replaceOnce(main, '<SplashScreen />', '<App />')), failure('R240-main-splash-component:'));
  const updater = replaceOnce(main, "document.documentElement.classList.add('splash-window');", "runLaunchUpdate();\n  document.documentElement.classList.add('splash-window');");
  assert.throws(() => checkSplashRoute(updater), failure('R240-main-splash-updater:'));
  const desktopUpdater = replaceOnce(main, "document.documentElement.classList.add('splash-window');", "runDesktopUpdateCheck();\n  document.documentElement.classList.add('splash-window');");
  assert.throws(() => checkSplashRoute(desktopUpdater), failure('R240-main-splash-updater:'));
});

it('R240 контрфакты infinite и удалённого reduced-motion правила ловятся CSS-стражем', () => {
  checkSplashCss();
  const finite = 'splashBob 2.4s ease-in-out 0.28s 5';
  const infinite = replaceOnce(css, finite, 'splashBob 2.4s ease-in-out 0.28s infinite');
  assert.throws(() => checkSplashCss(infinite), failure('R240-css-finite:'));
  const noReducedMotion = replaceOnce(css, '  .splash-goose-img,\n  .splash .update-shimmer {\n    animation: none;',
    '  .splash-goose-img,\n  .splash .update-shimmer {\n    animation: splashPoseIn 0.28s ease-out both;');
  assert.throws(() => checkSplashCss(noReducedMotion), failure('R240-css-reduced-animation:'));
  const missingShimmerRule = replaceOnce(css, '.splash .update-shimmer {', '.splash .update-shimmer:hover {');
  assert.throws(() => checkSplashCss(missingShimmerRule), failure('R240-css-reduced-selector:'));
  const animatedProgress = replaceOnce(css, '.splash .update-progress-bar.indeterminate {\n    animation: none;',
    '.splash .update-progress-bar.indeterminate {\n    animation: splashBob 2s infinite;');
  assert.throws(() => checkSplashCss(animatedProgress), failure('R240-css-reduced-animation:'));
});
