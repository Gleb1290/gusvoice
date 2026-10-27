import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import { eq } from 'drizzle-orm';
import { Permission, roomForChannel } from '@gusvoice/shared';
import * as schema from '../src/db/schema.js';
import { BotApiError } from '../src/bots/botRules.js';
import { createTestDb, type TestDb } from './harness.js';
import { voiceFixture, participant, plain, VOICE_PERMS, type VoiceEdit } from './botVoice.harness.js';

let db: TestDb;
before(async () => { db = await createTestDb(); });
after(async () => { await db?.close(); const { pool } = await import('../src/db/index.js'); await pool.end(); });
type Fixture = Awaited<ReturnType<typeof voiceFixture>>;
async function run(check: (f: Fixture) => Promise<void>, edit?: VoiceEdit) {
  const f = await voiceFixture(db, edit);
  try { await check(f); } finally { await f.clean(); }
}
const rejected = (work: Promise<unknown>, code: number, description: string, retryAfter?: number) =>
  assert.rejects(work, (error: unknown) => error instanceof BotApiError && error.code === code && error.description === description && error.retryAfter === retryAfter);
const joined = (f: Fixture, ctx: Awaited<ReturnType<Fixture['bot']>>, chat_id = 'voice') => f.voice.voiceJoin(ctx, { chat_id });

test('вход выдаёт полный ответ и передаёт mute/аватар/права LiveKit, до токена поставлены обе отметки', () => run(async f => {
  const ctx = await f.bot();
  f.sets.set('voice:mute:voice', new Set(['bot']));
  const result = await f.voice.voiceJoin(ctx, { chat_id: 'voice', bitrate: 128000 });
  assert.deepEqual(plain(result), { url: 'wss://voice.invalid', token: 'synthetic-voice-token', room: roomForChannel('voice'),
    chat: { id: 'voice', type: 'voice', title: 'голос', server_id: 'server' }, server_muted: true, expires_in: 600,
    audio: { sample_rate: 48000, channels: 2, bitrate: 128000 } });
  assert.equal(f.tokens.length, 1);
  assert.deepEqual(f.tokens[0], { botId: 'bot', name: ctx.user.displayName, room: roomForChannel('voice'), permissions: VOICE_PERMS, avatarUrl: null, serverMuted: true });
  assert.equal(f.sorted.get('bot:vc:pend:bot:bot')?.get('voice'), f.now() + 30_000);
  assert.equal(f.sorted.get('bot:vc:pend:ch:voice')?.get('bot'), f.now() + 30_000);
  assert.equal(f.expires.get('bot:vc:pend:ch:voice'), f.now() + 30_000);
  assert.deepEqual(f.calls.filter(x => x.kind === 'pending' || x.kind === 'token').map(x => x.kind), ['pending', 'pending', 'token']);
  assert.deepEqual(f.rates.filter(x => x.key.startsWith('botvc:')), [{ key: 'botvc:bot', max: 6, windowS: 60 }]);
}));

const refusals: { name: string; setup(f: Fixture): Promise<unknown>; chat: string; code: number; text: string }[] = [
  { name: 'выключатель раньше скрытого канала', setup: f => f.settings({ voice: false }), chat: 'missing', code: 403, text: 'Forbidden: voice is disabled for bots on this server' },
  { name: 'общий выключатель раньше CONNECT', setup: f => f.settings({ enabled: false }), chat: 'voice', code: 403, text: 'Forbidden: voice is disabled for bots on this server' },
  { name: 'несуществующий канал', setup: async () => {}, chat: 'missing', code: 400, text: 'Bad Request: chat not found' },
  { name: 'не видящий канал не узнаёт его тип', setup: f => f.deny('bot', 'channel', Permission.VIEW_CHANNEL), chat: 'channel', code: 400, text: 'Bad Request: chat not found' },
  { name: 'снятый с сервера бот не узнаёт канал', setup: f => f.t.db.delete(schema.serverBots).where(eq(schema.serverBots.botId, 'bot')), chat: 'voice', code: 400, text: 'Bad Request: chat not found' },
  { name: 'сервер вместо канала', setup: async () => {}, chat: 'server', code: 400, text: 'Bad Request: chat is a server; use a channel id' },
  { name: 'текстовый канал раньше CONNECT', setup: f => f.deny('bot', 'channel', Permission.CONNECT | Permission.SPEAK), chat: 'channel', code: 400, text: 'Bad Request: chat is not a voice channel' },
  { name: 'CONNECT раньше SPEAK', setup: f => f.deny('bot', 'voice', Permission.CONNECT | Permission.SPEAK), chat: 'voice', code: 403, text: 'Forbidden: not enough rights to connect to the voice chat' },
  { name: 'SPEAK при сохранённом CONNECT', setup: f => f.deny('bot', 'voice', Permission.SPEAK), chat: 'voice', code: 403, text: 'Forbidden: not enough rights to speak in the voice chat' },
];
for (const c of refusals) test(`отказ входа: ${c.name}, без траты частоты и побочных эффектов`, () => run(async f => {
  const ctx = await f.bot();
  await c.setup(f);
  const rateBefore = f.rates.length;
  f.rateBlocks.set('botvc:bot', 17); // Более поздний отказ намеренно тоже активен.
  await rejected(joined(f, ctx, c.chat), c.code, c.text);
  assert.equal(f.rates.length, rateBefore);
  assert.deepEqual(f.tokens, []); assert.deepEqual(f.removed, []); assert.equal(f.sorted.size, 0);
}));

test('429 с retry_after опережает заполненность; после снятия rate-границы полноценный вход разрешён', () => run(async f => {
  const ctx = await f.bot();
  f.roster('voice', ['one', 'two', 'three'].map(id => participant(id, true)));
  f.rateBlocks.set('botvc:bot', 17);
  await rejected(joined(f, ctx), 429, 'Too Many Requests: retry after 17', 17);
  assert.equal(f.tokens.length, 0);
  f.rateBlocks.delete('botvc:bot');
  await rejected(joined(f, ctx), 400, 'Bad Request: too many bots in the voice chat');
  f.roster('voice', [participant('one', true), participant('two', true), participant('person')]);
  assert.equal((await joined(f, ctx)).audio.bitrate, 64000);
  assert.equal(f.tokens[0].serverMuted, false);
}));

async function pendingChannel(f: Fixture) {
  const bots = await Promise.all(['first', 'second', 'third', 'fourth'].map(id => f.bot(id)));
  for (const b of bots.slice(0, 3)) await joined(f, b);
  // Presence ещё не успел показать первые подключения: лимит держат реальные отметки voiceJoin.
  f.advance(29_999);
  await rejected(joined(f, bots[3]), 400, 'Bad Request: too many bots in the voice chat');
  assert.equal(f.tokens.length, 3, 'R306 pending-channel');
  f.advance(1);
  await joined(f, bots[3]);
  assert.equal(f.tokens.length, 4);
}
test('ровно три входящих бота помещаются, четвёртый ждёт; отметки действуют 29999 мс и исчезают в 30000', () => run(pendingChannel));

test('себя и дубль pending/presence не считаем дважды, человек не занимает ботоместо', () => run(async f => {
  const ctx = await f.bot();
  await joined(f, ctx);
  f.roster('voice', [participant('bot', true), participant('one', true), participant('two', true), participant('person')]);
  await joined(f, ctx);
  assert.equal(f.tokens.length, 2);
  assert.deepEqual(f.removed, []);
}));

async function tenRooms(f: Fixture) {
  const ctx = await f.bot();
  await joined(f, ctx);
  for (let n = 1; n <= 10; n++) { await f.channel(`room-${n}`, `server-${n}`); await f.place('bot', `server-${n}`); }
  for (let n = 1; n <= 9; n++) await joined(f, ctx, `room-${n}`);
  assert.equal(f.tokens.length, 10);
  await rejected(joined(f, ctx, 'room-10'), 400, 'Bad Request: too many active voice chats');
  assert.equal(f.tokens.length, 10, 'R306 pending-rooms');
  await f.channel('same-server');
  f.roster('voice', [participant('bot', true)]); // Присутствие и pending одной комнаты объединяются.
  await joined(f, ctx, 'same-server');
  assert.deepEqual(f.removed, [{ room: roomForChannel('voice'), userId: 'bot' }], 'R306 same-server');
  assert.equal(f.sorted.get('bot:vc:pend:bot:bot')?.has('voice'), false);
  assert.equal(f.sorted.get('bot:vc:pend:bot:bot')?.has('same-server'), true);
  assert.equal(f.calls.filter(x => x.kind === 'remove' || x.kind === 'token').slice(-2)[0].kind, 'remove');
  f.advance(30_000); f.roster('voice', []);
  await joined(f, ctx, 'room-10');
  assert.equal(f.tokens.length, 12);
}
test('десять ещё входящих комнат допустимы, одиннадцатая нет; переход внутри сервера не съедает комнату', () => run(tenRooms));

test('leave конкретного канала повторяется безопасно и чистит pending; leave без chat_id выходит из всех своих комнат', () => run(async f => {
  const ctx = await f.bot();
  await joined(f, ctx);
  assert.equal(await f.voice.voiceLeave(ctx, { chat_id: 'voice' }), true);
  assert.equal(await f.voice.voiceLeave(ctx, { chat_id: 'voice' }), true);
  assert.equal(f.sorted.get('bot:vc:pend:bot:bot')?.size, 0);
  assert.equal(f.sorted.get('bot:vc:pend:ch:voice')?.size, 0);
  await f.channel('another', 'another-server'); await f.place('bot', 'another-server');
  await joined(f, ctx, 'another');
  f.roster('voice', [participant('bot', true), participant('person')]);
  f.removed.length = 0;
  assert.equal(await f.voice.voiceLeave(ctx, {}), true);
  assert.deepEqual(f.removed.map(x => x.room).sort(), [roomForChannel('another'), roomForChannel('voice')].sort());
  assert.ok(f.removed.every(x => x.userId === 'bot'));
  assert.equal(f.sorted.get('bot:vc:pend:bot:bot')?.size, 0);
}));

test('участники из presence содержат человека и бота с флагами; VIEW достаточно при voice:false и без CONNECT/SPEAK', () => run(async f => {
  const ctx = await f.bot();
  await f.settings({ voice: false }); await f.deny('bot', 'voice', Permission.CONNECT | Permission.SPEAK);
  f.roster('voice', [{ ...participant('person'), muted: true, deafened: true }, { ...participant('bot', true), serverMuted: true }, participant('unknown')]);
  const list = plain(await f.voice.voiceMembers(ctx, { chat_id: 'voice' }));
  assert.deepEqual(list.map(x => ({ id: x.user.id, bot: x.is_bot, muted: x.muted, deafened: x.deafened, server_muted: x.server_muted })), [
    { id: 'person', bot: false, muted: true, deafened: true, server_muted: false },
    { id: 'bot', bot: true, muted: false, deafened: false, server_muted: true },
  ]);
  assert.deepEqual(f.rates.at(-1), { key: 'botvcm:bot:server', max: 30, windowS: 60 });
  await f.deny('bot', 'voice', Permission.VIEW_CHANNEL);
  await rejected(f.voice.voiceMembers(ctx, { chat_id: 'voice' }), 400, 'Bad Request: chat not found');
  await rejected(f.voice.voiceMembers(ctx, { chat_id: 'channel' }), 400, 'Bad Request: chat is not a voice channel');
}));

const sweepCases: { name: string; change(f: Fixture): Promise<unknown> }[] = [
  { name: 'CONNECT отнят', change: f => f.deny('bot', 'voice', Permission.CONNECT) },
  { name: 'SPEAK отнят', change: f => f.deny('bot', 'voice', Permission.SPEAK) },
  { name: 'VIEW_CHANNEL отнят', change: f => f.deny('bot', 'voice', Permission.VIEW_CHANNEL) },
  { name: 'бот выключен', change: f => f.t.db.update(schema.bots).set({ disabledAt: new Date() }).where(eq(schema.bots.userId, 'bot')) },
  { name: 'бот удалён', change: f => f.t.db.update(schema.users).set({ deletedAt: new Date() }).where(eq(schema.users.id, 'bot')) },
  { name: 'бот снят с сервера', change: f => f.t.db.delete(schema.serverBots).where(eq(schema.serverBots.botId, 'bot')) },
  { name: 'голос ботов выключен', change: f => f.settings({ voice: false }) },
  { name: 'все боты выключены', change: f => f.settings({ enabled: false }) },
];
for (const c of sweepCases) test(`обход: ${c.name} — отключён только бот, а здоровый до изменения остаётся`, () => run(async f => {
  await f.bot(); f.roster('voice', [participant('bot', true), participant('person')]);
  await f.voice.sweepBotVoice(); assert.deepEqual(f.removed, []);
  await c.change(f); await f.voice.sweepBotVoice();
  assert.deepEqual(f.removed, [{ room: roomForChannel('voice'), userId: 'bot' }], 'R306 sweep-drop');
}));

test('одиночество: 299 секунд сохраняет бота, ровно 300 выкидывает; человек сбрасывает отсчёт', () => run(async f => {
  await f.bot(); await f.bot('second');
  const alone = [participant('bot', true), participant('second', true)];
  f.roster('voice', alone); await f.voice.sweepBotVoice();
  const since = f.get('bot:vc:alone:voice'); assert.equal(since, String(f.now() / 1000));
  f.advance(299_000); await f.voice.sweepBotVoice(); assert.equal(f.removed.length, 0);
  f.roster('voice', [...alone, participant('person')]); await f.voice.sweepBotVoice(); assert.equal(f.get('bot:vc:alone:voice'), null);
  f.roster('voice', alone); await f.voice.sweepBotVoice(); assert.notEqual(f.get('bot:vc:alone:voice'), since);
  f.advance(299_000); await f.voice.sweepBotVoice(); assert.equal(f.removed.length, 0);
  f.advance(1000); await f.voice.sweepBotVoice();
  assert.deepEqual(f.removed.map(x => x.userId).sort(), ['bot', 'second']);
  assert.equal(f.get('bot:vc:alone:voice'), null);
}));

async function lateJoinAfterDisable(f: Fixture) {
  const ctx = await f.bot();
  await joined(f, ctx);
  const result = await f.app.inject({ method: 'PUT', url: '/admin/bots/settings', payload: { voice: false } });
  assert.equal(result.statusCode, 200, result.body);
  // Уже выданный JWT не отзывается. Без presence отключать пока некого — это допустимое окно до обхода.
  assert.equal(f.removed.length, 0);
  f.advance(31_000);
  f.roster('voice', [participant('bot', true), participant('person')]);
  await f.voice.sweepBotVoice();
  assert.deepEqual(f.removed, [{ room: roomForChannel('voice'), userId: 'bot' }], 'R306 late-disabled-sweep');
  await rejected(joined(f, ctx), 403, 'Forbidden: voice is disabled for bots on this server');
  assert.equal(f.tokens.length, 1);
}
test('токен до voice:false: поздно появившегося в presence бота удаляет обход, новый токен не выдаётся', () => run(lateJoinAfterDisable));

async function delivery(f: Fixture) {
  await f.bot('visible'); await f.bot('self'); await f.bot('hidden'); await f.bot('disabled'); await f.bot('deleted');
  await f.deny('hidden', 'voice', Permission.VIEW_CHANNEL);
  await f.t.db.update(schema.bots).set({ disabledAt: new Date() }).where(eq(schema.bots.userId, 'disabled'));
  await f.t.db.update(schema.users).set({ deletedAt: new Date() }).where(eq(schema.users.id, 'deleted'));
  f.roster('voice', [participant('person'), participant('self', true), participant('person#screen')]);
  await f.events.voiceStateChanged('voice');
  const rows = await f.journal();
  assert.equal(rows.length, 4, 'R306 voice-recipients');
  assert.deepEqual(rows.map(r => `${r.botId}:${(r.payload.user as { id: string }).id}:${r.payload.action}`).sort(),
    ['self:person:joined', 'self:self:joined', 'visible:person:joined', 'visible:self:joined']);
  // visible отсутствует в ростере; readAll=false у обоих. Всё равно получают голосовые события.
  assert.ok(rows.every(r => r.type === 'voice_state' && r.payload.date === f.now() / 1000));
  assert.deepEqual(plain(rows[0].payload.chat), { id: 'voice', type: 'voice', title: 'голос', server_id: 'server' });
  const wakes = f.kicks.length;
  await f.events.voiceStateChanged('voice');
  assert.equal((await f.journal()).length, 4); assert.equal(f.kicks.length, wakes);
  f.roster('voice', []); await f.events.voiceStateChanged('voice');
  const leaves = (await f.journal()).slice(4);
  assert.equal(leaves.length, 4); assert.ok(leaves.every(r => r.payload.action === 'left'));
}
test('voice_state только живым видящим ботам, включая себя; readAll и нахождение в голосе не требуются', () => run(delivery));

async function move(f: Fixture) {
  await f.bot(); await f.bot('observer'); await f.channel('target');
  f.roster('voice', [participant('bot', true), participant('person')]);
  await f.events.voiceStateChanged('voice');
  await f.t.db.delete(schema.botUpdates);
  const result = await f.app.inject({ method: 'POST', url: '/channels/voice/voice/bot/move', payload: { toChannelId: 'target' } });
  assert.equal(result.statusCode, 204, result.body);
  let rows = await f.journal();
  assert.equal(rows.length, 1, 'R306 move-event');
  assert.equal(rows[0].botId, 'bot'); assert.equal(rows[0].payload.action, 'left');
  assert.deepEqual(plain(rows[0].payload.move_to), { id: 'target', type: 'voice', title: 'target', server_id: 'server' });
  assert.equal(f.get('bot:vc:moved:bot:voice'), '1');
  assert.deepEqual(f.removed, [{ room: roomForChannel('voice'), userId: 'bot' }]);
  assert.equal(f.calls.some(x => x.kind === 'user' && (x.args[1] as { t?: string })?.t === 'voice.move'), false);
  f.roster('voice', [participant('person')]); await f.events.voiceStateChanged('voice');
  rows = await f.journal();
  assert.equal(rows.filter(r => r.botId === 'bot').length, 1, 'R306 moved-self-once');
  assert.equal(rows.filter(r => r.botId === 'observer' && r.payload.action === 'left').length, 1);
  assert.equal(f.get('bot:vc:moved:bot:voice'), null);
  // Метка одноразовая: следующий самостоятельный выход уже доставляется боту.
  f.roster('voice', [participant('bot', true)]); await f.events.voiceStateChanged('voice');
  f.roster('voice', []); await f.events.voiceStateChanged('voice');
  assert.equal((await f.journal()).filter(r => r.botId === 'bot' && (r.payload.user as { id: string }).id === 'bot' && r.payload.action === 'left').length, 2);
}
test('HTTP перенос пишет move_to только самому боту, presence не дублирует left; наблюдатель получает обычный left', () => run(move));

async function moveRights(f: Fixture) {
  await f.bot(); await f.channel('target'); f.roster('voice', [participant('bot', true)]);
  const request = () => f.app.inject({ method: 'POST', url: '/channels/voice/voice/bot/move', payload: { toChannelId: 'target' } });
  for (const permission of [Permission.CONNECT, Permission.SPEAK]) {
    await f.deny('bot', 'target', permission);
    const res = await request(); assert.equal(res.statusCode, 403, 'R306 move-rights');
    assert.equal(res.json().error, "Forbidden: the bot can't connect to that channel");
    assert.deepEqual(f.removed, []); assert.equal((await f.journal()).length, 0);
  }
  await f.deny('bot', 'target', 0n); assert.equal((await request()).statusCode, 204);
  assert.equal(f.removed.length, 1); assert.equal((await f.journal()).length, 1);
}
test('HTTP перенос без CONNECT/SPEAK бота в цели запрещён 403; восстановленные права разрешают перенос', () => run(moveRights));

async function botActions(f: Fixture) {
  await f.bot();
  f.roster('voice', [participant('owner'), participant('person'), participant('bot', true)]);
  await f.t.db.insert(schema.serverEconomy).values({ serverId: 'server', enabled: true, ratePer5min: 10 });
  await f.t.db.insert(schema.coinBalances).values({ serverId: 'server', userId: 'owner', balance: 10_000 });
  for (const action of ['poke', 'buy']) {
    const payload = action === 'buy' ? { item: 'mega-poke', message: 'Проверка' } : { message: 'Проверка' };
    const bad = await f.app.inject({ method: 'POST', url: `/channels/voice/voice/bot/${action}`, payload });
    assert.equal(bad.statusCode, 400, `R306 bot-${action}`);
    assert.equal(bad.json().error, "Bad Request: bots don't accept this");
    assert.equal((await f.t.db.select().from(schema.coinPurchases)).length, 0);
    const good = await f.app.inject({ method: 'POST', url: `/channels/voice/voice/person/${action}`, payload });
    assert.equal(good.statusCode, action === 'buy' ? 200 : 204, good.body);
    if (action === 'buy') assert.deepEqual(good.json(), { spent: 400, balance: 9600 });
  }
  const purchases = await f.t.db.select().from(schema.coinPurchases);
  assert.equal(purchases.length, 1); assert.equal(purchases[0].targetUserId, 'person');
  assert.ok(f.calls.some(c => c.kind === 'user' && c.args[0] === 'person' && (c.args[1] as { t?: string }).t === 'poke'));
  assert.ok(f.calls.some(c => c.kind === 'channel' && (c.args[2] as { t?: string }).t === 'mega-poke'));
}
test('HTTP poke/buy отклоняют бота 400 без покупки; человеку проходят и покупка реально списывает монеты', () => run(botActions));

async function disable(f: Fixture, patch: Record<string, unknown>) {
  await f.bot(); await f.bot('other'); await f.channel('another', 'another-server');
  f.roster('voice', [participant('bot', true), participant('person')]);
  f.roster('another', [participant('other', true)]);
  const update = (payload: Record<string, unknown>) => f.app.inject({ method: 'PUT', url: '/admin/bots/settings', payload });
  const unchanged = await update({ perUserLimit: 7 }); assert.equal(unchanged.statusCode, 200); assert.deepEqual(f.removed, []);
  const result = await update(patch); assert.equal(result.statusCode, 200, result.body);
  assert.deepEqual(f.removed, [{ room: roomForChannel('voice'), userId: 'bot' }, { room: roomForChannel('another'), userId: 'other' }], 'R306 settings-drop-all');
  assert.equal((await f.store.readBotSettings()).perUserLimit, 7);
  assert.equal((await f.store.readBotSettings()).enabled, patch.enabled === false ? false : true);
  assert.equal((await f.store.readBotSettings()).voice, patch.voice === false ? false : undefined);
  f.removed.length = 0;
  assert.equal((await update(patch)).statusCode, 200); assert.deepEqual(f.removed, []);
  assert.equal((await update({ enabled: true, voice: true })).statusCode, 200); assert.deepEqual(f.removed, []);
}
for (const patch of [{ voice: false }, { enabled: false }]) test(`настройка ${JSON.stringify(patch)} выкидывает всех присутствующих ботов, но не людей; повтор и включение ничего не выкидывают`, () => run(f => disable(f, patch)));

// Сначала тот же сценарий на оригинале; мутант обязан упасть ТОЧНО на нашем утверждении, не на SQL/импорте/IO.
const mutants: { name: string; edit: VoiceEdit; check(f: Fixture): Promise<void>; marker: string }[] = [
  { name: 'pending канала игнорируется', edit: { file: 'bots/botVoice', from: 'for (const id of await livePending(pendCh(ch.id))) if (id !== botId) others.add(id);', to: '/* R306: pending ignored */' }, check: async f => {
    const bots = [];
    for (const id of ['a', 'b', 'c', 'd']) bots.push(await f.bot(id));
    for (const b of bots.slice(0, 3)) await joined(f, b);
    let refused = false; try { await joined(f, bots[3]); } catch (e) { if (!(e instanceof BotApiError)) throw e; refused = e.code === 400; }
    assert.equal(refused, true, 'R306 pending-denied');
  }, marker: 'R306 pending-denied' },
  { name: 'pending комнат игнорируется', edit: { file: 'bots/botVoice', from: 'const out = new Set<string>(await livePending(pendBot(botId)));', to: 'const out = new Set<string>();' }, check: async f => {
    const ctx = await f.bot();
    for (let n = 0; n <= 10; n++) { await f.channel(`r${n}`, `s${n}`); await f.place('bot', `s${n}`); }
    for (let n = 0; n < 10; n++) await joined(f, ctx, `r${n}`);
    let refused = false; try { await joined(f, ctx, 'r10'); } catch (e) { if (!(e instanceof BotApiError)) throw e; refused = e.description === 'Bad Request: too many active voice chats'; }
    assert.equal(refused, true, 'R306 rooms-denied');
  }, marker: 'R306 rooms-denied' },
  { name: 'старую комнату при переходе не закрыли', edit: { file: 'bots/botVoice', from: 'for (const id of sameServer) await removeFromRoom(botId, id);', to: '/* R306: old room retained */' }, check: async f => {
    const ctx = await f.bot(); await joined(f, ctx); await f.channel('target'); await joined(f, ctx, 'target');
    assert.equal(f.removed.length, 1, 'R306 transition-remove');
  }, marker: 'R306 transition-remove' },
  { name: 'обход не удаляет невалидных', edit: { file: 'bots/botVoice', from: 'if (drop) await removeFromRoom(x.userId, channelId);', to: 'if (false) await removeFromRoom(x.userId, channelId);' }, check: async f => {
    await f.bot(); f.roster('voice', [participant('bot', true), participant('person')]); await f.deny('bot', 'voice', Permission.CONNECT); await f.voice.sweepBotVoice();
    assert.equal(f.removed.length, 1, 'R306 sweep-remove');
  }, marker: 'R306 sweep-remove' },
  { name: 'обход игнорирует выключатель голоса', edit: { file: 'bots/botVoice', from: 'const enabled = botVoiceEnabled(await readBotSettings());\n    const botIds', to: 'const enabled = true;\n    const botIds' }, check: lateJoinAfterDisable, marker: 'R306 late-disabled-sweep' },
  { name: 'перенос не проверяет права бота', edit: { file: 'bots/botVoice', from: 'if (!channel || channel.serverId !== from.serverId || botVoiceDecision({ enabled, target, perms })) return false;', to: 'if (!channel || channel.serverId !== from.serverId) return false;' }, check: moveRights, marker: 'R306 move-rights' },
  { name: 'видимость не проверяется при доставке', edit: { file: 'bots/botVoiceEvents', from: 'if (perms && has(perms.permissions, Permission.VIEW_CHANNEL))', to: 'if (perms)' }, check: delivery, marker: 'R306 voice-recipients' },
  { name: 'left перенесённого доставлен второй раз', edit: { file: 'bots/botVoiceEvents', from: 'if (movedSelf && t.botId === c.id) continue;', to: '/* R306 duplicate */' }, check: move, marker: 'R306 moved-self-once' },
  { name: 'выключение не вызывает dropAll', edit: { file: 'routes/bots', from: "await import('../bots/botVoice.js').then((m) => m.dropAllBotsVoice(), () => undefined);", to: '/* R306 no drop */' }, check: f => disable(f, { voice: false }), marker: 'R306 settings-drop-all' },
];
for (const m of mutants) test(`R306 контрфакт: ${m.name}`, async () => {
  await run(m.check);
  await assert.rejects(run(m.check, m.edit), (e: unknown) => e instanceof assert.AssertionError && e.message.includes(m.marker));
});
