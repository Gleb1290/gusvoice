import assert from 'node:assert/strict';
import { createDecipheriv, createECDH, createHmac, randomBytes } from 'node:crypto';
import Fastify from 'fastify';
import { after, before, beforeEach, test } from 'node:test';
import { Permission } from '@gusvoice/shared';
import { createTestDb, truncateAll, type TestDb } from './harness.js';
import { setDmWriteBarrierForTests } from '../src/dmWriteBarrier.js';

// Управляемые тестовые значения задаются до первого импорта env/push: никаких локальных .env тест не читает.
process.env.NTFY_BASE_URL = 'https://ntfy.example.test';
process.env.NTFY_TOKEN = 'integration-push-token';

let t: TestDb;
let app: ReturnType<typeof Fastify>;
let tokenFor: (id: string) => string;
let resetBlockCache: () => void;
let blockedBy: (id: string) => Promise<Set<string>>;
let sendPushToUsers: typeof import('../src/push.js').sendPushToUsers;
let redisPub: typeof import('../src/realtime.js').redisPub;
const published: { channel: string; message: string }[] = [];
const posted: { url: string; init: RequestInit }[] = [];

const authHeader = (id: string) => ({ authorization: `Bearer ${tokenFor(id)}` });

before(async () => {
  t = await createTestDb();
  // Старые тестовые INSERT не выдают ключ сами: одна монотонная последовательность только для фикстур.
  await t.raw.exec(`CREATE SEQUENCE test_message_sort_key;
    ALTER SEQUENCE test_message_sort_key OWNED BY conversation_messages.sort_key;
    ALTER TABLE conversation_messages ALTER COLUMN sort_key SET DEFAULT nextval('test_message_sort_key')`);
  const auth = await import('../src/auth.js');
  const { authRoutes } = await import('../src/routes/auth.js');
  const { blockRoutes } = await import('../src/routes/blocks.js');
  const { convRoutes } = await import('../src/routes/conv.js');
  const { dmRoutes } = await import('../src/routes/dm.js');
  const { messageRoutes } = await import('../src/routes/messages.js');
  const { pushRoutes } = await import('../src/routes/push.js');
  const { unreadRoutes } = await import('../src/routes/unread.js');
  ({ resetBlockCacheForTests: resetBlockCache, blockedBy } = await import('../src/blocks.js'));
  ({ sendPushToUsers } = await import('../src/push.js'));
  ({ redisPub } = await import('../src/realtime.js'));
  redisPub.publish = (async (channel: string, message: string) => {
    published.push({ channel, message });
    return 1;
  }) as typeof redisPub.publish;
  redisPub.incr = (async () => 1) as typeof redisPub.incr;
  redisPub.expire = (async () => 1) as typeof redisPub.expire;
  redisPub.ttl = (async () => 300) as typeof redisPub.ttl;
  tokenFor = (id) => auth.signToken({ sub: id, username: id, gen: 0 });

  app = Fastify();
  await app.register(authRoutes);
  await app.register(blockRoutes);
  await app.register(dmRoutes);
  await app.register(convRoutes);
  await app.register(messageRoutes);
  await app.register(pushRoutes);
  await app.register(unreadRoutes);
  await app.ready();
});

beforeEach(async () => {
  setDmWriteBarrierForTests({});
  await truncateAll(t.raw);
  resetBlockCache();
  published.length = 0;
  posted.length = 0;
  Object.defineProperty(globalThis, 'fetch', {
    configurable: true,
    value: async (url: string, init: RequestInit) => {
      posted.push({ url, init });
      return new Response(null, { status: 200 });
    },
  });
  await t.raw.exec(`
    INSERT INTO users (id, username, display_name, password_hash) VALUES
      ('a', 'alpha', 'Alpha', 'hash'),
      ('b', 'bravo', 'Bravo', 'hash'),
      ('c', 'charlie', 'Charlie', 'hash');
    INSERT INTO servers (id, name, owner_id) VALUES ('s', 'Server', 'a');
    INSERT INTO server_members (server_id, user_id) VALUES ('s', 'a'), ('s', 'b'), ('s', 'c');
    INSERT INTO roles (id, server_id, name, permissions, is_everyone)
      VALUES ('everyone', 's', 'everyone', '${Permission.VIEW_CHANNEL | Permission.SEND_MESSAGES}', true);
    INSERT INTO channels (id, server_id, name, type) VALUES
      ('ch', 's', 'chat', 'text'), ('foreign-ch', 's', 'other', 'text');
    INSERT INTO conversations (id, kind, direct_key, created_by, last_message_at) VALUES
      ('dm', 'direct', 'a:b', 'a', '2026-09-20T10:00:00Z'),
      ('foreign-dm', 'direct', 'a:c', 'a', '2026-09-20T10:00:00Z');
    INSERT INTO conversation_members (conversation_id, user_id) VALUES
      ('dm', 'a'), ('dm', 'b'), ('foreign-dm', 'a'), ('foreign-dm', 'c');
  `);
  // PGlite — одно соединение: история читает block-кеш внутри snapshot-транзакции.
  // Запрос к базе при промахе кеша там заблокировал бы сам себя.
  for (const id of ['a', 'b', 'c']) await blockedBy(id);
});

after(async () => {
  setDmWriteBarrierForTests({});
  await app.close();
  redisPub.disconnect();
  await t.close();
});

function pushKeys() {
  const receiver = createECDH('prime256v1');
  receiver.generateKeys();
  const auth = randomBytes(16);
  return {
    receiver,
    auth,
    public: { p256dh: receiver.getPublicKey().toString('base64url'), auth: auth.toString('base64url') },
  };
}

function hmac(key: Buffer, data: Buffer): Buffer {
  return createHmac('sha256', key).update(data).digest();
}

function decryptPush(body: Buffer, receiver: ReturnType<typeof createECDH>, auth: Buffer): Buffer {
  const salt = body.subarray(0, 16);
  const keyLength = body[20]!;
  const sender = body.subarray(21, 21 + keyLength);
  const shared = receiver.computeSecret(sender);
  const prkKey = hmac(auth, shared);
  const info = Buffer.concat([Buffer.from('WebPush: info\0', 'latin1'), receiver.getPublicKey(), sender]);
  const ikm = hmac(prkKey, Buffer.concat([info, Buffer.from([1])]));
  const prk = hmac(salt, ikm);
  const cek = hmac(prk, Buffer.from('Content-Encoding: aes128gcm\0\x01', 'latin1')).subarray(0, 16);
  const nonce = hmac(prk, Buffer.from('Content-Encoding: nonce\0\x01', 'latin1')).subarray(0, 12);
  const sealed = body.subarray(21 + keyLength);
  const decipher = createDecipheriv('aes-128-gcm', cek, nonce);
  decipher.setAuthTag(sealed.subarray(-16));
  const clear = Buffer.concat([decipher.update(sealed.subarray(0, -16)), decipher.final()]);
  assert.equal(clear.at(-1), 2);
  return clear.subarray(0, -1);
}

test('регистрация пуша сохраняет ключи, отвергает кривые и стирает ключи при откате клиента', async () => {
  // Ловит как нешифрованный пуш новому APK, так и шифр, который откатившаяся версия уже не прочтёт.
  const keys = pushKeys().public;
  const valid = await app.inject({
    method: 'POST', url: '/push/register', headers: authHeader('a'),
    payload: { endpoint: 'https://ntfy.example.test/a', deviceId: 'phone', platform: 'android', keys },
  });
  assert.equal(valid.statusCode, 204);
  let rows = await t.raw.query<{ p256dh: string | null; auth: string | null }>(
    `SELECT p256dh, auth FROM push_devices WHERE user_id = 'a' AND device_id = 'phone'`,
  );
  assert.deepEqual(rows.rows, [{ p256dh: keys.p256dh, auth: keys.auth }]);

  const invalid = await app.inject({
    method: 'POST', url: '/push/register', headers: authHeader('a'),
    payload: { endpoint: 'https://ntfy.example.test/a', deviceId: 'bad', keys: { ...keys, auth: 'AA' } },
  });
  assert.equal(invalid.statusCode, 400);
  assert.deepEqual(invalid.json(), { error: 'invalid push keys' });

  const rollback = await app.inject({
    method: 'POST', url: '/push/register', headers: authHeader('a'),
    payload: { endpoint: 'https://ntfy.example.test/a', deviceId: 'phone', platform: 'android' },
  });
  assert.equal(rollback.statusCode, 204);
  rows = await t.raw.query(`SELECT p256dh, auth FROM push_devices WHERE user_id = 'a' AND device_id = 'phone'`);
  assert.deepEqual(rows.rows, [{ p256dh: null, auth: null }]);
});

test('регистрация не принимает точку P-256 верной формы, но вне кривой', async () => {
  // Ловит сохранение ключа, который падает только во время фоновой доставки пуша.
  const keys = pushKeys().public;
  const invalidPoint = Buffer.concat([Buffer.from([4]), Buffer.alloc(64)]).toString('base64url');
  const response = await app.inject({
    method: 'POST', url: '/push/register', headers: authHeader('a'),
    payload: { endpoint: 'https://ntfy.example.test/a', deviceId: 'off-curve', keys: { ...keys, p256dh: invalidPoint } },
  });
  assert.equal(response.statusCode, 400);
  const rows = await t.raw.query(`SELECT id FROM push_devices WHERE device_id = 'off-curve'`);
  assert.equal(rows.rows.length, 0);
});

test('повреждённый сохранённый ключ отправляет только обезличенный запасной пуш', async () => {
  // Ловит утечку текста ЛС в ntfy, если шифрование падает уже после регистрации устройства.
  const keys = pushKeys().public;
  const invalidPoint = Buffer.concat([Buffer.from([4]), Buffer.alloc(64)]).toString('base64url');
  await t.raw.query(
    `INSERT INTO push_devices (id, user_id, device_id, endpoint, platform, p256dh, auth)
     VALUES ('corrupt', 'a', 'phone', 'https://ntfy.example.test/corrupt', 'android', $1, $2)`,
    [invalidPoint, keys.auth],
  );
  await sendPushToUsers(['a'], { type: 'dm', title: 'Bravo', body: 'секрет', dmId: 'dm' });
  assert.equal(posted.length, 1);
  const wire = posted[0]!.init;
  assert.equal((wire.headers as Record<string, string>)['Content-Encoding'], undefined);
  assert.equal(String(wire.body).includes('секрет'), false);
  assert.equal(JSON.parse(String(wire.body)).dmId, 'dm');
});

test('рассылка шифрует устройство с ключами и сохраняет прежний JSON без ключей', async () => {
  // Ловит открытый текст на новом устройстве, забытый X-UnifiedPush и преждевременную редактировку legacy-пуша.
  const encrypted = pushKeys();
  await t.raw.exec(`
    INSERT INTO push_devices (id, user_id, device_id, endpoint, platform, p256dh, auth) VALUES
      ('p1', 'a', 'encrypted', 'https://ntfy.example.test/encrypted', 'android',
       '${encrypted.public.p256dh}', '${encrypted.public.auth}'),
      ('p2', 'a', 'legacy', 'https://ntfy.example.test/legacy', 'android', null, null)
  `);
  const payload = { type: 'dm' as const, title: 'Bravo', body: 'секрет', dmId: 'dm' };
  await sendPushToUsers(['a'], payload);
  assert.equal(posted.length, 2);
  const secure = posted.find((p) => p.url.endsWith('/encrypted'))!;
  const legacy = posted.find((p) => p.url.endsWith('/legacy'))!;
  const secureHeaders = secure.init.headers as Record<string, string>;
  assert.equal(secureHeaders['Content-Encoding'], 'aes128gcm');
  assert.equal(secureHeaders['X-UnifiedPush'], '1');
  assert.deepEqual(JSON.parse(decryptPush(Buffer.from(secure.init.body as Buffer), encrypted.receiver, encrypted.auth).toString()), payload);
  assert.deepEqual(JSON.parse(String(legacy.init.body)), payload);
});

test('чёрный список валидирует цель, не дублируется, отдаёт профиль и сразу сбрасывает кеш', async () => {
  // Ловит самоблокировку, висячий id и устаревший кеш после POST/DELETE.
  const self = await app.inject({ method: 'POST', url: '/blocks', headers: authHeader('a'), payload: { userId: 'a' } });
  assert.equal(self.statusCode, 400);
  const missing = await app.inject({ method: 'POST', url: '/blocks', headers: authHeader('a'), payload: { userId: 'missing' } });
  assert.equal(missing.statusCode, 404);
  for (let i = 0; i < 2; i++) {
    const response = await app.inject({ method: 'POST', url: '/blocks', headers: authHeader('a'), payload: { userId: 'b' } });
    assert.equal(response.statusCode, 204);
  }
  const count = await t.raw.query<{ n: number }>(`SELECT COUNT(*)::int AS n FROM user_blocks`);
  assert.equal(count.rows[0]?.n, 1);
  const list = await app.inject({ method: 'GET', url: '/blocks', headers: authHeader('a') });
  assert.deepEqual(list.json(), [{ id: 'b', username: 'bravo', displayName: 'Bravo', avatarUrl: null }]);
  const removed = await app.inject({ method: 'DELETE', url: '/blocks/b', headers: authHeader('a') });
  assert.equal(removed.statusCode, 204);
  const empty = await app.inject({ method: 'GET', url: '/blocks', headers: authHeader('a') });
  assert.deepEqual(empty.json(), []);
});

test('заблокированный пишет как обычно, но сообщение навсегда скрыто от блокировщика', async () => {
  // Ловит выдачу факта блокировки, подъём беседы, unread/push и проявление старого сообщения после разблокировки.
  await app.inject({ method: 'POST', url: '/blocks', headers: authHeader('a'), payload: { userId: 'b' } });
  const sent = await app.inject({
    method: 'POST', url: '/dm/dm/messages', headers: authHeader('b'), payload: { content: 'не увидишь' },
  });
  assert.equal(sent.statusCode, 201);
  const hiddenId = sent.json().id as string;
  const row = await t.raw.query<{ withheld: boolean }>(`SELECT withheld FROM conversation_messages WHERE id = '${hiddenId}'`);
  assert.equal(row.rows[0]?.withheld, true);
  const channel = await t.raw.query<{ last_message_at: Date }>(`SELECT last_message_at FROM conversations WHERE id = 'dm'`);
  assert.equal(channel.rows[0]?.last_message_at.toISOString(), '2026-09-20T10:00:00.000Z');
  assert.equal(published.some((p) => p.channel === 'gw:user:a'), false);
  assert.equal(posted.length, 0);
  const aList = await app.inject({ method: 'GET', url: '/dm', headers: authHeader('a') });
  assert.equal(aList.json()[0].unread, 0);
  const unread = await app.inject({ method: 'GET', url: '/unread', headers: authHeader('a') });
  assert.equal(unread.json().dms, 0);
  const seenA = await app.inject({ method: 'GET', url: '/dm/dm/messages', headers: authHeader('a') });
  const seenB = await app.inject({ method: 'GET', url: '/dm/dm/messages', headers: authHeader('b') });
  assert.deepEqual(seenA.json(), []);
  assert.deepEqual(seenB.json().map((m: { id: string }) => m.id), [hiddenId]);

  await app.inject({ method: 'DELETE', url: '/blocks/b', headers: authHeader('a') });
  const visible = await app.inject({
    method: 'POST', url: '/dm/dm/messages', headers: authHeader('b'), payload: { content: 'увидишь' },
  });
  assert.equal(visible.statusCode, 201);
  const after = await app.inject({ method: 'GET', url: '/dm/dm/messages', headers: authHeader('a') });
  assert.deepEqual(after.json().map((m: { id: string }) => m.id), [visible.json().id]);
});

test('DM-курсор по id не теряет соседа в той же миллисекунде и игнорирует чужой id', async () => {
  // Ловит потерю 51-го сообщения на микросекундной границе и использование курсора чужой беседы.
  await t.raw.exec(`
    INSERT INTO conversation_messages (id, conversation_id, author_id, content, created_at)
    SELECT 'd' || lpad(i::text, 2, '0'), 'dm', 'b', i::text,
      CASE WHEN i = 1 THEN '2026-09-20 12:00:00.0001+00'::timestamptz
           WHEN i = 2 THEN '2026-09-20 12:00:00.0009+00'::timestamptz
           ELSE '2026-09-20 12:00:00+00'::timestamptz + i * interval '1 millisecond' END
    FROM generate_series(1, 51) AS i;
    INSERT INTO conversation_messages (id, conversation_id, author_id, content, created_at)
      VALUES ('foreign-cursor', 'foreign-dm', 'c', 'x', '2026-09-20T12:00:00.030Z')
  `);
  const latest = await app.inject({ method: 'GET', url: '/dm/dm/messages', headers: authHeader('a') });
  assert.equal(latest.json().length, 50);
  const oldest = latest.json()[0] as { id: string; createdAt: string };
  const older = await app.inject({
    method: 'GET', url: `/dm/dm/messages?before=${encodeURIComponent(oldest.createdAt)}&beforeId=${oldest.id}`,
    headers: authHeader('a'),
  });
  assert.deepEqual(older.json().map((m: { id: string }) => m.id), ['d01']);
  const fallback = await app.inject({
    method: 'GET', url: `/dm/dm/messages?before=${encodeURIComponent('2026-09-20T12:00:00.020Z')}&beforeId=foreign-cursor`,
    headers: authHeader('a'),
  });
  assert.ok(fallback.json().length > 0);
  assert.equal(fallback.json().every((m: { createdAt: string }) => m.createdAt < '2026-09-20T12:00:00.020Z'), true);
});

test('канальный курсор по id не теряет соседа и чужой id падает на before', async () => {
  // Ловит зеркальное расхождение пагинации каналов и ЛС после починки только одного маршрута.
  await t.raw.exec(`
    INSERT INTO messages (id, channel_id, author_id, content, created_at)
    SELECT 'c' || lpad(i::text, 2, '0'), 'ch', 'b', i::text,
      CASE WHEN i = 1 THEN '2026-09-20 12:00:00.0001+00'::timestamptz
           WHEN i = 2 THEN '2026-09-20 12:00:00.0009+00'::timestamptz
           ELSE '2026-09-20 12:00:00+00'::timestamptz + i * interval '1 millisecond' END
    FROM generate_series(1, 51) AS i;
    INSERT INTO messages (id, channel_id, author_id, content, created_at)
      VALUES ('foreign-channel-cursor', 'foreign-ch', 'c', 'x', '2026-09-20T12:00:00.030Z')
  `);
  const latest = await app.inject({ method: 'GET', url: '/channels/ch/messages', headers: authHeader('a') });
  const oldest = latest.json()[0] as { id: string; createdAt: string };
  const older = await app.inject({
    method: 'GET', url: `/channels/ch/messages?before=${encodeURIComponent(oldest.createdAt)}&beforeId=${oldest.id}`,
    headers: authHeader('a'),
  });
  assert.deepEqual(older.json().map((m: { id: string }) => m.id), ['c01']);
  const fallback = await app.inject({
    method: 'GET', url: `/channels/ch/messages?before=${encodeURIComponent('2026-09-20T12:00:00.020Z')}&beforeId=foreign-channel-cursor`,
    headers: authHeader('a'),
  });
  assert.ok(fallback.json().length > 0);
  assert.equal(fallback.json().every((m: { createdAt: string }) => m.createdAt < '2026-09-20T12:00:00.020Z'), true);
});

test('отметка ЛС идёт до показанного сообщения, не откатывается и публикует сохранённое время', async () => {
  // Ловит поглощение невидимого хвоста, откат со второго устройства и событие с несохранённым временем.
  await t.raw.exec(`
    INSERT INTO conversation_messages (id, conversation_id, author_id, content, created_at) VALUES
      ('r1', 'dm', 'b', 'one', '2026-09-20T10:00:00Z'),
      ('r2', 'dm', 'b', 'two', '2026-09-20T11:00:00Z'),
      ('r3', 'dm', 'b', 'three', '2026-09-20T12:00:00Z')
  `);
  const mark = await app.inject({ method: 'POST', url: '/dm/dm/read', headers: authHeader('a'), payload: { upTo: 'r2' } });
  assert.equal(mark.statusCode, 200);
  await new Promise<void>((resolve) => setImmediate(resolve));
  let saved = await t.raw.query<{ last_read_key: number }>(`SELECT last_read_key FROM conversation_members WHERE conversation_id = 'dm' AND user_id = 'a'`);
  assert.equal(Number(saved.rows[0]?.last_read_key), 2);
  const event = published.map((p) => JSON.parse(p.message).m).find((m) => m.t === 'read.dm');
  assert.equal(event.at, '2026-09-20T11:00:00.000Z');
  const list = await app.inject({ method: 'GET', url: '/dm', headers: authHeader('a') });
  assert.equal(list.json()[0].unread, 1);
  await app.inject({ method: 'POST', url: '/dm/dm/read', headers: authHeader('a'), payload: { upTo: 'r1' } });
  saved = await t.raw.query(`SELECT last_read_key FROM conversation_members WHERE conversation_id = 'dm' AND user_id = 'a'`);
  assert.equal(Number(saved.rows[0]?.last_read_key), 2);
});

test('чужой upTo и отсутствие тела читают до хвоста беседы, а будущее время не откатывается', async () => {
  // Ловит доверие id другой беседы и возврат к отметке по часам вместо ключа видимого хвоста.
  await t.raw.exec(`
    INSERT INTO conversation_messages (id, conversation_id, author_id, content, created_at)
      VALUES ('foreign-read', 'foreign-dm', 'c', 'x', '2020-01-01T00:00:00Z');
    INSERT INTO conversation_messages (id, conversation_id, author_id, content, created_at)
      VALUES ('local-read', 'dm', 'b', 'local', '2026-09-20T12:00:00Z');
    UPDATE conversations SET last_sort_key = (SELECT sort_key FROM conversation_messages WHERE id = 'local-read') WHERE id = 'dm';
    UPDATE conversations SET last_message_at = '2099-01-01T00:00:00Z' WHERE id = 'dm'
  `);
  await app.inject({ method: 'POST', url: '/dm/dm/read', headers: authHeader('a'), payload: { upTo: 'foreign-read' } });
  let saved = await t.raw.query<{ last_read_key: number }>(`SELECT last_read_key FROM conversation_members WHERE conversation_id = 'dm' AND user_id = 'a'`);
  assert.equal(Number(saved.rows[0]?.last_read_key), 2);
  await t.raw.exec(`UPDATE conversation_members SET last_read_key = 0 WHERE conversation_id = 'dm' AND user_id = 'a'`);
  await app.inject({ method: 'POST', url: '/dm/dm/read', headers: authHeader('a') });
  saved = await t.raw.query(`SELECT last_read_key FROM conversation_members WHERE conversation_id = 'dm' AND user_id = 'a'`);
  assert.equal(Number(saved.rows[0]?.last_read_key), 2);
  await app.inject({ method: 'POST', url: '/dm/dm/messages', headers: authHeader('b'), payload: { content: 'new' } });
  const dm = await t.raw.query<{ last_message_at: Date }>(`SELECT last_message_at FROM conversations WHERE id = 'dm'`);
  assert.equal(dm.rows[0]?.last_message_at.toISOString(), '2099-01-01T00:00:00.000Z');
});

test('повтор add/remove реакции не создаёт строк и событий ни в ЛС, ни в канале', async () => {
  // Ловит удвоение счётчика на клиенте после повтора уже идемпотентного запроса.
  await t.raw.exec(`
    INSERT INTO conversation_messages (id, conversation_id, author_id, content) VALUES ('react-dm', 'dm', 'b', 'x');
    INSERT INTO messages (id, channel_id, author_id, content) VALUES ('react-ch', 'ch', 'b', 'x')
  `);
  for (const [url, eventName, channels] of [
    ['/dm/dm/messages/react-dm/reactions', 'dm.reaction', ['gw:user:a', 'gw:user:b']],
    ['/channels/ch/messages/react-ch/reactions', 'message.reaction', ['gw:server:s']],
  ] as const) {
    published.length = 0;
    for (const op of ['add', 'add', 'remove', 'remove'] as const) {
      const response = await app.inject({ method: 'POST', url, headers: authHeader('a'), payload: { emoji: '👍', op } });
      assert.equal(response.statusCode, 204);
    }
    for (const channel of channels) {
      const events = published.filter((p) => p.channel === channel)
        .map((p) => JSON.parse(p.message).m).filter((m) => m.t === eventName);
      assert.deepEqual(events.map((e) => e.op), ['add', 'remove']);
    }
  }
  const dmRows = await t.raw.query(`SELECT * FROM conversation_message_reactions`);
  const channelRows = await t.raw.query(`SELECT * FROM message_reactions`);
  assert.equal(dmRows.rows.length, 0);
  assert.equal(channelRows.rows.length, 0);
});

test('реакция заблокированного хранится для него, но скрыта из истории блокировщика', async () => {
  // Ловит обход чёрного списка через эмодзи под старым сообщением после самой блокировки.
  await t.raw.exec(`INSERT INTO conversation_messages (id, conversation_id, author_id, content) VALUES ('blocked-react', 'dm', 'a', 'x')`);
  await app.inject({ method: 'POST', url: '/blocks', headers: authHeader('a'), payload: { userId: 'b' } });
  const reaction = await app.inject({
    method: 'POST', url: '/dm/dm/messages/blocked-react/reactions', headers: authHeader('b'),
    payload: { emoji: '🔥', op: 'add' },
  });
  assert.equal(reaction.statusCode, 204);
  assert.equal(published.some((p) => p.channel === 'gw:user:a' && JSON.parse(p.message).m.t === 'dm.reaction'), false);
  const forA = await app.inject({ method: 'GET', url: '/dm/dm/messages', headers: authHeader('a') });
  const forB = await app.inject({ method: 'GET', url: '/dm/dm/messages', headers: authHeader('b') });
  assert.deepEqual(forA.json()[0].reactions, []);
  assert.deepEqual(forB.json()[0].reactions, [{ emoji: '🔥', count: 1, me: true }]);
});

test('без блокировки правка, реакция и удаление доходят до второго участника', async () => {
  // Ловит двойное отрицание у reachesPeer: база менялась, а живой собеседник не узнавал об этом.
  await t.raw.exec(`INSERT INTO conversation_messages (id, conversation_id, author_id, content) VALUES ('relay', 'dm', 'b', 'old')`);
  const cases = [
    { method: 'PATCH' as const, url: '/dm/dm/messages/relay', payload: { content: 'new' }, event: 'dm.update' },
    { method: 'POST' as const, url: '/dm/dm/messages/relay/reactions', payload: { emoji: '👍', op: 'add' }, event: 'dm.reaction' },
    { method: 'DELETE' as const, url: '/dm/dm/messages/relay', payload: undefined, event: 'dm.delete' },
  ];
  for (const c of cases) {
    published.length = 0;
    const response = await app.inject({ method: c.method, url: c.url, headers: authHeader('b'), ...(c.payload ? { payload: c.payload } : {}) });
    assert.ok(response.statusCode < 300, `${c.event}: ${response.statusCode}`);
    assert.equal(published.filter((p) => p.channel === 'gw:user:a' && JSON.parse(p.message).m.t === c.event).length, 1, c.event);
  }
});

test('удаление по умолчанию оставляет надгробие у обоих, но чужое запрещает', async () => {
  // Ловит потерю следа удаления для догонки и право стереть чужую строку у всех.
  await t.raw.exec(`INSERT INTO conversation_messages (id, conversation_id, author_id, content) VALUES ('own-b', 'dm', 'b', 'x')`);
  const foreign = await app.inject({ method: 'DELETE', url: '/dm/dm/messages/own-b', headers: authHeader('a') });
  assert.equal(foreign.statusCode, 403);
  const own = await app.inject({ method: 'DELETE', url: '/dm/dm/messages/own-b', headers: authHeader('b') });
  assert.equal(own.statusCode, 204);
  const rows = await t.raw.query<{ content: string; deleted_at: Date | null }>(`SELECT content, deleted_at FROM conversation_messages WHERE id = 'own-b'`);
  assert.equal(rows.rows.length, 1);
  assert.equal(rows.rows[0]?.content, '');
  assert.ok(rows.rows[0]?.deleted_at);
});

test('удаление только у себя прячет своё и чужое без дубля и без чужого события', async () => {
  // Ловит удаление у второго участника и повторное включение спрятанного сообщения в unread.
  await t.raw.exec(`INSERT INTO conversation_messages (id, conversation_id, author_id, content, created_at) VALUES
    ('hide-b', 'dm', 'b', 'one', now() - interval '2 minutes'),
    ('hide-a', 'dm', 'a', 'two', now() - interval '1 minute'),
    ('stay-b', 'dm', 'b', 'three', now())`);
  for (const id of ['hide-b', 'hide-a', 'hide-b']) {
    const response = await app.inject({ method: 'DELETE', url: `/dm/dm/messages/${id}?for=me`, headers: authHeader('a') });
    assert.equal(response.statusCode, 204);
  }
  assert.equal(published.some((p) => p.channel === 'gw:user:b' && JSON.parse(p.message).m.t === 'dm.delete'), false);
  const hidden = await t.raw.query<{ id: string; hidden_for: string[] }>(`SELECT id, hidden_for FROM conversation_messages WHERE id IN ('hide-b','hide-a') ORDER BY id`);
  assert.deepEqual(hidden.rows.map((r) => r.hidden_for), [['a'], ['a']]);
  const forA = await app.inject({ method: 'GET', url: '/dm/dm/messages', headers: authHeader('a') });
  const forB = await app.inject({ method: 'GET', url: '/dm/dm/messages', headers: authHeader('b') });
  assert.deepEqual(forA.json().map((m: { id: string }) => m.id), ['stay-b']);
  assert.deepEqual(forB.json().map((m: { id: string }) => m.id), ['hide-b', 'hide-a', 'stay-b']);
  const list = await app.inject({ method: 'GET', url: '/dm', headers: authHeader('a') });
  const summary = await app.inject({ method: 'GET', url: '/unread', headers: authHeader('a') });
  assert.equal(list.json()[0].unread, 1);
  assert.equal(summary.json().dms, 1);
  const lastDelete = published.filter((p) => p.channel === 'gw:user:a')
    .map((p) => JSON.parse(p.message).m).filter((m) => m.t === 'dm.delete').at(-1);
  assert.equal(lastDelete.unread, 1);
});

test('чужое придержанное нельзя удалить даже только у себя', async () => {
  // Ловит раскрытие существования сообщения, которое блокировщик никогда не видел.
  await app.inject({ method: 'POST', url: '/blocks', headers: authHeader('a'), payload: { userId: 'b' } });
  const sent = await app.inject({ method: 'POST', url: '/dm/dm/messages', headers: authHeader('b'), payload: { content: 'secret' } });
  const deleted = await app.inject({ method: 'DELETE', url: `/dm/dm/messages/${sent.json().id}?for=me`, headers: authHeader('a') });
  assert.equal(deleted.statusCode, 404);
});

test('удаление последнего у обоих уменьшает время беседы и пересчитывает непрочитанное', async () => {
  // Ловит зависшую наверху пустую беседу и цифру 1 после удаления непрочитанного.
  await t.raw.exec(`INSERT INTO conversation_messages (id, conversation_id, author_id, content, created_at) VALUES
    ('last-old', 'dm', 'b', 'one', now() - interval '2 minutes'),
    ('last-new', 'dm', 'b', 'two', now() - interval '1 minute')`);
  published.length = 0;
  const first = await app.inject({ method: 'DELETE', url: '/dm/dm/messages/last-new?for=both', headers: authHeader('b') });
  assert.equal(first.statusCode, 204);
  const left = await t.raw.query<{ created_at: Date }>(`SELECT created_at FROM conversation_messages WHERE id = 'last-old'`);
  const at = left.rows[0]!.created_at.toISOString();
  const row = await t.raw.query<{ last_message_at: Date }>(`SELECT last_message_at FROM conversations WHERE id = 'dm'`);
  assert.equal(row.rows[0]?.last_message_at.toISOString(), at);
  const event = published.filter((p) => p.channel === 'gw:user:a').map((p) => JSON.parse(p.message).m).find((m) => m.t === 'dm.delete');
  assert.equal(event.lastMessageAt, at);
  assert.equal(event.unread, 1);
  const ownEvent = published.filter((p) => p.channel === 'gw:user:b').map((p) => JSON.parse(p.message).m).find((m) => m.t === 'dm.delete');
  assert.equal(ownEvent.lastMessageAt, at);
  const second = await app.inject({ method: 'DELETE', url: '/dm/dm/messages/last-old', headers: authHeader('b') });
  assert.equal(second.statusCode, 204);
  const empty = await t.raw.query<{ last_message_at: Date | null }>(`SELECT last_message_at FROM conversations WHERE id = 'dm'`);
  assert.equal(empty.rows[0]?.last_message_at, null);
  const unread = await app.inject({ method: 'GET', url: '/dm', headers: authHeader('a') });
  assert.equal(unread.json()[0].unread, 0);
});

async function seedLastMessage(): Promise<void> {
  await t.raw.exec(`
    INSERT INTO conversation_messages (id, conversation_id, author_id, content, created_at)
      VALUES ('race-old', 'dm', 'b', 'old', now() - interval '1 minute');
    UPDATE conversations SET last_message_at = (SELECT created_at FROM conversation_messages WHERE id = 'race-old') WHERE id = 'dm';
  `);
}

async function assertFreshLast(sent: Awaited<ReturnType<typeof app.inject>>): Promise<void> {
  assert.equal(sent.statusCode, 201);
  const freshAt = sent.json().createdAt;
  const rows = await t.raw.query<{ last_message_at: Date }>(`SELECT last_message_at FROM conversations WHERE id = 'dm'`);
  assert.equal(rows.rows[0]!.last_message_at.toISOString(), freshAt);
  const messages = await t.raw.query<{ id: string }>(`SELECT id FROM conversation_messages WHERE conversation_id = 'dm' AND deleted_at IS NULL`);
  assert.deepEqual(messages.rows.map((row) => row.id), [sent.json().id]);
}

test('удаление под замком перед отправкой не стирает время свежего сообщения', async () => {
  // Ловит откат last_message_at в null, когда новый текст пришёл во время удаления последнего старого.
  await seedLastMessage();
  let reached!: () => void;
  let release!: () => void;
  const atLock = new Promise<void>((resolve) => { reached = resolve; });
  const hold = new Promise<void>((resolve) => { release = resolve; });
  setDmWriteBarrierForTests({ afterDeleteLock: async () => { reached(); await hold; } });
  try {
    const deleting = app.inject({ method: 'DELETE', url: '/dm/dm/messages/race-old?for=both', headers: authHeader('b') });
    await atLock;
    const sending = app.inject({ method: 'POST', url: '/dm/dm/messages', headers: authHeader('b'), payload: { content: 'fresh' } });
    await new Promise<void>((resolve) => setImmediate(resolve));
    release();
    assert.equal((await deleting).statusCode, 204);
    await assertFreshLast(await sending);
  } finally {
    release();
    setDmWriteBarrierForTests({});
  }
});

test('отправка перед удалением удерживает время нового сообщения', async () => {
  // Ловит пересчёт last_message_at по старому снимку при встречном порядке двух транзакций.
  await seedLastMessage();
  let reached!: () => void;
  let release!: () => void;
  const afterInsert = new Promise<void>((resolve) => { reached = resolve; });
  const hold = new Promise<void>((resolve) => { release = resolve; });
  setDmWriteBarrierForTests({ afterSendInsert: async () => { reached(); await hold; } });
  try {
    const sending = app.inject({ method: 'POST', url: '/dm/dm/messages', headers: authHeader('b'), payload: { content: 'fresh' } });
    await afterInsert;
    let deletionFinished = false;
    const deleting = app.inject({ method: 'DELETE', url: '/dm/dm/messages/race-old?for=both', headers: authHeader('b') });
    void deleting.then(() => { deletionFinished = true; });
    await new Promise<void>((resolve) => setImmediate(resolve));
    assert.equal(deletionFinished, false, 'удаление обязано ждать замок отправки');
    release();
    const sent = await sending;
    assert.equal((await deleting).statusCode, 204);
    await assertFreshLast(sent);
  } finally {
    release();
    setDmWriteBarrierForTests({});
  }
});

test('старая отправка доставляет раздельные dm и conv события без новых полей в старом DTO', async () => {
  // Ловит двойной показ сообщения в смешанной паре старого и нового клиентов.
  const sent = await app.inject({ method: 'POST', url: '/dm/dm/messages', headers: authHeader('b'), payload: { content: 'hello' } });
  assert.equal(sent.statusCode, 201);
  for (const field of ['conversationId', 'sortKey', 'clientId']) assert.equal(field in sent.json(), false, field);
  const envelopes = published.map((p) => ({ channel: p.channel, ...JSON.parse(p.message) }));
  const events = (channel: string, type: string) => envelopes.filter((e) => e.channel === channel && e.m.t === type);
  assert.equal(events('gw:user:a', 'dm.channel').length, 1);
  assert.equal(events('gw:user:a', 'dm.create').length, 1);
  assert.equal(events('gw:user:b', 'dm.create').length, 1);
  assert.equal(events('gw:user:a', 'conv.change').length, 1);
  assert.equal(events('gw:user:b', 'conv.change').length, 1);
  for (const e of envelopes) {
    if (e.m.t.startsWith('dm.')) assert.equal(e.notCap, 'conv1');
    if (e.m.t === 'conv.change') assert.equal(e.cap, 'conv1');
  }
});

test('новая и старая ручки читают сообщения друг друга, а повтор новой отправки не создаёт дубль', async () => {
  // Ловит расхождение двух независимых хранилищ ЛС после переноса.
  const old = await app.inject({ method: 'POST', url: '/dm/dm/messages', headers: authHeader('a'), payload: { content: 'old' } });
  assert.equal(old.statusCode, 201);
  const newHistory = await app.inject({ method: 'GET', url: '/conv/dm/messages', headers: authHeader('b') });
  assert.deepEqual(newHistory.json().messages.map((m: { id: string }) => m.id), [old.json().id]);
  const payload = { clientId: '00000000-0000-4000-8000-000000000001', content: 'new' };
  const first = await app.inject({ method: 'POST', url: '/conv/dm/messages', headers: authHeader('b'), payload });
  assert.equal(first.statusCode, 201);
  const replay = await app.inject({ method: 'POST', url: '/conv/dm/messages', headers: authHeader('b'), payload });
  assert.equal(replay.statusCode, 200);
  assert.equal(replay.json().id, first.json().id);
  const oldHistory = await app.inject({ method: 'GET', url: '/dm/dm/messages', headers: authHeader('a') });
  assert.deepEqual(oldHistory.json().map((m: { id: string }) => m.id), [old.json().id, first.json().id]);
});

test('clientId принимает нормализованный повтор, но отвергает новый текст и другую беседу', async () => {
  // Ловит покупку второй записи тем же id отправки и возврат сообщения из чужой беседы.
  const clientId = '00000000-0000-4000-8000-000000000002';
  const post = (id: string, content: string) => app.inject({
    method: 'POST', url: `/conv/${id}/messages`, headers: authHeader('a'), payload: { clientId, content },
  });
  const first = await post('dm', '  hello  ');
  assert.equal(first.statusCode, 201);
  const replay = await post('dm', 'hello');
  assert.equal(replay.statusCode, 200);
  assert.equal(replay.json().id, first.json().id);
  assert.equal((await post('dm', 'different')).statusCode, 409);
  assert.equal((await post('foreign-dm', 'hello')).statusCode, 409);
  const rows = await t.raw.query(`SELECT id FROM conversation_messages WHERE client_id = '${clientId}'`);
  assert.equal(rows.rows.length, 1);
});

test('параллельный повтор clientId пишет одну строку и один номер журнала', async () => {
  // Ловит UNIQUE-ошибку или двойное уведомление при повторной отправке с двух вкладок.
  const payload = { clientId: '00000000-0000-4000-8000-000000000099', content: 'once' };
  const send = () => app.inject({ method: 'POST', url: '/conv/dm/messages', headers: authHeader('a'), payload });
  const [first, second] = await Promise.all([send(), send()]);
  assert.deepEqual([first.statusCode, second.statusCode].sort(), [200, 201]);
  assert.equal(first.json().id, second.json().id);
  assert.equal((await t.raw.query(`SELECT id FROM conversation_messages WHERE client_id = '${payload.clientId}'`)).rows.length, 1);
  for (const id of ['a', 'b']) {
    const state = await t.raw.query<{ pts: number; n: number }>(`
      SELECT s.pts, (SELECT count(*)::int FROM user_changes c WHERE c.user_id = s.user_id) AS n
      FROM user_sync s WHERE s.user_id = '${id}'`);
    assert.deepEqual(state.rows.map((r) => [Number(r.pts), Number(r.n)]), [[1, 1]]);
  }
});

test('два старых запроса без clientId остаются двумя сообщениями, ключ после будущего растёт на один', async () => {
  // Ловит склейку старых отправок и откат порядка после перестановки часов.
  const future = Date.now() * 1000 + 10_000_000;
  await t.raw.query(`UPDATE conversations SET last_sort_key = $1 WHERE id = 'dm'`, [future]);
  const send = () => app.inject({ method: 'POST', url: '/dm/dm/messages', headers: authHeader('a'), payload: { content: 'same' } });
  const [one, two] = await Promise.all([send(), send()]);
  assert.equal(one.statusCode, 201);
  assert.equal(two.statusCode, 201);
  assert.notEqual(one.json().id, two.json().id);
  const keys = (await t.raw.query<{ sort_key: number }>(`
    SELECT sort_key FROM conversation_messages WHERE conversation_id = 'dm' ORDER BY sort_key`,
  )).rows.map((r) => Number(r.sort_key));
  assert.deepEqual(keys, [future + 1, future + 2]);
  assert.equal(Number((await t.raw.query<{ last_sort_key: number }>(`SELECT last_sort_key FROM conversations WHERE id = 'dm'`)).rows[0]?.last_sort_key), future + 2);
});

test('встречные отправки дают уникальный порядок и последовательный журнал обоим', async () => {
  // Ловит взаимную блокировку при обратном порядке участников и дырку в pts.
  const send = (id: string) => app.inject({
    method: 'POST', url: '/dm/dm/messages', headers: authHeader(id), payload: { content: id },
  });
  const [a, b] = await Promise.all([send('a'), send('b')]);
  assert.equal(a.statusCode, 201);
  assert.equal(b.statusCode, 201);
  const rows = (await t.raw.query<{ sort_key: number }>(`SELECT sort_key FROM conversation_messages WHERE conversation_id = 'dm' ORDER BY sort_key`)).rows;
  assert.equal(rows.length, 2);
  assert.ok(Number(rows[0]?.sort_key) < Number(rows[1]?.sort_key));
  for (const id of ['a', 'b']) {
    const journal = (await t.raw.query<{ pts: number }>(`SELECT pts FROM user_changes WHERE user_id = '${id}' ORDER BY pts`)).rows;
    assert.deepEqual(journal.map((r) => Number(r.pts)), [1, 2]);
  }
});

test('история беседы листается до, после и вокруг ключа без пропуска соседей', async () => {
  // Ловит потерю строки на границе страницы и смешение порядка сортировки.
  const ids: string[] = [];
  for (let i = 1; i <= 4; i++) {
    const sent = await app.inject({
      method: 'POST', url: '/conv/dm/messages', headers: authHeader('a'),
      payload: { clientId: `00000000-0000-4000-8000-${String(i).padStart(12, '0')}`, content: String(i) },
    });
    assert.equal(sent.statusCode, 201);
    ids.push(sent.json().id);
  }
  const page = async (suffix: string) => {
    const response = await app.inject({ method: 'GET', url: `/conv/dm/messages?${suffix}`, headers: authHeader('b') });
    assert.equal(response.statusCode, 200);
    return response.json();
  };
  const latest = await page('limit=2');
  assert.deepEqual(latest.messages.map((m: { id: string }) => m.id), ids.slice(2));
  assert.equal(latest.hasMoreBefore, true);
  const cursor = `${latest.messages[0].sortKey}_${latest.messages[0].id}`;
  assert.deepEqual((await page(`before=${cursor}&limit=2`)).messages.map((m: { id: string }) => m.id), ids.slice(0, 2));
  assert.deepEqual((await page(`after=${cursor}&limit=2`)).messages.map((m: { id: string }) => m.id), ids.slice(3));
  assert.deepEqual((await page(`around=${ids[1]}&limit=3`)).messages.map((m: { id: string }) => m.id), ids.slice(0, 3));
});

test('догонка отдаёт страницы без пропуска, а слишком старый номер требует снимок', async () => {
  // Ловит пропуск журнала между страницами и бесконечную догонку после очистки.
  for (let i = 1; i <= 3; i++) {
    const sent = await app.inject({ method: 'POST', url: '/dm/dm/messages', headers: authHeader('a'), payload: { content: String(i) } });
    assert.equal(sent.statusCode, 201);
  }
  const sync = async (pts: number, limit = 2) => {
    const response = await app.inject({ method: 'GET', url: `/conv/sync?pts=${pts}&limit=${limit}`, headers: authHeader('b') });
    assert.equal(response.statusCode, 200);
    return response.json();
  };
  const first = await sync(0);
  assert.equal(first.reset, false);
  assert.equal(first.more, true);
  assert.equal(first.pts, 2);
  assert.equal(first.messages.length, 2);
  const second = await sync(first.pts);
  assert.equal(second.more, false);
  assert.equal(second.pts, 3);
  assert.equal(second.messages.length, 1);
  await t.raw.exec(`UPDATE user_sync SET min_pts = 2 WHERE user_id = 'b'`);
  assert.deepEqual(await sync(1), { reset: true, pts: 3 });
  assert.equal((await sync(2)).reset, false);
  assert.deepEqual(await sync(4), { reset: true, pts: 3 });
});

test('личное скрытие превращается в gone только для скрывшего, не для собеседника', async () => {
  // Ловит оставшийся в офлайн-кеше текст после удаления «у меня» с другого устройства.
  const sent = await app.inject({ method: 'POST', url: '/dm/dm/messages', headers: authHeader('b'), payload: { content: 'secret' } });
  const id = sent.json().id;
  const hidden = await app.inject({ method: 'DELETE', url: `/dm/dm/messages/${id}?for=me`, headers: authHeader('a') });
  assert.equal(hidden.statusCode, 204);
  const sync = async (viewer: string) => (await app.inject({
    method: 'GET', url: '/conv/sync?pts=0', headers: authHeader(viewer),
  })).json();
  const a = await sync('a');
  const b = await sync('b');
  assert.deepEqual(a.messages, [{ id, conversationId: 'dm', gone: true }]);
  assert.equal(b.messages[0].id, id);
  assert.equal('gone' in b.messages[0], false);
});

test('придержанное не появляется ни в журнале, ни в истории блокировщика', async () => {
  // Ловит раскрытие факта отправки заблокированным через догонку или счётчик.
  await app.inject({ method: 'POST', url: '/blocks', headers: authHeader('a'), payload: { userId: 'b' } });
  const sent = await app.inject({ method: 'POST', url: '/dm/dm/messages', headers: authHeader('b'), payload: { content: 'hidden' } });
  assert.equal(sent.statusCode, 201);
  const a = (await app.inject({ method: 'GET', url: '/conv/sync?pts=0', headers: authHeader('a') })).json();
  const b = (await app.inject({ method: 'GET', url: '/conv/sync?pts=0', headers: authHeader('b') })).json();
  assert.equal(a.pts, 0);
  assert.deepEqual(a.messages, []);
  assert.equal(b.messages[0].id, sent.json().id);
  assert.equal((await app.inject({ method: 'GET', url: '/conv/dm/messages', headers: authHeader('a') })).json().messages.length, 0);
});

test('удаление у обоих стирает реакцию и даёт адресное надгробие без второй записи при повторе', async () => {
  // Ловит воскресшую реакцию или дублирующую догонку после удаления сообщения.
  const sent = await app.inject({ method: 'POST', url: '/dm/dm/messages', headers: authHeader('b'), payload: { content: 'soon gone' } });
  const id = sent.json().id;
  const react = await app.inject({ method: 'POST', url: `/conv/dm/messages/${id}/reactions`, headers: authHeader('a'), payload: { emoji: '👍', op: 'add' } });
  assert.equal(react.statusCode, 204);
  assert.equal((await t.raw.query(`SELECT 1 FROM conversation_message_reactions WHERE message_id = '${id}'`)).rows.length, 1);
  assert.equal((await app.inject({ method: 'DELETE', url: `/dm/dm/messages/${id}`, headers: authHeader('b') })).statusCode, 204);
  assert.equal((await t.raw.query(`SELECT 1 FROM conversation_message_reactions WHERE message_id = '${id}'`)).rows.length, 0);
  for (const viewer of ['a', 'b']) {
    const sync = (await app.inject({ method: 'GET', url: '/conv/sync?pts=0', headers: authHeader(viewer) })).json();
    assert.deepEqual(sync.messages, [{ id, conversationId: 'dm', gone: true }]);
  }
  const before = (await t.raw.query<{ n: number }>(`SELECT count(*)::int AS n FROM user_changes`)).rows[0]?.n;
  assert.equal((await app.inject({ method: 'DELETE', url: `/dm/dm/messages/${id}`, headers: authHeader('b') })).statusCode, 204);
  assert.equal((await t.raw.query<{ n: number }>(`SELECT count(*)::int AS n FROM user_changes`)).rows[0]?.n, before);
});

test('цитата удалённого у обоих остаётся помеченной только в новом DTO', async () => {
  // Ловит пустую цитату без признака удаления в старом клиенте или потерю ссылки в новом.
  const parent = await app.inject({ method: 'POST', url: '/dm/dm/messages', headers: authHeader('a'), payload: { content: 'parent' } });
  const child = await app.inject({ method: 'POST', url: '/dm/dm/messages', headers: authHeader('b'), payload: { content: 'child', replyToId: parent.json().id } });
  assert.equal(child.statusCode, 201);
  assert.equal((await app.inject({ method: 'DELETE', url: `/dm/dm/messages/${parent.json().id}`, headers: authHeader('a') })).statusCode, 204);
  const old = (await app.inject({ method: 'GET', url: '/dm/dm/messages', headers: authHeader('a') })).json();
  const fresh = (await app.inject({ method: 'GET', url: '/conv/dm/messages', headers: authHeader('a') })).json().messages;
  assert.equal(old.find((m: { id: string }) => m.id === child.json().id).replyTo, null);
  assert.equal(fresh.find((m: { id: string }) => m.id === child.json().id).replyTo.deleted, true);
});

test('прочтение принимает только ключ своего сообщения и не откатывает отметку', async () => {
  // Ловит произвольное чтение будущего и возврат unread после отставшего устройства.
  const one = await app.inject({ method: 'POST', url: '/dm/dm/messages', headers: authHeader('a'), payload: { content: '1' } });
  const two = await app.inject({ method: 'POST', url: '/dm/dm/messages', headers: authHeader('a'), payload: { content: '2' } });
  const key = async (id: string) => Number((await t.raw.query<{ sort_key: number }>(
    `SELECT sort_key FROM conversation_messages WHERE id = '${id}'`,
  )).rows[0]?.sort_key);
  const low = await key(one.json().id);
  const high = await key(two.json().id);
  const read = (value: number) => app.inject({ method: 'POST', url: '/conv/dm/read', headers: authHeader('b'), payload: { key: value } });
  assert.equal((await read(high + 1)).statusCode, 400);
  assert.equal((await read(high)).json().lastReadKey, high);
  const pts = Number((await t.raw.query<{ pts: number }>(`SELECT pts FROM user_sync WHERE user_id = 'b'`)).rows[0]?.pts);
  assert.equal((await read(low)).json().lastReadKey, high);
  assert.equal(Number((await t.raw.query<{ pts: number }>(`SELECT pts FROM user_sync WHERE user_id = 'b'`)).rows[0]?.pts), pts);
});

test('повторное удаление надгробия не создаёт второе событие', async () => {
  // Ловит повторное удаление в догонке после повторного нажатия старого клиента.
  const sent = await app.inject({ method: 'POST', url: '/dm/dm/messages', headers: authHeader('b'), payload: { content: 'delete' } });
  const url = `/dm/dm/messages/${sent.json().id}`;
  published.length = 0;
  assert.equal((await app.inject({ method: 'DELETE', url, headers: authHeader('b') })).statusCode, 204);
  const once = published.length;
  assert.ok(once > 0);
  assert.equal((await app.inject({ method: 'DELETE', url, headers: authHeader('b') })).statusCode, 204);
  assert.equal(published.length, once);
});

test('открытая старая пара возвращает прежнюю беседу без unread, новая — UUIDv7', async () => {
  // Ловит дубль пары и несовместимый DTO ответа старого POST /dm.
  const existing = await app.inject({ method: 'POST', url: '/dm', headers: authHeader('a'), payload: { userId: 'b' } });
  assert.equal(existing.statusCode, 200);
  assert.equal(existing.json().id, 'dm');
  assert.equal('unread' in existing.json(), false);
  const created = await app.inject({ method: 'POST', url: '/dm', headers: authHeader('b'), payload: { userId: 'c' } });
  assert.equal(created.statusCode, 200);
  assert.match(created.json().id, /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i);
  assert.equal('unread' in created.json(), false);
});

test('профиль объявляет conv1 и новая ручка доступна без старого флага', async () => {
  // Ловит скрытое включение работающих бесед, из-за которого новый клиент остался бы на старом API.
  const me = await app.inject({ method: 'GET', url: '/auth/me', headers: authHeader('a') });
  assert.equal(me.statusCode, 200);
  assert.deepEqual(me.json().features, ['conv1']);
  const conv = await app.inject({ method: 'GET', url: '/conv', headers: authHeader('a') });
  assert.equal(conv.statusCode, 200);
  assert.deepEqual(conv.json().conversations.map((c: { id: string }) => c.id).sort(), ['dm', 'foreign-dm']);
});

test('цитата скрытого у меня сообщения исчезает только из моей истории', async () => {
  // Ловит утечку текста сообщения через reply preview после «удалить у меня».
  await t.raw.exec(`INSERT INTO conversation_messages (id, conversation_id, author_id, content, reply_to_id) VALUES
    ('quote-parent', 'dm', 'b', 'скрытая цитата', null),
    ('quote-child', 'dm', 'b', 'ответ', 'quote-parent')`);
  const deleted = await app.inject({ method: 'DELETE', url: '/dm/dm/messages/quote-parent?for=me', headers: authHeader('a') });
  assert.equal(deleted.statusCode, 204);
  const a = await app.inject({ method: 'GET', url: '/dm/dm/messages', headers: authHeader('a') });
  const b = await app.inject({ method: 'GET', url: '/dm/dm/messages', headers: authHeader('b') });
  assert.equal(a.json().find((m: { id: string }) => m.id === 'quote-child').replyTo, null);
  assert.equal(b.json().find((m: { id: string }) => m.id === 'quote-child').replyTo.content, 'скрытая цитата');
});

test('блокировка не задерживает правку и удаление доставленного, но придержанное молчит', async () => {
  // Ловит расхождение живой ленты с базой для старого сообщения и утечку нового придержанного.
  await t.raw.exec(`INSERT INTO conversation_messages (id, conversation_id, author_id, content) VALUES ('delivered', 'dm', 'b', 'old')`);
  await app.inject({ method: 'POST', url: '/blocks', headers: authHeader('a'), payload: { userId: 'b' } });
  published.length = 0;
  const edit = await app.inject({ method: 'PATCH', url: '/dm/dm/messages/delivered', headers: authHeader('b'), payload: { content: 'new' } });
  assert.equal(edit.statusCode, 200);
  assert.equal(published.some((p) => p.channel === 'gw:user:a' && JSON.parse(p.message).m.t === 'dm.update'), true);
  published.length = 0;
  const remove = await app.inject({ method: 'DELETE', url: '/dm/dm/messages/delivered', headers: authHeader('b') });
  assert.equal(remove.statusCode, 204);
  assert.equal(published.some((p) => p.channel === 'gw:user:a' && JSON.parse(p.message).m.t === 'dm.delete'), true);
  const sent = await app.inject({ method: 'POST', url: '/dm/dm/messages', headers: authHeader('b'), payload: { content: 'withheld' } });
  published.length = 0;
  const silentEdit = await app.inject({ method: 'PATCH', url: `/dm/dm/messages/${sent.json().id}`, headers: authHeader('b'), payload: { content: 'still withheld' } });
  assert.equal(silentEdit.statusCode, 200);
  const silentDelete = await app.inject({ method: 'DELETE', url: `/dm/dm/messages/${sent.json().id}`, headers: authHeader('b') });
  assert.equal(silentDelete.statusCode, 204);
  assert.equal(published.some((p) => p.channel === 'gw:user:a' && ['dm.update', 'dm.delete'].includes(JSON.parse(p.message).m.t)), false);
});

test('правка пробелами запрещена без вложений и разрешает убрать подпись у вложения', async () => {
  // Ловит пустые сообщения из пробелов и одновременно запрет законного удаления подписи у файла.
  await t.raw.exec(`
    INSERT INTO conversation_messages (id, conversation_id, author_id, content, attachments) VALUES
      ('edit-dm-text', 'dm', 'a', 'keep', '[]'::jsonb),
      ('edit-dm-file', 'dm', 'a', 'caption', '[{"url":"https://x.test/f","name":"f","contentType":"text/plain","size":1}]'::jsonb);
    INSERT INTO messages (id, channel_id, author_id, content, attachments) VALUES
      ('edit-ch-text', 'ch', 'a', 'keep', '[]'::jsonb),
      ('edit-ch-file', 'ch', 'a', 'caption', '[{"url":"https://x.test/f","name":"f","contentType":"text/plain","size":1}]'::jsonb)
  `);
  for (const [textUrl, fileUrl] of [
    ['/dm/dm/messages/edit-dm-text', '/dm/dm/messages/edit-dm-file'],
    ['/channels/ch/messages/edit-ch-text', '/channels/ch/messages/edit-ch-file'],
  ]) {
    const rejected = await app.inject({ method: 'PATCH', url: textUrl, headers: authHeader('a'), payload: { content: '   ' } });
    assert.equal(rejected.statusCode, 400);
    const accepted = await app.inject({ method: 'PATCH', url: fileUrl, headers: authHeader('a'), payload: { content: '   ' } });
    assert.equal(accepted.statusCode, 200);
    assert.equal(accepted.json().content, '');
  }
  const texts = await t.raw.query<{ content: string }>(`
    SELECT content FROM conversation_messages WHERE id = 'edit-dm-text'
    UNION ALL SELECT content FROM messages WHERE id = 'edit-ch-text'
  `);
  assert.deepEqual(texts.rows.map((r) => r.content), ['keep', 'keep']);
});
