import assert from 'node:assert/strict';
import { after, before, beforeEach, test } from 'node:test';
import { Readable } from 'node:stream';
import { ZodError } from 'zod';
import { eq } from 'drizzle-orm';
import Fastify, { type FastifyError, type FastifyReply, type FastifyRequest } from 'fastify';
import multipart from '@fastify/multipart';
import { createTestDb, truncateAll, type TestDb } from './harness.js';

// Управляемая доставка только на тестовый адрес; ни .env, ни настоящей сети.
process.env.NTFY_BASE_URL = 'https://ntfy.example.test';
process.env.NTFY_TOKEN = 'integration-push-token';
process.env.PUBLIC_API_URL = 'https://api.example.test';
// Удаление аккаунта вызывает LiveKit/S3-cleanup; этот PGlite-сценарий не должен ходить во внешние службы.
process.env.LIVEKIT_URL_INTERNAL = 'http://127.0.0.1:1';
process.env.MINIO_ENDPOINT = '';

let t: TestDb;
let app: ReturnType<typeof Fastify>;
let tokenFor: (id: string) => string;
let redisPub: typeof import('../src/realtime.js').redisPub;
let resetBlockCache: () => void;
let forgetTokenGeneration: (id: string) => void;
let setAttachmentStoreForTests: typeof import('../src/attachments.js').setAttachmentStoreForTests;
const storageFiles = new Map<string, Buffer>();
const removedStorageKeys: string[] = [];
const published: { channel: string; message: string }[] = [];
const posted: { url: string; init: RequestInit }[] = [];
const originalFetch = globalThis.fetch;

const authHeader = (id: string) => ({ authorization: `Bearer ${tokenFor(id)}` });
const sendAt = (ms: number) => new Date(ms).toISOString();
const client = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const route = (id = 'dm') => `/conv/${id}/scheduled`;

function eventsFor(user: string): Record<string, unknown>[] {
  return published.filter((p) => p.channel === `gw:user:${user}`).map((p) => JSON.parse(p.message).m);
}

function scheduledEvents(user: string): Record<string, unknown>[] {
  return eventsFor(user).filter((m) => m.t === 'conv.change' && m.scheduled !== undefined);
}

async function seed(): Promise<void> {
  await t.raw.exec(`
    INSERT INTO users (id, username, display_name, password_hash) VALUES
      ('a', 'alpha', 'Alpha', 'hash'), ('b', 'bravo', 'Bravo', 'hash'),
      ('c', 'charlie', 'Charlie', 'hash'), ('d', 'delta', 'Delta', 'hash');
    INSERT INTO conversations (id, kind, direct_key, created_by) VALUES
      ('dm', 'direct', 'a:b', 'a'), ('dm2', 'direct', 'a:c', 'a');
    INSERT INTO conversation_members (conversation_id, user_id) VALUES
      ('dm','a'),('dm','b'),('dm2','a'),('dm2','c');
  `);
}

async function create(body: Record<string, unknown>, user = 'a', conversation = 'dm') {
  return app.inject({ method: 'POST', url: route(conversation), headers: authHeader(user), payload: body });
}

function installStorage(): void {
  storageFiles.clear();
  removedStorageKeys.length = 0;
  setAttachmentStoreForTests({
    ready: () => true, ensureReady: async () => true, configured: () => true,
    put: async (key, bytes) => { storageFiles.set(key, Buffer.from(bytes)); },
    stat: async (key) => storageFiles.has(key) ? { size: storageFiles.get(key)!.length } : null,
    get: async (key) => Readable.from(storageFiles.get(key) ?? Buffer.alloc(0)),
    remove: async (key) => { removedStorageKeys.push(key); storageFiles.delete(key); },
  });
}

async function upload(name: string, user = 'a', conversation = 'dm', bytes = Buffer.from(name)): Promise<{ id: string; size: number }> {
  const boundary = `gv-scheduled-${name.replace(/[^a-z0-9]/gi, '')}`;
  const payload = Buffer.concat([
    Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="${name}"\r\nContent-Type: application/octet-stream\r\n\r\n`),
    bytes,
    Buffer.from(`\r\n--${boundary}--\r\n`),
  ]);
  const result = await app.inject({ method: 'POST', url: `/conv/${conversation}/attachments`, headers: {
    ...authHeader(user), 'content-type': `multipart/form-data; boundary=${boundary}`,
  }, payload });
  assert.equal(result.statusCode, 200, `загрузка ${name}: ${result.body}`);
  return { id: result.json().id, size: result.json().size };
}

async function scheduledRows() {
  return (await t.raw.query<{ id: string; author_id: string; conversation_id: string; client_id: string; attempts: number; failed_at: Date | null; fail_reason: string | null; next_attempt_at: Date | null }>(
    `SELECT id,author_id,conversation_id,client_id,attempts,failed_at,fail_reason,next_attempt_at FROM conversation_scheduled ORDER BY id`,
  )).rows;
}

async function messageRows() {
  return (await t.raw.query<{ id: string; conversation_id: string; author_id: string; client_id: string; content: string; silent: boolean; withheld: boolean; created_at: Date; reply_to_id: string | null }>(
    `SELECT id,conversation_id,author_id,client_id,content,silent,withheld,created_at,reply_to_id FROM conversation_messages ORDER BY sort_key`,
  )).rows;
}

before(async () => {
  t = await createTestDb();
  const auth = await import('../src/auth.js');
  ({ setAttachmentStoreForTests } = await import('../src/attachments.js'));
  const { authRoutes } = await import('../src/routes/auth.js');
  const { convRoutes } = await import('../src/routes/conv.js');
  ({ resetBlockCacheForTests: resetBlockCache } = await import('../src/blocks.js'));
  ({ redisPub } = await import('../src/realtime.js'));
  ({ forgetTokenGeneration } = auth);
  redisPub.publish = (async (channel: string, message: string) => { published.push({ channel, message }); return 1; }) as typeof redisPub.publish;
  redisPub.incr = (async () => 1) as typeof redisPub.incr;
  redisPub.expire = (async () => 1) as typeof redisPub.expire;
  redisPub.ttl = (async () => 10) as typeof redisPub.ttl;
  tokenFor = (id) => auth.signToken({ sub: id, username: id, gen: 0 });
  app = Fastify();
  app.setErrorHandler((err: FastifyError, _req: FastifyRequest, reply: FastifyReply) => {
    if (err instanceof ZodError) return reply.code(400).send({ error: 'validation', details: err.issues });
    return reply.send(err);
  });
  await app.register(multipart, { limits: { fileSize: 25 * 1024 * 1024, files: 1 } });
  await app.register(authRoutes);
  await app.register(convRoutes);
  await app.ready();
});

beforeEach(async () => {
  await truncateAll(t.raw);
  resetBlockCache();
  for (const id of ['a', 'b', 'c', 'd']) forgetTokenGeneration(id);
  published.length = 0;
  posted.length = 0;
  globalThis.fetch = (async (url: string | URL | Request, init?: RequestInit) => {
    posted.push({ url: String(url), init: init ?? {} });
    return new Response(null, { status: 200 });
  }) as typeof fetch;
  await seed();
});

after(async () => {
  setAttachmentStoreForTests(null);
  globalThis.fetch = originalFetch;
  await app.close();
  redisPub.disconnect();
  await t.close();
});

test('создание, список, правка/перенос и удаление отложенного меняют только мой список', async () => {
  // Отложенное — приватный черновик на сервере: собеседник не должен узнать текст или даже число до фактической отправки.
  const now = Date.now() + 60_000;
  const first = await create({ clientId: client(1), content: '  позже  ', sendAt: sendAt(now), silent: true });
  assert.equal(first.statusCode, 201, first.body);
  assert.equal(first.json().items.length, 1);
  const sid = first.json().items[0].id as string;
  assert.equal(first.json().items[0].content, 'позже');
  const list = await app.inject({ method: 'GET', url: route(), headers: authHeader('a') });
  assert.equal(list.statusCode, 200);
  assert.equal(list.json().items[0].silent, true);
  const peer = await app.inject({ method: 'GET', url: route(), headers: authHeader('b') });
  assert.equal(peer.statusCode, 200);
  assert.deepEqual(peer.json().items, [], 'собеседник получает пустой свой список, а не чужое отложенное');
  const summaryA = (await app.inject({ method: 'GET', url: '/conv', headers: authHeader('a') })).json().conversations.find((c: { id: string }) => c.id === 'dm');
  const summaryB = (await app.inject({ method: 'GET', url: '/conv', headers: authHeader('b') })).json().conversations.find((c: { id: string }) => c.id === 'dm');
  assert.equal(summaryA.scheduledCount, 1);
  assert.equal(summaryB.scheduledCount, 0);
  assert.equal(scheduledEvents('a').length, 1);
  assert.equal(scheduledEvents('b').length, 0);
  assert.deepEqual((await t.raw.query<{ kind: string }>(`SELECT kind FROM user_changes WHERE user_id='a'`)).rows.map((r) => r.kind), ['sched']);
  const edit = await app.inject({ method: 'PATCH', url: `${route()}/${sid}`, headers: authHeader('a'), payload: { content: 'перенесено', sendAt: sendAt(now + 120_000) } });
  assert.equal(edit.statusCode, 200, edit.body);
  assert.equal(edit.json().items[0].content, 'перенесено');
  assert.equal(new Date(edit.json().items[0].sendAt).getTime(), now + 120_000);
  const noChangePts = edit.json().pts;
  published.length = 0;
  const noChange = await app.inject({ method: 'PATCH', url: `${route()}/${sid}`, headers: authHeader('a'), payload: { content: 'перенесено' } });
  assert.equal(noChange.statusCode, 200);
  assert.equal(noChange.json().pts, noChangePts);
  assert.equal(published.length, 0, 'повтор той же правки не создаёт шум в sync');
  const del = await app.inject({ method: 'DELETE', url: `${route()}/${sid}`, headers: authHeader('a') });
  assert.equal(del.statusCode, 200, del.body);
  assert.deepEqual(del.json().items, []);
  assert.equal((await scheduledRows()).length, 0);
  assert.equal((await app.inject({ method: 'DELETE', url: `${route()}/${sid}`, headers: authHeader('a') })).statusCode, 404);
});

test('clientId даёт replay без дубля, а конфликт содержимого или беседы отклоняется', async () => {
  // Повтор после потери HTTP-ответа не должен размножать отправки; тот же UUID с другим назначением — явный конфликт.
  const body = { clientId: client(2), content: 'один раз', whenOnline: true };
  const one = await create(body);
  const pts = one.json().pts;
  const eventCount = published.length;
  const replay = await create(body);
  assert.equal(one.statusCode, 201, one.body);
  assert.equal(replay.statusCode, 200, replay.body);
  assert.equal(replay.json().pts, pts);
  assert.equal(published.length, eventCount);
  assert.equal((await scheduledRows()).length, 1);
  const conflict = await create({ ...body, content: 'другое' });
  assert.equal(conflict.statusCode, 409);
  assert.equal(conflict.json().error, 'client_id_conflict');
  const elsewhere = await create(body, 'a', 'dm2');
  assert.equal(elsewhere.statusCode, 409);
  assert.equal((await scheduledRows()).length, 1);
});

test('ручка отвергает мусор, слишком длинный список вложений, неверные цели и пустые правки до записи', async () => {
  // Отказ на схеме не должен менять очередь; настоящие ссылки на файлы проверяются через загрузку ниже.
  const base = { clientId: client(3), content: 'текст' };
  assert.equal((await create({ clientId: client(30), content: 'x'.repeat(4096), whenOnline: true })).statusCode, 201, '4096 символов — допустимая граница');
  assert.equal((await create({ clientId: client(31), content: 'x'.repeat(4097), whenOnline: true })).statusCode, 400);
  assert.equal((await create({ clientId: client(32), content: 'x', sendAt: sendAt(Date.now() + 60_000), attachments: Array.from({ length: 100 }, () => ({})) })).statusCode, 400,
    'объекты без uuid не должны проходить схему вложений');
  assert.equal((await create({ clientId: client(33), content: 'x', sendAt: sendAt(Date.now() + 60_000), attachments: Array.from({ length: 101 }, () => ({})) })).statusCode, 400,
    'список за лимитом схемы тоже отвергается до мутаций');
  const bad = [
    { ...base }, { ...base, sendAt: '2026-02-30T10:00:00Z' }, { ...base, sendAt: '2027-01-01T00:00:00Z', whenOnline: true },
    { ...base, sendAt: sendAt(Date.now() + 60_000), attachments: [{ id: 'file' }] },
    { ...base, sendAt: sendAt(Date.now() + 60_000), content: '   ' },
  ];
  for (const body of bad) assert.equal((await create(body)).statusCode, 400, JSON.stringify(body));
  const good = await create({ ...base, whenOnline: true });
  const sid = good.json().items[0].id;
  for (const payload of [{}, { sendAt: 'bad' }, { content: '  ' }]) {
    assert.equal((await app.inject({ method: 'PATCH', url: `${route()}/${sid}`, headers: authHeader('a'), payload })).statusCode, 400);
  }
  assert.equal((await scheduledRows()).length, 2, 'валидная граница текста и базовый вариант сохранены; все ошибочные запросы не добавили строк');
});

test('лимит 100 на беседу и 500 на автора проверяет включённую грань и не частично вставляет', async () => {
  // Именно 100/500 должны ещё помещаться; следующий запрос не должен проскочить и оставлять лишнюю строку.
  const at = sendAt(Date.now() + 60_000);
  await t.raw.query(`INSERT INTO conversation_scheduled (id,conversation_id,author_id,client_id,payload_hash,content,send_at,when_online)
    SELECT 'c'||n,'dm','a', '10000000-0000-4000-8000-'||lpad(n::text,12,'0'), repeat('a',64),'x',$1,false FROM generate_series(1,99) n`, [at]);
  const reaches100 = await create({ clientId: client(101), content: 'граница', sendAt: at });
  assert.equal(reaches100.statusCode, 201, reaches100.body);
  const over100 = await create({ clientId: client(102), content: 'лишнее', sendAt: at });
  assert.equal(over100.statusCode, 409);
  assert.equal(over100.json().scope, 'conversation');
  assert.equal((await t.raw.query<{ n: number }>(`SELECT count(*)::int n FROM conversation_scheduled WHERE conversation_id='dm'`)).rows[0].n, 100);

  await truncateAll(t.raw); await seed();
  await t.raw.query(`INSERT INTO conversation_scheduled (id,conversation_id,author_id,client_id,payload_hash,content,send_at,when_online)
    SELECT 'u'||n,'dm2','a', '20000000-0000-4000-8000-'||lpad(n::text,12,'0'), repeat('b',64),'x',$1,false FROM generate_series(1,499) n`, [at]);
  const reaches500 = await create({ clientId: client(104), content: '500-я', sendAt: at });
  assert.equal(reaches500.statusCode, 201, reaches500.body);
  assert.equal((await t.raw.query<{ n: number }>(`SELECT count(*)::int n FROM conversation_scheduled WHERE author_id='a'`)).rows[0].n, 500);
  const over500 = await create({ clientId: client(103), content: 'лишнее', sendAt: at });
  assert.equal(over500.statusCode, 409);
  assert.equal(over500.json().scope, 'user');
  assert.equal(over500.json().max, 500);
  assert.equal((await t.raw.query<{ n: number }>(`SELECT count(*)::int n FROM conversation_scheduled WHERE author_id='a'`)).rows[0].n, 500);
});

test('бюджет 30 запросов за 10 секунд пропускает 30 и ограничивает 31-й', async () => {
  // Redis детерминированно подменён: все CRUD-ручки должны расходовать общий ключ автора.
  const incr = redisPub.incr, expire = redisPub.expire, ttl = redisPub.ttl;
  let hits = 0;
  const expiries: [string, number][] = [];
  redisPub.incr = (async (key: string) => key === 'rl:conv-sched:a' ? ++hits : 1) as typeof redisPub.incr;
  redisPub.expire = (async (key: string, seconds: number) => { expiries.push([key, seconds]); return 1; }) as typeof redisPub.expire;
  redisPub.ttl = (async () => 10) as typeof redisPub.ttl;
  try {
    for (let i = 1; i <= 30; i++) {
      const res = await create({ clientId: client(100 + i), content: `пакет ${i}`, whenOnline: true });
      assert.equal(res.statusCode, 201, `запрос ${i}: ${res.body}`);
    }
    const before = (await scheduledRows()).length;
    const limited = await create({ clientId: client(131), content: '31-й', whenOnline: true });
    assert.equal(limited.statusCode, 429, limited.body);
    assert.equal(limited.headers['retry-after'], '10');
    assert.equal((await scheduledRows()).length, before);
    assert.deepEqual(expiries, [['rl:conv-sched:a', 10]]);
  } finally { redisPub.incr = incr; redisPub.expire = expire; redisPub.ttl = ttl; }
});

test('«отправить сейчас» создаёт обычное сообщение немедленно и убирает его из моего списка', async () => {
  // Кнопка не должна ждать срока или порождать новый clientId: сообщение связывается с исходным отложенным.
  const queued = await create({ clientId: client(40), content: 'сейчас', sendAt: sendAt(Date.now() + 3_600_000) });
  const sid = queued.json().items[0].id;
  const res = await app.inject({ method: 'POST', url: `${route()}/${sid}/send`, headers: authHeader('a') });
  assert.equal(res.statusCode, 201, res.body);
  assert.equal(res.json().message.content, 'сейчас');
  assert.equal(res.json().message.clientId, client(40));
  assert.equal((await messageRows()).length, 1);
  assert.equal((await scheduledRows()).length, 0);
  assert.deepEqual(res.json().items, []);
  assert.ok(eventsFor('a').some((m) => m.t === 'conv.change'), 'отправка сейчас обновляет устройства автора');
  assert.ok(eventsFor('b').some((m) => m.t === 'conv.change'), 'отправленное сообщение приходит собеседнику');
});

test('файлы проходят загрузку, парковку, правку пустой подписи и обе ветки отправки', async () => {
  // Иначе метаданные отложенного могут разойтись с файлом в закрытом бакете или такт обойдёт обычную привязку сообщения.
  installStorage();
  const immediateFile = await upload('now.bin');
  const immediate = await create({ clientId: client(70), content: 'подпись', attachments: [{ id: immediateFile.id }], sendAt: sendAt(Date.now() + 3_600_000) });
  assert.equal(immediate.statusCode, 201, immediate.body);
  const sidNow = immediate.json().items[0].id as string;
  let parked = (await t.raw.query<{ state: string; scheduled_id: string | null }>('SELECT state, scheduled_id FROM attachments WHERE id=$1', [immediateFile.id])).rows[0];
  assert.deepEqual(parked, { state: 'scheduled', scheduled_id: sidNow });
  const edited = await app.inject({ method: 'PATCH', url: `${route()}/${sidNow}`, headers: authHeader('a'), payload: { content: '', sendAt: sendAt(Date.now() + 7_200_000) } });
  assert.equal(edited.statusCode, 200, edited.body);
  assert.equal(edited.json().items[0].content, '', 'вложение позволяет убрать подпись, не удаляя сам файл');
  assert.equal(edited.json().items[0].attachments.length, 1, 'правка текста/времени сохраняет файл');
  const sendNow = await app.inject({ method: 'POST', url: `${route()}/${sidNow}/send`, headers: authHeader('a') });
  assert.equal(sendNow.statusCode, 201, sendNow.body);
  assert.equal(sendNow.json().message.attachments.length, 1);
  parked = (await t.raw.query<{ state: string; message_id: string | null; scheduled_id: string | null }>('SELECT state, message_id, scheduled_id FROM attachments WHERE id=$1', [immediateFile.id])).rows[0];
  assert.deepEqual(parked, { state: 'attached', message_id: sendNow.json().message.id, scheduled_id: null });

  const { runScheduledTick } = await import('../src/scheduled.js');
  const tickFile = await upload('tick.bin');
  const due = new Date(Date.now() - 1_000);
  const queued = await create({ clientId: client(71), content: '', attachments: [{ id: tickFile.id }], sendAt: due.toISOString() });
  assert.equal(queued.statusCode, 201, queued.body);
  const report = await runScheduledTick({ now: () => new Date(), isOnline: () => false });
  assert.equal(report.sent, 1);
  const tickMessage = (await messageRows()).find((row) => row.client_id === client(71));
  assert.ok(tickMessage, 'такт должен создать обычную запись сообщения для файла');
  const tickAtt = (await t.raw.query<{ state: string; message_id: string | null; scheduled_id: string | null }>('SELECT state, message_id, scheduled_id FROM attachments WHERE id=$1', [tickFile.id])).rows[0];
  assert.deepEqual(tickAtt, { state: 'attached', message_id: tickMessage!.id, scheduled_id: null });
});

test('видео-подсказки отложенного сохраняются до «Отправить сейчас» без огибающей', async () => {
  // Подсказки нужны на экране отложенного и после общей отправки, но waveform видео не превращает его в голосовое.
  installStorage();
  const { createPending } = await import('../src/attachments.js');
  const id = await createPending({ ownerId: 'a', conversationId: 'dm', name: 'scheduled.mp4', contentType: 'video/mp4', bytes: Buffer.from('video bytes') });
  const queued = await create({ clientId: client(829), content: 'клип', attachments: [{ id, width: 1280, height: 720, durationMs: 17_000, waveform: [0, 30, 100] }], whenOnline: true });
  assert.equal(queued.statusCode, 201, queued.body);
  const item = queued.json().items[0];
  assert.deepEqual([item.attachments[0].width, item.attachments[0].height, item.attachments[0].durationMs], [1280, 720, 17_000]);
  assert.equal(Object.hasOwn(item.attachments[0], 'waveform'), false, 'сводка отложенного хранит только видео-подсказки');
  const send = await app.inject({ method: 'POST', url: `${route()}/${item.id}/send`, headers: authHeader('a') });
  assert.equal(send.statusCode, 201, send.body);
  assert.deepEqual([send.json().message.attachments[0].width, send.json().message.attachments[0].height, send.json().message.attachments[0].durationMs], [1280, 720, 17_000]);
  assert.equal(Object.hasOwn(send.json().message.attachments[0], 'waveform'), false);
  const row = (await t.raw.query<{ attachments: { width?: number; height?: number; durationMs?: number; waveform?: number[] }[] }>(
    'SELECT attachments FROM conversation_messages WHERE client_id=$1', [client(829)],
  )).rows[0].attachments[0];
  assert.deepEqual([row.width, row.height, row.durationMs], [1280, 720, 17_000]);
  assert.equal(Object.hasOwn(row, 'waveform'), false, 'после send-now в строке сообщения остаются только width/height/duration');
});

test('такт отложенного сохраняет GIF, «как файл», спойлер и подпись над медиа', async () => {
  // Эти флаги выбираются в окне отправки; потеря в парковке или при такте меняет вид уже отправленного сообщения.
  installStorage();
  const { createPending } = await import('../src/attachments.js');
  const video = await createPending({ ownerId: 'a', conversationId: 'dm', name: 'loop.mp4', contentType: 'video/mp4', bytes: Buffer.from('video') });
  const image = await createPending({ ownerId: 'a', conversationId: 'dm', name: 'spoiler.png', contentType: 'image/png', bytes: Buffer.from('image') });
  const due = new Date(Date.now() - 1_000);
  const queued = await create({
    clientId: client(830), content: 'подпись к альбому',
    attachments: [{ id: video, asFile: true, gif: true }, { id: image, spoiler: true }],
    captionAbove: true, sendAt: due.toISOString(),
  });
  assert.equal(queued.statusCode, 201, queued.body);
  const item = queued.json().items[0];
  assert.equal(item.captionAbove, true);
  assert.deepEqual(item.attachments.map((a: { asFile?: boolean; gif?: boolean; spoiler?: boolean }) => [a.asFile === true, a.gif === true, a.spoiler === true]), [
    [true, true, false], [false, false, true],
  ]);

  const { runScheduledTick } = await import('../src/scheduled.js');
  assert.equal((await runScheduledTick({ now: () => new Date(), isOnline: () => false })).sent, 1);
  const sent = (await t.raw.query<{ attachments: { asFile?: boolean; gif?: boolean; spoiler?: boolean }[]; caption_above: boolean }>(
    'SELECT attachments, caption_above FROM conversation_messages WHERE client_id=$1', [client(830)],
  )).rows[0];
  assert.equal(sent.caption_above, true);
  assert.deepEqual(sent.attachments.map((a) => [a.asFile === true, a.gif === true, a.spoiler === true]), [
    [true, true, false], [false, false, true],
  ]);

  // Нельзя поднять подпись над пустым содержимым: вложение остаётся допустимым, но флаг не должен «залипнуть».
  const blank = await create({
    clientId: client(831), content: '', attachments: [{ id: await createPending({ ownerId: 'a', conversationId: 'dm', name: 'blank.png', contentType: 'image/png', bytes: Buffer.from('image') }) }],
    captionAbove: true, whenOnline: true,
  });
  assert.equal(blank.statusCode, 201, blank.body);
  assert.equal(blank.json().items[0].captionAbove, undefined);
});

test('старый такт d45764c2 не может зафиксировать текст без припаркованного файла', async () => {
  // В d45764c2 sendRowTx передавал attachments:[] и удалял schedule в той же транзакции; deferred FK обязан откатить такую потерю.
  installStorage();
  const file = await upload('legacy-tick.bin');
  const queued = await create({ clientId: client(828), content: 'legacy body', attachments: [{ id: file.id }], whenOnline: true });
  assert.equal(queued.statusCode, 201, queued.body);
  const scheduledId = queued.json().items[0].id as string;
  const { loadAccess, sendMessage } = await import('../src/conversations.js');
  const { conversationScheduled } = await import('../src/db/schema.js');
  await assert.rejects(
    t.db.transaction(async (tx) => {
      const access = await loadAccess('dm', 'a', tx as unknown as Parameters<typeof loadAccess>[2]);
      assert.ok(access, 'отложенная строка принадлежит действующему участнику');
      // Точный legacy-call из старого sendRowTx: schedule содержит вложение, но код старой версии отправлял пустой список.
      const result = await sendMessage('a', access, {
        clientId: client(828), content: 'legacy body', attachments: [], replyToId: null, withheld: false, silent: false,
      }, tx as unknown as NonNullable<Parameters<typeof sendMessage>[3]>);
      assert.equal(result.kind, 'created', 'старый такт успевает вставить текстовое сообщение до проверки FK при COMMIT');
      await tx.delete(conversationScheduled).where(eq(conversationScheduled.id, scheduledId));
    }),
    (error: unknown) => error instanceof Error && /foreign key|scheduled_id/i.test(error.message),
    'отложенная FK миграции должна откатить транзакцию старого такта, который не перевёл файл из scheduled',
  );
  assert.equal((await messageRows()).length, 0, 'частичное текстовое сообщение не переживает откат старого такта');
  assert.equal((await scheduledRows()).length, 1, 'после отката очередь остаётся доступной новому планировщику');
  assert.equal((await t.raw.query<{ state: string; scheduled_id: string }>(
    'SELECT state, scheduled_id FROM attachments WHERE id=$1', [file.id],
  )).rows[0].state, 'scheduled');
});

test('отложенное принимает пустую подпись, но отвергает чужие, чужебеседные, привязанные, повторные и неизвестные id', async () => {
  // Подмена id не должна парковать не принадлежащий автору файл, а безопасный HTTP replay обязан оставаться идемпотентным.
  installStorage();
  const foreignConversation = await upload('foreign-conversation.bin', 'a', 'dm2');
  const foreignOwner = await upload('foreign-owner.bin', 'b');
  const alreadyAttached = await upload('already-attached.bin');
  const sent = await app.inject({ method: 'POST', url: '/conv/dm/messages', headers: authHeader('a'), payload: {
    clientId: client(72), content: '', attachments: [{ id: alreadyAttached.id }],
  } });
  assert.equal(sent.statusCode, 201, sent.body);
  const idempotentFile = await upload('idempotent.bin');
  const body = { clientId: client(73), content: '', attachments: [{ id: idempotentFile.id }], whenOnline: true };
  const first = await create(body);
  const replay = await create(body);
  assert.equal(first.statusCode, 201, first.body);
  assert.equal(replay.statusCode, 200, replay.body);
  const conflict = await create({ ...body, content: 'иной запрос' });
  assert.equal(conflict.statusCode, 409);
  assert.equal(conflict.json().error, 'client_id_conflict');
  const invalidBodies = [
    { clientId: client(74), attachments: [{ id: foreignConversation.id }], whenOnline: true },
    { clientId: client(75), attachments: [{ id: foreignOwner.id }], whenOnline: true },
    { clientId: client(76), attachments: [{ id: alreadyAttached.id }], whenOnline: true },
    { clientId: client(77), attachments: [{ id: idempotentFile.id }, { id: idempotentFile.id }], whenOnline: true },
    { clientId: client(78), attachments: [{ id: '00000000-0000-4000-8000-999999999999' }], whenOnline: true },
  ];
  for (const payload of invalidBodies) {
    const result = await create(payload);
    assert.equal(result.statusCode, 400, `негодная ссылка должна отклониться до вставки: ${result.body}`);
  }
  assert.equal((await scheduledRows()).length, 1, 'ошибочные файлы не создали дополнительные отложенные');
});

test('границы 20 файловых отложенных и 1 ГиБ проверяются до парковки', async () => {
  // Файлы остаются в бакете до отправки, поэтому оба лимита должны включать ровно разрешённую грань и исключать следующий шаг.
  installStorage();
  for (let i = 0; i < 19; i++) {
    const file = await upload(`limit-${i}.bin`);
    const created = await create({ clientId: client(800 + i), content: '', attachments: [{ id: file.id }], whenOnline: true });
    assert.equal(created.statusCode, 201, `файловое отложенное ${i + 1}: ${created.body}`);
  }
  const twentieth = await upload('limit-20.bin');
  assert.equal((await create({ clientId: client(819), content: '', attachments: [{ id: twentieth.id }], whenOnline: true })).statusCode, 201);
  const twentyFirst = await upload('limit-21.bin');
  const overCount = await create({ clientId: client(820), content: '', attachments: [{ id: twentyFirst.id }], whenOnline: true });
  assert.equal(overCount.statusCode, 409);
  assert.equal(overCount.json().reason, 'scheduled_media_limit');
  assert.equal(overCount.json().scope, 'conversation');
  assert.equal(overCount.json().max, 20);

  await truncateAll(t.raw); await seed();
  storageFiles.clear();
  const almostGiB = await upload('almost-gib.bin', 'a', 'dm', Buffer.from('x'));
  const parked = await create({ clientId: client(821), content: '', attachments: [{ id: almostGiB.id }], whenOnline: true });
  assert.equal(parked.statusCode, 201, parked.body);
  await t.raw.query('UPDATE attachments SET size=$1 WHERE id=$2', [1024 * 1024 * 1024 - 1, almostGiB.id]);
  const exactGiB = await upload('one-byte.bin', 'a', 'dm', Buffer.from('y'));
  const exact = await create({ clientId: client(822), content: '', attachments: [{ id: exactGiB.id }], whenOnline: true });
  assert.equal(exact.statusCode, 201, exact.body);
  const overGiBFile = await upload('extra-byte.bin', 'a', 'dm', Buffer.from('z'));
  const overGiB = await create({ clientId: client(823), content: '', attachments: [{ id: overGiBFile.id }], whenOnline: true });
  assert.equal(overGiB.statusCode, 409);
  assert.equal(overGiB.json().reason, 'scheduled_media_limit');
  assert.equal(overGiB.json().scope, 'user');
  assert.equal(overGiB.json().maxBytes, 1024 * 1024 * 1024);
});

test('вытеснение сорок первой загрузки и суточная уборка не трогают припаркованный файл', async () => {
  // Отложенные файлы не являются pending: TTL и лимит сирот не должны удалять их, пока живёт их строка.
  installStorage();
  const parked = await upload('parked-survivor.bin');
  const scheduled = await create({ clientId: client(824), content: '', attachments: [{ id: parked.id }], whenOnline: true });
  assert.equal(scheduled.statusCode, 201, scheduled.body);
  await t.raw.query(`INSERT INTO attachments (id,conversation_id,owner_id,storage_key,name,content_type,size,state,created_at)
    SELECT 'pending-old-'||n,'dm','a','dm/pending-old-'||n,'old','application/octet-stream',1,'pending',now() - (41-n)*interval '1 minute'
    FROM generate_series(1,40) n`);
  for (let n = 1; n <= 40; n++) storageFiles.set(`dm/pending-old-${n}`, Buffer.from('x'));
  const next = await upload('41st.bin');
  const pending = await t.raw.query<{ n: number }>("SELECT count(*)::int n FROM attachments WHERE owner_id='a' AND state='pending'");
  assert.equal(pending.rows[0].n, 40);
  assert.equal((await t.raw.query<{ state: string }>("SELECT state FROM attachments WHERE id=$1", [parked.id])).rows[0].state, 'scheduled');
  const { purgeAttachments } = await import('../src/attachments.js');
  await t.raw.query("UPDATE attachments SET created_at=now()-interval '25 hours' WHERE id=$1", [next.id]);
  await purgeAttachments();
  assert.equal((await t.raw.query<{ state: string }>("SELECT state FROM attachments WHERE id=$1", [parked.id])).rows[0].state, 'scheduled');
  assert.equal(storageFiles.has(`dm/${parked.id}`), true);
  assert.equal((await t.raw.query<{ id: string }>("SELECT id FROM attachments WHERE id=$1", [next.id])).rows.length, 0,
    'суточная уборка после вытеснения стирает запись удалённой загрузки');
});

test('удаление отложенного и выход автора очищают припаркованный объект', async () => {
  // Ни удаление, ни потеря автора не должны оставлять вечную ссылку на файл в закрытом бакете.
  installStorage();
  const deletionFile = await upload('delete.bin');
  const deletion = await create({ clientId: client(825), content: '', attachments: [{ id: deletionFile.id }], whenOnline: true });
  const deletionId = deletion.json().items[0].id as string;
  assert.equal((await app.inject({ method: 'DELETE', url: `${route()}/${deletionId}`, headers: authHeader('a') })).statusCode, 200);
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.equal(storageFiles.has(`dm/${deletionFile.id}`), false, 'удаление списка удаляет объект после транзакции');

  const leaveFile = await upload('leave.bin');
  await create({ clientId: client(826), content: '', attachments: [{ id: leaveFile.id }], whenOnline: true });
  await t.raw.exec("UPDATE conversation_members SET left_at=now() WHERE conversation_id='dm' AND user_id='a'");
  const { runScheduledTick } = await import('../src/scheduled.js');
  assert.equal((await runScheduledTick({ now: () => new Date(), isOnline: () => true })).dropped, 1);
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.equal((await t.raw.query<{ id: string }>("SELECT id FROM attachments WHERE id=$1", [leaveFile.id])).rows.length, 0,
    'после выхода автора помеченная запись убирается вместе с объектом');
  assert.equal(storageFiles.has(`dm/${leaveFile.id}`), false, 'вышедший автор теряет и строку, и файл');

  await t.raw.exec("UPDATE conversation_members SET left_at=NULL WHERE conversation_id='dm' AND user_id='a'");
  const missingRowFile = await upload('missing-row.bin');
  const missingRowSchedule = await create({ clientId: client(827), content: '', attachments: [{ id: missingRowFile.id }], whenOnline: true });
  const missingRowId = missingRowSchedule.json().items[0].id as string;
  await t.raw.query('DELETE FROM attachments WHERE id=$1', [missingRowFile.id]);
  const broken = await app.inject({ method: 'POST', url: `${route()}/${missingRowId}/send`, headers: authHeader('a') });
  assert.equal(broken.statusCode, 409);
  assert.equal(broken.json().error, 'scheduled attachments missing');
  assert.equal((await scheduledRows()).length, 1, 'отсутствующая DB-строка оставляет отложенное видимым автору');

});

test('планировщик ждёт заданного времени, затем посылает один раз с временем фактического такта', async () => {
  // Инъекция now проверяет границу без таймера: send_at до такта — нет сообщения, на такте — общая доставка обоим.
  const { runScheduledTick } = await import('../src/scheduled.js');
  const due = new Date(Date.now() - 1_000);
  const created = await create({ clientId: client(4), content: 'будущее', sendAt: due.toISOString() });
  const sid = created.json().items[0].id;
  assert.deepEqual(await runScheduledTick({ now: () => new Date(due.getTime() - 1), isOnline: () => true }), { sent: 0, failed: 0, dropped: 0, retried: 0, busy: 0 });
  assert.equal((await messageRows()).length, 0);
  published.length = 0;
  const sendStarted = Date.now();
  assert.deepEqual(await runScheduledTick({ now: () => new Date(), isOnline: () => false }), { sent: 1, failed: 0, dropped: 0, retried: 0, busy: 0 });
  const sendFinished = Date.now();
  const messages = await messageRows();
  assert.equal(messages.length, 1);
  assert.equal(messages[0].client_id, client(4));
  assert.equal(messages[0].content, 'будущее');
  assert.ok(messages[0].created_at.getTime() >= sendStarted - 1_000 && messages[0].created_at.getTime() <= sendFinished + 1_000,
    'время сообщения берётся из транзакции отправки, не из запланированного срока');
  assert.equal((await scheduledRows()).length, 0);
  assert.ok(eventsFor('a').some((m) => m.t === 'conv.change'), 'такт уведомляет устройства автора о новом сообщении');
  assert.ok(eventsFor('b').some((m) => m.t === 'conv.change'), 'такт доставляет сообщение собеседнику');
  assert.equal(scheduledEvents('b').length, 0);
  const changes = eventsFor('a').filter((m) => m.t === 'conv.change');
  assert.equal(changes.length, 2, 'автору сообщение, затем его список отложенных');
  assert.equal((changes[0].message as { clientId: string }).clientId, client(4));
  assert.equal(Object.hasOwn(changes[0], 'scheduled'), false);
  assert.deepEqual(changes[1].scheduled, []);
  assert.equal(Object.hasOwn(changes[1], 'message'), false);
  const authorJournal = (await t.raw.query<{ pts: number; kind: string }>(`SELECT pts,kind FROM user_changes WHERE user_id='a' ORDER BY pts`)).rows;
  assert.deepEqual(authorJournal.map((r) => r.kind), ['sched', 'msg', 'sched']);
  assert.deepEqual(changes.map((m) => m.pts), authorJournal.slice(1).map((r) => Number(r.pts)));
  assert.equal(eventsFor('b').some((m) => String(m.t).startsWith('dm.') || m.t === 'read.dm'), false,
    'планировщик больше не публикует события старого пути ЛС');
  const oldClientEvents = published.filter((p) => p.channel === 'gw:user:b').map((p) => JSON.parse(p.message))
    .filter((envelope) => !envelope.cap);
  assert.deepEqual(oldClientEvents, [], 'соединение без conv1 не получает отправку планировщика');
  assert.equal((await runScheduledTick({ now: () => new Date(Date.now() + 10_000) })).sent, 0);
  assert.equal((await messageRows()).length, 1);
  assert.equal((await t.raw.query<{ n: number }>(`SELECT count(*)::int n FROM user_changes WHERE kind='sched' AND user_id='a'`)).rows[0].n, 2);
  assert.equal((await t.raw.query<{ n: number }>(`SELECT count(*)::int n FROM user_changes WHERE kind='msg' AND user_id='b'`)).rows[0].n, 1);
  assert.equal(sid.length > 0, true);
});

test('режим «когда в сети» ждёт, принимает online callback и не раскрывает invisible', async () => {
  // Невидимого надо отсекать ещё до callback: иначе доставка обнаружит его присутствие собеседнику.
  const { runScheduledTick } = await import('../src/scheduled.js');
  const hidden = await create({ clientId: client(5), content: 'не сейчас', whenOnline: true });
  assert.equal((await runScheduledTick({ now: () => new Date(), isOnline: () => false })).sent, 0);
  assert.equal((await scheduledRows()).length, 1, 'нет соединения — строка ждёт');
  await t.raw.exec(`UPDATE users SET presence_status='invisible' WHERE id='b'`);
  const connected = new Set(['b']);
  assert.equal((await runScheduledTick({ now: () => new Date(), isOnline: (id) => connected.has(id) })).sent, 0);
  assert.equal((await messageRows()).length, 0);
  await t.raw.exec(`UPDATE users SET presence_status='online' WHERE id='b'`);
  assert.equal((await runScheduledTick({ now: () => new Date(), isOnline: (id) => connected.has(id) })).sent, 1);
  assert.equal((await messageRows())[0].content, 'не сейчас');
  assert.equal(hidden.json().items.length, 1);
});

test('блокировка придерживает отложенное сообщение, silent сохраняется и собеседник не получает события', async () => {
  // Блокировка должна дать обычный withheld без событий собеседнику; silent не должен потеряться при отложенном пути.
  const { runScheduledTick } = await import('../src/scheduled.js');
  const due = new Date(Date.now() - 1_000);
  await create({ clientId: client(6), content: 'тихо', sendAt: due.toISOString(), silent: true });
  await t.raw.exec(`INSERT INTO user_blocks (blocker_id,blocked_id) VALUES ('b','a')`);
  await t.raw.exec(`INSERT INTO push_devices (id,user_id,device_id,endpoint,platform)
    VALUES ('blocked-sched-push','b','phone','https://ntfy.example.test/blocked','android')`);
  assert.equal((await runScheduledTick({ now: () => new Date() })).sent, 1);
  const row = (await messageRows())[0];
  assert.equal(row.silent, true);
  assert.equal(row.withheld, true);
  assert.equal(eventsFor('b').some((m) => m.t === 'conv.change'), false);
  assert.equal(eventsFor('a').some((m) => m.t === 'conv.change'), true);
  for (let i = 0; i < 10; i++) await new Promise<void>((resolve) => setTimeout(resolve, 0));
  assert.equal(posted.length, 0, 'придержанное не раскрывается и через push');
});

test('сбой повторяется с backoff 30 секунд до восьмой попытки и остаётся как failed error', async () => {
  // Инъекция ошибки sendMessage без таймера должна зафиксировать границы retry, не теряя исходную строку.
  const { runScheduledTick } = await import('../src/scheduled.js');
  await create({ clientId: client(7), content: 'повтор', sendAt: sendAt(Date.now() - 1_000) });
  await t.raw.exec(`CREATE FUNCTION fail_scheduled_insert() RETURNS trigger LANGUAGE plpgsql AS $$
    BEGIN IF NEW.content = 'повтор' THEN RAISE EXCEPTION 'временный отказ'; END IF; RETURN NEW; END $$;
    CREATE TRIGGER fail_scheduled_insert BEFORE INSERT ON conversation_messages
      FOR EACH ROW EXECUTE FUNCTION fail_scheduled_insert();`);
  const start = new Date(Date.now() + 5_000);
  try {
    const delays = [30_000, 60_000, 120_000, 240_000, 480_000, 960_000, 1_920_000];
    for (let attempt = 1; attempt <= 7; attempt++) {
      const tick = new Date(start.getTime() + delays.slice(0, attempt - 1).reduce((a, b) => a + b, 0));
      assert.equal((await runScheduledTick({ now: () => tick })).retried, 1);
      const [row] = await scheduledRows();
      assert.equal(row.attempts, attempt);
      assert.equal(row.next_attempt_at!.getTime(), tick.getTime() + delays[attempt - 1]);
      assert.equal(row.failed_at, null);
      assert.equal((await runScheduledTick({ now: () => new Date(row.next_attempt_at!.getTime() - 1) })).retried, 0);
    }
    const last = await scheduledRows();
    const final = new Date(last[0].next_attempt_at!.getTime());
    assert.equal((await runScheduledTick({ now: () => final })).failed, 1);
    const [failed] = await scheduledRows();
    assert.equal(failed.attempts, 8);
    assert.equal(failed.fail_reason, 'error');
    assert.ok(failed.failed_at, 'восьмая ошибка должна оставить запись видимым автору статусом «не отправлено»');
    assert.equal(failed.next_attempt_at, null);
    assert.equal((await messageRows()).length, 0);
    assert.equal(scheduledEvents('a').length > 0, true);
    assert.equal(scheduledEvents('b').length, 0);
  } finally { await t.raw.exec('DROP TRIGGER fail_scheduled_insert ON conversation_messages; DROP FUNCTION fail_scheduled_insert()'); }
});

test('ушедший собеседник помечается peer-gone, а вышедший автор удаляется без сообщения', async () => {
  // Это разные исходы: peer-gone надо показать автору для решения, а без автора отложенное уже не имеет владельца.
  const { runScheduledTick } = await import('../src/scheduled.js');
  await create({ clientId: client(8), content: 'некому', sendAt: sendAt(Date.now() - 1_000) });
  await t.raw.exec(`UPDATE users SET deleted_at=now() WHERE id='b'`);
  assert.equal((await runScheduledTick({ now: () => new Date() })).failed, 1);
  assert.equal((await scheduledRows())[0].fail_reason, 'peer-gone');
  await t.raw.exec(`UPDATE users SET deleted_at=NULL WHERE id='b'`);
  await create({ clientId: client(13), content: 'автор вышел', whenOnline: true });
  await t.raw.exec(`UPDATE conversation_members SET left_at=now() WHERE conversation_id='dm' AND user_id='a'`);
  assert.equal((await runScheduledTick({ now: () => new Date(), isOnline: () => true })).dropped, 1);
  assert.equal((await scheduledRows()).length, 1, 'peer-gone остаётся автору, а строка ушедшего автора удаляется');
  assert.equal((await messageRows()).length, 0);
});

test('удаление аккаунта автора очищает отложенные; sync включает мой список, а журнал sched приватен', async () => {
  // Хранение не ссылается прямо на users, поэтому очистка должна быть явной и не дать осиротевшей строке вечную жизнь.
  installStorage();
  const parked = await upload('account-delete.bin');
  await create({ clientId: client(9), content: '', attachments: [{ id: parked.id }], whenOnline: true });
  const syncA = await app.inject({ method: 'GET', url: '/conv/sync?pts=0', headers: authHeader('a') });
  assert.equal(syncA.statusCode, 200, syncA.body);
  assert.ok(syncA.json().scheduled.some((x: { conversationId: string }) => x.conversationId === 'dm'), 'догонка должна дать автору список его отложенных');
  const syncB = await app.inject({ method: 'GET', url: '/conv/sync?pts=0', headers: authHeader('b') });
  assert.equal(syncB.statusCode, 200);
  assert.equal(syncB.json().scheduled, undefined);
  const { anonymizeAccount } = await import('../src/accountDelete.js');
  await anonymizeAccount('a');
  assert.equal((await scheduledRows()).length, 0);
  assert.equal(storageFiles.has(`dm/${parked.id}`), false, 'после транзакционной очистки аккаунта удаляется припаркованный объект');
  const deleted = (await t.raw.query<{ deleted_at: Date | null; token_generation: number }>(
    "SELECT deleted_at, token_generation FROM users WHERE id='a'",
  )).rows[0];
  assert.ok(deleted.deleted_at, 'настоящая функция удаления помечает аккаунт удалённым');
  assert.equal(deleted.token_generation, 1, 'удаление аккаунта отзывает ранее выданные токены');
  assert.equal((await t.raw.query<{ n: number }>(`SELECT count(*)::int n FROM user_changes WHERE user_id='a' AND kind='sched'`)).rows[0].n, 0,
    'удаление user_sync удаляет и приватный журнал синхронизации');
});

test('повторный такт не дублирует сообщение; batch ограничивает число строк этого такта', async () => {
  // Дедупликация проверяется на настоящей базе, но последовательные транзакции PGlite не моделируют конкурентный SKIP LOCKED.
  const { runScheduledTick } = await import('../src/scheduled.js');
  const due = sendAt(Date.now() - 2_000);
  await create({ clientId: client(10), content: 'первое', sendAt: due });
  await create({ clientId: client(11), content: 'второе', sendAt: due });
  assert.equal((await runScheduledTick({ now: () => new Date(), batch: 1 })).sent, 1);
  assert.equal((await messageRows()).length, 1);
  assert.equal((await runScheduledTick({ now: () => new Date(), batch: 1 })).sent, 1);
  assert.equal((await runScheduledTick({ now: () => new Date() })).sent, 0);
  assert.equal((await messageRows()).length, 2);
  assert.equal(new Set((await messageRows()).map((m) => m.client_id)).size, 2);
});

test('переоткрытый reply на удалённое сообщение отправляется без ссылки-ответа', async () => {
  // Отложенная цитата может исчезнуть за время ожидания; устаревший replyTo не должен ломать саму доставку.
  const { runScheduledTick } = await import('../src/scheduled.js');
  await t.raw.exec(`INSERT INTO conversation_messages (id,conversation_id,author_id,content,sort_key) VALUES ('parent','dm','b','старое',900001)`);
  await create({ clientId: client(12), content: 'ответ', sendAt: sendAt(Date.now() - 1_000), replyToId: 'parent' });
  await t.raw.exec(`UPDATE conversation_messages SET deleted_at=now() WHERE id='parent'`);
  assert.equal((await runScheduledTick({ now: () => new Date() })).sent, 1);
  assert.equal((await messageRows()).find((m) => m.client_id === client(12))?.reply_to_id, null);
});

test('такт отложенного пользуется обычной доставкой push и передаёт тихость только тихому', async () => {
  // Ловит отдельную ветку планировщика, которая доставила бы сообщение без обычного push/silent fan-out.
  const { runScheduledTick } = await import('../src/scheduled.js');
  await t.raw.exec(`INSERT INTO push_devices (id,user_id,device_id,endpoint,platform)
    VALUES ('sched-push','b','phone','https://ntfy.example.test/scheduled','android')`);
  for (const [n, silent] of [true, false].entries()) {
    const res = await create({ clientId: client(500 + n), content: `scheduled-push-${n}`, whenOnline: true, silent });
    assert.equal(res.statusCode, 201, res.body);
  }
  assert.equal((await runScheduledTick({ now: () => new Date(), isOnline: () => true })).sent, 2);
  for (let i = 0; i < 20; i++) await new Promise<void>((resolve) => setTimeout(resolve, 0));
  assert.equal(posted.length, 2);
  const payloads = posted.map((p) => JSON.parse(String(p.init.body)));
  assert.equal(payloads[0].body, 'scheduled-push-0');
  assert.equal(payloads[0].silent, true);
  assert.equal(payloads[1].body, 'scheduled-push-1');
  assert.equal(Object.hasOwn(payloads[1], 'silent'), false);
  assert.equal((await scheduledRows()).length, 0);
});

test('новое время после ошибки снимает failed и попытки, затем send-now отправляет ровно раз', async () => {
  // Ловит навечно застрявшее failed после ручного переноса и повторную отправку после успешного send-now.
  const res = await create({ clientId: client(600), content: 'исправлено', whenOnline: true });
  assert.equal(res.statusCode, 201, res.body);
  const sid = res.json().items[0].id;
  await t.raw.query(`UPDATE conversation_scheduled SET attempts=8,failed_at=now(),fail_reason='error',last_error='old' WHERE id=$1`, [sid]);
  const edit = await app.inject({ method: 'PATCH', url: `${route()}/${sid}`, headers: authHeader('a'), payload: { sendAt: sendAt(Date.now() + 60_000) } });
  assert.equal(edit.statusCode, 200, edit.body);
  const row = (await scheduledRows())[0];
  assert.deepEqual([row.attempts, row.failed_at, row.fail_reason, row.next_attempt_at], [0, null, null, null]);
  const sent = await app.inject({ method: 'POST', url: `${route()}/${sid}/send`, headers: authHeader('a') });
  assert.equal(sent.statusCode, 201, sent.body);
  assert.equal((await app.inject({ method: 'POST', url: `${route()}/${sid}/send`, headers: authHeader('a') })).statusCode, 404);
  assert.equal((await messageRows()).length, 1);
});
