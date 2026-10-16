import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { it } from 'node:test';
import ts from 'typescript';
const source = readFileSync(new URL('./store.ts', import.meta.url), 'utf8').replace(/\r\n/g, '\n');
function action(name: string, raw = source) {
  const tree = ts.createSourceFile('store.ts', raw, ts.ScriptTarget.Latest, true);
  const found: ts.PropertyAssignment[] = [];
  function visit(n: ts.Node) { if (ts.isPropertyAssignment(n) && n.name.getText(tree) === name) found.push(n); ts.forEachChild(n, visit); } visit(tree);
  assert.equal(found.length, 1, `единственное действие ${name}`); return found[0]!.initializer.getText(tree);
}
function tabContract(raw = source) {
  const text = action('openServersTab', raw);
  assert.match(text, /const toList = wasActive && s0.mobilePane === 'list' && !!s0.currentServerId && !s0.serverListOpen;/, 'повторный клик только по активным каналам');
  assert.match(text, /set\(\{ view: 'server', mobileProfileOpen: false, mobilePane: 'list', mobileMembersOpen: false, serverListOpen: toList \}\)/, 'сброс профиля и панели при переходе');
  assert.match(text, /if \(!s0.currentServerId\) \{[\s\S]*const id = lastPlace\(activeInstanceId\(\)\)\?\.serverId;[\s\S]*if \(id && s0.servers.some\(\(x\) => x.id === id\)\) void get\(\).openServer\(id\).catch\(\(\) => \{\}\);/, 'последнее место только при отсутствии текущего и наличии сервера');
}
function openContract(raw = source) {
  const server = action('openServer', raw), channel = action('openChannel', raw);
  assert.match(server, /serverListOpen: false/, 'openServer сбрасывает список');
  assert.match(channel, /serverListOpen: false/, 'openChannel сбрасывает список');
  assert.match(server, /if \(inst0\) rememberPlace\(\{ instanceId: inst0, serverId \}\)/, 'сервер запоминается без выбранного канала');
  assert.match(channel, /if \(inst\) rememberPlace\(\{ instanceId: inst, serverId: get\(\).currentServerId \?\? undefined, channelId \}\)/, 'канал сохраняется в месте');
}
it('R174 проводка стора возвращает активную вкладку к серверам, иначе к последнему доступному серверу', () => {
  // AST/text guard для большого сетевого стора: без eval извлечённого action и без базы/живой сессии.
  // Фиксируем обе стороны wasActive/currentServerId и проверку missing lastPlace через полное условие в настоящем action.
  tabContract();
});
it('R174 открытие сервера и канала сбрасывает список и сохраняет соответствующее место', () => {
  // На телефоне openServer не открывает канал автоматически: сохранение самого сервера нельзя откладывать до openChannel.
  openContract();
});
it('R174 контрфакты без wasActive, сброса профиля и запоминания сервера отвергаются AST-проводкой', () => {
  // Статические мутанты не являются заявлением о выполненных сетевых действиях стора.
  for (const [anchor, replacement, check, message] of [
    ["const toList = wasActive &&", 'const toList =', tabContract, 'повторный клик'],
    ["view: 'server', mobileProfileOpen: false, mobilePane: 'list', mobileMembersOpen: false, serverListOpen: toList", "view: 'server', mobileProfileOpen: true, mobilePane: 'list', mobileMembersOpen: false, serverListOpen: toList", tabContract, 'сброс профиля'],
    ['if (inst0) rememberPlace({ instanceId: inst0, serverId });', 'if (inst0) void serverId;', openContract, 'сервер запоминается'],
  ] as const) {
    check(); assert.equal(source.split(anchor).length - 1, 1);
    assert.throws(() => check(source.replace(anchor, replacement)), e => e instanceof assert.AssertionError && e.message.includes(message));
  }
});
