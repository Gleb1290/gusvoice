import assert from 'node:assert/strict';
import { randomUUID, generateKeyPairSync } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import { before, beforeEach, after, test } from 'node:test';
import ts from 'typescript';
import * as orm from 'drizzle-orm';
import * as shared from '@gusvoice/shared';
import * as schema from '../src/db/schema.js';
import * as linkRules from '../src/federation/linkRules.js';
import * as outboxRules from '../src/federation/outboxRules.js';
import * as keyRules from '../src/federation/keyRevocation.js';
import { createTestDb, truncateAll, type TestDb } from './harness.js';

const streamSource = readFileSync(new URL('../src/federation/eventStream.ts', import.meta.url), 'utf8').replace(/\r\n/g, '\n');
const outboxSource = readFileSync(new URL('../src/federation/outbox.ts', import.meta.url), 'utf8').replace(/\r\n/g, '\n');
const revokeSource = readFileSync(new URL('../src/federation/revocation.ts', import.meta.url), 'utf8');
let t: TestDb;
const now = Date.parse('2026-10-12T12:00:00Z');
before(async () => { t = await createTestDb(); });
beforeEach(async () => { await truncateAll(t.raw); });
after(async () => { await t.close(); });
const noEffect = async () => {};
function replace(raw: string, anchor: string, value: string) {
  assert.equal(raw.split(anchor).length - 1, 1, 'единственный якорь целого модуля'); return raw.replace(anchor, value);
}
function fixture(streamRaw = streamSource, outboxRaw = outboxSource) {
  const deliveries: { peer: string; seqs: number[] }[] = [];
  const handled: number[] = [];
  const deliver: typeof import('../src/federation/peerClient.js').postSignedToPeer = async input => {
    const body = input.payload as { events?: { seq: number }[] };
    deliveries.push({ peer: new URL(input.apiBase).hostname, seqs: (body.events ?? []).map(e => e.seq) });
    return { ok: true, value: { status: 200, body: '{}' } };
  };
  class Clock extends Date { constructor(value?: string | number) { super(value ?? now); } static override now() { return now; } }
  const identity = { identity: () => ({ instanceId: 'self' }), signingKey: () => ({ kid: 'fixture', privateKeyDer: new Uint8Array() }),
    rotateRootKey: async () => {
      const old = generateKeyPairSync('ed25519'), next = generateKeyPairSync('ed25519');
      return { previous: { instanceId: 'self-old', rootPrivateKeyDer: old.privateKey.export({ format: 'der', type: 'pkcs8' }) },
        next: { instanceId: 'self-new', rootPublicKeyDer: next.publicKey.export({ format: 'der', type: 'spki' }), fingerprint: 'fixture-new' } };
    } };
  const deps: Record<string, unknown> = {
    'drizzle-orm': orm, '@gusvoice/shared': shared, 'node:crypto': { randomUUID },
    '../db/index.js': { db: t.db }, '../db/schema.js': schema,
    './instance.js': { federation: identity }, './peerClient.js': { postSignedToPeer: deliver },
    './linkRules.js': linkRules, './outboxRules.js': outboxRules,
    './reportStatus.js': { markReportsDelivered: async (_peer: string, ids: string[]) => { assert.equal(ids.length, 0, 'fixture не отправляет жалобы'); } },
    './directorySync.js': { markNeedsFull: noEffect }, './keyRevocation.js': keyRules,
    // Эти границы относятся к гостям/каталогу, которых в сцене нет. Сам reset связки выполняет настоящий revocation SQL.
    './peerAuth.js': { forgetPeerDocument: () => {} }, './directoryCache.js': { forgetPeerCache: noEffect },
    './guestAccess.js': { freezeGuestsOf: noEffect, moveGuestsToInstance: noEffect, thawGuestsOf: noEffect },
  };
  function load<T>(raw: string): T {
    const module = { exports: {} };
    runInNewContext(ts.transpileModule(raw, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText,
      { module, exports: module.exports, Date: Clock, URL, Buffer, crypto: { randomUUID }, console: { warn: () => {} },
        setInterval: () => { throw new Error('не запускать worker'); },
        require: (id: string) => { if (!Object.hasOwn(deps, id)) throw new Error(`неописанная граница ${id}`); return deps[id]; } });
    return module.exports as T;
  }
  const outbox = load<typeof import('../src/federation/outbox.js')>(outboxRaw); deps['./outbox.js'] = outbox;
  const stream = load<typeof import('../src/federation/eventStream.js')>(streamRaw); deps['./eventStream.js'] = stream;
  stream.onFedEvent('fixture.event', async ({ event, instanceId }) => {
    // Handler с реальной SQL-записью: повторы должны быть отсеяны ДО его вызова.
    await t.raw.query('UPDATE federation_links SET local_name = $1 WHERE instance_id = $2', [`handled-${event.seq}`, instanceId]);
    handled.push(event.seq);
  });
  const revocation = load<typeof import('../src/federation/revocation.js')>(revokeSource);
  return { stream, outbox, revocation, deliveries, handled, deliver,
    signer: () => ({ self: identity.identity(), key: identity.signingKey() }) };
}
async function link(id: string) {
  await t.raw.query(`INSERT INTO federation_links (instance_id,domain,api_base,client_origin,root_key,state)
    VALUES ($1,$2,$3,$4,'fixture-root','active')`, [id, `${id}.example`, `https://${id}.example/api`, `https://${id}.example`]);
}
async function row(id = 'a') {
  return (await t.raw.query<{ last_event_seq: number; missing_event_seqs: number[]; state: string; local_name: string }>(
    'SELECT last_event_seq::int AS last_event_seq, missing_event_seqs, state, local_name FROM federation_links WHERE instance_id = $1', [id])).rows[0];
}
const event = (seq: number, id = `event-${seq}`) => shared.serializeFedEvent({ eventId: id, seq, kind: 'fixture.event', createdAt: now, payload: {} });
async function queued(streamRaw = streamSource) {
  await truncateAll(t.raw); await link('a'); await link('b'); const f = fixture(streamRaw);
  assert.equal(await f.stream.queueEventTo('a', 'fixture.event', {}), 'queued');
  const outcome = await f.stream.sendEventTo('a', 'fixture.event', {});
  assert.equal(outcome, 'queued', 'ранняя очередь не обгоняется'); assert.equal(f.deliveries.length, 0, 'нет немедленной доставки хвоста');
  assert.equal(await f.stream.sendEventTo('b', 'fixture.event', {}), 'sent', 'очередь другого соседа не мешает');
  assert.equal(f.deliveries[0].peer, 'b.example'); assert.equal(f.deliveries[0].seqs.join(','), '1');
  const count = await t.raw.query<{ n: number }>('SELECT count(*)::int AS n FROM federation_outbox WHERE instance_id = $1', ['a']);
  assert.equal(count.rows[0].n, 2);
}
test('R187 ранняя очередь связки удерживает новое событие, другая связка доставляет сразу', async () => {
  // Класс ошибки: новая доставка обгоняет недоставленный номер той же связки.
  await queued();
});
test('R187 чистая очередь позволяет немедленную доставку и удаляет доставленное событие', async () => {
  // Класс ошибки: запрет обгона ошибочно блокирует первое событие.
  await link('a'); const f = fixture(); assert.equal(await f.stream.sendEventTo('a', 'fixture.event', {}), 'sent');
  assert.equal(f.deliveries.length, 1); assert.equal(f.deliveries[0].seqs.join(','), '1');
  assert.equal((await t.raw.query('SELECT id FROM federation_outbox')).rows.length, 0);
});
async function pending(outboxRaw = outboxSource) {
  await truncateAll(t.raw); await link('a'); await link('b'); const f = fixture(streamSource, outboxRaw);
  for (const [peer, seq, due] of [['a', 1, now + 1], ['a', 2, now], ['b', 1, now]] as const) {
    await t.db.insert(schema.federationOutbox).values({ id: randomUUID(), instanceId: peer, seq, eventId: `${peer}-${seq}`, kind: 'fixture.event', payload: {}, createdAt: new Date(now), nextAttemptAt: new Date(due) });
  }
  const first = await f.outbox.runOutboxPass(now, f.deliver, f.signer);
  assert.equal(f.deliveries.some(d => d.peer === 'a.example'), false, 'хвост ждёт будущую голову');
  assert.equal(f.deliveries.length, 1); assert.equal(f.deliveries[0].peer, 'b.example'); assert.equal(first.delivered, 1);
  assert.equal((await t.raw.query('SELECT id FROM federation_outbox')).rows.length, 2);
  f.deliveries.length = 0;
  const second = await f.outbox.runOutboxPass(now + 1, f.deliver, f.signer);
  assert.equal(second.delivered, 2); assert.equal(f.deliveries[0].seqs.join(','), '1,2', 'срок ровно now допускает голову и сохраняет порядок');
  assert.equal((await t.raw.query('SELECT id FROM federation_outbox')).rows.length, 0);
}
test('R187 хвост ждёт будущую голову, ровно срок допускает её первой, другая связка независима', async () => {
  // Класс ошибки: выборка только готовых событий скрывает задержанную голову и выпускает хвост.
  await pending();
});
async function missing(streamRaw = streamSource) {
  await truncateAll(t.raw); await link('a'); const f = fixture(streamRaw);
  assert.equal((await f.stream.receiveEvents('a', [event(3)])).gaps, 1);
  assert.equal((await row()).last_event_seq, 3); assert.equal(JSON.stringify((await row()).missing_event_seqs), '[1,2]');
  const late = await f.stream.receiveEvents('a', [event(1)]);
  assert.equal(late.accepted, 1); assert.equal(late.gaps, 0);
  assert.equal((await row()).last_event_seq, 3, 'late не сдвигает lastSeq');
  assert.equal(JSON.stringify((await row()).missing_event_seqs), '[2]');
  const repeat = await f.stream.receiveEvents('a', [event(1), event(1, 'same-seq-new-id')]);
  assert.equal(repeat.accepted, 0); assert.equal(repeat.duplicates, 2); assert.equal(f.handled.join(','), '3,1', 'повтор не вызывает handler');
  await f.stream.receiveEvents('a', [event(2)]);
  assert.equal(JSON.stringify((await row()).missing_event_seqs), '[]'); assert.equal((await row()).last_event_seq, 3);
  assert.equal((await row()).local_name, 'handled-2'); assert.equal(f.handled.join(','), '3,1,2');
}
test('R187 дыра хранится в SQL, позднее событие вычёркивается без отката lastSeq, повтор не вызывает handler', async () => {
  // Класс ошибки: потерянный номер навсегда становится повтором либо откатывает курсор.
  await missing();
});
test('R187 отзыв собственного ключа переводит связки в trust-lost и реально сбрасывает пропуски', async () => {
  // Класс ошибки: прежняя нумерация переживает смену доверия и отбрасывает события новой личности.
  await link('a'); const f = fixture(); await f.stream.receiveEvents('a', [event(3)]);
  assert.equal((await row()).missing_event_seqs.length, 2);
  assert.equal((await f.revocation.revokeOwnKey())?.notified, 1);
  const state = await row(); assert.equal(state.state, 'trust-lost'); assert.equal(state.last_event_seq, 0); assert.equal(JSON.stringify(state.missing_event_seqs), '[]');
});
test('R187 перепривязка активной связки очищает пропуски и дедуп, первое событие новой личности применяется', async () => {
  // Класс ошибки: новая связка наследует пропуски и окно идентификаторов старой.
  await link('a'); const f = fixture(); await f.stream.receiveEvents('a', [event(3)]);
  // Незавершённая повторная заявка новой личности может иметь старое окно в памяти того же процесса.
  await link('new-a'); await f.stream.receiveEvents('new-a', [event(3)]);
  await t.raw.query("UPDATE federation_links SET state = 'pending' WHERE instance_id = 'new-a'");
  const ok = await f.revocation.rebindLink('a', { instanceId: 'new-a', domain: 'a.example', apiBase: 'https://a.example/api', clientOrigin: 'https://a.example', rootKey: 'new-fixture-root', theirName: null, protocolVersion: 1, features: [] });
  assert.equal(ok, true); assert.equal(await row('a'), undefined);
  const state = await row('new-a'); assert.equal(state.last_event_seq, 0); assert.equal(JSON.stringify(state.missing_event_seqs), '[]');
  assert.equal((await f.stream.receiveEvents('new-a', [event(1, 'event-3')])).accepted, 1);
  assert.equal((await row('new-a')).last_event_seq, 1); assert.equal(f.handled.join(','), '3,3,1');
});
test('R187 мутант без hasEarlierQueued обнаруживается отсутствием немедленного обгона', async () => {
  // Класс ошибки: удалён рубеж перед немедленной отправкой.
  await queued(); await assert.rejects(queued(replace(streamSource, "if (await hasEarlierQueued(instanceId, event.seq)) return 'queued';", '')),
    e => e instanceof assert.AssertionError && e.message.includes('ранняя очередь не обгоняется'));
});
test('R187 мутант готовой выборки nextAttemptAt обнаруживается хвостом будущей головы', async () => {
  // Класс ошибки: SQL-фильтр скрывает голову очереди от проверки порядка.
  await pending(); const raw = replace(outboxSource, '.where(eq(federationOutbox.instanceId, link.instanceId))',
    '.where(and(eq(federationOutbox.instanceId, link.instanceId), lte(federationOutbox.nextAttemptAt, new Date(now))))');
  const mutated = replace(raw, "import { asc, eq, inArray } from 'drizzle-orm';", "import { and, asc, eq, inArray, lte } from 'drizzle-orm';");
  await assert.rejects(pending(mutated), e => e instanceof assert.AssertionError && e.message.includes('хвост ждёт будущую голову'));
});
test('R187 мутант позднего lastSeq обнаруживается сохранённым SQL курсором', async () => {
  // Класс ошибки: late событие откатывает последний принятый номер.
  await missing(); await assert.rejects(missing(replace(streamSource, 'if (!verdict.late) lastSeq = event.seq;', 'lastSeq = event.seq;')),
    e => e instanceof assert.AssertionError && e.message.includes('late не сдвигает lastSeq'));
});
