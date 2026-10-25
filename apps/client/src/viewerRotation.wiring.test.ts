import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { it } from 'node:test';
import ts from 'typescript';

const read = (path: string) => readFileSync(new URL(path, import.meta.url), 'utf8').replace(/\r\n/g, '\n');
const kotlin = read('../../desktop/src-tauri/gen/android/app/src/main/java/tech/gusik/gusvoice/MainActivity.kt');
const main = read('./main.tsx');
const css = read('./styles.css');
const media = '@media (orientation: landscape) and (max-height: 500px) and (hover: none)';

function replaceOnce(source: string, from: string, to: string) {
  assert.equal(source.split(from).length - 1, 1, `единственный живой якорь: ${from}`);
  return source.replace(from, to);
}
const failure = (marker: string) => (error: unknown) => error instanceof assert.AssertionError && error.message.includes(marker);

function withoutKotlinComments(source: string) {
  return source.replace(/"(?:\\.|[^"\\])*"|\/\*[\s\S]*?\*\/|\/\/[^\n]*/g,
    token => token.startsWith('/') ? ' '.repeat(token.length) : token);
}
function braced(source: string, opening: number) {
  const tokens = /"(?:\\.|[^"\\])*"|[{}]/g;
  tokens.lastIndex = opening + 1;
  let depth = 1;
  for (let token = tokens.exec(source); token; token = tokens.exec(source)) {
    if (token[0] === '{') depth++;
    else if (token[0] === '}' && --depth === 0) return { body: source.slice(opening + 1, token.index), end: token.index + 1 };
  }
  assert.fail('R276:balanced — тело Kotlin сбалансировано');
}
function nativeContract(source: string) {
  // Не запускаем Kotlin как JS. Страж проверяет конкретное тело моста, обе ветви и порядок на настоящем исходнике.
  const clean = withoutKotlinComments(source);
  const signature = /@JavascriptInterface\s+fun\s+setViewerRotation\(on:\s*Boolean\):\s*Boolean\s*\{/.exec(clean);
  assert.ok(signature, 'R276:bridge — метод доступен WebView');
  const body = braced(clean, signature.index + signature[0].length - 1).body;
  const guard = /^\s*if\s*\(resources\.configuration\.smallestScreenWidthDp\s*>=\s*600\)\s*return false\b/.exec(body);
  // >=600 означает: 599 — телефон, ровно 600 и 601 — планшет. >600 ошибочно включает 600dp в телефонную ветку.
  assert.ok(guard, 'R276:tablet-boundary — 599 допускается, 600 и 601 возвращают false до UI');
  const rest = body.slice(guard[0].length);
  const ui = /^\s*runOnUiThread\s*\{/.exec(rest);
  assert.ok(ui, 'R276:ui-thread — ориентация меняется на главном потоке после отказа планшету');
  const block = braced(rest, ui.index + ui[0].length - 1);
  assert.match(block.body, /^\s*this@MainActivity\.requestedOrientation\s*=\s*if\s*\(on\)\s*android\.content\.pm\.ActivityInfo\.SCREEN_ORIENTATION_UNSPECIFIED\s*else\s*android\.content\.pm\.ActivityInfo\.SCREEN_ORIENTATION_PORTRAIT\s*$/,
    'R276:orientation — on снимает фиксацию с учётом автоповорота, off возвращает портрет');
  assert.match(rest.slice(block.end), /^\s*return true\s*$/, 'R276:phone-true — только телефон сообщает об установленном режиме');
}
function mutateNative(from: string, to: string, source = kotlin) {
  const start = source.indexOf('fun setViewerRotation(');
  assert.ok(start >= 0);
  const { end } = braced(source, source.indexOf('{', start));
  return source.slice(0, start) + replaceOnce(source.slice(start, end), from, to) + source.slice(end);
}

it('R276 мост отклоняет планшет от 600dp до UI, телефону разрешает автоповорот и возвращает портрет', () => {
  nativeContract(kotlin);
});
it('R276 контрфакт >600 не выдаёт планшет ровно 600dp за телефон', () => {
  nativeContract(kotlin);
  const mutant = replaceOnce(kotlin, 'smallestScreenWidthDp >= 600', 'smallestScreenWidthDp > 600');
  assert.throws(() => nativeContract(mutant), failure('R276:tablet-boundary'));
});
it('R276 контрфакт PORTRAIT в ветви on не маскируется правильным UNSPECIFIED в комментарии', () => {
  nativeContract(kotlin);
  const from = 'if (on) android.content.pm.ActivityInfo.SCREEN_ORIENTATION_UNSPECIFIED';
  const mutant = replaceOnce(kotlin, from, 'if (on) android.content.pm.ActivityInfo.SCREEN_ORIENTATION_PORTRAIT') + `\n// ${from}\n`;
  assert.throws(() => nativeContract(mutant), failure('R276:orientation'));
});
it('R276 контрфакт изменения ориентации вне главного потока обнаруживается в теле моста', () => {
  nativeContract(kotlin);
  const mutant = mutateNative('runOnUiThread {', 'run {');
  assert.throws(() => nativeContract(mutant), failure('R276:ui-thread'));
});
it('R276 контрфакт позднего отказа планшету не допускает изменение его ориентации', () => {
  nativeContract(kotlin);
  const guard = 'if (resources.configuration.smallestScreenWidthDp >= 600) return false';
  const moved = mutateNative(guard, '');
  const mutant = mutateNative('return true', `${guard}\n      return true`, moved);
  assert.throws(() => nativeContract(mutant), failure('R276:tablet-boundary'));
});

function startupContract(source: string) {
  const file = ts.createSourceFile('main.tsx', source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  const imported = file.statements.some(statement => ts.isImportDeclaration(statement)
    && ts.isStringLiteral(statement.moduleSpecifier) && statement.moduleSpecifier.text === './viewerRotation'
    && statement.importClause?.namedBindings && ts.isNamedImports(statement.importClause.namedBindings)
    && statement.importClause.namedBindings.elements.some(item => item.name.text === 'installViewerRotation'
      && (item.propertyName?.text ?? item.name.text) === 'installViewerRotation'));
  assert.equal(imported, true, 'R276:startup-import — main импортирует настоящий установщик');
  const calls = file.statements.filter(statement => ts.isExpressionStatement(statement) && ts.isCallExpression(statement.expression)
    && ts.isIdentifier(statement.expression.expression) && statement.expression.expression.text === 'installViewerRotation');
  assert.equal(calls.length, 1, 'R276:startup-call — установщик вызван один раз без условной ветки');
  const call = calls[0] as ts.ExpressionStatement;
  assert.ok(ts.isCallExpression(call.expression));
  assert.equal(call.expression.arguments.length, 0, 'R276:startup-args — установщик стартует без аргументов');
  const root = file.statements.find(statement => ts.isVariableStatement(statement)
    && statement.declarationList.declarations.some(declaration => declaration.initializer && ts.isCallExpression(declaration.initializer)
      && ts.isIdentifier(declaration.initializer.expression) && declaration.initializer.expression.text === 'createRoot'));
  assert.ok(root, 'R276:react-root — создание корня найдено');
  assert.equal(call.getStart(file) < root.getStart(file), true, 'R276:startup-order — наблюдение включено до первого React-слоя');
}
it('R276 main устанавливает наблюдение за просмотрщиками до создания React-корня', () => {
  startupContract(main);
});
it('R276 закомментированный вызов установщика не считается запуском наблюдения', () => {
  startupContract(main);
  assert.throws(() => startupContract(replaceOnce(main, '\ninstallViewerRotation();', '\n// installViewerRotation();')),
    failure('R276:startup-call'));
});

// Такой же узкий разбор дерева правил, как в stylesGuards: комментарий не правило,
// вложенный @supports не безусловный ребёнок media; это не браузерная проверка раскладки.
interface CssBlock { header: string; body: string; children: CssBlock[] }
function cssBlocks(source: string): CssBlock[] {
  const clean = source.replace(/\/\*[\s\S]*?\*\//g, '');
  const blocks: CssBlock[] = [];
  let cursor = 0;
  while (cursor < clean.length) {
    const open = clean.indexOf('{', cursor);
    if (open < 0) break;
    const { body, end } = braced(clean, open);
    const header = clean.slice(cursor, open).trim().replace(/\s+/g, ' ');
    blocks.push({ header, body, children: header.startsWith('@') ? cssBlocks(body) : [] });
    cursor = end;
  }
  return blocks;
}
function splitCss(source: string, separator: string) {
  const parts: string[] = [];
  let depth = 0, start = 0;
  for (let i = 0; i < source.length; i++) {
    if (source[i] === '(') depth++;
    else if (source[i] === ')') depth--;
    else if (!depth && source[i] === separator) { parts.push(source.slice(start, i).trim()); start = i + 1; }
  }
  assert.equal(depth, 0, 'R276:css-balanced — выражение CSS сбалансировано');
  return [...parts, source.slice(start).trim()];
}
function declarations(blocks: CssBlock[], selector: string) {
  const values = new Map<string, string>();
  for (const block of blocks) if (!block.header.startsWith('@') && splitCss(block.header, ',').includes(selector)) {
    for (const declaration of splitCss(block.body, ';')) {
      const colon = declaration.indexOf(':');
      if (colon >= 0) values.set(declaration.slice(0, colon).trim(), declaration.slice(colon + 1).trim().replace(/\s+/g, ' '));
    }
  }
  return values;
}
function landscapeContract(source: string) {
  const blocks = cssBlocks(source);
  const scopes = blocks.filter(block => block.header === media);
  assert.equal(scopes.length, 1, 'R276:touch-landscape — landscape до 500px только без hover, не узкое окно ПК');
  const phone = scopes[0].children;
  for (const selector of ['.lightbox .lb-stage', '.lightbox .lb-stage.has-caption', '.lightbox .lb-stage.video'])
    assert.equal(declarations(phone, selector).get('padding'), 'var(--sa-t) var(--sa-r) var(--sa-b) var(--sa-l)',
      `R276:stage-insets — ${selector} занимает экран с четырьмя системными вставками, без полей ПК`);
  const photo = declarations(phone, '.lightbox .lb-img');
  const image = new Map([...declarations(blocks, '.lb-img'), ...declarations(phone, '.lb-img'), ...photo]);
  for (const axis of ['width', 'height']) assert.equal(image.get(`max-${axis}`), '100%', `R276:image-fit — max-${axis} ограничен сценой`);
  assert.equal(photo.get('border-radius'), '0', 'R276:photo-flat — снимок без скруглённой карточки');
  assert.equal(photo.get('box-shadow'), 'none', 'R276:photo-flat — снимок без тени карточки');
  assert.equal(declarations(phone, '.lightbox .lb-nav').get('display'), 'none', 'R276:no-arrows — в ландшафте листают пальцем');
  assert.equal(declarations(phone, '.lightbox .lb-top').get('padding-left'), 'var(--sa-l)', 'R276:top-inset — назад не уходит под вырез');
  assert.equal(declarations(phone, '.lightbox .lb-count').get('top'), 'calc(56px + max(env(safe-area-inset-top), var(--gv-sat, 0px)) + 10px)',
    'R276:count-inset — счётчик ниже шапки и native/browser вставки');
  for (const [selector, gap] of [['.pick-top', '12px'], ['.pick-bar', '10px']]) for (const [side, token] of [['left', 'l'], ['right', 'r']])
    assert.equal(declarations(phone, selector).get(`padding-${side}`), `calc(${gap} + var(--sa-${token}))`,
      `R276:pick-insets — ${selector} ${side} защищён собственной вставкой`);
}
function mutateLandscape(from: string, to: string) {
  const anchor = css.indexOf(media);
  assert.ok(anchor >= 0);
  const open = css.indexOf('{', anchor), { end } = braced(css, open);
  return css.slice(0, anchor) + replaceOnce(css.slice(anchor, end), from, to) + css.slice(end);
}
it('R276 низкий сенсорный ландшафт вписывает фото и видео, сохраняет вставки и убирает стрелки', () => {
  landscapeContract(css);
  landscapeContract(css + `\n/* ${media} { .lightbox .lb-nav { display: flex; } } */`);
});
it('R276 контрфакт hover:hover не подменяет телефонный media правильным комментарием', () => {
  landscapeContract(css);
  const mutant = replaceOnce(css, media, media.replace('hover: none', 'hover: hover')) + `\n/* ${media} {} */`;
  assert.throws(() => landscapeContract(mutant), failure('R276:touch-landscape'));
});
it('R276 контрфакт полей ПК вместо четырёх системных вставок уменьшает сцену и обнаруживается', () => {
  landscapeContract(css);
  assert.throws(() => landscapeContract(mutateLandscape('padding: var(--sa-t) var(--sa-r) var(--sa-b) var(--sa-l);', 'padding: 64px 76px 84px;')),
    failure('R276:stage-insets'));
});
it('R276 контрфакты потери ограничения каждой оси изображения ловятся по живому базовому правилу', () => {
  for (const axis of ['width', 'height']) {
    landscapeContract(css);
    const anchor = '.lb-img {', start = css.indexOf(anchor), { end } = braced(css, start + anchor.length - 1);
    const mutant = css.slice(0, start) + replaceOnce(css.slice(start, end), `max-${axis}: 100%;`, `max-${axis}: none;`) + css.slice(end);
    assert.throws(() => landscapeContract(mutant), failure('R276:image-fit'));
    landscapeContract(css);
    assert.throws(() => landscapeContract(mutateLandscape('.lightbox .lb-img {', `.lightbox .lb-img { max-${axis}: none;`)),
      failure('R276:image-fit'));
  }
});
it('R276 контрфакт видимых стрелок не скрывается правильным правилом в комментарии', () => {
  landscapeContract(css);
  assert.throws(() => landscapeContract(mutateLandscape('display: none;', 'display: flex;') + '\n/* .lightbox .lb-nav { display: none; } */'),
    failure('R276:no-arrows'));
});
it('R276 контрфакты потери левой и правой вставки обеих панелей галереи обнаруживаются отдельно', () => {
  for (const [selector, gap] of [['.pick-top', '12px'], ['.pick-bar', '10px']]) for (const [side, token] of [['left', 'l'], ['right', 'r']]) {
    landscapeContract(css);
    // Одинаковое корректное выражение на соседней панели не спасает кнопку под вырезом.
    assert.throws(() => landscapeContract(mutateLandscape(`padding-${side}: calc(${gap} + var(--sa-${token}));`, `padding-${side}: ${gap};`)),
      failure(`R276:pick-insets — ${selector} ${side}`));
  }
});
