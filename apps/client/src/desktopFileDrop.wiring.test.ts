import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { it } from 'node:test';
import ts from 'typescript';

const configNames = ['tauri.conf.json', 'tauri.windows.conf.json'] as const;
type Config = { app: { windows: Array<{ label: string; dragDropEnabled?: boolean }> } };
const configs = new Map(configNames.map(name => [name,
  JSON.parse(readFileSync(new URL(`../../desktop/src-tauri/${name}`, import.meta.url), 'utf8')) as Config]));
const configMarker = (name: string) => `R286 ${name}: main отдаёт бросок файлов HTML5, не Tauri`;

function mainDrop(config: Config, name: string) {
  const mains = config.app.windows.filter(window => window.label === 'main');
  assert.equal(mains.length, 1, `R286 один main в ${name}`);
  assert.equal(mains[0].dragDropEnabled, false, configMarker(name));
}

// Не импортируем клиент, Tauri или стор. Проверяем production TS/JS, включая вложенные каталоги,
// но не сами стражи с контрфактами. Пути в сообщениях относительные и одинаковые на Windows/Linux.
function clientSources() {
  const root = fileURLToPath(new URL('.', import.meta.url));
  const sources = new Map<string, string>();
  const visit = (dir: string) => {
    for (const entry of readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      const path = join(dir, entry.name);
      if (entry.isDirectory()) {
        if (entry.name !== 'node_modules' && entry.name !== 'dist') visit(path);
      } else if (entry.isFile() && /\.(?:[jt]sx?|[mc]js)$/.test(entry.name) && !/\.(?:test|itest)\.[jt]sx?$/.test(entry.name)) {
        sources.set(relative(root, path).replace(/\\/g, '/'), readFileSync(path, 'utf8'));
      }
    }
  };
  visit(root);
  assert.ok(sources.has('main.tsx'), 'R286 проверяется настоящий каталог клиента с main.tsx');
  return sources;
}
const sources = clientSources();
const clientMarker = (path: string) => `R286 клиент не подписан на бросок Tauri: ${path}`;

function noNativeDrop(files: ReadonlyMap<string, string>) {
  for (const [path, source] of files) {
    // В обычных файлах без этих маркеров нечего разбирать; комментарии кандидатов отсекает AST, не grep.
    if (!/onDragDropEvent|tauri:/.test(source)) continue;
    const file = ts.createSourceFile(path, source, ts.ScriptTarget.Latest, true,
      path.endsWith('.tsx') ? ts.ScriptKind.TSX : ts.ScriptKind.TS);
    assert.equal((file as ts.SourceFile & { parseDiagnostics: readonly ts.Diagnostic[] }).parseDiagnostics.length, 0,
      `R286 исходник стража синтаксически корректен: ${path}`);
    let native = false;
    const visit = (node: ts.Node) => {
      if (ts.isIdentifier(node) && node.text === 'onDragDropEvent') native = true;
      if (ts.isTemplateExpression(node) && node.head.text.startsWith('tauri://drag-')) native = true;
      if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) {
        if (node.text.startsWith('tauri://drag-')) native = true;
        if (node.text === 'onDragDropEvent' && ts.isElementAccessExpression(node.parent)
            && node.parent.argumentExpression === node) native = true;
      }
      ts.forEachChild(node, visit);
    };
    visit(file);
    assert.equal(native, false, clientMarker(path));
  }
}
function failsAt(marker: string) {
  return (error: unknown) => error instanceof assert.AssertionError && error.message.split('\n')[0] === marker;
}

for (const name of configNames) it(`R286 main в ${name} не перехватывает HTML5-бросок проводника`, () => {
  // Даже исправленный клиент не получит drop, если любой desktop-конфиг включит SetAllowExternalDrop(false) через Tauri.
  mainDrop(configs.get(name)!, name);
});

it('R286 true и отсутствие dragDropEnabled в любом конфиге отвергаются после исходного false', () => {
  // Умолчание Tauri равно включённому перехвату: пропущенный ключ не эквивалентен явному false.
  for (const name of configNames) for (const missing of [false, true]) {
    const original = configs.get(name)!;
    mainDrop(original, name);
    const mutant = JSON.parse(JSON.stringify(original)) as Config;
    const main = mutant.app.windows.find(window => window.label === 'main')!;
    if (missing) delete main.dragDropEnabled;
    else main.dragDropEnabled = true;
    assert.throws(() => mainDrop(mutant, name), failsAt(configMarker(name)));
  }
});

it('R286 production-клиент использует HTML5 drop без onDragDropEvent и tauri://drag-*', () => {
  // Иначе после отключения перехвата в Tauri клиент мог бы ждать события, которые больше не приходят.
  noNativeDrop(sources);
  const commented = new Map(sources);
  commented.set('main.tsx', sources.get('main.tsx')! + '\n/* onDragDropEvent; listen("tauri://drag-drop", () => {}); */');
  noNativeDrop(commented);
});

it('R286 возврат метода или любого события броска Tauri обнаруживается в настоящем клиентском исходнике', () => {
  // Контрфакты валидны синтаксически; ошибка парсинга или посторонний assert не считается доказательством стража.
  noNativeDrop(sources);
  const subscriptions = [
    'import { getCurrentWebview as r286Webview } from "@tauri-apps/api/webview"; void r286Webview().onDragDropEvent(() => {});',
    'import { getCurrentWebview as r286Webview } from "@tauri-apps/api/webview"; void r286Webview()["onDragDropEvent"](() => {});',
    'import { listen as r286Listen } from "@tauri-apps/api/event"; const r286Kind = "drop"; void r286Listen(`tauri://drag-${r286Kind}`, () => {});',
    ...['enter', 'over', 'drop', 'leave'].map(kind =>
      `import { listen as r286Listen } from "@tauri-apps/api/event"; void r286Listen("tauri://drag-${kind}", () => {});`),
  ];
  for (const subscription of subscriptions) {
    const mutant = new Map(sources);
    mutant.set('main.tsx', sources.get('main.tsx')! + '\n' + subscription);
    assert.throws(() => noNativeDrop(mutant), failsAt(clientMarker('main.tsx')));
  }
});
