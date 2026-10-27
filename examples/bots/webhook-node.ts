/**
 * Бот, который принимает события НА АДРЕС (webhook), а не держит соединение: `@gusvoice/bot` + `node:http`.
 * Подходит, если у бота есть публичный https-адрес (за обратным прокси), и не нужно держать открытый сокет.
 *
 * Запуск:
 *   GUSVOICE_URL=https://voice.example.com GUSVOICE_BOT_TOKEN=gvb_… \
 *   PUBLIC_URL=https://bot.example.com/hook HOOK_SECRET=<16–256 символов A-Z a-z 0-9 _ -> npx tsx webhook-node.ts
 * Слушает 127.0.0.1:8080 (PORT/HOST); наружу его выставляет прокси: `https://bot.example.com/hook` -> `http://127.0.0.1:8080/hook`
 * (nginx: `proxy_pass http://127.0.0.1:8080;`, тело не менять — подпись считается по сырым байтам). `/healthz` — для проверки живости.
 *
 * Как это устроено:
 *  - `setWebhook(url, secret)` при старте включает доставку (после этого `getUpdates` и WebSocket отвечают 409/4009);
 *  - `bot.webhookHandler({ secret })` проверяет `X-GusVoice-Signature` (HMAC-SHA256, окно 5 минут, сравнение за постоянное
 *    время), неверная подпись -> 401, события обрабатываются теми же `bot.command` / `bot.on`, что и в `echo.ts`;
 *  - отвечайте 2xx быстро: долгую работу уводите в фон, иначе сервер повторит доставку;
 *  - `verifyWebhookSignature(secret, заголовок, сырое_тело)` можно звать и самому, если разбираете запрос без `bot.webhookHandler`.
 * Секрет и токен — только из окружения, не в коде.
 */
import http from 'node:http';
import { Bot, toNodeHandler } from '@gusvoice/bot';

const need = (name: string): string => {
  const v = process.env[name]?.trim();
  if (!v) {
    console.error(`Set ${name}`);
    process.exit(1);
  }
  return v;
};

const secret = need('HOOK_SECRET');
const publicUrl = need('PUBLIC_URL');
const hookPath = new URL(publicUrl).pathname;
const bot = new Bot(need('GUSVOICE_BOT_TOKEN'), { baseUrl: need('GUSVOICE_URL') });

bot.command('start', (ctx) => ctx.reply('Привет! Я получаю события на адрес, а не по сокету.'));
bot.on('message', (ctx) => ctx.reply(`echo: ${ctx.text}`));

const onHook = toNodeHandler(bot.webhookHandler({ secret }));
const server = http.createServer((req, res) => {
  const path = (req.url ?? '/').split('?')[0];
  if (path === hookPath) return onHook(req, res);
  if (path === '/healthz') {
    res.statusCode = 200;
    return void res.end('ok');
  }
  res.statusCode = 404;
  res.end('not found');
});

const port = Number(process.env.PORT ?? 8080);
const host = process.env.HOST ?? '127.0.0.1';
server.listen(port, host, () => {
  // Адрес и секрет передаём серверу после того, как сами начали слушать: он проверит адрес сразу.
  bot.api.setWebhook(publicUrl, secret).then(
    () => console.log(`webhook: ${publicUrl} -> http://${host}:${port}${hookPath}`),
    (e) => {
      console.error('setWebhook failed:', e instanceof Error ? e.message : e);
      process.exit(1);
    },
  );
});

const shutdown = () => server.close(() => process.exit(0));
process.once('SIGINT', shutdown);
process.once('SIGTERM', shutdown);
