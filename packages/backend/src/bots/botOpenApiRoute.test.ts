import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { it } from 'node:test';
import Fastify from 'fastify';
import { buildBotOpenApi } from './botOpenApi.js';
import { botOpenApiBody } from './botOpenApiRoute.js';
import { assertion, loadApi, loadRoute, type Edit } from './botOpenApi.harness.js';

async function run(check: (f: { app: ReturnType<typeof Fastify>; api: ReturnType<typeof loadApi>; route: ReturnType<typeof loadRoute> }) => Promise<void>, edit?: Edit, staticFirst = false) {
  const app = Fastify(), api = loadApi(), route = loadRoute(edit);
  try {
    assert.equal(route.builds(), 0, 'импорт маршрута не строит документ');
    if (staticFirst) await app.register(route.mod.botOpenApiRoutes, { prefix: '/api' });
    await app.register(api.api.botApiRoutes, { prefix: '/api' });
    if (!staticFirst) await app.register(route.mod.botOpenApiRoutes, { prefix: '/api' });
    await app.ready();
    assert.deepEqual(api.hooks, ['conv', 'channel', 'member']);
    assert.equal(route.builds(), 1, 'документ собран один раз при регистрации');
    await check({ app, api, route });
  } finally { await app.close(); api.clean(); }
}
it('R307 тело OpenAPI и ETag определены только содержимым, строка завершается LF', () => {
  const first = botOpenApiBody(), second = botOpenApiBody();
  assert.deepEqual(first, second); assert.equal(first.body, `${JSON.stringify(buildBotOpenApi(), null, 2)}\n`);
  assert.equal(first.etag, `"${createHash('sha256').update(first.body).digest('hex').slice(0, 32)}"`);
});
async function anonymous(edit?: Edit, staticFirst = false) {
  await run(async ({ app, api, route }) => {
    const result = await app.inject('/api/bot/v1/openapi.json');
    assert.equal(result.statusCode, 200, 'R307 схема доступна без авторизации');
    assert.equal(result.headers['content-type'], 'application/json; charset=utf-8');
    assert.equal(result.headers['cache-control'], 'public, max-age=3600');
    assert.deepEqual(result.json(), buildBotOpenApi());
    assert.equal(result.body, botOpenApiBody().body);
    assert.equal(result.headers.etag, botOpenApiBody().etag, 'R307 маршрут отдаёт ETag');
    assert.equal(api.rates.length, 0, 'публичный маршрут не тратит botip'); assert.equal(api.lookups.length, 0);
    const second = await app.inject({ url: '/api/bot/v1/openapi.json', headers: { host: 'forged.invalid', 'x-forwarded-host': 'forged.invalid', authorization: 'invalid' } });
    assert.equal(second.statusCode, 200); assert.equal(second.body, result.body); assert.equal(second.headers.etag, result.headers.etag);
    assert.equal(route.builds(), 1); assert.equal(api.rates.length, 0); assert.equal(api.lookups.length, 0);
    // Контрфакт входа настоящий: динамический сосед действительно требует токен и считает IP, не фиктивный маршрут.
    const method = await app.inject('/api/bot/v1/getMe'); assert.equal(method.statusCode, 401);
    assert.deepEqual(api.rates, ['botip:192.0.2.1']); assert.equal(api.lookups.length, 0);
  }, edit, staticFirst);
}
for (const first of [false, true]) it(`R307 статический OpenAPI обходит настоящий authBot и :method, зарегистрирован первым=${first}`, () => anonymous(undefined, first));
async function conditional(edit?: Edit) {
  await run(async ({ app, api, route }) => {
    const first = await app.inject('/api/bot/v1/openapi.json');
    assert.equal(first.statusCode, 200);
    const match = await app.inject({ url: '/api/bot/v1/openapi.json', headers: { 'if-none-match': String(first.headers.etag) } });
    assert.equal(match.statusCode, 304, 'R307 совпавший ETag даёт 304'); assert.equal(match.body, '');
    assert.equal(match.headers.etag, first.headers.etag); assert.equal(match.headers['cache-control'], 'public, max-age=3600');
    const other = await app.inject({ url: '/api/bot/v1/openapi.json', headers: { 'if-none-match': '"other"' } });
    assert.equal(other.statusCode, 200); assert.equal(other.body, first.body);
    assert.equal(route.builds(), 1); assert.equal(api.rates.length, 0);
  }, edit);
}
it('R307 совпавший ETag даёт пустой 304, чужой — полный 200; документ не перестраивается', () => conditional());
it('R307 HEAD сохраняет заголовки GET и не отправляет тело, включая условный HEAD', () => run(async ({ app, api }) => {
  const get = await app.inject('/api/bot/v1/openapi.json');
  const head = await app.inject({ method: 'HEAD', url: '/api/bot/v1/openapi.json' });
  assert.equal(head.statusCode, 200); assert.equal(head.body, '');
  for (const key of ['content-type', 'cache-control', 'etag', 'content-length']) assert.equal(head.headers[key], get.headers[key]);
  const cached = await app.inject({ method: 'HEAD', url: '/api/bot/v1/openapi.json', headers: { 'if-none-match': String(get.headers.etag) } });
  assert.equal(cached.statusCode, 304); assert.equal(cached.body, ''); assert.equal(api.rates.length, 0);
}));
it('R307 настоящий getMe сообщает openapi и api_version 4, а openapi.json не входит в методы', () => run(async ({ app, api }) => {
  const reply = await app.inject({ url: '/api/bot/v1/getMe', headers: { authorization: `Bot ${api.token}` } });
  assert.equal(reply.statusCode, 200); assert.equal(reply.json().result.api_version, 4); assert.ok(reply.json().result.features.includes('openapi'));
  assert.equal(api.api.botMethodNames().includes('openapi.json'), false);
  const unknown = await app.inject({ url: '/api/bot/v1/notAMethod', headers: { authorization: `Bot ${api.token}` } });
  assert.equal(unknown.statusCode, 404); assert.equal(unknown.json().description, 'Not Found: method not found');
}));
it('R307 контрфакт: ETag потерян из ответа', async () => {
  await anonymous();
  await assert.rejects(anonymous({ from: ".header('ETag', doc.etag)", to: '' }), assertion('R307 маршрут отдаёт ETag'));
});
it('R307 контрфакт: публичный маршрут начал требовать токен', async () => {
  await anonymous();
  await assert.rejects(anonymous({ from: "app.get('/bot/v1/openapi.json', async (req, reply) => {", to: "app.get('/bot/v1/openapi.json', async (req, reply) => {\n    if (!req.headers.authorization) return reply.code(401).send({ error: 'Unauthorized' });" }), assertion('R307 схема доступна без авторизации', 401, 200));
});
it('R307 контрфакт: статический путь потерян и запрос проваливается в настоящий :method/authBot', async () => {
  await anonymous();
  await assert.rejects(anonymous({ from: "app.get('/bot/v1/openapi.json',", to: "app.get('/bot/v1/openapi-renamed.json'," }), assertion('R307 схема доступна без авторизации', 401, 200));
});
it('R307 контрфакт: If-None-Match перестал давать 304', async () => {
  await conditional();
  await assert.rejects(conditional({ from: "if (req.headers['if-none-match'] === doc.etag)", to: "if (req.headers['if-none-match'] === 'never-a-real-etag')" }), assertion('R307 совпавший ETag даёт 304', 200, 304));
});
