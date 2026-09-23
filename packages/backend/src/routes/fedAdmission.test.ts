import assert from 'node:assert/strict';
import { generateKeyPairSync } from 'node:crypto';
import Fastify from 'fastify';
import { describe, it } from 'node:test';
import { instanceIdFrom } from '../federation/instanceIdentity.js';
import { createAdmitPeer, createEventsHandler, type AdmitPeerDeps } from './fedAdmission.js';
import type { StoredLink } from '../federation/linkService.js';

const INSTANCE_ID = instanceIdFrom(generateKeyPairSync('ed25519').publicKey.export({ type: 'spki', format: 'der' }));
const LINK: StoredLink = {
  instanceId: INSTANCE_ID, domain: 'peer.example', apiBase: 'https://peer.example', clientOrigin: 'https://peer.example',
  rootKey: 'root', theirName: 'Peer', state: 'active', protocolVersion: 1, features: [],
};

async function admission(overrides: Partial<AdmitPeerDeps> = {}) {
  const calls: string[] = [];
  const deps: AdmitPeerDeps = {
    clientIp: () => '1.2.3.4',
    rateBlock: async (kind, who) => { calls.push(`rate:${kind}:${who}`); return 0; },
    authenticate: async () => { calls.push('auth'); return { ok: true, link: LINK }; },
    ...overrides,
  };
  const app = Fastify();
  const admit = createAdmitPeer(deps);
  app.post('/admit', async (req, reply) => {
    const body = req.body as { instance_id?: unknown };
    const accepted = await admit(req, reply, body.instance_id, 'events');
    if (accepted) return { instanceId: accepted.instanceId };
  });
  return { app, calls };
}

describe('порядок допуска федеративного соседа', () => {
  it('неверный instance_id даёт 400 до rate limit и подписи', async () => {
    // Ловит засорение Redis произвольными ключами из недоверенного тела.
    const h = await admission();
    const response = await h.app.inject({ method: 'POST', url: '/admit', payload: { instance_id: 'bad' } });
    assert.equal(response.statusCode, 400);
    assert.deepEqual(h.calls, []);
    await h.app.close();
  });

  it('предел адреса даёт 429 с retry-after и не проверяет подпись', async () => {
    // Ловит дорогую криптографию и расход лимита честного соседа мусором с одного адреса.
    const h = await admission({ rateBlock: async (kind) => kind === 'peerAddress' ? 17 : 0 });
    const response = await h.app.inject({ method: 'POST', url: '/admit', payload: { instance_id: INSTANCE_ID } });
    assert.equal(response.statusCode, 429);
    assert.equal(response.headers['retry-after'], '17');
    assert.equal(h.calls.includes('auth'), false);
    await h.app.close();
  });

  it('отказ аутентификации сохраняет его статус и не тратит предел связки', async () => {
    // Ловит подмену протокольного 409 общим 401 и преждевременное выжигание лимита по чужому id.
    const h = await admission({ authenticate: async () => {
      h.calls.push('auth'); return { ok: false, status: 409, error: 'federation.trust_lost' };
    } });
    const response = await h.app.inject({ method: 'POST', url: '/admit', payload: { instance_id: INSTANCE_ID } });
    assert.equal(response.statusCode, 409);
    assert.equal(h.calls.filter((call) => call.startsWith('rate:')).length, 1);
    await h.app.close();
  });

  it('предел связки проверяется только после верной подписи', async () => {
    // Ловит возможность постороннего выжечь часовой лимит выбранного соседа.
    const order: string[] = [];
    const h = await admission({
      authenticate: async () => { order.push('auth'); return { ok: true, link: LINK }; },
      rateBlock: async (kind) => { order.push(`rate:${kind}`); return kind === 'events' ? 9 : 0; },
    });
    const response = await h.app.inject({ method: 'POST', url: '/admit', payload: { instance_id: INSTANCE_ID } });
    assert.equal(response.statusCode, 429);
    assert.equal(response.headers['retry-after'], '9');
    assert.deepEqual(order, ['rate:peerAddress', 'auth', 'rate:events']);
    await h.app.close();
  });
});

describe('приём пачки федеративных событий', () => {
  async function events(opts: { replay?: boolean } = {}) {
    let admits = 0;
    let receives = 0;
    const app = Fastify();
    app.post('/events', createEventsHandler({
      admitPeer: async () => { admits += 1; return LINK; },
      seenSignature: async () => Boolean(opts.replay),
      receiveEvents: async (_instanceId, list) => { receives += 1; return { accepted: list.length }; },
    }));
    return { app, counts: () => ({ admits, receives }) };
  }

  it('не-массив отвергается до допуска соседа', async () => {
    // Ловит расход подписи и лимитов на заведомо непригодное тело.
    const h = await events();
    const response = await h.app.inject({ method: 'POST', url: '/events', payload: { instance_id: INSTANCE_ID, events: {} } });
    assert.equal(response.statusCode, 400);
    assert.deepEqual(h.counts(), { admits: 0, receives: 0 });
    await h.app.close();
  });

  it('101 событие даёт 413 с пределом 100 и не доходит до допуска', async () => {
    // Ловит обход request-rate-limit тысячами дорогих событий в одном теле.
    const h = await events();
    const response = await h.app.inject({ method: 'POST', url: '/events', payload: { instance_id: INSTANCE_ID, events: Array(101).fill({}) } });
    assert.equal(response.statusCode, 413);
    assert.deepEqual(response.json(), { error: 'batch-too-large', max: 100 });
    assert.deepEqual(h.counts(), { admits: 0, receives: 0 });
    await h.app.close();
  });

  it('повтор верной пачки даёт 409 и не применяет события второй раз', async () => {
    // Ловит повторное изменение состояния при сетевом ретрае уже принятого запроса.
    const h = await events({ replay: true });
    const response = await h.app.inject({ method: 'POST', url: '/events', headers: { signature: 'same' }, payload: { instance_id: INSTANCE_ID, events: [{}] } });
    assert.equal(response.statusCode, 409);
    assert.deepEqual(h.counts(), { admits: 1, receives: 0 });
    await h.app.close();
  });
});
