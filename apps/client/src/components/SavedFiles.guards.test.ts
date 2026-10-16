import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { it } from 'node:test';
import ts from 'typescript';

const read = (path: string) => readFileSync(new URL(path, import.meta.url), 'utf8').replace(/\r\n/g, '\n');
const pane = read('./MessagePane.tsx'), viewer = read('./Lightbox.tsx'), list = read('./DownloadsList.tsx');
const rust = read('../../../desktop/src-tauri/src/lib.rs');
const kotlin = read('../../../desktop/src-tauri/gen/android/app/src/main/java/tech/gusik/gusvoice/MediaBridge.kt');
const flat = (text: string) => text.replace(/\s+/g, '');
function all(root: ts.Node, predicate: (node: ts.Node) => boolean): ts.Node[] {
  const result: ts.Node[] = [];
  const visit = (node: ts.Node) => { if (predicate(node)) result.push(node); ts.forEachChild(node, visit); };
  visit(root); return result;
}
function ancestor(node: ts.Node, predicate: (node: ts.Node) => boolean): ts.Node {
  let current: ts.Node | undefined = node.parent;
  while (current && !predicate(current)) current = current.parent;
  assert.ok(current, 'найден управляющий AST-узел, не совпадение в комментарии'); return current;
}
function tree(raw: string) { return ts.createSourceFile('surface.tsx', raw, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX); }
function label(file: ts.SourceFile, name: string, attributeName = 'label'): ts.JsxAttribute {
  const matches = all(file, node => ts.isJsxAttribute(node) && node.name.getText(file) === attributeName
    && !!node.initializer && ts.isStringLiteral(node.initializer) && node.initializer.text === name);
  assert.equal(matches.length, 1, `ровно один JSX-пункт «${name}»`); return matches[0] as ts.JsxAttribute;
}
function listGate(raw: string) {
  const file = tree(raw), item = label(file, 'Показать в папке', 'title');
  const conditional = ancestor(item, ts.isConditionalExpression) as ts.ConditionalExpression;
  assert.equal(flat(conditional.condition.getText(file)), "e.state==='done'&&e.path&&showInFolderAvailable()",
    'R214-list-gate: кнопка требует завершённый файл, путь и оболочку');
  assert.equal(conditional.whenFalse.kind, ts.SyntaxKind.NullKeyword);
  const element = item.parent.parent;
  const click = all(element, node => ts.isJsxAttribute(node) && node.name.getText(file) === 'onClick')[0] as ts.JsxAttribute;
  assert.equal(flat(click.initializer!.getText(file)), '{()=>e.path&&showInFolder(e.path)}');
}
function paneGate(raw: string) {
  const file = tree(raw), item = label(file, 'Показать в папке');
  const conditional = ancestor(item, ts.isConditionalExpression) as ts.ConditionalExpression;
  assert.equal(conditional.condition.getText(file), 'folder', 'R214-pane-gate: пункт зависит от известного пути');
  assert.equal(conditional.whenFalse.kind, ts.SyntaxKind.NullKeyword);
  const arrow = ancestor(conditional, ts.isArrowFunction) as ts.ArrowFunction;
  assert.ok(ts.isBlock(arrow.body));
  const declaration = all(arrow.body, node => ts.isVariableDeclaration(node) && node.name.getText(file) === 'folder')[0] as ts.VariableDeclaration;
  assert.ok(declaration?.initializer);
  assert.equal(flat(declaration.initializer.getText(file)),
    'file?savedFilePath(attachmentKey(file),api.attachmentDownloadUrl(file)):photo?savedFilePath(attachmentKey(photo),api.attachmentDownloadUrl(photo)):undefined');
  const element = item.parent.parent;
  const click = all(element, node => ts.isJsxAttribute(node) && node.name.getText(file) === 'onClick')[0] as ts.JsxAttribute;
  assert.equal(flat(click.initializer!.getText(file)), '{()=>{close();showInFolder(folder);}}', 'R214-pane-path: мост получает путь, не URL');
  assert.equal(item.pos < label(file, 'Копировать название').pos, true, 'папка стоит перед копированием названия');
}
function viewerGate(raw: string) {
  const file = tree(raw);
  const objects = all(file, node => ts.isObjectLiteralExpression(node) && node.properties.some(p =>
    ts.isPropertyAssignment(p) && p.name.getText(file) === 'id' && flat(p.initializer.getText(file)) === "'folder'asconst"));
  assert.equal(objects.length, 1);
  const conditional = ancestor(objects[0], ts.isConditionalExpression) as ts.ConditionalExpression;
  assert.equal(ts.isArrayLiteralExpression(conditional.whenTrue) && conditional.whenTrue.elements.includes(objects[0] as ts.Expression), true,
    'R214-viewer-branch: папка находится в разрешённой ветке');
  assert.equal(ts.isArrayLiteralExpression(conditional.whenFalse) && conditional.whenFalse.elements.length === 0, true,
    'без сохранённого пути просмотрщик не добавляет пункт');
  assert.equal(flat(conditional.condition.getText(file)), 'img.downloadUrl&&dlTarget&&savedFilePath(dlTarget.key,dlTarget.url)',
    'R214-viewer-gate: просмотрщик предлагает папку лишь сохранённому файлу');
  const run = (objects[0] as ts.ObjectLiteralExpression).properties.find(p => ts.isPropertyAssignment(p) && p.name.getText(file) === 'run') as ts.PropertyAssignment;
  assert.equal(flat(run.initializer.getText(file)), '()=>{constp=savedFilePath(dlTarget.key,dlTarget.url);if(p)showInFolder(p);}',
    'обработчик повторно проверяет путь перед вызовом оболочки');
}
function rustBody(raw: string, name: string) {
  const start = raw.indexOf(`fn ${name}(`); assert.ok(start >= 0, `Rust-функция ${name} существует`);
  const end = raw.indexOf('\n}', start); assert.ok(end >= 0); return raw.slice(start, end + 2);
}
function rustGate(raw: string) {
  const body = rustBody(raw, 'gv_show_in_folder');
  assert.equal(/let known = SAVED_FILES\s*\.lock\(\)\s*\.map\(\|g\| g\.iter\(\)\.any\(\|p\| \*p == wanted\)\)\s*\.unwrap_or\(false\);/.test(body), true,
    'Rust сверяет точный путь со списком сохранённых');
  assert.equal(/if !known\s*\{\s*return Err\("файл не из сохранённых этим приложением"/.test(body), true,
    'R214-rust-gate: неизвестный путь отбрасывается до запуска Проводника');
  assert.equal(body.indexOf('if !known') < body.indexOf('Command::new("explorer.exe")'), true);
  const handler = /\bgenerate_handler!\[([\s\S]*?)\n\s*\]\)/.exec(raw);
  assert.ok(handler, 'найдена вся команда generate_handler с вложенными cfg');
  assert.match(handler[1], /\bgv_show_in_folder\b/);
}
function kotlinTargets(raw: string) {
  const start = raw.indexOf('private fun downloadsTarget('), end = raw.indexOf('\n  }', start);
  assert.ok(start >= 0 && end > start); const body = flat(raw.slice(start, end));
  assert.equal(body.includes('mime.startsWith("video/")->Pair(MediaStore.Video.Media.getContentUri(MediaStore.VOLUME_EXTERNAL_PRIMARY),Environment.DIRECTORY_MOVIES)'), true,
    'R214-video-target: видео сохраняется в Movies, не Downloads');
  assert.equal(body.includes('mime.startsWith("audio/")->Pair(MediaStore.Audio.Media.getContentUri(MediaStore.VOLUME_EXTERNAL_PRIMARY),Environment.DIRECTORY_MUSIC)'), true);
  assert.equal(body.includes('else->Pair(MediaStore.Downloads.getContentUri(MediaStore.VOLUME_EXTERNAL_PRIMARY),Environment.DIRECTORY_DOWNLOADS)'), true);
}

// AST проверяет настоящую управляющую ветку, но не изображает layout и не запускает ОС/Android.
it('R214 кнопка списка загрузок требует done, путь и доступный мост', () => listGate(list));
it('R214 меню сообщения берёт путь файла или фото и показывает его перед копированием названия', () => paneGate(pane));
it('R214 просмотрщик предлагает папку только при известном пути и перепроверяет его при нажатии', () => viewerGate(viewer));
it('R214 оболочка разрешает только сохранённый путь и регистрирует команду показа папки', () => rustGate(rust));
it('R214 событие COMPLETED запоминает путь до done, а DownloadInfo передаёт исходный URL', () => {
  const info = rust.slice(rust.indexOf('struct DownloadInfo {'), rust.indexOf('\n}', rust.indexOf('struct DownloadInfo {')));
  assert.match(info, /\burl:\s*String\s*,/);
  assert.match(rust, /if st == COREWEBVIEW2_DOWNLOAD_STATE_COMPLETED\s*\{\s*remember_saved\(&info\.path\);/);
  const branch = rust.slice(rust.indexOf('if st == COREWEBVIEW2_DOWNLOAD_STATE_COMPLETED'), rust.indexOf('if st == COREWEBVIEW2_DOWNLOAD_STATE_INTERRUPTED'));
  assert.equal(branch.indexOf('remember_saved') < branch.indexOf('gv-download-done'), true);
});
it('R214 Android выбирает Movies для видео, Music для звука и Downloads для остальных', () => kotlinTargets(kotlin));
it('R214 контрфакт перестановки веток не предлагает папку только несохранённому файлу', () => {
  viewerGate(viewer);
  const file = tree(viewer), property = all(file, node => ts.isPropertyAssignment(node) && node.name.getText(file) === 'id'
    && flat(node.initializer.getText(file)) === "'folder'asconst")[0];
  assert.ok(property);
  const conditional = ancestor(property, ts.isConditionalExpression) as ts.ConditionalExpression;
  const from = conditional.getText(file);
  const to = `${conditional.condition.getText(file)} ? [] : ${conditional.whenTrue.getText(file)}`;
  assert.equal(viewer.split(from).length - 1, 1, 'изменяется одна полная ветка построения меню');
  assert.throws(() => viewerGate(viewer.replace(from, to)), (e: unknown) => e instanceof assert.AssertionError
    && e.message.startsWith('R214-viewer-branch:') && e.operator === 'strictEqual' && e.actual === false && e.expected === true);
});

for (const [name, raw, from, to, check, prefix, actual, expected] of [
  ['кнопка выдаётся loading', list, "e.state === 'done' && e.path && showInFolderAvailable()", 'e.path && showInFolderAvailable()', listGate,
    'R214-list-gate:', 'e.path&&showInFolderAvailable()', "e.state==='done'&&e.path&&showInFolderAvailable()"],
  ['мост получает адрес вместо пути', pane, 'showInFolder(folder);', 'showInFolder(file.url);', paneGate,
    'R214-pane-path:', '{()=>{close();showInFolder(file.url);}}', '{()=>{close();showInFolder(folder);}}'],
  ['просмотрщик предлагает папку несохранённому файлу', viewer, 'img.downloadUrl && dlTarget && savedFilePath(dlTarget.key, dlTarget.url)', 'img.downloadUrl && dlTarget', viewerGate,
    'R214-viewer-gate:', 'img.downloadUrl&&dlTarget', 'img.downloadUrl&&dlTarget&&savedFilePath(dlTarget.key,dlTarget.url)'],
  ['оболочка игнорирует список сохранённого', rust, 'if !known {', 'if false {', rustGate,
    'R214-rust-gate:', false, true],
  ['Android кладёт видео в Downloads', kotlin, 'MediaStore.VOLUME_EXTERNAL_PRIMARY), Environment.DIRECTORY_MOVIES)',
    'MediaStore.VOLUME_EXTERNAL_PRIMARY), Environment.DIRECTORY_DOWNLOADS)', kotlinTargets, 'R214-video-target:', false, true],
] as const) it(`R214 контрфакт показа папки: ${name}`, () => {
  check(raw); assert.equal(raw.split(from).length - 1, 1, 'однозначный якорь контрфакта поверхности');
  assert.throws(() => check(raw.replace(from, to)), (e: unknown) => e instanceof assert.AssertionError && e.message.startsWith(prefix)
    && e.operator === 'strictEqual' && Object.is(e.actual, actual) && Object.is(e.expected, expected));
});
