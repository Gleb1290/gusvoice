import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { it } from 'node:test';
import { runInNewContext } from 'node:vm';
import ts from 'typescript';
import { Api } from './apiClient.js';

const base = 'https://sdk.example.test';
const token = 'synthetic-sdk-token';
const source = readFileSync(new URL('./apiClient.ts', import.meta.url), 'utf8');
type Case = { name: string; call(api: Api): Promise<unknown>; method: string; params: unknown; result: unknown };
const member = { user: { id: 'person', username: 'reader', display_name: 'Читатель', bot: false }, status: 'member', role_ids: ['role'] };
const message = { message_id: 'message', chat: { id: 'channel', type: 'channel', server_id: 'server', title: 'Общий' },
  from: member.user, date: 1700000000, text: 'Текст' };
const cases: Case[] = [
  { name: 'постановка реакции', call: a => a.setMessageReaction('channel', 'message', '👍'), method: 'setMessageReaction',
    params: { chat_id: 'channel', message_id: 'message', reaction: [{ type: 'emoji', emoji: '👍' }] }, result: true },
  { name: 'закреп с явным тихим режимом', call: a => a.pinChatMessage('channel', 'message', { disable_notification: false }), method: 'pinChatMessage',
    params: { chat_id: 'channel', message_id: 'message', disable_notification: false }, result: true },
  { name: 'снятие закрепа', call: a => a.unpinChatMessage('channel', 'message'), method: 'unpinChatMessage', params: { chat_id: 'channel', message_id: 'message' }, result: true },
  { name: 'получение участника', call: a => a.getChatMember('server', 'person'), method: 'getChatMember', params: { chat_id: 'server', user_id: 'person' }, result: member },
  { name: 'число участников', call: a => a.getChatMemberCount('server'), method: 'getChatMemberCount', params: { chat_id: 'server' }, result: 3 },
  { name: 'страница участников с курсором', call: a => a.getChatMembers('server', { offset: 'cursor', limit: 200 }), method: 'getChatMembers',
    params: { chat_id: 'server', offset: 'cursor', limit: 200 }, result: { members: [member], next_offset: 'next' } },
  { name: 'список своих серверов', call: a => a.getMyServers(), method: 'getMyServers', params: {}, result: [{ id: 'server', title: 'Сервер' }] },
  { name: 'структура сервера', call: a => a.getServer('server'), method: 'getServer', params: { server_id: 'server' },
    result: { id: 'server', title: 'Сервер', channels: [{ id: 'channel', title: 'Общий', type: 'text', can_send: true }], roles: [] } },
  { name: 'история канала', call: a => a.getChatHistory('channel', { before_message_id: 'before', limit: 100 }), method: 'getChatHistory',
    params: { chat_id: 'channel', before_message_id: 'before', limit: 100 }, result: [message] },
  { name: 'выдача роли', call: a => a.addChatMemberRole('server', 'person', 'role'), method: 'addChatMemberRole',
    params: { chat_id: 'server', user_id: 'person', role_id: 'role' }, result: true },
  { name: 'снятие роли', call: a => a.removeChatMemberRole('server', 'person', 'role'), method: 'removeChatMemberRole',
    params: { chat_id: 'server', user_id: 'person', role_id: 'role' }, result: true },
  { name: 'бан с причиной', call: a => a.banChatMember('server', 'person', { reason: 'Правило' }), method: 'banChatMember',
    params: { chat_id: 'server', user_id: 'person', reason: 'Правило' }, result: true },
  { name: 'снятие бана', call: a => a.unbanChatMember('server', 'person'), method: 'unbanChatMember', params: { chat_id: 'server', user_id: 'person' }, result: true },
  { name: 'исключение участника', call: a => a.kickChatMember('server', 'person'), method: 'kickChatMember', params: { chat_id: 'server', user_id: 'person' }, result: true },
  { name: 'самостоятельный выход', call: a => a.leaveChat('server'), method: 'leaveChat', params: { chat_id: 'server' }, result: true },
];
for (const c of cases) it(`R303 SDK ${c.name}: точные метод, JSON-параметры и результат`, async () => {
  let calls = 0;
  const api = new Api(token, { baseUrl: base, discover: false, fetch: async (url, init) => {
    calls++;
    assert.equal(String(url), `${base}/api/bot/v1/${c.method}`);
    assert.equal(init?.method, 'POST');
    assert.equal(new Headers(init?.headers).get('authorization'), `Bot ${token}`);
    assert.equal(new Headers(init?.headers).get('content-type'), 'application/json');
    assert.deepEqual(JSON.parse(String(init?.body)), c.params);
    return new Response(JSON.stringify({ ok: true, result: c.result }));
  } });
  assert.deepEqual(await c.call(api), c.result); assert.equal(calls, 1);
});

it('R303 пустая строка и пустой массив снимают реакции, набор передаётся без потерь', async () => {
  const bodies: unknown[] = [];
  const api = new Api(token, { baseUrl: base, discover: false, fetch: async (_url, init) => {
    bodies.push(JSON.parse(String(init?.body))); return new Response('{"ok":true,"result":true}');
  } });
  await api.setMessageReaction('dm', 'message', ''); await api.setMessageReaction('dm', 'message', []);
  const reaction = [{ type: 'emoji' as const, emoji: '❤' }, { type: 'emoji' as const, emoji: '👍' }];
  await api.setMessageReaction('dm', 'message', reaction);
  assert.deepEqual(bodies, [[], [], reaction].map(reaction => ({ chat_id: 'dm', message_id: 'message', reaction })));
});
it('R303 необязательные параметры не превращаются в null, false и нули по умолчанию', async () => {
  const bodies: unknown[] = [];
  const api = new Api(token, { baseUrl: base, discover: false, fetch: async (_url, init) => {
    bodies.push(JSON.parse(String(init?.body))); return new Response('{"ok":true,"result":true}');
  } });
  await api.pinChatMessage('c', 'm'); await api.banChatMember('s', 'u');
  await api.getChatMembers('s'); await api.getChatHistory('c');
  assert.deepEqual(bodies, [{ chat_id: 'c', message_id: 'm' }, { chat_id: 's', user_id: 'u' }, { chat_id: 's' }, { chat_id: 'c' }]);
});
it('R303 client_id, HTML и область команд групп доходят до провода без переименования', async () => {
  const bodies: unknown[] = [];
  const api = new Api(token, { baseUrl: base, discover: false, fetch: async (_url, init) => {
    bodies.push(JSON.parse(String(init?.body))); return new Response(JSON.stringify({ ok: true, result: message }));
  } });
  await api.sendMessage('channel', '<b>Привет</b>', { client_id: 'retry-id', parse_mode: 'HTML' });
  await api.editMessageText('channel', 'message', '<i>Новый</i>', { parse_mode: 'HTML' });
  await api.setMyCommands([{ command: 'ping', description: 'Проверить' }], { scope: { type: 'all_group_chats' } });
  assert.deepEqual(bodies, [
    { chat_id: 'channel', text: '<b>Привет</b>', client_id: 'retry-id', parse_mode: 'HTML' },
    { chat_id: 'channel', message_id: 'message', text: '<i>Новый</i>', parse_mode: 'HTML' },
    { commands: [{ command: 'ping', description: 'Проверить' }], scope: { type: 'all_group_chats' } },
  ]);
});
it('R303 setWebhook передаёт batch только при явном выборе, прежний объект запроса не расширяется', async () => {
  const bodies: unknown[] = [];
  const api = new Api(token, { baseUrl: base, discover: false, fetch: async (_url, init) => {
    bodies.push(JSON.parse(String(init?.body))); return new Response('{"ok":true,"result":true}');
  } });
  await api.setWebhook('https://bot.example.test/hook', 'synthetic-hook');
  await api.setWebhook('https://bot.example.test/hook', 'synthetic-hook', { batch: true });
  assert.deepEqual(bodies, [{ url: 'https://bot.example.test/hook', secret_token: 'synthetic-hook' },
    { url: 'https://bot.example.test/hook', secret_token: 'synthetic-hook', batch: true }]);
});

function loadApi(raw: string): typeof import('./apiClient.js') {
  const module = { exports: {} };
  runInNewContext(ts.transpileModule(raw, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS } }).outputText,
    { module, exports: module.exports, URL, AbortController, Blob, FormData, Uint8Array, setTimeout, clearTimeout });
  return module.exports as typeof import('./apiClient.js');
}
async function downgrade(raw = source) {
  let calls = 0;
  const api = new (loadApi(raw).Api)(token, { baseUrl: base, fetch: async (_url, init) => {
    calls++;
    if (calls === 1) {
      assert.equal(new Headers(init?.headers).get('authorization'), null);
      return new Response('{"apiUrl":"http://api.example.test"}');
    }
    return new Response('{"ok":true,"result":true}');
  } });
  let rejected = false;
  try { await api.getMe(); } catch (error) { rejected = true; assert.match(String((error as Error).message), /non-HTTPS/); }
  assert.equal(calls, 1, 'R303 HTTPS discovery не отправляет токен на HTTP');
  assert.equal(rejected, true);
}
it('R303 сайт HTTPS с apiUrl HTTP отвергается до единственного запроса с токеном', () => downgrade());
it('R303 HTTP-сайт может использовать HTTP API, HTTPS discovery с HTTPS API принимается', async () => {
  for (const [site, found] of [['http://sdk.example.test', 'http://api.example.test'], [base, 'https://api.example.test']]) {
    const calls: string[] = [];
    const api = new Api(token, { baseUrl: site, fetch: async (url, init) => {
      calls.push(String(url));
      if (calls.length === 1) return new Response(JSON.stringify({ apiUrl: found }));
      assert.equal(new Headers(init?.headers).get('authorization'), `Bot ${token}`);
      return new Response('{"ok":true,"result":true}');
    } });
    assert.equal(await api.getMe(), true); assert.deepEqual(calls, [`${site}/config.json`, `${found}/api/bot/v1/getMe`]);
  }
});
it('R303 контрфакт снятого HTTPS-гейта ловится на лишнем запросе, оригинал проходит первым', async () => {
  await downgrade();
  const needle = 'if (/^https:/i.test(this.base) && !/^https:/i.test(found))';
  assert.equal(source.split(needle).length - 1, 1);
  await assert.rejects(downgrade(source.replace(needle, 'if (false)')), (error: unknown) => error instanceof assert.AssertionError
    && error.code === 'ERR_ASSERTION' && error.message.split(/\r?\n/, 1)[0] === 'R303 HTTPS discovery не отправляет токен на HTTP'
    && error.operator === 'strictEqual' && error.actual === 2 && error.expected === 1);
});
