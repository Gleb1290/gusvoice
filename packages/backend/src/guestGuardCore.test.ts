import assert from 'node:assert/strict';
import Fastify, { type FastifyRequest } from 'fastify';
import { describe, it } from 'node:test';
import { createRequireLocalUser } from './guestGuardCore.js';

describe('запрет гостям локальных маршрутов', () => {
  it('гость, неизвестный человек и запрос без пользователя получают 403, а местный проходит', async () => {
    // Ловит открытие локальных ручек при отсутствующей строке и чрезмерный запрет своему человеку.
    const app = Fastify();
    const guard = createRequireLocalUser(async (id) => id === 'local');
    app.get('/guarded', {
      preHandler: [
        async (req) => {
          const id = typeof req.headers['x-user'] === 'string' ? req.headers['x-user'] : undefined;
          (req as FastifyRequest).user = id ? { sub: id, username: id } : undefined;
        },
        guard,
      ],
    }, async () => ({ ok: true }));
    for (const id of [undefined, 'guest', 'missing']) {
      const response = await app.inject({ method: 'GET', url: '/guarded', headers: id ? { 'x-user': id } : {} });
      assert.equal(response.statusCode, 403, String(id));
      assert.deepEqual(response.json(), { error: 'federation.guest_forbidden' });
    }
    const local = await app.inject({ method: 'GET', url: '/guarded', headers: { 'x-user': 'local' } });
    assert.equal(local.statusCode, 200);
    await app.close();
  });
});
