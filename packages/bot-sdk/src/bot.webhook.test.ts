import assert from 'node:assert/strict';
import { it } from 'node:test';
import { Bot } from './bot.js';
import { SIGNATURE_HEADER } from './webhook.js';
import type { BotUser, Message, Update } from './wire.js';

const secret = 'synthetic-webhook-secret';
const now = 1_800_000_000;
const me: BotUser = { id: 'bot-id', username: 'PanelBot', display_name: 'Панель', bot: true, description: '', about: '', public: true };
const message: Message = { message_id: 'message-id', chat: { id: 'chat-id', type: 'dm' }, from: {
  id: 'user-id', username: 'friend', display_name: 'Друг', bot: false,
}, date: now, text: 'Привет' };
// Runtime URL сохраняет SDK build внутри rootDir, но подпись считает настоящий серверный модуль.
const serverModuleUrl = new URL('../../backend/src/bots/botRules.js', import.meta.url).href;
async function request(body: string, signed = true): Promise<Request> {
  const headers = new Headers();
  if (signed) {
    const server = await import(serverModuleUrl) as { webhookSignature(secret: string, body: string, nowS: number): string };
    headers.set(SIGNATURE_HEADER, server.webhookSignature(secret, body, now));
  }
  return new Request('https://bot.example.invalid/hook', { method: 'POST', headers, body });
}
function setup() {
  const methods: string[] = [];
  const bot = new Bot('synthetic-test-token', {
    baseUrl: 'https://sdk.example.invalid', discover: false, log: false,
    fetch: async input => {
      const url = String(input);
      assert.equal(url, 'https://sdk.example.invalid/api/bot/v1/getMe', 'разрешён только подменный getMe');
      methods.push('getMe');
      return new Response(JSON.stringify({ ok: true, result: me }), { headers: { 'content-type': 'application/json' } });
    },
  });
  return { bot, methods, handler: bot.webhookHandler({ secret, nowS: now }) };
}
const update = (id = 1, text = message.text): Update => ({ update_id: id, message: { ...message, text } });

it('R299 webhookHandler требует непустой секрет при создании', () => {
  const { bot } = setup();
  assert.throws(() => bot.webhookHandler({ secret: '' }), /secret is required/);
});

it('R299 GET возвращает 405 и разрешает POST, не узнавая бота и не вызывая обработчик', async () => {
  const { bot, methods, handler } = setup();
  let calls = 0;
  bot.on('message', () => { calls++; });
  const response = await handler(new Request('https://bot.example.invalid/hook'));
  assert.equal(response.status, 405);
  assert.equal(response.headers.get('allow'), 'POST');
  assert.equal(calls, 0);
  assert.deepEqual(methods, []);
});

it('R299 POST без подписи возвращает 401, подписанный запрос принимается', async () => {
  const { bot, methods, handler } = setup();
  const seen: number[] = [];
  bot.on('message', ctx => { seen.push(ctx.update.update_id); });
  const body = JSON.stringify(update());
  assert.equal((await handler(await request(body, false))).status, 401);
  assert.deepEqual(seen, []);
  assert.deepEqual(methods, []);
  assert.equal((await handler(await request(body))).status, 200);
  assert.deepEqual(seen, [1]);
});

it('R299 битый JSON с верной подписью возвращает 400 до getMe и обработчика', async () => {
  const { bot, methods, handler } = setup();
  let calls = 0;
  bot.on('message', () => { calls++; });
  const response = await handler(await request('{"update_id":'));
  assert.equal(response.status, 400);
  assert.equal(calls, 0);
  assert.deepEqual(methods, []);
});

it('R299 правильная доставка возвращает 200 после завершения обработчика, getMe вызывается один раз', async () => {
  const { bot, methods, handler } = setup();
  const seen: number[] = [];
  let release!: () => void;
  const waiting = new Promise<void>(resolve => { release = resolve; });
  let entered!: () => void;
  const started = new Promise<void>(resolve => { entered = resolve; });
  bot.on('message', async ctx => {
    if (ctx.update.update_id === 1) { entered(); await waiting; }
    seen.push(ctx.update.update_id);
  });
  let finished = false;
  const pending = handler(await request(JSON.stringify(update()))).then(response => { finished = true; return response; });
  try {
    await started;
    assert.equal(finished, false, 'доставка не подтверждается до обработки');
    assert.deepEqual(seen, []);
  } finally { release(); }
  const response = await pending;
  assert.equal(response.status, 200);
  assert.equal(await response.text(), 'ok');
  assert.deepEqual(seen, [1]);
  assert.equal((await handler(await request(JSON.stringify(update(2))))).status, 200);
  assert.deepEqual(seen, [1, 2]);
  assert.deepEqual(methods, ['getMe']);
});

it('R299 первая доставка узнаёт ник бота перед разбором адресованной команды', async () => {
  const { bot, handler } = setup();
  const seen: string[] = [];
  bot.command('status', ctx => { seen.push(`command:${ctx.command}`); });
  bot.on('message', () => { seen.push('message'); });
  assert.equal((await handler(await request(JSON.stringify(update(1, '/status@other'))))).status, 200);
  assert.equal((await handler(await request(JSON.stringify(update(2, '/Status@PanelBot'))))).status, 200);
  assert.deepEqual(seen, ['message', 'command:status']);
});

it('R299 ошибка обработчика попадает в catch, но доставка всё равно подтверждается 200', async () => {
  const { bot, handler } = setup();
  const failure = new Error('synthetic handler failure');
  const errors: Array<{ error: unknown; id: number | undefined }> = [];
  bot.on('message', () => { throw failure; });
  bot.catch((error, ctx) => { errors.push({ error, id: ctx?.update.update_id }); });
  const response = await handler(await request(JSON.stringify(update())));
  assert.equal(response.status, 200);
  assert.deepEqual(errors, [{ error: failure, id: 1 }]);
});

it('R299 даже упавший catch не ломает подтверждение и последующую доставку', async () => {
  const { bot, handler } = setup();
  const seen: number[] = [];
  let caught = 0;
  bot.on('message', ctx => { if (ctx.update.update_id === 1) throw new Error('synthetic failure'); seen.push(ctx.update.update_id); });
  bot.catch(() => { caught++; throw new Error('synthetic catch failure'); });
  assert.equal((await handler(await request(JSON.stringify(update())))).status, 200);
  assert.equal((await handler(await request(JSON.stringify(update(2))))).status, 200);
  assert.equal(caught, 1);
  assert.deepEqual(seen, [2]);
});

it('R303 подписанная пачка проходит по порядку, подтверждение ждёт последнего обработчика', async () => {
  const { bot, methods, handler } = setup();
  const log: string[] = []; let release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  bot.on('message', async ctx => {
    const id = ctx.update.update_id; log.push(`start:${id}`);
    if (id === 2) await gate;
    log.push(`end:${id}`);
  });
  const body = JSON.stringify([update(1), update(2)]); let done = false;
  const pending = handler(await request(body)).then(r => { done = true; return r; });
  try {
    // WebCrypto HMAC работает в пуле потоков: один turn не гарантирует завершение подписи.
    // Ждём наблюдаемый второй handler с потолком, не ранний HTTP-ответ и не произвольный sleep.
    const deadline = Date.now() + 5_000;
    while (!log.includes('start:2') && !done && Date.now() < deadline) {
      await new Promise<void>(resolve => setTimeout(resolve, 5));
    }
    assert.deepEqual(log, ['start:1', 'end:1', 'start:2']); assert.equal(done, false);
  } finally { release(); }
  assert.equal((await pending).status, 200);
  assert.deepEqual(log, ['start:1', 'end:1', 'start:2', 'end:2']); assert.deepEqual(methods, ['getMe']);
});
it('R303 подпись первого элемента не подтверждает всю пачку; подпись всего JSON принимается', async () => {
  const { bot, methods, handler } = setup(); const seen: number[] = [];
  bot.on('message', ctx => { seen.push(ctx.update.update_id); });
  const batch = JSON.stringify([update(1), update(2)]);
  const signedFirst = await request(JSON.stringify(update(1)));
  const invalid = new Request('https://bot.example.invalid/hook', { method: 'POST', headers: signedFirst.headers, body: batch });
  assert.equal((await handler(invalid)).status, 401); assert.deepEqual(seen, []); assert.deepEqual(methods, []);
  assert.equal((await handler(await request(batch))).status, 200); assert.deepEqual(seen, [1, 2]);
});
it('R303 пустая пачка и смешанные новые события не создают фиктивных сообщений', async () => {
  const { bot, handler } = setup(); const seen: string[] = [];
  bot.on('message', () => { seen.push('неожиданное сообщение'); });
  bot.on('message_reaction', ctx => { seen.push(`${ctx.type}:${ctx.from?.id}:${ctx.chat.id}`); });
  bot.on('chat_member', ctx => { seen.push(`${ctx.type}:${ctx.payload.new_status}:${ctx.serverId}`); });
  assert.equal((await handler(await request('[]'))).status, 200); assert.deepEqual(seen, []);
  const updates: Update[] = [{ update_id: 1, message_reaction: { chat: { id: 'channel', type: 'channel', server_id: 'server' },
    message_id: 'message', user: message.from, date: now, old_reaction: [], new_reaction: [{ type: 'emoji', emoji: '👍' }] } },
  { update_id: 2, chat_member: { chat: { id: 'server', type: 'server' }, from: message.from, user: message.from,
    date: now, old_status: 'member', new_status: 'kicked' } }];
  assert.equal((await handler(await request(JSON.stringify(updates)))).status, 200);
  assert.deepEqual(seen, ['message_reaction:user-id:channel', 'chat_member:kicked:server']);
});
