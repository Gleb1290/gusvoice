import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { it } from 'node:test';
import ts from 'typescript';

const source = (file: string) => readFileSync(new URL(`../${file}.ts`, import.meta.url), 'utf8').replace(/\r\n/g, '\n');
function ast(raw: string) { return ts.createSourceFile('voice-guard.ts', raw, ts.ScriptTarget.Latest, true); }
function nodes(root: ts.Node, match: (n: ts.Node) => boolean) {
  const out: ts.Node[] = []; function visit(n: ts.Node) { if (match(n)) out.push(n); ts.forEachChild(n, visit); } visit(root); return out;
}
function calls(root: ts.Node, name: string): ts.CallExpression[] {
  return nodes(root, n => ts.isCallExpression(n) && (ts.isIdentifier(n.expression) ? n.expression.text === name
    : ts.isPropertyAccessExpression(n.expression) && n.expression.name.text === name)) as ts.CallExpression[];
}
function fn(file: ts.SourceFile, name: string) {
  const found = nodes(file, n => ts.isFunctionDeclaration(n) && n.name?.text === name) as ts.FunctionDeclaration[];
  assert.equal(found.length, 1, `функция ${name} найдена единожды`); return found[0];
}
function scope(node: ts.Node) {
  let parent = node.parent;
  while (parent && !ts.isFunctionDeclaration(parent) && !ts.isArrowFunction(parent) && !ts.isFunctionExpression(parent)) parent = parent.parent;
  assert.ok(parent, 'вызов находится в функции'); return parent;
}
const compact = (raw: string) => raw.replace(/\s+/g, '');
const dropSoonStatement = "await import('../bots/botVoice.js').then((m) => m.dropBotVoice(botId), () => undefined);";
function dropSoonCoverage(raw: string) {
  const body = fn(ast(raw), 'dropBotVoiceSoon').body;
  assert.ok(body);
  // Иначе пустой helper или вызов с чужим id сохраняет прежний страж caller зелёным.
  assert.equal(compact(body.getText()), compact(`{${dropSoonStatement}}`),
    'R306_DROP_HELPER: целое тело загружает голосовой модуль и передаёт исходный botId');
}
function settingsCoverage(raw: string) {
  const file = ast(raw);
  const routes = calls(file, 'put').filter(c => ts.isStringLiteral(c.arguments[0]) && c.arguments[0].text === '/admin/bots/settings');
  assert.equal(routes.length, 1, 'маршрут настроек найден единожды');
  const callback = routes[0].arguments[1];
  assert.ok(callback && ts.isArrowFunction(callback));
  const drops = calls(callback, 'dropAllBotsVoice');
  assert.equal(drops.length, 1, 'R306_SETTINGS_GATE: настройки вызывают один общий выход из голоса');
  let gate: ts.Node | undefined = drops[0].parent;
  while (gate && gate !== callback && !ts.isIfStatement(gate)) gate = gate.parent;
  assert.ok(gate && ts.isIfStatement(gate), 'R306_SETTINGS_GATE: общий выход обусловлен переходом настроек');
  assert.equal(compact(gate.expression.getText()), 'botVoiceEnabled(prev)&&!botVoiceEnabled(next)',
    'R306_SETTINGS_GATE: только переход из разрешённого голоса в запрещённый');
  assert.equal(compact(gate.thenStatement.getText()),
    compact("{await import('../bots/botVoice.js').then((m) => m.dropAllBotsVoice(), () => undefined);}"),
    'R306_SETTINGS_GATE: ветка исполняет настоящий общий выход, а не хранит мёртвый callback');
}
const dispatcherBody = `{
  return async (ctx, p) => {
    const mod = await import('../bots/botVoice.js');
    return mod[name](ctx, p);
  };
}`;
function dispatcherCoverage(raw: string) {
  const body = fn(ast(raw), 'voiceMethod').body;
  assert.ok(body);
  assert.equal(compact(body.getText()), compact(dispatcherBody),
    'R306_VOICE_DISPATCH: целый dispatcher возвращает результат выбранного метода с исходными ctx и p');
}
function closeCoverage(raw: string, name: string) {
  const file = ast(raw), closes = calls(file, 'closeBotSockets');
  assert.equal(closes.length, name === 'routes/bots' ? 3 : 1, 'все входы closeBotSockets известны');
  for (const call of closes) {
    const owner = scope(call);
    const drop = [...calls(owner, 'dropBotVoiceSoon'), ...calls(owner, 'dropBotVoice'), ...calls(owner, 'dropAllBotsVoice')];
    assert.equal(drop.length, 1, 'R306 каждый вход закрытия потребителя выкидывает из голоса');
    assert.equal(drop[0].pos > call.pos, true, 'сначала отозван Bot API, затем голос');
  }
}
for (const name of ['routes/bots', 'bots/botLifecycle']) it(`R306 закрытие бота и голоса согласованы во всех входах ${name}`, () => closeCoverage(source(name), name));
it('R306 helper выхода действительно загружает голос и передаёт id закрытого бота', () => dropSoonCoverage(source('routes/bots')));
// Поведение PUT на PGlite проверяет botVoice.itest; здесь только полная проводка перехода настроек.
it('R306 выключение голоса в настройках связано с dropAllBotsVoice правильным условием', () => settingsCoverage(source('routes/bots')));
it('R306 dispatcher голосовых методов загружает нужный модуль и возвращает его результат', () => dispatcherCoverage(source('routes/botApi')));
it('R306 удаление владельца идёт через общий deleteBot, а не отдельный неполный путь', () => {
  const file = ast(source('bots/botLifecycle')); const c = calls(fn(file, 'deleteBotsOwnedBy'), 'deleteBot');
  assert.equal(c.length, 1); assert.equal(c[0].arguments[0].getText(file), 'r.id');
});
it('R306 выход и бан бота чистят только комнаты снятого сервера', () => {
  const file = ast(source('bots/botChannel')), body = fn(file, 'memberBotUpdates');
  const gates = nodes(body, n => ts.isIfStatement(n) && n.expression.getText(file) === "c.to === 'left' || c.to === 'kicked'") as ts.IfStatement[];
  assert.equal(gates.length, 1);
  const c = calls(gates[0].thenStatement, 'dropBotVoice');
  assert.equal(c.length, 1); assert.deepEqual(c[0].arguments.map(n => n.getText(file)), ['c.userId', 'c.serverId']);
  assert.equal(calls(body, 'dropBotVoice').length, 1);
});
it('R306 страховка голоса включена в минутный проход доставки, а не только в разовую уборку', () => {
  const file = ast(source('bots/webhookDelivery')); const body = fn(file, 'startBotJobs');
  assert.equal(calls(body, 'sweepBotVoice').length, 1);
  const sweep = nodes(body, n => ts.isVariableDeclaration(n) && n.name.getText(file) === 'sweep')[0]; assert.ok(sweep);
  assert.equal(calls(sweep, 'sweepBotVoice').length, 1);
  assert.equal(calls(body, 'setInterval').some(c => c.arguments[0]?.getText(file) === 'sweep' && c.arguments[1]?.getText(file) === '60_000'), true);
});
it('R306 три метода Bot API направлены в голосовой модуль', () => {
  const file = ast(source('routes/botApi'));
  for (const [key, value] of [['joinvoice', 'voiceJoin'], ['leavevoice', 'voiceLeave'], ['getvoicechatmembers', 'voiceMembers']]) {
    const properties = nodes(file, n => ts.isPropertyAssignment(n) && n.name.getText(file) === key) as ts.PropertyAssignment[];
    assert.equal(properties.length, 1); const c = properties[0].initializer;
    assert.equal(ts.isCallExpression(c) && c.expression.getText(file) === 'voiceMethod' && ts.isStringLiteral(c.arguments[0]) && c.arguments[0].text === value, true);
  }
});
for (const [name, from, to] of [
  ['routes/bots', "closeBotSockets(id, 4001, 'token revoked');\n      await dropBotVoiceSoon(id);", "closeBotSockets(id, 4001, 'token revoked');"],
  ['bots/botLifecycle', "await import('./botVoice.js').then((m) => m.dropBotVoice(botId), () => undefined);", '// голос забыли'],
] as const) it(`R306 контрфакт: закрытие без выхода из голоса ${name}`, () => {
  const raw = source(name); closeCoverage(raw, name); assert.equal(raw.split(from).length - 1, 1);
  assert.throws(() => closeCoverage(raw.replace(from, to), name), e => e instanceof assert.AssertionError
    && e.message.startsWith('R306 каждый вход закрытия потребителя') && e.actual === 0 && e.expected === 1);
});

function mutation(raw: string, from: string, to: string, probe: (raw: string) => void, marker: string) {
  assert.equal(raw.split(from).length - 1, 1, 'уникальный якорь адресного контрфакта');
  probe(raw);
  assert.throws(() => probe(raw.replace(from, to)), e => e instanceof assert.AssertionError
    && e.operator === 'strictEqual' && e.message.startsWith(marker), 'контрфакт отвергается именно нарушенным стражем');
}
it('R306 контрфакты пустого helper, чужого модуля и чужого id обнаруживаются до caller', () => {
  const raw = source('routes/bots');
  for (const to of ['return;', dropSoonStatement.replace('/botVoice.js', '/notVoice.js'),
    dropSoonStatement.replace('m.dropBotVoice(botId)', "m.dropBotVoice('someone-else')")])
    mutation(raw, dropSoonStatement, to, dropSoonCoverage, 'R306_DROP_HELPER:');
});
it('R306 контрфакты мёртвого и расширенного условия настроек обнаруживаются', () => {
  const raw = source('routes/bots');
  for (const to of ['false', 'botVoiceEnabled(prev) || !botVoiceEnabled(next)'])
    mutation(raw, 'botVoiceEnabled(prev) && !botVoiceEnabled(next)', to, settingsCoverage, 'R306_SETTINGS_GATE:');
});
it('R306 контрфакты dispatcher без результата, с чужим импортом и переставленными аргументами обнаруживаются', () => {
  const raw = source('routes/botApi');
  for (const [from, to] of [
    ['return mod[name](ctx, p);', 'return true;'],
    ["const mod = await import('../bots/botVoice.js');", "const mod = await import('../bots/notVoice.js');"],
    ['return mod[name](ctx, p);', 'return mod[name](p, ctx);'],
  ]) mutation(raw, from, to, dispatcherCoverage, 'R306_VOICE_DISPATCH:');
});
