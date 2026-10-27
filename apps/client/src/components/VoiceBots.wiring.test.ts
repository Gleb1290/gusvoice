import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { it } from 'node:test';
import ts from 'typescript';

// Только стражи проводки по исходникам: они не выдаются за проверку клика/пикселей.
// Чистые контракты и настоящий хук исполняются соседними voiceRules/useStageSpeaker тестами.
const sources = Object.fromEntries(['ChannelSidebar', 'VoiceChannelView', 'VoiceParticipants', 'UserContextMenu', 'PhoneProfile']
  .map(name => [name, readFileSync(new URL(`./${name}.tsx`, import.meta.url), 'utf8').replace(/\r\n/g, '\n')]));
const compact = (node: ts.Node) => node.getText().replace(/\s+/g, '');
function tree(raw: string): ts.SourceFile {
  return ts.createSourceFile('voice.tsx', raw, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
}
function descendants(root: ts.Node, predicate: (n: ts.Node) => boolean): ts.Node[] {
  const found: ts.Node[] = [];
  function walk(n: ts.Node) { if (predicate(n)) found.push(n); ts.forEachChild(n, walk); }
  walk(root); return found;
}
function one(root: ts.Node, predicate: (n: ts.Node) => boolean, marker: string): ts.Node {
  const matches = descendants(root, predicate); assert.equal(matches.length, 1, marker); return matches[0];
}
function scope(raw: string, name: string) {
  return one(tree(raw), n => ts.isFunctionDeclaration(n) && n.name?.text === name, `R306_SCOPE: ${name}`);
}
function variable(root: ts.Node, name: string): ts.Expression {
  const n = one(root, n => ts.isVariableDeclaration(n) && ts.isIdentifier(n.name) && n.name.text === name,
    `R306_VAR: ${name}`) as ts.VariableDeclaration;
  assert.ok(n.initializer); return n.initializer;
}
function andHas(node: ts.Node, expected: string): boolean {
  if (ts.isParenthesizedExpression(node)) return andHas(node.expression, expected);
  return compact(node) === expected || (ts.isBinaryExpression(node) && node.operatorToken.kind === ts.SyntaxKind.AmpersandAmpersandToken
    && (andHas(node.left, expected) || andHas(node.right, expected)));
}
function guarded(node: ts.Node, expected: string): boolean {
  for (let p = node.parent; p; p = p.parent)
    if (ts.isBinaryExpression(p) && p.operatorToken.kind === ts.SyntaxKind.AmpersandAmpersandToken &&
      node.pos >= p.right.pos && node.end <= p.right.end && andHas(p.left, expected)) return true;
  return false;
}
function attr(node: ts.JsxOpeningLikeElement, name: string): string | undefined {
  const value = node.attributes.properties.find(p => ts.isJsxAttribute(p) && p.name.getText() === name);
  return value && ts.isJsxAttribute(value) && value.initializer && ts.isStringLiteral(value.initializer)
    ? value.initializer.text : undefined;
}
function badgeAndFlags(raw: string, name: string) {
  const root = scope(raw, name);
  const badge = one(root, n => ts.isJsxElement(n) && attr(n.openingElement, 'className') === 'bot-tag', 'R306_BADGE: значок один') as ts.JsxElement;
  assert.equal(badge.children.filter(ts.isJsxText).map(n => n.text.trim()).join(''), 'БОТ', 'R306_BADGE: текст БОТ');
  assert.equal(guarded(badge, 'isBot'), true, 'R306_BADGE: значок только у бота');
  const targetBot = one(root, n => ts.isPropertyAssignment(n) && n.name.getText() === 'bot',
    'R306_TARGET: метка передаётся в цель контекстного меню') as ts.PropertyAssignment;
  assert.equal(compact(targetBot.initializer), 'isBot||undefined', 'R306_TARGET: меню получает ту же метку, что значок');
  for (const [rule, icon] of [['showMicOff', 'mic-off'], ['showDeafened', 'headphones-off']]) {
    const cond = one(root, n => ts.isConditionalExpression(n) && ts.isCallExpression(n.condition) &&
      n.condition.expression.getText() === rule, `R306_FLAGS: ${rule}`) as ts.ConditionalExpression;
    assert.equal(ts.isCallExpression(cond.condition) && compact(cond.condition.arguments[0]) === 'isBot', true, 'R306_FLAGS: метка передана');
    assert.equal(descendants(cond.whenTrue, n => ts.isJsxSelfClosingElement(n) && n.tagName.getText() === 'Icon' &&
      attr(n, 'name') === icon).length, 1, `R306_FLAGS: ${rule} управляет ${icon}`);
  }
}
for (const [file, name] of [['ChannelSidebar', 'ChannelSidebar'], ['VoiceChannelView', 'StageTile'], ['VoiceParticipants', 'ParticipantRow']]) {
  it(`R306 исходник ${file}: значок БОТ и оба голосовых значка зависят от правил бота`, () => badgeAndFlags(sources[file], name));
}

function sorted(raw: string, name: string, local: string, predicate: string) {
  const init = variable(scope(raw, name), local);
  assert.equal(ts.isCallExpression(init) && compact(init.expression) === 'botsAfterHumans', true, 'R306_SORT: вызывается общее правило');
  assert.ok(ts.isCallExpression(init));
  assert.equal(compact(init.arguments[1]), predicate, 'R306_SORT: сортировка читает метку бота');
}
it('R306 сайдбар сортирует presence в список here, а не меняет исходный порядок presence', () => {
  sorted(sources.ChannelSidebar, 'ChannelSidebar', 'here', '(v)=>v.bot===true');
});
it('R306 сцена сортирует allPeople по botIds и передаёт тот же набор в выбор крупного', () => {
  sorted(sources.VoiceChannelView, 'VoiceStage', 'allPeople', '(p)=>botIds.has(p.identity)');
  assert.equal(compact(variable(scope(sources.VoiceChannelView, 'VoiceStage'), 'speakerId')),
    'useStageSpeaker(others,oneBig,botIds)', 'R306_SPEAKER: метка доходит до настоящего хука');
});
it('R306 голосовой список сортирует реальные плитки до map, распознавая presence и метаданные', () => {
  const root = scope(sources.VoiceParticipants, 'VoiceParticipants');
  const call = one(root, n => ts.isCallExpression(n) && n.expression.getText() === 'botsAfterHumans', 'R306_SORT: список') as ts.CallExpression;
  assert.equal(compact(call.arguments[1]), '(p)=>isVoiceBot(p.identity,channelPresence,p.metadata)', 'R306_SORT: оба источника метки');
  assert.ok(ts.isPropertyAccessExpression(call.parent) && call.parent.name.text === 'map', 'R306_SORT: именно порядок отображения');
});

function tip(raw: string, name: string) {
  assert.equal(andHas(variable(scope(raw, name), 'canTip'), 'botAcceptsSocial(isBot)'), true,
    'R306_TIP: запрет бота — обязательное AND, не альтернативная OR-ветка');
}
for (const [file, name] of [['ChannelSidebar', 'ChannelSidebar'], ['VoiceChannelView', 'StageTile']])
  it(`R306 ${file}: все способы дать чаевые используют canTip с обязательным запретом бота`, () => tip(sources[file], name));

function economy(raw: string) {
  const root = tree(raw);
  const blocks = descendants(root, n => ts.isJsxSelfClosingElement(n) && n.tagName.getText() === 'ProfileEconomy');
  assert.equal(blocks.length, 1, 'R306_ECONOMY: один общий блок экономики');
  assert.equal(guarded(blocks[0], '!target.bot'), true, 'R306_ECONOMY: бот не получает чаевые/покупку/генерала');
}
for (const file of ['UserContextMenu', 'PhoneProfile'])
  it(`R306 ${file}: ProfileEconomy доступна человеку, но не боту`, () => economy(sources[file]));

function poke(raw: string) {
  const root = tree(raw);
  assert.equal(andHas(variable(root, 'canPoke'), '!target.bot'), true, 'R306_POKE: бот исключён до обоих пунктов');
  for (const label of ['Ткнуть', 'Ущипнуть']) {
    const item = one(root, n => ts.isJsxSelfClosingElement(n) && n.tagName.getText() === 'MenuItem' && attr(n, 'label') === label,
      `R306_POKE: пункт ${label}`);
    assert.equal(guarded(item, 'canPoke'), true, 'R306_POKE: обычный и платный тычок закрыты одной проверкой');
  }
}
it('R306 контекстное меню закрывает боту обычный и платный тычок, не закрывая модерацию', () => {
  poke(sources.UserContextMenu);
  for (const name of ['canMute', 'canMove'])
    assert.equal(compact(variable(tree(sources.UserContextMenu), name)).includes('target.bot'), false,
      'модератор по-прежнему может заглушить и переместить бота');
});
function call(raw: string) {
  const init = variable(tree(raw), 'profileCall'); assert.ok(ts.isConditionalExpression(init));
  assert.equal(andHas(init.condition, '!target.bot'), true, 'R306_CALL: голосовой бот не становится собеседником звонка');
}
it('R306 общий callback звонка для ПК и телефона недоступен боту', () => call(sources.UserContextMenu));

const mutants: Array<{ title: string; file: string; anchor: string; replacement: string; marker: string; probe(raw: string): void }> = [
  { title: 'потерянный значок БОТ', file: 'VoiceParticipants', anchor: 'className="bot-tag"', replacement: 'className="former-bot-tag"',
    marker: 'R306_BADGE:', probe: raw => badgeAndFlags(raw, 'ParticipantRow') },
  { title: 'обход botAcceptsSocial', file: 'VoiceChannelView', anchor: "!p.isLocal && tipMode !== 'none' && botAcceptsSocial(isBot)",
    replacement: "!p.isLocal && tipMode !== 'none'", marker: 'R306_TIP:', probe: raw => tip(raw, 'StageTile') },
  { title: 'сайдбар без общего порядка', file: 'ChannelSidebar', anchor: 'botsAfterHumans(presence[c.id] ?? [], (v) => v.bot === true)',
    replacement: '(presence[c.id] ?? [])', marker: 'R306_SORT:', probe: raw => sorted(raw, 'ChannelSidebar', 'here', '(v)=>v.bot===true') },
  { title: 'потерянный запрет экономики', file: 'PhoneProfile', anchor: '!isSelf && !target.bot && <ProfileEconomy',
    replacement: '!isSelf && <ProfileEconomy', marker: 'R306_ECONOMY:', probe: economy },
  { title: 'потерянный запрет тычка', file: 'UserContextMenu', anchor: '!!target.voiceChannelId && !target.bot;',
    replacement: '!!target.voiceChannelId;', marker: 'R306_POKE:', probe: poke },
  { title: 'потерянный запрет звонка', file: 'UserContextMenu', anchor: 'callsOn && !isSelf && !target.bot',
    replacement: 'callsOn && !isSelf', marker: 'R306_CALL:', probe: call },
];
for (const m of mutants) it(`R306 исходниковый контрфакт: ${m.title} обнаруживается целевым стражем`, () => {
  const raw = sources[m.file]; assert.equal(raw.split(m.anchor).length - 1, 1, 'уникальный якорь'); m.probe(raw);
  assert.throws(() => m.probe(raw.replace(m.anchor, m.replacement)),
    e => e instanceof assert.AssertionError && e.message.startsWith(m.marker));
});
