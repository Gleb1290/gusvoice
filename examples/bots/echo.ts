/**
 * Самый короткий бот на `@gusvoice/bot`: `/start` здоровается, всё остальное — эхо.
 *
 * Запуск (Node 22+; на Node 18–21 — `MODE=polling`):
 *   GUSVOICE_URL=https://voice.example.com GUSVOICE_BOT_TOKEN=gvb_… npx tsx echo.ts
 * Токен — только из окружения. Бот не пишет первым: сначала откройте с ним беседу сами (кнопка «Старт»).
 */
import { Bot } from '@gusvoice/bot';

const bot = new Bot(process.env.GUSVOICE_BOT_TOKEN!, { baseUrl: process.env.GUSVOICE_URL! });

bot.command('start', (ctx) => ctx.reply('Привет! Напишите что-нибудь — повторю.'));
bot.on('message', (ctx) => ctx.reply(`echo: ${ctx.text}`));

process.once('SIGINT', () => void bot.stop());
process.once('SIGTERM', () => void bot.stop());
await bot.start({ mode: process.env.MODE === 'polling' ? 'polling' : 'ws', onStart: (me) => console.log(`@${me.username} на связи`) });
