import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import { generateKeyPairSync, randomUUID } from 'node:crypto';
import { before, beforeEach, after, test } from 'node:test';
import Fastify from 'fastify';
import ts from 'typescript';
import * as shared from '@gusvoice/shared';
import * as orm from 'drizzle-orm';
import * as schema from '../src/db/schema.js';
import * as rules from '../src/convRules.js';
import * as signatures from '../src/federation/httpSignature.js';
import { createTestDb, truncateAll, type TestDb } from './harness.js';

type Conv = typeof import('../src/conversations.js');
type Changes = typeof import('../src/federation/convChanges.js');
const self = 'a'.repeat(32), peer = 'b'.repeat(32);
let t: TestDb;
const raw = (name: string) => readFileSync(new URL(`../src/${name}.ts`, import.meta.url), 'utf8').replace(/\r\n/g, '\n');
function blocked(name: string) {
  return new Proxy({}, { get: (_t, k) => k === '__esModule' ? true : () => { throw new Error(`неисполняемая граница ${name}.${String(k)}`); } });
}
function moduleOf<T>(name: string, deps: Record<string, unknown>, mutation?: readonly [string, string]): T {
  let source = raw(name);
  if (mutation) { assert.equal(source.split(mutation[0]).length - 1, 1, 'единственный якорь'); source = source.replace(...mutation); }
  const ast = ts.createSourceFile(name, source, ts.ScriptTarget.Latest, true);
  // Неиспользуемые подсистемы целого модуля имеют запрет исполнения, а исполняемые перечислены явно в deps.
  const imports: Record<string, unknown> = {};
  for (const n of ast.statements) if (ts.isImportDeclaration(n) && !n.importClause?.isTypeOnly)
    imports[(n.moduleSpecifier as ts.StringLiteral).text] = blocked((n.moduleSpecifier as ts.StringLiteral).text);
  Object.assign(imports, deps);
  const module = { exports: {} };
  runInNewContext(ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS,
    target: ts.ScriptTarget.ES2022 } }).outputText, { module, exports: module.exports, Date, Map, Set, Promise, Buffer,
    require: (id: string) => { assert.equal(Object.hasOwn(imports, id), true, `явный импорт ${id}`); return imports[id]; } });
  return module.exports as T;
}
function changes(db: unknown = t.db, mutation?: readonly [string, string]) {
  return moduleOf<Changes>('federation/convChanges', { '@gusvoice/shared': shared, 'drizzle-orm': orm,
    '../db/index.js': { db }, '../db/schema.js': schema }, mutation);
}
function conv(db: unknown = t.db, mutation?: readonly [string, string]) {
  const serialize = moduleOf<typeof import('../src/serialize.js')>('serialize', {
    '@gusvoice/shared': shared, './env.js': { env: {} },
    './federation/instanceLabels.js': { instanceLabel: (id: string) => ({ instanceId: id, name: 'Тестовый сосед', domain: 'peer.invalid', reports: false }) },
    './linkThreats.js': { dangerousLinksOf: () => [] },
  });
  return moduleOf<Conv>('conversations', { '@gusvoice/shared': shared, 'drizzle-orm': orm, './convRules.js': rules,
    './db/index.js': { db }, './db/schema.js': schema, './util.js': { uuidv7: randomUUID }, './env.js': { env: {} }, './serialize.js': serialize }, mutation);
}
async function guest() {
  return moduleOf<typeof import('../src/federation/guestHost.js')>('federation/guestHost', {
    'node:crypto': { randomUUID }, 'drizzle-orm': orm, '@gusvoice/shared': shared,
    '../db/index.js': { db: t.db }, '../db/schema.js': schema,
    '../auth.js': { hashPassword: async () => 'unusable-test-hash' },
    '../authRules.js': await import('../src/authRules.js'), './guestRules.js': await import('../src/federation/guestRules.js'),
    './links.js': { getLink: async (id: string) => (await t.db.select().from(schema.federationLinks).where(orm.eq(schema.federationLinks.instanceId, id)))[0] ?? null },
    './avatars.js': { refreshGuestAvatar: async () => {} },
  });
}
before(async () => { t = await createTestDb(); });
beforeEach(async () => {
  await truncateAll(t.raw);
  await t.raw.exec("INSERT INTO users(id,username,display_name,password_hash,verified,approved_at) VALUES ('local','dmtest_local','Локальный','hash',true,now()),('other','dmtest_other','Другой','hash',true,now())");
  await t.raw.query(`INSERT INTO federation_links(instance_id,domain,api_base,client_origin,root_key,state)
    VALUES ($1,'peer.invalid','https://peer.invalid/api','https://peer.invalid','fixture-root','active')`, [peer]);
});
after(async () => { await t.close(); });
const profile = { username: 'dmtest_remote', displayName: 'Удалённый', avatarHash: null };
async function shadow() {
  const row = await (await guest()).ensureShadowUser(peer, 'remote', profile);
  assert.equal(!!row, true, 'активный сосед создаёт теневого'); return row!;
}

test('R187 неактивная связка и отсутствие профиля/кеша не создают теневого пользователя, активный профиль создаёт', async () => {
  // Класс ошибки: невидимая подготовка создаёт аккаунты без доверия или достоверного имени.
  const g = await guest();
  assert.equal(await g.ensureShadowUser(self, 'unlinked', profile), null);
  await t.raw.query("UPDATE federation_links SET state='paused' WHERE instance_id=$1", [peer]);
  assert.equal(await g.ensureShadowUser(peer, 'inactive', profile), null);
  await t.raw.query("UPDATE federation_links SET state='active' WHERE instance_id=$1", [peer]);
  assert.equal(await g.ensureShadowUser(peer, 'missing'), null);
  const made = await g.ensureShadowUser(peer, 'profile', profile);
  assert.equal(made?.homeUserId, 'profile'); assert.equal(made?.homeInstanceId, peer);
  assert.equal(made?.homeUsername, profile.username); assert.equal(made?.displayName, profile.displayName);
});
test('R187 кеш соседа создаёт теневого без профиля и имеет приоритет над переданным профилем', async () => {
  // Класс ошибки: fallback профиля не должен терять проверенное имя из каталога.
  await t.raw.query(`INSERT INTO federation_peer_users(instance_id,user_id,username,display_name,updated_at)
    VALUES ($1,'cached','dmtest_cached','Кеш',1),($1,'priority','dmtest_priority','Приоритет',1)`, [peer]);
  const g = await guest(); const made = await g.ensureShadowUser(peer, 'cached');
  assert.equal(made?.homeUsername, 'dmtest_cached'); assert.equal(made?.displayName, 'Кеш');
  assert.equal((await g.ensureShadowUser(peer, 'cached'))?.id, made?.id);
  const priority = await g.ensureShadowUser(peer, 'priority', profile);
  assert.equal(priority?.homeUsername, 'dmtest_priority'); assert.equal(priority?.displayName, 'Приоритет');
});
test('R187 одновременные создания теневого возвращают одну строку по паре дома и пользователя', async () => {
  // Класс ошибки гонки: разные события не должны заводить два локальных id одного человека.
  const g = await guest(); const rows = await Promise.all(Array.from({ length: 3 }, () => g.ensureShadowUser(peer, 'simultaneous', profile)));
  assert.equal(rows.every(r => !!r), true); assert.equal(new Set(rows.map(r => r!.id)).size, 1);
  assert.equal((await t.raw.query<{ n: number }>("SELECT count(*)::int AS n FROM users WHERE home_instance_id=$1 AND home_user_id='simultaneous'", [peer])).rows[0]?.n, 1);
});
test('R187 беседа с теневым использует глобальный отсортированный ключ, повтор и обратный порядок находят тот же id', async () => {
  // Класс ошибки идентичности: локальный id теневого не является именем человека между инстансами.
  const remote = await shadow(); const c = conv(); c.configureFederatedConv({ selfInstanceId: () => self, record: null });
  const made = await c.createDirect('local', remote.id); assert.equal(!!made, true);
  const saved = (await t.raw.query<{ direct_key: string }>('SELECT direct_key FROM conversations WHERE id=$1', [made!.row.id])).rows[0];
  assert.equal(saved?.direct_key, `${self}:local|${peer}:remote`);
  assert.equal(await c.createDirect(remote.id, 'local'), null);
  assert.equal((await c.findDirect('local', remote.id))?.id, made!.row.id);
  assert.equal((await c.findDirect(remote.id, 'local'))?.id, made!.row.id);
});
test('R187 журнал на соседа пишется через configureFederatedConv только для теневого участника, без hook не пишется', async () => {
  // Класс ошибки feature-gate: подготовка федерации не должна менять локальные беседы или выключенный журнал.
  const remote = await shadow(); const ch = changes(); const c = conv();
  await c.createDirect('local', 'other');
  assert.equal((await t.db.select().from(schema.fedConvChanges)).length, 0);
  c.configureFederatedConv({ selfInstanceId: () => self, record: ch.recordFedConvChanges });
  const local = await c.findDirect('local', 'other');
  await t.db.transaction(tx => c.journal(tx as unknown as Parameters<Conv['journal']>[0], [{ userId: 'local', conversationId: local!.id, kind: 'conv', messageId: null }]));
  assert.equal((await t.db.select().from(schema.fedConvChanges)).length, 0);
  const made = await c.createDirect('local', remote.id); assert.equal(!!made, true);
  const rows = await t.db.select().from(schema.fedConvChanges);
  assert.equal(rows.length, 1); assert.equal(rows[0].instanceId, peer); assert.equal(rows[0].conversationId, made!.row.id);
  c.configureFederatedConv(null);
  await t.db.transaction(tx => c.journal(tx as unknown as Parameters<Conv['journal']>[0], [{ userId: 'local', conversationId: made!.row.id, kind: 'conv', messageId: null }]));
  assert.equal((await t.db.select().from(schema.fedConvChanges)).length, 1);
});

async function recorded() {
  const remote = await shadow(); const ch = changes(); const c = conv();
  c.configureFederatedConv({ selfInstanceId: () => self, record: ch.recordFedConvChanges });
  const made = await c.createDirect('local', remote.id); assert.equal(!!made, true);
  return { remote, ch, c, id: made!.row.id };
}
async function removed(ch: Changes, id: string, user: string) {
  await t.raw.query('DELETE FROM conversation_members WHERE conversation_id=$1 AND user_id=$2', [id, user]);
  const page = await ch.changesForPeer(peer, 0, 30, self);
  assert.equal('items' in page && page.items.length, 0, 'удалённый участник скрывает беседу от соседа');
}
test('R187 страница отдаёт беседу участника, после удаления участника перестаёт отдавать сохранившийся журнал', async () => {
  // Класс ошибки утечки: старый указатель журнала не является правом соседа на нынешнюю беседу.
  const f = await recorded(); const page = await f.ch.changesForPeer(peer, 0, 30, self);
  assert.equal('items' in page && page.items.length, 1); await removed(f.ch, f.id, f.remote.id);
});
test('R187 удаление EXISTS обнаруживается выдачей беседы после настоящего удаления участника', async () => {
  // Whole-module original-first; отсутствие участника моделируется SQL, не поддельной страницей.
  const f = await recorded(); await removed(f.ch, f.id, f.remote.id);
  const broken = changes(t.db, [
    'sql`EXISTS (SELECT 1 FROM conversation_members cm JOIN users u ON u.id = cm.user_id\n                    WHERE cm.conversation_id = ${fedConvChanges.conversationId} AND u.home_instance_id = ${instanceId})`', 'sql`true`',
  ]);
  await assert.rejects(removed(broken, f.id, f.remote.id), e => e instanceof assert.AssertionError && e.message.includes('удалённый участник скрывает'));
});
test('R187 уборка старого журнала поднимает min_seq, ниже границы reset, на границе остаётся новая запись', async () => {
  // Класс ошибки курсора: удалённый префикс нельзя выдавать как полный непрерывный журнал.
  const f = await recorded();
  await t.raw.query('UPDATE fed_conv_changes SET at=now()-interval \'31 days\' WHERE instance_id=$1', [peer]);
  await t.db.transaction(tx => f.ch.recordFedConvChanges(tx as unknown as Parameters<Changes['recordFedConvChanges']>[0], [{ conversationId: f.id, kind: shared.FED_CONV_CHANGE.conv, entityId: null }]));
  const clean = moduleOf<typeof import('../src/convJournal.js')>('convJournal', { 'drizzle-orm': orm, './convRules.js': rules, './db/index.js': { db: t.db } });
  assert.equal(await clean.pruneFedConvChanges(), 1);
  const sync = (await t.db.select().from(schema.fedConvSync))[0]; assert.equal(Number(sync.minSeq), 1); assert.equal(Number(sync.seq), 2);
  assert.equal('reset' in await f.ch.changesForPeer(peer, 0, 30, self), true);
  const page = await f.ch.changesForPeer(peer, 1, 30, self); assert.equal('items' in page && page.items.length, 1);
  assert.equal(await clean.pruneFedConvChanges(), 0);
});
test('R187 настоящая правка увеличивает edit_version, повтор того же текста не меняет версию, время и журнал', async () => {
  // Класс ошибки идемпотентности: пустая правка не должна побеждать настоящую правку на соседнем инстансе.
  const f = await recorded(); await t.raw.query("INSERT INTO conversation_messages(id,conversation_id,author_id,sort_key,content) VALUES ('edit',$1,'local',1,'До')", [f.id]);
  const access = await f.c.loadAccess(f.id, 'local'); assert.equal(!!access, true);
  const changed = await f.c.editMessage('local', access!, 'edit', 'После'); assert.equal(changed.kind, 'ok');
  const first = (await t.db.select().from(schema.conversationMessages))[0]; assert.equal(first.editVersion, 1);
  const count = (await t.db.select().from(schema.fedConvChanges)).length;
  const repeated = await f.c.editMessage('local', access!, 'edit', 'После'); assert.equal(repeated.kind, 'ok');
  if (repeated.kind === 'ok') assert.equal(repeated.delivery, null);
  const second = (await t.db.select().from(schema.conversationMessages))[0];
  assert.equal(second.editVersion, 1); assert.equal(second.editedAt?.getTime(), first.editedAt?.getTime());
  assert.equal((await t.db.select().from(schema.fedConvChanges)).length, count);
});

const timeout = Symbol('ограничение ожидания');
async function bounded<T>(work: Promise<T>, ms = 5000): Promise<T | typeof timeout> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try { return await Promise.race([work, new Promise<typeof timeout>(resolve => { timer = setTimeout(() => resolve(timeout), ms); })]); }
  finally { if (timer) clearTimeout(timer); }
}
async function directHttp(mutation?: readonly [string, string]) {
  // Отдельная БД для потенциально зависшего мутанта. Прерывается JS-ожидание глобального запроса,
  // затем настоящая транзакция делает ROLLBACK и освобождает очередь PGlite перед close.
  const isolated = await createTestDb(); let inTransaction = false;
  const cancels: Array<() => void> = [], queued: Promise<unknown>[] = [];
  const database = new Proxy(isolated.db, { get(target, key) {
    if (key === 'transaction') return async (callback: (tx: unknown) => Promise<unknown>, opts: unknown) =>
      target.transaction(async tx => { inTransaction = true; try { return await callback(tx); } finally { inTransaction = false; } }, opts as never);
    if (key === 'select') return (...args: unknown[]) => {
      const select = (target.select as (...a: unknown[]) => any).apply(target, args);
      return new Proxy(select, { get(builder, prop) {
        if (prop !== 'from') { const v = Reflect.get(builder, prop); return typeof v === 'function' ? v.bind(builder) : v; }
        return (table: unknown) => {
          const from = builder.from(table);
          if (!inTransaction) return from;
          return new Proxy(from, { get(query, member) {
            if (member !== 'where') { const v = Reflect.get(query, member); return typeof v === 'function' ? v.bind(query) : v; }
            return (condition: unknown) => {
              const actual = Promise.resolve(query.where(condition)); queued.push(actual);
              const abort = new Promise<never>((_resolve, reject) => cancels.push(() => reject(new Error('cleanup ожидания глобальной БД'))));
              return Promise.race([actual, abort]);
            };
          } });
        };
      } });
    };
    const value = Reflect.get(target, key); return typeof value === 'function' ? value.bind(target) : value;
  } });
  const app = Fastify(); let pending: Promise<unknown> | undefined;
  try {
    await isolated.raw.exec("INSERT INTO users(id,username,display_name,password_hash,verified,approved_at) VALUES ('local','dmtest_local','Локальный','hash',true,now()),('other','dmtest_other','Другой','hash',true,now())");
    const c = conv(database, mutation);
    const route = moduleOf<typeof import('../src/routes/conv.js')>('routes/conv', {
      '@gusvoice/shared': shared, 'drizzle-orm': orm, zod: await import('zod'), '../db/index.js': { db: database }, '../db/schema.js': schema,
      '../auth.js': { requireAuth: async (req: any) => { req.user = { sub: 'local' }; }, isSuperAdmin: () => false },
      '../guestGuard.js': { requireLocalUser: async () => {} }, '../authGuard.js': { rateHit: async () => 0 },
      '../conversations.js': { ...c, deliver: async () => {} }, '../convRules.js': rules,
      '../dmRules.js': await import('../src/dmRules.js'), '../db/peerQueries.js': { shareServer: async () => true },
      '../instanceSetup.js': { dmPolicy: async () => 'anyone' }, '../userSearchRules.js': await import('../src/userSearchRules.js'),
      '../superAdminRules.js': { asUserId: (id: string) => id },
    });
    await app.register(route.convRoutes); await app.ready();
    const request = app.inject({ method: 'POST', url: '/conv/direct', payload: { userId: 'other' } });
    pending = request;
    const result = await bounded(request);
    assert.equal(result === timeout, false, 'POST на одном соединении завершается за 5 секунд');
    if (result !== timeout) { assert.equal(result.statusCode, 201, result.body); assert.equal(typeof result.json().id, 'string'); }
  } finally {
    for (const cancel of cancels) cancel();
    if (pending) assert.notEqual(await bounded(pending.catch(() => undefined)), timeout, 'cleanup освобождает транзакцию');
    assert.notEqual(await bounded(Promise.allSettled(queued)), timeout, 'cleanup дожидается очереди реальных запросов');
    await app.close(); await isolated.close();
    // createTestDb меняет соединение приложения; остальные VM используют собственное t.db.
    const { setDbForTests } = await import('../src/db/index.js'); setDbForTests(t.db as unknown as Parameters<typeof setDbForTests>[0]);
  }
}
test('R187 POST открытия местной беседы завершается на единственном соединении PGlite', async () => {
  // Класс ошибки deadlock: даже местный directKeyOf теперь читает пользователей и обязан использовать tx.
  await directHttp();
});
test('R187 глобальный db вместо tx у directKeyOf обнаруживается ограниченным ожиданием POST без зависания cleanup', async () => {
  // Whole-module original-first; откат после целевого timeout освобождает настоящее единственное соединение.
  await directHttp();
  await assert.rejects(directHttp(['directKey: await directKeyOf(tx, me, otherId)', 'directKey: await directKeyOf(db, me, otherId)']),
    e => e instanceof assert.AssertionError && e.message.includes('POST на одном соединении завершается'));
});

test('R187 федеративная ручка изменений выключена флагом, без подписи запрещена, неверный since отвергается, подпись соседа принимается', async () => {
  // Класс ошибки границы: выключенная подготовка не должна публиковать маршрут или принимать неподписанного соседа.
  const f = await recorded(); const keys = generateKeyPairSync('ed25519');
  const privateKeyDer = keys.privateKey.export({ format: 'der', type: 'pkcs8' });
  const publicKeyDer = keys.publicKey.export({ format: 'der', type: 'spki' });
  for (const enabled of [false, true]) {
    const app = Fastify();
    const route = moduleOf<typeof import('../src/routes/federation.js')>('routes/federation', {
      '@gusvoice/shared': shared, 'drizzle-orm': orm, '../db/index.js': { db: t.db }, '../db/schema.js': schema,
      '../env.js': { env: { federation: { dmEnabled: enabled } } },
      '../federation/instance.js': { federation: { identity: () => ({ instanceId: self }) } },
      './fedAdmission.js': await import('../src/routes/fedAdmission.js'),
      '../federation/guardsRuntime.js': { fedRateBlock: async () => 0 },
      '../federation/convChanges.js': f.ch,
      '../federation/peerAuth.js': { authenticateLinkedPeer: async (req: any) => {
        const verified = signatures.verifyRequest({ method: req.method, targetUri: 'https://local.invalid/api' + req.url,
          body: '', headers: req.headers, findKey: id => id === 'test-key' ? publicKeyDer : null, nowS: Math.floor(Date.now() / 1000) });
        if (!verified.ok) return { ok: false, status: 401, error: 'unknown' };
        const [link] = await t.db.select().from(schema.federationLinks).where(orm.eq(schema.federationLinks.instanceId, peer));
        assert.equal(link.state, 'active', 'подписанный сосед действительно связан');
        return { ok: true, link };
      } },
    });
    try {
      await app.register(route.federationRoutes); await app.ready();
      const url = `/fed/v1/conv/changes?instance_id=${peer}&since=0`;
      const unsigned = await app.inject({ method: 'GET', url }); assert.equal(unsigned.statusCode, enabled ? 401 : 404);
      if (!enabled) continue;
      for (const since of ['bad', '0']) {
        const path = `/fed/v1/conv/changes?instance_id=${peer}&since=${since}`;
        const headers = signatures.signRequest({ method: 'GET', targetUri: 'https://local.invalid/api' + path,
          body: '', keyid: 'test-key', privateKeyDer, nowS: Math.floor(Date.now() / 1000) });
        const res = await app.inject({ method: 'GET', url: path, headers });
        assert.equal(res.statusCode, since === 'bad' ? 400 : 200, res.body);
        if (since === '0') assert.equal(res.json().items.length, 1);
      }
    } finally { await app.close(); }
  }
});
