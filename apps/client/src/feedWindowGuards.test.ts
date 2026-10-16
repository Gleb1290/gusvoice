import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { it } from 'node:test';
import { runInNewContext } from 'node:vm';
import ts from 'typescript';
const src = (name: string) => readFileSync(new URL(`./${name}`, import.meta.url), 'utf8');

it('ожидание места не подгружает stale окно и ограничивает догрузку одним сроком', () => {
  const s = src('components/MessagePane.tsx');
  const body = s.slice(s.indexOf('function settlePlace('), s.indexOf('function scrollToRow('));
  for (const pattern of [/Date\.now\(\) >= p\.until/, /r === 'missing'\) return/, /p\.applied = true/, /if \(fw\?\.stale\) return/, /if \(p\.until === undefined\)/, /p\.until = Date\.now\(\) \+ 2000/, /loadNewer\(\)/, /loadOlderWindowed\(\)/]) assert.match(body, pattern);
  assert.ok(body.indexOf('if (fw?.stale) return') < body.indexOf('loadNewer()'));
  assert.match(s, /stale/); assert.match(src('components/DmChatView.tsx'), /stale: !!win\?\.stale/);
});
it('якорь держится до последней операции и следует за прокруткой и переходом человека', () => {
  const s = src('components/MessagePane.tsx');
  assert.match(s, /heldOps\.current\+\+/); assert.match(s, /heldOps\.current--/);
  assert.match(s, /if \(heldOps\.current === 0\) heldAnchor\.current = null/);
  assert.match(s, /heldOps\.current > 0\) heldAnchor\.current = captureAnchor\(\) \?\? heldAnchor\.current/);
  assert.ok((s.match(/followHeld\(\);/g) ?? []).length >= 5);
  assert.match(s, /navMessages\.current === messages/); assert.match(s, /ownMessage = added > 0 &&/);
});
it('черновик первого кадра не отправляется, удалённое поле не затирает правку и текущий набор', () => {
  const s = src('components/MessagePane.tsx');
  assert.match(s, /if \(!draftSeen\.current\) \{\s*draftSeen\.current = true;\s*return;/);
  assert.match(s, /if \(composerEdit \|\| draftSaver\.pending\(\)\) return/);
  assert.match(s, /document\.activeElement === input && text\.trim\(\)/);
  assert.match(src('components/DmChatView.tsx'), /s\.draftRev\[dm\.id\]/);
  assert.match(src('App.tsx'), /onConvCacheFlushed\(\(\) => useStore\.getState\(\)\.convFlushDrafts\(true\)\)/);
  assert.match(src('api.ts'), /convDraft:[\s\S]*?body, \{ keepalive \}\)/);
});
it('срочная запись черновика предшествует сбросу инстанса и у ленты есть срочный хук', () => {
  const s = src('instanceSwitch.ts'); const start = s.indexOf('function teardownCurrent('); const body = s.slice(start, start + 2500);
  assert.ok(body.indexOf('flushConvCacheNow()') >= 0);
  assert.ok(body.indexOf('flushConvCacheNow()') < body.indexOf('switchedInstance()'));
  assert.match(src('components/MessagePane.tsx'), /onConvCacheUrgent\(\(\) => draftSaver\.flush\(\)\)/);
});
it('визит снимает readKey раньше readDmNow и снимает обе подписки ухода', () => {
  const s = src('channelVisit.ts'); assert.ok(s.indexOf('setReadKey(useStore') < s.indexOf('readDmNow(id)'));
  for (const name of ['pagehide', 'visibilitychange']) {
    assert.ok(s.includes(`addEventListener('${name}'`)); assert.ok(s.includes(`removeEventListener('${name}'`));
  }
  const pane = src('components/MessagePane.tsx'); assert.match(pane, /if \(pending\.applied\) return/);
  assert.match(pane, /pendingScroll\.current\?\.kind === 'place'\) return/);
});
it('пузыри ограничены ЛС: каналы не передают bubbles, хвост следует следующей строке и дню', () => {
  const s = src('components/MessagePane.tsx');
  for (const [name, expected] of [['DmChatView', true], ['ChatView', false]] as const) {
    const ast = ts.createSourceFile(`${name}.tsx`, src(`components/${name}.tsx`), ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
    const panes: ts.JsxAttributes[] = [];
    const visit = (node: ts.Node) => {
      if ((ts.isJsxSelfClosingElement(node) || ts.isJsxOpeningElement(node)) && node.tagName.getText(ast) === 'MessagePane') panes.push(node.attributes);
      ts.forEachChild(node, visit);
    };
    visit(ast);
    assert.equal(panes.length, 1, name);
    const bubbles = panes[0].properties.find((p) => ts.isJsxAttribute(p) && p.name.getText(ast) === 'bubbles');
    assert.equal(!!bubbles, expected, name);
    if (bubbles && ts.isJsxAttribute(bubbles)) assert.equal(bubbles.initializer, undefined, 'ЛС всегда передают bubbles=true');
  }
  assert.match(s, /const next = p\.messages\[i \+ 1\]/); assert.match(s, /!isGrouped\(/);
  assert.match(s, /tail=\{p\.bubbles && tail\}/);
  const bubble = src('components/MessageBubble.tsx');
  assert.match(bubble, /side === 'out' \? 'mine' : 'theirs'/); assert.match(bubble, /message-main bubble/);
  assert.doesNotMatch(bubble, /msg-gutter|message-head/);
  assert.match(s, /<MessageBubble[\s\S]*?side="out"/);
});
it('время пузыря выбирает ровно одно место для текста, фото, карточек и реакций', () => {
  const s = src('components/MessagePane.tsx');
  const ast = ts.createSourceFile('MessagePane.tsx', s, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  let expression: string | undefined;
  const visit = (node: ts.Node) => {
    if (ts.isVariableDeclaration(node) && node.name.getText(ast) === 'metaAt' && node.initializer) expression = node.initializer.getText(ast);
    ts.forEachChild(node, visit);
  };
  visit(ast); assert.ok(expression);
  for (const hasReactions of [false, true]) for (const media of [false, true]) for (const content of ['', 'текст']) for (const preview of [false, true]) for (const attachments of [false, true]) {
    const look = { kind: media ? 'media' : 'text' }; const previews = preview ? [{}] : []; const m = { content, attachments: attachments ? [{}] : [] };
    const where = runInNewContext(`(${expression})`, { hasReactions, media, look, previews, m });
    const expected = hasReactions ? 'reactions' : media && !content ? 'over' : content && !preview && (media || !attachments) ? 'body' : 'row';
    assert.equal(where, expected);
  }
  for (const location of ['body', 'over', 'row']) assert.ok(s.includes(`metaAt === '${location}' ?`));
});
it('стили пузыря изолированы классом bub и не меняют обычные строки каналов', () => {
  const css = src('styles.css');
  const block = css.slice(css.indexOf('/* ── ЛС как в Telegram'));
  const selectors = [...block.matchAll(/(?:^|\n)([^{}]+)\{/g)].map((m) => m[1].replace(/\/\*[\s\S]*?\*\//g, '').trim()).filter((s) => s.includes('.bubble') || s.includes('.bub-meta'));
  assert.ok(selectors.length > 10);
  for (const selector of selectors) for (const part of selector.split(',')) assert.match(part, /\.message\.bub|\.messages\.bubbles/);
});
it('широкий вид меняет только свои пузыри, телефон не перезаписывает позицию скачивания', () => {
  const css = src('styles.css').replace(/\/\*[\s\S]*?\*\//g, '');
  for (const m of css.matchAll(/([^{}]*\.bub-left[^{}]*)\{/g)) assert.match(m[1], /\.message\.bub\.mine/);
  assert.match(css, /\.message\.bub \.reaction\.add,\s*\.message\.bub \.att-dl\s*\{\s*display: none/);
  const rawCss = src('styles.css');
  const phone = rawCss.slice(rawCss.indexOf('/* ===== Телефон: зоны касания'), rawCss.indexOf('/* ── ЛС как в Telegram')).replace(/\/\*[\s\S]*?\*\//g, '');
  for (const m of phone.matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
    if (m[1].split(',').some((selector) => selector.trim() === '.att-dl')) assert.doesNotMatch(m[2], /position:\s*relative/);
  }
  const pane = src('components/MessagePane.tsx'); assert.match(pane, /!bubbles/); assert.match(pane.slice(pane.indexOf('const [bubLeft'), pane.indexOf('const [bubLeft') + 1700), /isMobile\(\)/);
  assert.match(pane, /bubbles \? \(bubLeft \?/);
});
it('детали пузырей есть в экспортах и карте выгрузки, каждый ключ карты действительно экспортирован', () => {
  const s = src('designSystem.ts'); const ast = ts.createSourceFile('designSystem.ts', s, ts.ScriptTarget.Latest, true);
  const names: string[] = [];
  for (const stmt of ast.statements) {
    if (!ts.isExportDeclaration(stmt) || !stmt.moduleSpecifier || !stmt.moduleSpecifier.getText(ast).includes('./components/') || !stmt.exportClause || !ts.isNamedExports(stmt.exportClause)) continue;
    for (const item of stmt.exportClause.elements) if (!item.isTypeOnly && /^[A-Z]/.test(item.name.text)) names.push(item.name.text);
  }
  const config = JSON.parse(readFileSync(new URL('../../../.design-sync/config.json', import.meta.url), 'utf8'));
  const mapped = Object.keys(config.componentSrcMap);
  for (const name of mapped) assert.ok(names.includes(name), name);
  for (const name of ['MessageBubble', 'BubbleMeta', 'DayDivider', 'ReplyQuote']) assert.ok(mapped.includes(name), name);
  assert.deepEqual([...mapped].sort(), [...names].sort(), 'экспорты компонентов и карта обязаны совпадать в обе стороны');
});
