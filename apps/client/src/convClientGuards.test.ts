import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { describe, it } from 'node:test';
import { counterfact } from '../../../packages/shared/test/counterfacts';
import ts from 'typescript';
import { DM_SERVER_UPDATE_TEXT, dmNeedsServerUpdate } from './dmRules';

const source = (path: string) => readFileSync(new URL(path, import.meta.url), 'utf8');

const DRAFT = 'R369/wiring/check/';
function tree(raw: string, name: string) {
  if (raw.length > 1_000_000) throw new Error('R369/wiring/budget/source');
  const ast = ts.createSourceFile(name, raw, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  const errors = (ast as ts.SourceFile & { parseDiagnostics: readonly unknown[] }).parseDiagnostics;
  assert.equal(errors.length, 0, 'R369/wiring/setup/TSX');
  return ast;
}
const compact = (node: ts.Node, ast: ts.SourceFile) => node.getText(ast).replace(/\s/g, '');

function checkDraftWiring(raw: string) {
  const ast = tree(raw, 'MessagePane.tsx');
  const pane = ast.statements.filter((node): node is ts.FunctionDeclaration => ts.isFunctionDeclaration(node) && node.name?.text === 'MessagePane');
  assert.equal(pane.length, 1, 'R369/wiring/setup/одна-лента');
  assert.equal(pane[0].modifiers?.some(node => node.kind === ts.SyntaxKind.ExportKeyword), true, 'R369/wiring/setup/экспорт-ленты');
  assert.ok(pane[0].body, 'R369/wiring/setup/тело-ленты');
  const statements = pane[0].body.statements;
  if (statements.length > 2_000) throw new Error('R369/wiring/budget/statements');
  const effects = statements.filter(ts.isExpressionStatement).map(node => node.expression)
    .filter((node): node is ts.CallExpression => ts.isCallExpression(node)
      && ts.isIdentifier(node.expression) && node.expression.text === 'useEffect');
  const callbacks = effects.map(node => node.arguments[0]).filter((node): node is ts.ArrowFunction => !!node && ts.isArrowFunction(node));
  const write = callbacks.filter(node => ts.isBlock(node.body) && node.body.statements.some(statement => ts.isVariableStatement(statement)
    && statement.declarationList.declarations.some(declaration => ts.isIdentifier(declaration.name) && declaration.name.text === 'v'
      && declaration.initializer && ts.isCallExpression(declaration.initializer)
      && ts.isIdentifier(declaration.initializer.expression) && declaration.initializer.expression.text === 'draftToSave')));
  assert.equal(write.length, 1, 'R369/wiring/setup/настоящий-эффект-черновика');
  const body = write[0].body as ts.Block;
  const parts = body.statements.map(node => compact(node, ast));
  const quiet = parts.indexOf('if(!draftTyped.current&&quiet&&quiet.text===v.text&&quiet.replyToId===v.replyToId)return;');
  const typed = parts.indexOf('draftTyped.current=true;');
  const last = parts.indexOf('draftLast.current=v;');
  const save = parts.indexOf('draftSaver.change(v);');
  assert.equal(quiet >= 0 && quiet < typed && typed < last && last < save, true, DRAFT + 'тихое-до-записи');

  const cleanups = callbacks.map(node => ts.isArrowFunction(node.body) ? node.body : undefined);
  const restage = cleanups.findIndex(node => node && ts.isBlock(node.body)
    && compact(node.body, ast) === '{if(draftTyped.current&&draftLast.current&&!draftSaver.pending())draftSaver.change(draftLast.current);}');
  const flush = cleanups.findIndex(node => node && compact(node.body, ast) === 'draftSaver.flush()');
  const leave = cleanups.findIndex(node => node && compact(node.body, ast) === 'onDraftLeaveRef.current?.()');
  assert.equal(restage >= 0 && restage < flush && flush < leave, true, DRAFT + 'последнее-flush-leave');
}

function checkLeaveWire(raw: string) {
  const ast = tree(raw, 'DmChatView.tsx');
  const views = ast.statements.filter((node): node is ts.FunctionDeclaration => ts.isFunctionDeclaration(node) && node.name?.text === 'DmChatView');
  assert.equal(views.length, 1, 'R369/wiring/setup/один-вид-ЛС');
  assert.equal(views[0].modifiers?.some(node => node.kind === ts.SyntaxKind.ExportKeyword), true, 'R369/wiring/setup/экспорт-вида-ЛС');
  assert.ok(views[0].body, 'R369/wiring/setup/тело-вида-ЛС');
  const panes: ts.JsxAttributes[] = [];
  let visited = 0;
  const visit = (node: ts.Node) => {
    if (++visited > 100_000) throw new Error('R369/wiring/budget/AST');
    if ((ts.isJsxOpeningElement(node) || ts.isJsxSelfClosingElement(node)) && node.tagName.getText(ast) === 'MessagePane') panes.push(node.attributes);
    ts.forEachChild(node, visit);
  };
  visit(views[0].body);
  assert.equal(panes.length, 1, 'R369/wiring/setup/один-MessagePane');
  const prop = panes[0].properties.find((node): node is ts.JsxAttribute => ts.isJsxAttribute(node) && node.name.getText(ast) === 'onDraftLeave');
  assert.ok(prop?.initializer && ts.isJsxExpression(prop.initializer) && prop.initializer.expression
    && ts.isArrowFunction(prop.initializer.expression), DRAFT + 'есть-живой-onDraftLeave');
  const callback = prop.initializer.expression;
  assert.equal(callback.parameters.length, 0, DRAFT + 'уход-без-чужого-id');
  assert.equal(compact(callback.body, ast), 'useStore.getState().convDraftLeave(dm.id)', DRAFT + 'уход-именно-этой-беседы');
}

function replaced(raw: string, before: string, after: string) {
  assert.equal(raw.split(before).length - 1, 1, 'R369/wiring/setup/единственный-якорь');
  return raw.replace(before, after);
}
function failure(address: string) {
  return (error: unknown) => error instanceof assert.AssertionError && error.message.startsWith(address);
}

describe('стыки нового пути личных бесед', () => {
  it('conv1 без conv2 требует обновления сервера, обе возможности включают беседы без локального переключателя', () => {
    // После удаления старых API нельзя обещать переписку с сервером без новой рассылки.
    assert.equal(dmNeedsServerUpdate(['conv1']), true);
    assert.equal(dmNeedsServerUpdate(['conv1', 'conv2']), false);
    assert.equal(DM_SERVER_UPDATE_TEXT, 'ЛС на этом сервере требуют обновления сервера');
    const app = source('./App.tsx');
    assert.match(app, /const active = !!features\?\.includes\(CAP_CONV1\)\s*&&\s*!!features\?\.includes\(FEATURE_CONV2\);\s*st\.setConvActive\(active\)/);
    assert.doesNotMatch(app, /convClientSwitch/);
  });
  it('черновик не пересоздаёт стор при равном значении и удаляется после очистки поля', () => {
    // Ловит дорогие перерисовки ленты на каждой букве и возврат очищенного черновика.
    const s = source('./store.ts');
    assert.match(s, /const drafts = updateDrafts\(s\.drafts, convId, text, replyToId\)/);
    assert.match(s, /return drafts === s\.drafts \? s : \{ drafts \}/);
  });

  it('лента начинает с черновика, сохраняет состояние до правки и при размонтировании', () => {
    // Ловит потерю текста при входе в голос и запись редактируемого сообщения вместо черновика.
    const s = source('./components/MessagePane.tsx');
    assert.match(s, /useState\(draft\?\.text \?\? ''\)/);
    checkDraftWiring(s);
    assert.match(s, /beforeEdit: before && \{ text: before\.text, replyToId: before\.replyingTo\?\.id \?\? null \}/);
    assert.match(s, /if \(!onDraftRef\.current\) return/);
    assert.match(s, /useEffect\(\(\) => \(\) => draftSaver\.flush\(\), \[draftSaver\]\)/);
    counterfact(() => {
    const quiet = '    if (!draftTyped.current && quiet && quiet.text === v.text && quiet.replyToId === v.replyToId) return;';
    assert.throws(() => checkDraftWiring(replaced(s, quiet, '')), failure(DRAFT + 'тихое-до-записи'));
    const cleanup = '  useEffect(() => () => draftSaver.flush(), [draftSaver]);\n  useEffect(() => () => onDraftLeaveRef.current?.(), []);';
    const normalized = s.replace(/\r\n/g, '\n');
    assert.throws(() => checkDraftWiring(replaced(normalized, cleanup,
      '  useEffect(() => () => onDraftLeaveRef.current?.(), []);\n  useEffect(() => () => draftSaver.flush(), [draftSaver]);')),
    failure(DRAFT + 'последнее-flush-leave'));
    });
  });

  it('вид ЛС берёт черновик однократно, без подписки на каждую букву', () => {
    // Ловит пересоздание всей ленты при вводе текста черновика.
    const s = source('./components/DmChatView.tsx');
    assert.match(s, /useState\(\(\) => useStore\.getState\(\)\.drafts\[dm\.id\]\)/);
    assert.doesNotMatch(s, /useStore\(\(s\) => s\.drafts/);
    checkLeaveWire(s);
    counterfact(() => {
    assert.throws(() => checkLeaveWire(replaced(s, 'convDraftLeave(dm.id)', "convDraftLeave('other-chat')")),
      failure(DRAFT + 'уход-именно-этой-беседы'));
    });
  });

  it('очередь у ленты отправляет через enqueue, каналы сохраняют прежний onSend с тем же ключом', () => {
    // Ловит двойную отправку в режиме бесед и потерю идемпотентного ключа на старом пути.
    const s = source('./components/MessagePane.tsx');
    assert.match(s, /if \(outbox\) \{[\s\S]{0,160}outbox\.enqueue\(/);
    assert.match(s, /onSend\(item\.content, item\.files, item\.replyToId, item\.key\)/);
    assert.match(s, /outbox \? outbox\.items : outgoing\.filter/);
    assert.match(s, /clientId === o\.key/);
  });

  it('выход дожидается стирания кеша до перезагрузки интерфейса', () => {
    // Ловит возвращение старых личных сообщений после мгновенной перезагрузки.
    for (const path of ['./components/MobileProfile.tsx', './components/UserSettingsModal.tsx']) {
      const s = source(path);
      assert.ok(/await logout\(\);\s*(?:onClose\(\);\s*)?location\.reload\(\)/.test(s), path);
      assert.ok(!/(?<!await )logout\(\);\s*(?:onClose\(\);\s*)?location\.reload\(\)/.test(s), path);
    }
  });

  it('поколение сброса отменяет ответы старой догонки и старой отправки', () => {
    // Ловит примешивание данных прежнего аккаунта после переключения инстанса.
    const s = source('./convStore.ts');
    assert.match(s, /convReset: \(\) => \{\s*gen\+\+/);
    assert.match(s, /if \(myGen !== gen\) return/);
    assert.match(s, /for \(const t of pumpTimers\.values\(\)\) clearTimeout\(t\)/);
    assert.match(s, /sending\.clear\(\)/);
  });

  it('шлюз всегда объявляет conv1, а догонка запускается только при поддержке бесед сервером', () => {
    // Старых обработчиков больше нет: переключение режима не должно вернуть серверу старую доставку.
    const s = source('./sockets.ts');
    assert.match(s, /const caps(?::[^=;]+)?\s*=\s*\[CAP_CONV1\]/);
    assert.match(s, /t: 'identify',[\s\S]{0,180}caps: \[\.\.\.caps,/);
    assert.match(s, /if \(store\.convActive\) void store\.convOnReady\(\)/);
  });

  it('старый токен не уходит в чужой API при нескольких инстансах', () => {
    // Ловит утечку bearer-токена через запасной ключ старой установки.
    const s = source('./api.ts');
    assert.match(s, /if \(active\?\.token\) return active\.token/);
    assert.match(s, /instances\(\)\.length <= 1 \? localStorage\.getItem\('gv_token'\) : null/);
  });

  it('при старте метка своего ключа снимается после уборки, но до чтения и записи кеша', () => {
    // Ловит удаление новых черновиков следующей загрузкой либо подъём данных до отложенной очистки.
    const s = source('./App.tsx');
    const body = s.slice(s.indexOf('async function decideConvMode'), s.indexOf('function bounceStrandedGuestHome'));
    const at = (needle: string) => body.indexOf(needle);
    assert.ok(at('await finishConvCacheWipes()') < at('clearConvCacheWipe(key)'));
    assert.ok(at('clearConvCacheWipe(key)') < at('await readConvCache(key)'));
    assert.ok(at('await readConvCache(key)') < at('startConvCacheWriter()'));
  });

  it('приглашение оставляет восстановление места, а забранный адресный пуш его подавляет', () => {
    // Ловит открытие старого канала поверх намеренного перехода и зависание окна приглашения без места.
    const push = source('./nativeUnifiedPush.ts');
    const app = source('./App.tsx');
    assert.match(push, /return !link\.startsWith\('invite:'\)/);
    assert.match(app, /const tookLink = consumeDeepLink\(\)/);
    assert.match(app, /if \(!tookLink && !st\.currentServerId && !st\.currentDmId\)/);
  });

  it('чужое прочтение отмечает посещение только при нуле, росте ключа и вне открытой ленты', () => {
    // Ловит перенос черты «новые» у читающего или её возврат после другого устройства.
    const s = source('./convStore.ts');
    const body = s.slice(s.indexOf('function takeSummary'), s.indexOf('function takeMessage'));
    assert.match(body, /applied\.unread === 0/);
    assert.match(body, /applied\.lastReadKey > before\.lastReadKey/);
    assert.match(body, /onScreenId\(get\(\)\) !== s\.id/);
    assert.match(body, /markChannelSeen\(s\.id/);
  });

  it('профиль обновляет сводки бесед, а выход метит всю семью до удаления кешей', () => {
    // Ловит старое имя в списке ЛС и оставшуюся гостевую переписку после выхода из дома.
    const s = source('./store.ts');
    assert.match(s, /const conv = patchPeer\(s\.conv, userId, displayName, avatarUrl\)/);
    const body = s.slice(s.indexOf('logout: () => {'), s.indexOf('loadPushMutes: async'));
    assert.match(body, /i\.id !== homeId && i\.guestOf !== homeId/);
    assert.ok(body.indexOf('for (const k of cacheKeys) markConvCacheWipe(k)') < body.indexOf('deleteConvCache(k)'));
    assert.match(body, /if \(ok\) clearConvCacheWipe\(k\)/);
  });
});
