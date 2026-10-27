import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { it } from 'node:test';
import { runInNewContext } from 'node:vm';
import ts from 'typescript';
import { Api, GusVoiceApiError } from './apiClient.js';

const source = readFileSync(new URL('./apiClient.ts', import.meta.url), 'utf8');
const joinResult = { url: 'wss://sfu.invalid', token: 'synthetic-not-real-token', room: 'voice', chat: { id: 'voice', type: 'voice', server_id: 'server' },
  server_muted: false, expires_in: 600, audio: { sample_rate: 48000, channels: 2, bitrate: 96000 } };
const members = [{ user: { id: 'friend', username: 'reader', display_name: 'Друг', bot: false }, muted: false, deafened: true, server_muted: false, is_bot: false }];
const cases = [
  { name: 'joinVoice с bitrate', call: (a: Api) => a.joinVoice('voice', { bitrate: 96000 }), method: 'joinVoice', body: { chat_id: 'voice', bitrate: 96000 }, result: joinResult },
  { name: 'joinVoice без bitrate', call: (a: Api) => a.joinVoice('voice'), method: 'joinVoice', body: { chat_id: 'voice' }, result: joinResult },
  { name: 'leaveVoice одного канала', call: (a: Api) => a.leaveVoice('voice'), method: 'leaveVoice', body: { chat_id: 'voice' }, result: true },
  { name: 'leaveVoice всех без аргументов', call: (a: Api) => a.leaveVoice(), method: 'leaveVoice', body: {}, result: true },
  { name: 'getVoiceChatMembers', call: (a: Api) => a.getVoiceChatMembers('voice'), method: 'getVoiceChatMembers', body: { chat_id: 'voice' }, result: members },
];
async function request(c: typeof cases[number], Constructor = Api) {
  let calls = 0;
  const api = new Constructor('synthetic-sdk-token', { baseUrl: 'https://sdk.invalid', discover: false, fetch: async (url, init) => {
    calls++;
    assert.equal(String(url), `https://sdk.invalid/api/bot/v1/${c.method}`, `R306 API ${c.method}: точный маршрут`);
    assert.equal(init?.method, 'POST');
    assert.equal(new Headers(init?.headers).get('authorization'), 'Bot synthetic-sdk-token');
    assert.equal(new Headers(init?.headers).get('content-type'), 'application/json');
    assert.deepEqual(JSON.parse(String(init?.body)), c.body, `R306 API ${c.name}: точный JSON`);
    return new Response(JSON.stringify({ ok: true, result: c.result }));
  } });
  // API мутанта выполняется в другом VM realm: сравниваем JSON-провод, не прототипы объектов его JSON.parse.
  assert.deepEqual(JSON.parse(JSON.stringify(await c.call(api))), c.result); assert.equal(calls, 1);
}
for (const c of cases) it(`R306 API ${c.name}: POST, chat_id, опции и ответ передаются без потерь`, () => request(c));
it('R306 API голосовых методов: 403 возвращается исходной API-ошибкой без скрытого повтора', async () => {
  for (const c of [cases[0], cases[2], cases[4]]) {
    let calls = 0;
    const api = new Api('synthetic-sdk-token', { baseUrl: 'https://sdk.invalid', discover: false, fetch: async () => {
      calls++; return new Response(JSON.stringify({ ok: false, error_code: 403, description: 'Forbidden: synthetic voice permissions' }), { status: 403 });
    } });
    await assert.rejects(c.call(api), (e: unknown) => e instanceof GusVoiceApiError && e.code === 403 && e.method === c.method);
    assert.equal(calls, 1);
  }
});
function load(raw: string): typeof import('./apiClient.js') {
  const exports = {};
  runInNewContext(ts.transpileModule(raw, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS } }).outputText,
    { exports, URL, AbortController, Blob, FormData, Uint8Array, setTimeout, clearTimeout,
      require: (name: string) => { throw new Error(`R306 API: запрещённый импорт ${name}`); } });
  return exports as typeof import('./apiClient.js');
}
for (const c of [
  { name: 'потерян bitrate', needle: "return this.call('joinVoice', { chat_id: chatId, ...options });", replacement: "return this.call('joinVoice', { chat_id: chatId });", test: cases[0], message: 'R306 API joinVoice с bitrate: точный JSON' },
  { name: 'перепутан маршрут участников', needle: "return this.call('getVoiceChatMembers', { chat_id: chatId });", replacement: "return this.call('getChatMembers', { chat_id: chatId });", test: cases[4], message: 'R306 API getVoiceChatMembers: точный маршрут' },
]) it(`R306 API контрфакт: ${c.name}, оригинал проходит первым`, async () => {
  await request(c.test, load(source).Api);
  assert.equal(source.split(c.needle).length - 1, 1, 'R306 API: точный уникальный якорь');
  await assert.rejects(() => request(c.test, load(source.replace(c.needle, c.replacement)).Api), (e: unknown) => e instanceof assert.AssertionError
    && e.code === 'ERR_ASSERTION' && e.message.split('\n', 1)[0] === c.message);
});
