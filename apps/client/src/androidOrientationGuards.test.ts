import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { it } from 'node:test';

const root = '../../desktop/src-tauri/gen/android/app/src/main/';
const read = (name: string) => readFileSync(new URL(root + name, import.meta.url), 'utf8').replace(/\r\n/g, '\n');
const activities = ['MainActivity', 'IncomingCallActivity'].map(name => ({ name,
  source: read(`java/tech/gusik/gusvoice/${name}.kt`) }));
const manifest = read('AndroidManifest.xml');
function withoutComments(source: string) {
  return source.replace(/"(?:\\.|[^"\\])*"|\/\*[\s\S]*?\*\/|\/\/[^\n]*/g, token => token.startsWith('/') ? ' '.repeat(token.length) : token);
}
function onCreate(source: string) {
  const code = withoutComments(source);
  const start = /override\s+fun\s+onCreate\s*\([^)]*\)\s*\{/.exec(code); assert.ok(start, 'onCreate существует');
  const offset = start.index + start[0].length;
  const tokens = /"(?:\\.|[^"\\])*"|[{}]/g; tokens.lastIndex = offset;
  let depth = 1;
  for (let token = tokens.exec(code); token; token = tokens.exec(code)) {
    if (token[0] === '{') depth++;
    else if (token[0] === '}' && --depth === 0) return code.slice(offset, token.index);
  }
  assert.fail('onCreate сбалансирован');
}
function check(source: string) {
  const body = onCreate(source);
  const conditional = /if\s*\(\s*resources\.configuration\.smallestScreenWidthDp\s*<\s*600\s*\)\s*\{\s*requestedOrientation\s*=\s*(?:android\.content\.pm\.)?ActivityInfo\.SCREEN_ORIENTATION_PORTRAIT\s*\}/.exec(body);
  assert.ok(conditional, 'портрет ставится только внутри условия ширины <600');
  const superAt = body.indexOf('super.onCreate(');
  assert.ok(superAt >= 0, 'системный onCreate сохранён');
  assert.equal(conditional.index < superAt, true, 'ориентация задана до системного onCreate');
  assert.equal((body.match(/requestedOrientation\s*=/g) ?? []).length, 1, 'вне телефонного условия нет второй блокировки');
}
function replaceOnce(source: string, from: string, to: string) {
  assert.equal(source.split(from).length - 1, 1, 'один точный якорь контрфакта'); return source.replace(from, to);
}

it('R156 обе активности фиксируют портрет до super только при smallestScreenWidthDp <600', () => {
  // Граница исключает планшет ровно600dp и TV; манифест этого различия не умеет.
  for (const activity of activities) check(activity.source);
});
it('R156 контрфакты <=600 и >600 нарушают телефонную границу в каждой активности', () => {
  for (const activity of activities) for (const comparison of ['<=', '>']) {
    check(activity.source);
    const mutant = replaceOnce(activity.source, 'smallestScreenWidthDp < 600', `smallestScreenWidthDp ${comparison} 600`);
    assert.throws(() => check(mutant), assert.AssertionError);
  }
});
it('R156 контрфакт переноса блокировки после super обнаруживается в каждой активности', () => {
  // Ранняя установка нужна до создания окна/WebView, не после раскладки первого экрана.
  for (const activity of activities) {
    check(activity.source);
    const block = '    if (resources.configuration.smallestScreenWidthDp < 600) {\n      requestedOrientation = android.content.pm.ActivityInfo.SCREEN_ORIENTATION_PORTRAIT\n    }\n';
    const moved = replaceOnce(activity.source, block, '');
    const mutant = replaceOnce(moved, '    super.onCreate(savedInstanceState)\n', `    super.onCreate(savedInstanceState)\n${block}`);
    assert.throws(() => check(mutant), assert.AssertionError);
  }
});
it('R156 манифест не фиксирует ориентацию для планшетов и TV, контрфакт portrait отвергается', () => {
  const checkManifest = (source: string) => assert.doesNotMatch(source.replace(/<!--[\s\S]*?-->/g, ''), /\b(?:android:)?screenOrientation\s*=/);
  checkManifest(manifest);
  const mutant = replaceOnce(manifest, 'android:name=".MainActivity"', 'android:name=".MainActivity" android:screenOrientation="portrait"');
  assert.throws(() => checkManifest(mutant), assert.AssertionError);
});
