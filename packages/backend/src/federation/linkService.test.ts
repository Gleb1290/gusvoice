import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type { FedInstanceDocument } from '@gusvoice/shared';
import { decodeLinkCode, hashLinkSecret } from './linkCode.js';
import {
  confirmDeliveryOf,
  confirmRetryDelayMs,
  createLinkService,
  peerRejectionReason,
  type LinkDeps,
  type StoredCode,
  type StoredLink,
} from './linkService.js';
import type { PeerDocument } from './peerClient.js';

type Box = {
  id: string;
  fingerprint: string;
  doc: FedInstanceDocument;
  links: Map<string, StoredLink>;
  codes: Map<string, StoredCode>;
  service: ReturnType<typeof createLinkService>;
  failPost: boolean;
  postCalls: number;
  upsertCalls: number;
  rebindCalls: number;
  order: string[];
  burnResult: boolean | void;
  revokedIds: Set<string>;
  takenDomains: Set<string>;
};

function makeBox(id: string, fingerprint: string): Box {
  const doc: FedInstanceDocument = {
    instanceId: id,
    name: id,
    iconHash: null,
    domain: `${id.toLowerCase()}.example`,
    clientOrigin: `https://${id.toLowerCase()}.example`,
    apiBase: `https://${id.toLowerCase()}.example`,
    protocol: { min: 1, max: 1 },
    features: [],
    appVersion: null,
    rootKey: `root-${id}`,
    keys: [],
  };
  const box = {
    id,
    fingerprint,
    doc,
    links: new Map(),
    codes: new Map(),
    service: null as never,
    failPost: false,
    postCalls: 0,
    upsertCalls: 0,
    rebindCalls: 0,
    order: [],
    burnResult: undefined,
    revokedIds: new Set<string>(),
    takenDomains: new Set<string>(),
  };
  return box;
}

function peerOf(box: Box): PeerDocument {
  return { doc: box.doc, instanceId: box.id, fingerprint: box.fingerprint, protocolVersion: 1 };
}

function connect(box: Box, peers: Map<string, Box>): void {
  let seq = 0;
  const deps: LinkDeps = {
    now: () => 1_000,
    self: () => ({ instanceId: box.id, fingerprint: box.fingerprint, domain: box.doc.domain, apiBase: box.doc.apiBase, name: box.id }),
    signing: () => ({ keyid: `key-${box.id}`, privateKeyDer: Buffer.from([1]) }),
    async fetchDocument(apiBase) {
      const peer = [...peers.values()].find((candidate) => apiBase.includes(candidate.doc.domain));
      return peer ? { ok: true, value: peerOf(peer) } : { ok: false, problem: 'unreachable' };
    },
    async postToPeer(input) {
      box.postCalls++;
      box.order.push('post');
      if (box.failPost) return { ok: false, problem: 'unreachable' };
      const peer = [...peers.values()].find((candidate) => input.apiBase === candidate.doc.apiBase);
      if (!peer) return { ok: false, problem: 'unreachable' };
      if (input.path === '/api/fed/v1/link/request') {
        const payload = input.payload as { secret: string };
        const result = await peer.service.receiveRequest({ secret: payload.secret, peer: peerOf(box) });
        return result.ok
          ? { ok: true, value: { status: 200, body: '{}' } }
          : { ok: true, value: { status: 409, body: JSON.stringify({ error: result.problem }) } };
      }
      if (input.path === '/api/fed/v1/link/confirmed') {
        const result = await peer.service.receiveConfirmed(box.id);
        return result.ok
          ? { ok: true, value: { status: 200, body: '{}' } }
          : { ok: true, value: { status: 409, body: JSON.stringify({ error: result.problem }) } };
      }
      return { ok: true, value: { status: 404, body: '{}' } };
    },
    async saveCode(code) { box.codes.set(code.secretHash, { ...code, usedAt: null }); },
    async findCodeByHash(hash) { return box.codes.get(hash) ?? null; },
    async markCodeUsed(codeId) {
      if (box.burnResult === false) return false;
      for (const [hash, code] of box.codes) if (code.id === codeId) box.codes.set(hash, { ...code, usedAt: 1_000 });
      return box.burnResult;
    },
    async isRevoked(instanceId) { return box.revokedIds.has(instanceId); },
    async domainTaken(domain) { return box.takenDomains.has(domain); },
    async getLink(instanceId) { return box.links.get(instanceId) ?? null; },
    async upsertLink(link) { box.upsertCalls++; box.links.set(link.instanceId, link); },
    async setLinkState(instanceId, state) {
      const link = box.links.get(instanceId);
      if (link) box.links.set(instanceId, { ...link, state });
    },
    newId: () => `${box.id}-${++seq}`,
    async rebind(fromInstanceId, link) {
      box.rebindCalls++;
      box.order.push('rebind');
      if (!box.links.has(fromInstanceId)) return false;
      box.links.delete(fromInstanceId);
      box.links.set(link.instanceId, link);
      return true;
    },
    audit() {},
  };
  box.service = createLinkService(deps);
}

describe('порядок заведения федеративной связки', () => {
  it('код → заявка → подтверждение активирует обе стороны только после решения A', async () => {
    const a = makeBox('A', 'FP-A');
    const b = makeBox('B', 'FP-B');
    const peers = new Map([[a.id, a], [b.id, b]]);
    connect(a, peers);
    connect(b, peers);

    const issued = await a.service.issueCode({ issuedBy: 'owner-a' });
    assert.equal(issued.ok, true);
    if (!issued.ok) return;
    const requested = await b.service.requestLink(issued.value.code);
    assert.deepEqual(requested, { ok: true, value: { instanceId: 'A', state: 'requested' } });
    assert.equal(a.links.get('B')?.state, 'pending');
    assert.equal(b.links.get('A')?.state, 'requested');
    assert.equal([...a.links.values(), ...b.links.values()].some((link) => link.state === 'active'), false);

    const confirmed = await a.service.confirmLink('B');
    assert.deepEqual(confirmed, { ok: true, value: { state: 'active', peerNotified: true } });
    assert.equal(a.links.get('B')?.state, 'active');
    assert.equal(b.links.get('A')?.state, 'active');
  });

  it('тот же код у другого инстанса получает code-used именно от выдавшей стороны', async () => {
    const a = makeBox('A', 'FP-A');
    const b = makeBox('B', 'FP-B');
    const c = makeBox('C', 'FP-C');
    const peers = new Map([[a.id, a], [b.id, b], [c.id, c]]);
    connect(a, peers); connect(b, peers); connect(c, peers);
    const issued = await a.service.issueCode({ issuedBy: 'owner-a' });
    assert.equal(issued.ok, true);
    if (!issued.ok) return;
    assert.equal((await b.service.requestLink(issued.value.code)).ok, true);
    const decoded = decodeLinkCode(issued.value.code);
    assert.ok(decoded);
    assert.equal(a.codes.get(hashLinkSecret(decoded.secret))?.usedAt, 1_000);
    assert.deepEqual(await a.service.receiveRequest({ secret: decoded.secret, peer: peerOf(c) }), {
      ok: false,
      problem: 'code-used',
    });
  });

  it('отказ соседа сохраняет его причину, а недоступность после подтверждения не откатывает решение', async () => {
    const a = makeBox('A', 'FP-A');
    const b = makeBox('B', 'FP-B');
    const peers = new Map([[a.id, a], [b.id, b]]);
    connect(a, peers); connect(b, peers);
    const issued = await a.service.issueCode({ issuedBy: 'owner-a' });
    assert.equal(issued.ok, true);
    if (!issued.ok) return;
    const decoded = decodeLinkCode(issued.value.code);
    assert.ok(decoded);
    const stored = a.codes.get(hashLinkSecret(decoded.secret));
    assert.ok(stored);
    a.codes.set(hashLinkSecret(decoded.secret), { ...stored, usedAt: 999 });
    assert.deepEqual(await b.service.requestLink(issued.value.code), { ok: false, problem: 'peer-rejected', detail: 'code-used' });

    a.links.set('B', { ...b.doc, instanceId: 'B', rootKey: 'root-B', theirName: 'B', state: 'pending', protocolVersion: 1, features: [] });
    a.failPost = true;
    assert.deepEqual(await a.service.confirmLink('B'), { ok: true, value: { state: 'active', peerNotified: false } });
    assert.equal(a.links.get('B')?.state, 'active');
  });

  it('повторное подтверждение и resume из blocked отвергаются как wrong-state', async () => {
    const a = makeBox('A', 'FP-A');
    const peers = new Map([[a.id, a]]);
    connect(a, peers);
    a.links.set('B', {
      instanceId: 'B', domain: 'b.example', apiBase: 'https://b.example', clientOrigin: 'https://b.example',
      rootKey: 'root-B', theirName: 'B', state: 'active', protocolVersion: 1, features: [],
    });
    assert.deepEqual(await a.service.confirmLink('B'), { ok: false, problem: 'wrong-state', detail: 'active' });
    assert.equal((await a.service.applyAdminAction('B', 'block')).ok, true);
    assert.deepEqual(await a.service.applyAdminAction('B', 'resume'), { ok: false, problem: 'wrong-state', detail: 'blocked' });
  });
});

describe('разбор доставки подтверждения связки', () => {
  const response = (status: number, error?: string) => ({
    ok: true as const,
    value: { status, body: error === undefined ? '' : JSON.stringify({ error }) },
  });

  it('успех доставлен, а сетевой сбой и временные отказы повторяются', () => {
    // Ловит снятие отметки досылки после недоставленного или исправимого ответа соседа.
    assert.equal(confirmDeliveryOf(response(200)), 'delivered');
    assert.equal(confirmDeliveryOf({ ok: false }), 'retry');
    for (const [status, code] of [[400, 'domain-unproven'], [401, 'expired'], [401, 'bad-signature'], [409, 'replay'], [500, 'unknown']] as const) {
      assert.equal(confirmDeliveryOf(response(status, code)), 'retry', `${status} ${code}`);
    }
  });

  it('сосед, который больше не ждёт или не знает нас, останавливает досылку', () => {
    // Ловит вечную очередь подтверждений уже разорванной либо забытой связки.
    for (const [status, code] of [
      [400, 'wrong-state'], [400, 'unknown-link'], [401, 'unknown'],
      [409, 'federation.server_closed'], [409, 'federation.trust_lost'],
    ] as const) assert.equal(confirmDeliveryOf(response(status, code)), 'not-waiting', `${status} ${code}`);
  });

  it('задержка удваивается от десяти минут и упирается ровно в шесть часов', () => {
    // Ловит как шторм повторов, так и суточное ожидание уже поднявшегося соседа.
    assert.equal(confirmRetryDelayMs(0), 10 * 60_000);
    assert.equal(confirmRetryDelayMs(1), 10 * 60_000);
    assert.equal(confirmRetryDelayMs(2), 20 * 60_000);
    assert.equal(confirmRetryDelayMs(3), 40 * 60_000);
    assert.equal(confirmRetryDelayMs(20), 6 * 60 * 60_000);
  });

  it('причиной бывает только короткий машинный код нижнего регистра', () => {
    // Ловит показ держателю внедрённого соседом текста как системной причины GusVoice.
    assert.equal(peerRejectionReason('{"error":"federation.server_closed"}'), 'federation.server_closed');
    assert.equal(peerRejectionReason('{"error":"свяжитесь t.me/x"}'), null);
    assert.equal(peerRejectionReason('{"error":"Wrong"}'), null);
    assert.equal(peerRejectionReason(JSON.stringify({ error: `a${'b'.repeat(64)}` })), null);
    assert.equal(peerRejectionReason('{"error":""}'), null);
    assert.equal(peerRejectionReason('not json'), null);
  });

  it('сосед не может сам подтвердить присланную им заявку', async () => {
    // Ловит обход второй кнопки держателя: входящее pending нельзя активировать чужим confirmed.
    const a = makeBox('A', 'FP-A');
    connect(a, new Map([[a.id, a]]));
    const base = {
      instanceId: 'B', domain: 'b.example', apiBase: 'https://b.example', clientOrigin: 'https://b.example',
      rootKey: 'root-B', theirName: 'B', protocolVersion: 1, features: [],
    };
    a.links.set('B', { ...base, state: 'pending' });
    assert.deepEqual(await a.service.receiveConfirmed('B'), { ok: false, problem: 'wrong-state', detail: 'pending' });
    assert.equal(a.links.get('B')?.state, 'pending');

    a.links.set('B', { ...base, state: 'requested' });
    assert.deepEqual(await a.service.receiveConfirmed('B'), { ok: true, value: { state: 'active' } });
    assert.equal(a.links.get('B')?.state, 'active');
  });

  it('код перепривязки в общем поле ничего не меняет и не исполняет названную в нём связку', async () => {
    // Ловит F-01: недоверенное поле o прежде позволяло перенести чужую рабочую связку без выбора карточки.
    const a = makeBox('A', 'FP-A');
    const b = makeBox('B', 'FP-B');
    const peers = new Map([[a.id, a], [b.id, b]]);
    connect(a, peers); connect(b, peers);
    b.links.set('victim', {
      instanceId: 'victim', domain: 'victim.example', apiBase: 'https://victim.example',
      clientOrigin: 'https://victim.example', rootKey: 'root-victim', theirName: 'Victim',
      state: 'active', protocolVersion: 1, features: [],
    });
    const issued = await a.service.issueCode({ issuedBy: 'owner-a', purpose: 'rebind', previousInstanceId: 'victim' });
    assert.equal(issued.ok, true);
    if (!issued.ok) return;

    assert.deepEqual(await b.service.requestLink(issued.value.code), { ok: false, problem: 'rebind-code' });
    assert.equal(b.postCalls, 0);
    assert.equal(b.upsertCalls, 0);
    assert.equal(b.rebindCalls, 0);
    assert.equal(b.links.get('victim')?.state, 'active');
  });

  it('карточка перепривязки принимает только rebind-код для выбранной рабочей связки и прежнего хоста', async () => {
    // Ловит повторное исполнение кода с неверной карточки, той же личностью или подменённым api_base.
    const a = makeBox('A', 'FP-A');
    const b = makeBox('B', 'FP-B');
    const peers = new Map([[a.id, a], [b.id, b]]);
    connect(a, peers); connect(b, peers);
    const normal = await a.service.issueCode({ issuedBy: 'owner-a' });
    const rebound = await a.service.issueCode({ issuedBy: 'owner-a', purpose: 'rebind', previousInstanceId: 'B' });
    assert.equal(normal.ok, true); assert.equal(rebound.ok, true);
    if (!normal.ok || !rebound.ok) return;
    const old = {
      domain: 'a.example', apiBase: 'https://a.example', clientOrigin: 'https://a.example',
      rootKey: 'old-root', theirName: 'A', protocolVersion: 1, features: [],
    };

    b.links.set('old-a', { ...old, instanceId: 'old-a', state: 'blocked' });
    assert.deepEqual(await b.service.requestLink(normal.value.code, { rebindOf: 'old-a' }), { ok: false, problem: 'not-rebind-code' });
    assert.deepEqual(await b.service.requestLink(rebound.value.code, { rebindOf: 'old-a' }), {
      ok: false, problem: 'wrong-state', detail: 'blocked',
    });

    b.links.delete('old-a');
    b.links.set('A', { ...old, instanceId: 'A', state: 'trust-lost' });
    assert.deepEqual(await b.service.requestLink(rebound.value.code, { rebindOf: 'A' }), { ok: false, problem: 'same-identity' });

    b.links.delete('A');
    b.links.set('old-a', { ...old, instanceId: 'old-a', apiBase: 'https://old.example', state: 'trust-lost' });
    assert.deepEqual(await b.service.requestLink(rebound.value.code, { rebindOf: 'old-a' }), {
      ok: false, problem: 'host-mismatch', detail: 'old.example',
    });
    assert.equal(b.postCalls, 0);
    assert.equal(b.rebindCalls, 0);
  });

  it('перепривязка сначала получает согласие соседа и только затем переносит старую связку', async () => {
    // Ловит потерю рабочей связки при сетевом сбое между локальным переносом и отказом соседа.
    const a = makeBox('A', 'FP-A');
    const b = makeBox('B', 'FP-B');
    const peers = new Map([[a.id, a], [b.id, b]]);
    connect(a, peers); connect(b, peers);
    a.links.set('B', {
      instanceId: 'B', domain: 'b.example', apiBase: 'https://b.example', clientOrigin: 'https://b.example',
      rootKey: 'root-B', theirName: 'B', state: 'trust-lost', protocolVersion: 1, features: [],
    });
    b.links.set('old-a', {
      instanceId: 'old-a', domain: 'a.example', apiBase: 'https://a.example', clientOrigin: 'https://a.example',
      rootKey: 'old-root', theirName: 'A', state: 'trust-lost', protocolVersion: 1, features: [],
    });
    const issued = await a.service.issueCode({ issuedBy: 'owner-a', purpose: 'rebind', previousInstanceId: 'B' });
    assert.equal(issued.ok, true);
    if (!issued.ok) return;

    assert.deepEqual(await b.service.requestLink(issued.value.code, { rebindOf: 'old-a' }), {
      ok: true, value: { instanceId: 'A', state: 'active' },
    });
    assert.deepEqual(b.order, ['post', 'rebind']);
    assert.equal(b.links.has('old-a'), false);
    assert.equal(b.links.get('A')?.state, 'active');
  });

  it('отказ соседа не переносит старую связку и оставляет код пригодным для повтора', async () => {
    // Ловит необратимое локальное изменение до внешнего подтверждения перепривязки.
    const a = makeBox('A', 'FP-A');
    const b = makeBox('B', 'FP-B');
    const peers = new Map([[a.id, a], [b.id, b]]);
    connect(a, peers); connect(b, peers);
    b.links.set('old-a', {
      instanceId: 'old-a', domain: 'a.example', apiBase: 'https://a.example', clientOrigin: 'https://a.example',
      rootKey: 'old-root', theirName: 'A', state: 'trust-lost', protocolVersion: 1, features: [],
    });
    const issued = await a.service.issueCode({ issuedBy: 'owner-a', purpose: 'rebind', previousInstanceId: 'B' });
    assert.equal(issued.ok, true);
    if (!issued.ok) return;
    b.failPost = true;

    assert.deepEqual(await b.service.requestLink(issued.value.code, { rebindOf: 'old-a' }), { ok: false, problem: 'unreachable' });
    assert.equal(b.rebindCalls, 0);
    assert.equal(b.links.get('old-a')?.state, 'trust-lost');
  });

  it('код перепривязки оживляет только ту личность, для которой был выдан', async () => {
    // Ловит применение утёкшего rebind-кода к другой связке в состоянии trust-lost.
    const a = makeBox('A', 'FP-A');
    const b = makeBox('B', 'FP-B');
    const c = makeBox('C', 'FP-C');
    const peers = new Map([[a.id, a], [b.id, b], [c.id, c]]);
    connect(a, peers); connect(b, peers); connect(c, peers);
    a.links.set('B', { ...b.doc, instanceId: 'B', rootKey: 'root-B', theirName: 'B', state: 'trust-lost', protocolVersion: 1, features: [] });
    a.links.set('C', { ...c.doc, instanceId: 'C', rootKey: 'root-C', theirName: 'C', state: 'trust-lost', protocolVersion: 1, features: [] });
    const issued = await a.service.issueCode({ issuedBy: 'owner-a', purpose: 'rebind', previousInstanceId: 'B' });
    assert.equal(issued.ok, true);
    if (!issued.ok) return;
    const decoded = decodeLinkCode(issued.value.code);
    assert.ok(decoded);

    assert.deepEqual(await a.service.receiveRequest({ secret: decoded.secret, peer: peerOf(c) }), { ok: false, problem: 'bad-code' });
    assert.equal(a.links.get('C')?.state, 'trust-lost');
    assert.deepEqual(await a.service.receiveRequest({ secret: decoded.secret, peer: peerOf(b) }), { ok: true, value: { state: 'active' } });
    assert.equal(a.links.get('B')?.state, 'active');
  });

  it('проигравшая атомарное погашение заявка не создаёт связку', async () => {
    // Ловит гонку двух предъявителей одного кода: второй не должен писать строку после CAS=false.
    const a = makeBox('A', 'FP-A');
    const b = makeBox('B', 'FP-B');
    const peers = new Map([[a.id, a], [b.id, b]]);
    connect(a, peers); connect(b, peers);
    const issued = await a.service.issueCode({ issuedBy: 'owner-a' });
    assert.equal(issued.ok, true);
    if (!issued.ok) return;
    const decoded = decodeLinkCode(issued.value.code);
    assert.ok(decoded);
    a.burnResult = false;

    assert.deepEqual(await a.service.receiveRequest({ secret: decoded.secret, peer: peerOf(b) }), { ok: false, problem: 'code-used' });
    assert.equal(a.upsertCalls, 0);
    assert.equal(a.links.has('B'), false);
  });

  it('код от отозванной личности отвергается до записи и сети', async () => {
    // Ловит повторное доверие уже объявленному украденным корневому ключу.
    const a = makeBox('A', 'FP-A');
    const b = makeBox('B', 'FP-B');
    const peers = new Map([[a.id, a], [b.id, b]]);
    connect(a, peers); connect(b, peers);
    const issued = await a.service.issueCode({ issuedBy: 'owner-a' });
    assert.equal(issued.ok, true);
    if (!issued.ok) return;
    b.revokedIds.add('A');

    assert.deepEqual(await b.service.requestLink(issued.value.code), { ok: false, problem: 'revoked-identity' });
    assert.equal(b.upsertCalls, 0);
    assert.equal(b.postCalls, 0);
  });

  it('занятый домен запрещает и новую заявку, и позднее подтверждение', async () => {
    // Ловит две рабочие личности с одинаковой видимой подписью после гонки между заявкой и кнопкой.
    const a = makeBox('A', 'FP-A');
    const b = makeBox('B', 'FP-B');
    const peers = new Map([[a.id, a], [b.id, b]]);
    connect(a, peers); connect(b, peers);
    const issued = await a.service.issueCode({ issuedBy: 'owner-a' });
    assert.equal(issued.ok, true);
    if (!issued.ok) return;
    b.takenDomains.add('a.example');
    assert.deepEqual(await b.service.requestLink(issued.value.code), { ok: false, problem: 'domain-taken' });
    assert.equal(b.upsertCalls, 0);

    b.links.set('A', {
      instanceId: 'A', domain: 'a.example', apiBase: 'https://a.example', clientOrigin: 'https://a.example',
      rootKey: 'root-A', theirName: 'A', state: 'requested', protocolVersion: 1, features: [],
    });
    assert.deepEqual(await b.service.receiveConfirmed('A'), { ok: false, problem: 'domain-taken' });
    assert.equal(b.links.get('A')?.state, 'requested');
  });
});

function confirmationHarness() {
  let clock = 1_000;
  let paused = false;
  let postCalls = 0;
  let postResult: Awaited<ReturnType<LinkDeps['postToPeer']>> = {
    ok: true, value: { status: 200, body: '{}' },
  };
  let postOverride: LinkDeps['postToPeer'] | null = null;
  const pendingWrites: boolean[] = [];
  const audits: { event: string; detail: Record<string, unknown> }[] = [];
  let link: StoredLink = {
    instanceId: 'B', domain: 'b.example', apiBase: 'https://b.example', clientOrigin: 'https://b.example',
    rootKey: 'root-B', theirName: 'B', state: 'active', protocolVersion: 1, features: [], confirmPending: true,
  };
  const deps: LinkDeps = {
    now: () => clock,
    self: () => ({ instanceId: 'A', fingerprint: 'FP-A', domain: 'a.example', apiBase: 'https://a.example', name: 'A' }),
    signing: () => ({ keyid: 'key-A', privateKeyDer: Buffer.from([1]) }),
    async fetchDocument() { return { ok: false, problem: 'unreachable' }; },
    async postToPeer(input) { postCalls++; return postOverride ? postOverride(input) : postResult; },
    async saveCode() {}, async findCodeByHash() { return null; }, async markCodeUsed() {},
    async getLink() { return link; },
    async upsertLink(next) { link = next; },
    async setLinkState(_id, state) { link = { ...link, state }; },
    async setConfirmPending(_id, pending) { pendingWrites.push(pending); link = { ...link, confirmPending: pending }; },
    async paused() { return paused; },
    newId: () => 'id', async rebind() { return false; },
    audit(event, detail) { audits.push({ event, detail }); },
  };
  return {
    service: createLinkService(deps),
    get link() { return link; }, set link(value) { link = value; },
    get clock() { return clock; }, set clock(value) { clock = value; },
    get paused() { return paused; }, set paused(value) { paused = value; },
    get postCalls() { return postCalls; },
    set postResult(value: Awaited<ReturnType<LinkDeps['postToPeer']>>) { postResult = value; },
    set postOverride(value: LinkDeps['postToPeer'] | null) { postOverride = value; },
    pendingWrites, audits,
  };
}

describe('досылка подтверждения связки', () => {
  it('успешная досылка снимает отметку и пишет одно событие журнала', async () => {
    // Ловит вечную отметку ожидания после уже принятого соседом подтверждения.
    const h = confirmationHarness();
    assert.equal(await h.service.resendConfirmation('B'), 'delivered');
    assert.deepEqual(h.pendingWrites, [false]);
    assert.equal(h.link.confirmPending, false);
    assert.deepEqual(h.audits.map((a) => a.event), ['federation.link_confirm_resent']);
  });

  it('перечитанная blocked-связка и глобальная пауза не отправляют ничего', async () => {
    // Ловит подтверждение соседу уже после решения держателя отрезать либо приостановить федерацию.
    const blocked = confirmationHarness();
    blocked.link = { ...blocked.link, state: 'blocked' };
    assert.equal(await blocked.service.resendConfirmation('B'), 'skipped');
    assert.equal(blocked.postCalls, 0);
    const paused = confirmationHarness();
    paused.paused = true;
    assert.equal(await paused.service.resendConfirmation('B'), 'skipped');
    assert.equal(paused.postCalls, 0);
  });

  it('одинаковый сетевой отказ соблюдает backoff и не засоряет журнал дублями', async () => {
    // Ловит десятиминутный шторм одинаковых записей и игнорирование ручной принудительной попытки.
    const h = confirmationHarness();
    h.postResult = { ok: false, problem: 'unreachable' };
    assert.equal(await h.service.resendConfirmation('B'), 'retry');
    assert.equal(await h.service.resendConfirmation('B'), 'skipped');
    assert.equal(h.postCalls, 1);
    h.clock += confirmRetryDelayMs(1);
    assert.equal(await h.service.resendConfirmation('B'), 'retry');
    assert.equal(h.audits.length, 1);
    assert.equal(await h.service.resendConfirmation('B', { force: true }), 'retry');
    assert.equal(h.postCalls, 3);
    assert.equal(h.audits.length, 1);
  });

  it('not-waiting снимает отметку и больше не отправляется', async () => {
    // Ловит вечные повторы соседу, который удалил или уже завершил свою половину связки.
    const h = confirmationHarness();
    h.postResult = { ok: true, value: { status: 401, body: '{"error":"unknown"}' } };
    assert.equal(await h.service.resendConfirmation('B'), 'not-waiting');
    assert.deepEqual(h.pendingWrites, [false]);
    assert.equal(await h.service.resendConfirmation('B', { force: true }), 'skipped');
    assert.equal(h.postCalls, 1);
  });

  it('два одновременных вызова делают ровно один сетевой запрос', async () => {
    // Ловит двойное подтверждение от планового прохода и ручной кнопки в один момент.
    const h = confirmationHarness();
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    h.postOverride = async () => { await gate; return { ok: true, value: { status: 200, body: '{}' } }; };
    const first = h.service.resendConfirmation('B');
    await Promise.resolve();
    assert.equal(await h.service.resendConfirmation('B'), 'skipped');
    assert.equal(h.postCalls, 1);
    release();
    assert.equal(await first, 'delivered');
  });

  it('confirmLink ставит pending до отправки и оставляет его при сетевой ошибке', async () => {
    // Ловит потерю единственного повода дослать подтверждение после перезапуска посреди отправки.
    const h = confirmationHarness();
    h.link = { ...h.link, state: 'pending', confirmPending: false };
    const order: string[] = [];
    h.postOverride = async () => { order.push(`post:${h.link.confirmPending}`); return { ok: false, problem: 'unreachable' }; };
    const result = await h.service.confirmLink('B');
    assert.deepEqual(result, { ok: true, value: { state: 'active', peerNotified: false } });
    assert.deepEqual(h.pendingWrites, [true]);
    assert.deepEqual(order, ['post:true']);
    assert.equal(h.link.confirmPending, true);
  });

  it('confirmLink снимает pending после 2xx и после окончательного server_closed', async () => {
    // Ловит бессмысленную досылку после принятого подтверждения или явного разрыва у соседа.
    for (const result of [
      { ok: true as const, value: { status: 200, body: '{}' } },
      { ok: true as const, value: { status: 409, body: '{"error":"federation.server_closed"}' } },
    ]) {
      const h = confirmationHarness();
      h.link = { ...h.link, state: 'pending', confirmPending: false };
      h.postResult = result;
      await h.service.confirmLink('B');
      assert.deepEqual(h.pendingWrites, [true, false]);
      assert.equal(h.link.confirmPending, false);
    }
  });
});
