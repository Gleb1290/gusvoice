import assert from 'node:assert/strict';
import { generateKeyPairSync } from 'node:crypto';
import { describe, it } from 'node:test';
import { signRequest } from './httpSignature.js';
import { issueSigningKey } from './signingKeys.js';
import {
  createPeerAuth,
  DOC_CACHE_TTL_MS,
  DOC_FORCE_MIN_INTERVAL_MS,
  DOC_RETRY_AFTER_MS,
  DOC_STALE_MAX_MS,
  type PeerRequestLike,
} from './peerAuthCore.js';
import type { StoredLink } from './linkService.js';
import type { PeerDocument } from './peerClient.js';

const API_BASE = 'https://local.example/api';
const TARGET = `${API_BASE}/fed/v1/events`;

function keyPair() {
  const root = generateKeyPairSync('ed25519');
  const issued = issueSigningKey(root.privateKey.export({ type: 'pkcs8', format: 'der' }), 0, 10_000_000);
  return {
    kid: issued.kid,
    privateKey: issued.privateKeyDer,
    publicKey: issued.publicKeyDer,
    rootPublicKey: root.publicKey.export({ type: 'spki', format: 'der' }),
    sig: issued.sig,
  };
}

function link(state: StoredLink['state'] = 'active'): StoredLink {
  return {
    instanceId: 'peer-id', domain: 'peer.example', apiBase: 'https://peer.example/api',
    clientOrigin: 'https://peer.example', rootKey: 'root', theirName: 'Peer', state,
    protocolVersion: 1, features: [],
  };
}

function document(key: ReturnType<typeof keyPair>, instanceId = 'peer-id'): PeerDocument {
  return {
    instanceId, fingerprint: 'AA', protocolVersion: 1,
    doc: {
      instanceId, name: 'Peer', iconHash: null, domain: 'peer.example',
      clientOrigin: 'https://peer.example', apiBase: 'https://peer.example/api',
      protocol: { min: 1, max: 1 }, features: [], appVersion: null,
      rootKey: key.rootPublicKey.toString('base64url'),
      keys: [{
        kid: key.kid, publicKey: key.publicKey.toString('base64url'),
        notBefore: 0, notAfter: 10_000_000, sig: key.sig,
      }],
    },
  };
}

function signedRequest(key: ReturnType<typeof keyPair>, now: number, body = ''): PeerRequestLike {
  return {
    method: 'POST', url: '/fed/v1/events',
    headers: signRequest({
      method: 'POST', targetUri: TARGET, body, keyid: key.kid,
      privateKeyDer: key.privateKey, nowS: Math.floor(now / 1000),
    }),
    rawBody: body,
  } as PeerRequestLike;
}

function harness(opts: {
  now?: number;
  state?: StoredLink['state'];
  fetch?: () => Promise<{ ok: true; value: PeerDocument } | { ok: false; problem: 'unreachable' }>;
  markTrustLost?: (instanceId: string, reason: string) => Promise<unknown>;
  paused?: () => Promise<boolean>;
} = {}) {
  let now = opts.now ?? 1_000_000;
  let fetches = 0;
  let storms = 0;
  const auth = createPeerAuth({
    apiBase: API_BASE,
    now: () => now,
    getLink: async () => link(opts.state),
    fetchPeerDocument: async () => {
      fetches += 1;
      return opts.fetch ? opts.fetch() : { ok: true, value: document(keyPair()) };
    },
    markTrustLost: opts.markTrustLost ?? (async () => {}),
    noteSignatureFailure: () => { storms += 1; },
    paused: opts.paused ?? (async () => false),
  });
  return { auth, get now() { return now; }, set now(value: number) { now = value; }, get fetches() { return fetches; }, get storms() { return storms; } };
}

describe('проверка федеративного соседа', () => {
  it('два незнакомых ключа за полминуты вызывают только одно принудительное перечитывание визитки', async () => {
    // Ловит отражённую нагрузку на соседа через поток корректно оформленных запросов с чужими kid.
    const known = keyPair();
    const firstUnknown = keyPair();
    const secondUnknown = keyPair();
    const h = harness({ fetch: async () => ({ ok: true, value: document(known) }) });
    await h.auth.authenticateLinkedPeer(signedRequest(firstUnknown, h.now), 'peer-id');
    h.now += DOC_FORCE_MIN_INTERVAL_MS - 1;
    await h.auth.authenticateLinkedPeer(signedRequest(secondUnknown, h.now), 'peer-id');
    assert.equal(h.fetches, 2);
  });

  it('сто одновременных запросов при пустом кеше делят одну загрузку визитки', async () => {
    // Ловит stampede: один пакет синхронизации не должен превращаться в сто сетевых запросов.
    const signer = keyPair();
    let release!: (value: { ok: true; value: PeerDocument }) => void;
    const held = new Promise<{ ok: true; value: PeerDocument }>((resolve) => { release = resolve; });
    const h = harness({ fetch: () => held });
    const calls = Array.from({ length: 100 }, () => h.auth.authenticateLinkedPeer(signedRequest(signer, h.now), 'peer-id'));
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(h.fetches, 1);
    release({ ok: true, value: document(signer) });
    assert.equal((await Promise.all(calls)).every((result) => result.ok), true);
  });

  it('после сбоя полминуты не ходит в сеть, свежую старую визитку использует, а пятнадцатиминутную отвергает', async () => {
    // Ловит одновременно сетевой шторм после отказа и бессрочное доверие протухшему ключу.
    const signer = keyPair();
    let fail = false;
    const h = harness({ fetch: async () => fail
      ? { ok: false as const, problem: 'unreachable' as const }
      : { ok: true as const, value: document(signer) } });
    assert.equal((await h.auth.authenticateLinkedPeer(signedRequest(signer, h.now), 'peer-id')).ok, true);
    fail = true;
    h.now += DOC_CACHE_TTL_MS + 1;
    assert.equal((await h.auth.authenticateLinkedPeer(signedRequest(signer, h.now), 'peer-id')).ok, true);
    const afterFailure = h.fetches;
    h.now += DOC_RETRY_AFTER_MS - 1;
    assert.equal((await h.auth.authenticateLinkedPeer(signedRequest(signer, h.now), 'peer-id')).ok, true);
    assert.equal(h.fetches, afterFailure);
    h.now = 1_000_000 + DOC_STALE_MAX_MS + 1;
    assert.deepEqual(await h.auth.authenticateLinkedPeer(signedRequest(signer, h.now), 'peer-id'), {
      ok: false, status: 401, error: 'unknown',
    });
  });

  it('чужая личность отмечает потерю доверия один раз и ставит паузу повторов даже при ошибке записи', async () => {
    // Ловит бесконечные повторные походы к подменённому адресу, если запись trust-lost сама упала.
    const signer = keyPair();
    let marks = 0;
    const h = harness({
      fetch: async () => ({ ok: true, value: document(signer, 'foreign-id') }),
      markTrustLost: async () => { marks += 1; throw new Error('db down'); },
    });
    await assert.rejects(h.auth.authenticateLinkedPeer(signedRequest(signer, h.now), 'peer-id'), /db down/);
    h.now += DOC_RETRY_AFTER_MS - 1;
    assert.deepEqual(await h.auth.authenticateLinkedPeer(signedRequest(signer, h.now), 'peer-id'), {
      ok: false, status: 401, error: 'unknown',
    });
    assert.equal(marks, 1);
    assert.equal(h.fetches, 1);
  });

  it('плохая подпись считается всплеском только у рабочей или приостановленной связки', async () => {
    // Ловит ложные тревоги о соседях, которых держатель уже заблокировал или которым перестал доверять.
    const trusted = keyPair();
    const foreign = { ...keyPair(), kid: trusted.kid };
    for (const [state, expected] of [['active', 1], ['paused', 1], ['blocked', 0], ['trust-lost', 0]] as const) {
      const h = harness({ state, fetch: async () => ({ ok: true, value: document(trusted) }) });
      await h.auth.authenticateLinkedPeer(signedRequest(foreign, h.now), 'peer-id');
      assert.equal(h.storms, expected, state);
    }
  });

  it('аварийная пауза раскрывается только предъявителю верной подписи', async () => {
    // Ловит утечку состояния федерации постороннему с поддельной подписью.
    const trusted = keyPair();
    const foreign = { ...keyPair(), kid: trusted.kid };
    let pauseReads = 0;
    const h = harness({
      fetch: async () => ({ ok: true, value: document(trusted) }),
      paused: async () => { pauseReads += 1; return true; },
    });
    const rejected = await h.auth.authenticateLinkedPeer(signedRequest(foreign, h.now), 'peer-id');
    assert.equal(rejected.ok, false);
    if (!rejected.ok) assert.deepEqual({ status: rejected.status, error: rejected.error }, { status: 401, error: 'unknown' });
    assert.equal(pauseReads, 0);
    assert.deepEqual(await h.auth.authenticateLinkedPeer(signedRequest(trusted, h.now), 'peer-id'), {
      ok: false, status: 409, error: 'federation.paused',
    });
    assert.equal(pauseReads, 1);
  });

  it('peerPublicKey возвращает проверенный ключ из общего кеша, а forget заставляет загрузить визитку заново', async () => {
    // Ловит отдельный сетевой кеш для identity-токенов и сохранение ключей разорванной связки после forget.
    const signer = keyPair();
    const h = harness({ fetch: async () => ({ ok: true, value: document(signer) }) });
    assert.deepEqual(await h.auth.peerPublicKey(link(), signer.kid), signer.publicKey);
    assert.deepEqual(await h.auth.peerPublicKey(link(), signer.kid), signer.publicKey);
    assert.equal(h.fetches, 1);
    h.auth.forgetPeerDocument('peer-id');
    assert.deepEqual(await h.auth.peerPublicKey(link(), signer.kid), signer.publicKey);
    assert.equal(h.fetches, 2);
  });

  it('targetUriOf сохраняет query и не добавляет второй слэш после apiBase', () => {
    // Ловит проверку подписи по адресу, отличному от того, который подписал сосед.
    const h = harness();
    assert.equal(h.auth.targetUriOf({ url: '/fed/v1/directory?cursor=a%2Fb' }), `${API_BASE}/fed/v1/directory?cursor=a%2Fb`);
  });
});
