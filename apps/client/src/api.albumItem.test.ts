import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import { it } from 'node:test';
import ts from 'typescript';

const source = readFileSync(new URL('./api.ts', import.meta.url), 'utf8').replace(/\r\n/g, '\n');
type Api = typeof import('./api');
function fixture(raw = source, body: unknown = { removed: 'item' }, status = 200) {
  const calls: Array<{ url: string; init: RequestInit }> = [];
  const unused = () => assert.fail('IO вне удаления элемента альбома');
  const dependencies: Record<string, unknown> = {
    './bgGateways': { mirrorToBg: unused },
    './config': { config: { apiUrl: 'https://album.example.test' }, activeInstance: () => null, activeInstanceId: () => null,
      instances: () => [], updateActiveInstance: unused, updateInstance: unused },
    './imageSize': { measureMediaFile: unused },
  };
  const module = { exports: {} };
  runInNewContext(ts.transpileModule(raw, { compilerOptions: {
    module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, esModuleInterop: true,
  } }).outputText, { module, exports: module.exports, URL, Response, Headers, AbortSignal, Error, TypeError,
    localStorage: { getItem: (key: string) => { assert.equal(key, 'gv_token'); return null; }, setItem: unused, removeItem: unused },
    fetch: async (url: string, init: RequestInit) => {
      calls.push({ url, init }); return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
    },
    require: (id: string) => { assert.ok(Object.hasOwn(dependencies, id), `объявленный импорт полного api.ts: ${id}`); return dependencies[id]; },
  });
  return { api: (module.exports as Api).api, calls };
}

async function route(raw = source, scope: 'me' | 'both' = 'me') {
  const f = fixture(raw);
  const message = 'message/№ 1?', attachment = 'photo/№ 2?';
  const result = await f.api.convDeleteAlbumItem('conversation', message, attachment, scope);
  assert.equal(f.calls.length, 1, 'удаление одного элемента делает ровно один запрос');
  const expected = `https://album.example.test/api/conv/conversation/messages/${encodeURIComponent(message)}/attachments/${encodeURIComponent(attachment)}?for=${scope}`;
  assert.equal(f.calls[0].url, expected, 'G56-api-url: id сообщения и элемента кодируются отдельно, область сохраняется');
  assert.equal(f.calls[0].init.method, 'DELETE', 'G56-api-method: элемент удаляется отдельным DELETE, не пересылкой или пачкой');
  assert.equal(f.calls[0].init.body, undefined, 'ручка DELETE не получает фиктивное JSON-тело');
  assert.equal(Object.hasOwn(f.calls[0].init.headers!, 'Authorization'), false, 'фикстура не использует реальный токен');
  assert.deepEqual(result, { removed: 'item' }, 'тип удаления возвращается вызывающему без подмены');
}

it('R213 API одного элемента использует DELETE, экранирует оба id и сохраняет область у себя', () => route());
it('R213 API одного элемента сохраняет область у обоих', () => route(source, 'both'));
it('R213 API последнего элемента возвращает удаление всего сообщения вызывающему', async () => {
  const f = fixture(source, { removed: 'message' });
  assert.deepEqual(await f.api.convDeleteAlbumItem('conversation', 'message', 'photo', 'me'), { removed: 'message' });
});
it('R213 API отказа старого соседа сохраняет 409 и машинную причину для перевода в интерфейсе', async () => {
  const f = fixture(source, { error: 'album_item_peer_old' }, 409);
  await assert.rejects(f.api.convDeleteAlbumItem('conversation', 'message', 'photo', 'both'), (error: unknown) =>
    error instanceof Error && error.message === 'album_item_peer_old' && (error as Error & { status?: number }).status === 409);
  assert.equal(f.calls.length, 1);
});

const path = '`/conv/${convId}/messages/${encodeURIComponent(messageId)}/attachments/${encodeURIComponent(attachmentId)}?for=${scope}`';
for (const [name, from, to, prefix, actual, expected] of [
  ['перепутан HTTP-метод', "      'DELETE',\n      " + path, "      'POST',\n      " + path,
    'G56-api-method:', 'POST', 'DELETE'],
  ['attachmentId не экранируется', path, path.replace('${encodeURIComponent(attachmentId)}', '${attachmentId}'),
    'G56-api-url:', 'https://album.example.test/api/conv/conversation/messages/message%2F%E2%84%96%201%3F/attachments/photo/№ 2??for=me',
    'https://album.example.test/api/conv/conversation/messages/message%2F%E2%84%96%201%3F/attachments/photo%2F%E2%84%96%202%3F?for=me'],
  ['у себя превращается в у обоих', path, path.replace('${scope}', 'both'),
    'G56-api-url:', 'https://album.example.test/api/conv/conversation/messages/message%2F%E2%84%96%201%3F/attachments/photo%2F%E2%84%96%202%3F?for=both',
    'https://album.example.test/api/conv/conversation/messages/message%2F%E2%84%96%201%3F/attachments/photo%2F%E2%84%96%202%3F?for=me'],
] as const) it(`R213 API контрфакт: ${name}`, async () => {
  await route(); assert.equal(source.split(from).length - 1, 1, 'однозначный якорь в полном api.ts');
  await assert.rejects(route(source.replace(from, to)), (error: unknown) => error instanceof assert.AssertionError
    && error.message.startsWith(prefix) && error.operator === 'strictEqual' && error.actual === actual && error.expected === expected);
});
