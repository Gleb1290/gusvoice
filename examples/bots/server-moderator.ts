/**
 * Бот-модератор сервера на `@gusvoice/bot` (API 3, боты на серверах): `/ping` — ответ в канал; `/warn @ник причина` —
 * предупреждение с кнопками «Кикнуть» / «Отмена» (только модераторам — по ролям из MOD_ROLE_IDS); новичку — приветствие в
 * канал WELCOME_CHANNEL_ID.
 *
 * Запуск (Node 22+; на Node 18–21 — MODE=polling):
 *   GUSVOICE_URL=https://voice.example.com GUSVOICE_BOT_TOKEN=gvb_… MOD_ROLE_IDS=<id роли>,<id роли> \
 *     WELCOME_CHANNEL_ID=<id канала> npx tsx server-moderator.ts
 *
 * Добавить бота на сервер: «Настройки сервера → Интеграции → Боты → Добавить бота», права — «Видеть канал», «Писать»,
 * «Выгонять участников». «Читать все сообщения» не нужна: бот слушает только команды, упоминания и ответы на свои сообщения.
 *
 * Безопасность: ник может совпасть у местного и у гостя с другого инстанса — права проверяются по `from.id` и ролям
 * (`getChatMember`), а не по нику. Кнопки — то же: `callback_data` приходит от клиента человека, поэтому каждое нажатие
 * снова проверяет роли нажавшего. Сообщения других ботов сервер боту не присылает — петель «бот отвечает боту» нет.
 */
import { Bot, type Context, InlineKeyboard } from '@gusvoice/bot';

const env = (name: string, fallback?: string): string => {
  const v = process.env[name]?.trim() || fallback;
  if (v === undefined) {
    console.error(`Set ${name}`);
    process.exit(1);
  }
  return v;
};
const MOD_ROLE_IDS = new Set(env('MOD_ROLE_IDS', '').split(',').map((x) => x.trim()).filter(Boolean));
const WELCOME_CHANNEL_ID = process.env.WELCOME_CHANNEL_ID?.trim() || '';

const bot = new Bot(env('GUSVOICE_BOT_TOKEN'), { baseUrl: env('GUSVOICE_URL') });

/** Модератор = владелец сервера или участник с ролью из MOD_ROLE_IDS. Проверка — по id, а не по нику. */
async function isModerator(ctx: Context, userId: string | undefined): Promise<boolean> {
  const serverId = ctx.serverId;
  if (!serverId || !userId) return false;
  const m = await ctx.api.getChatMember(serverId, userId).catch(() => null);
  if (!m) return false;
  return m.status === 'creator' || m.role_ids.some((r) => MOD_ROLE_IDS.has(r));
}

bot.command('ping', (ctx) => ctx.reply(ctx.isChannel ? 'pong (канал)' : 'pong'), { description: 'Проверить, что бот жив' });

bot.command(
  'warn',
  async (ctx) => {
    if (!ctx.isChannel) return ctx.reply('Команда работает в каналах сервера');
    if (!(await isModerator(ctx, ctx.from?.id))) return ctx.reply('Только для модераторов');
    const nick = (ctx.args[0] ?? '').replace(/^@/, '');
    const reason = ctx.args.slice(1).join(' ') || 'без причины';
    if (!nick) return ctx.reply('Формат: /warn @ник причина');
    // Ник → id по ростеру (первая страница; на больших серверах — листать `next_offset`).
    const { members } = await ctx.api.getChatMembers(ctx.serverId!, { limit: 200 });
    const target = members.find((m) => m.user.username.toLowerCase() === nick.toLowerCase() && !m.user.instance_domain);
    if (!target) return ctx.reply(`@${nick} не найден на сервере`);
    await ctx.reply(`⚠️ @${target.user.username}, предупреждение: ${reason}`, {
      reply_markup: new InlineKeyboard().text('Кикнуть', `kick:${target.user.id}`).text('Отмена', 'cancel'),
    });
  },
  { description: 'Предупредить участника: /warn @ник причина' },
);

bot.callbackQuery(/^kick:/, async (ctx) => {
  // Нажать может любой, кто видит канал, — права проверяем заново.
  if (!(await isModerator(ctx, ctx.from?.id))) return ctx.answerCallbackQuery({ text: 'Нет доступа', show_alert: true });
  const userId = ctx.callbackData.slice('kick:'.length);
  try {
    await ctx.api.kickChatMember(ctx.serverId!, userId);
    await ctx.editMessageText(`${ctx.message?.text ?? ''}\n— кикнут модератором`);
    await ctx.answerCallbackQuery('Готово');
  } catch (e) {
    await ctx.answerCallbackQuery({ text: `Не вышло: ${(e as Error).message}`, show_alert: true });
  }
});

bot.callbackQuery('cancel', async (ctx) => {
  if (!(await isModerator(ctx, ctx.from?.id))) return ctx.answerCallbackQuery({ text: 'Нет доступа', show_alert: true });
  await ctx.editMessageReplyMarkup();
  await ctx.answerCallbackQuery('Отменено');
});

// Новичок на сервере → приветствие в канал WELCOME_CHANNEL_ID.
bot.on('chat_member', async (ctx) => {
  const u = ctx.payload;
  if (!WELCOME_CHANNEL_ID || u.old_status !== 'left' || u.new_status !== 'member' || u.user.bot) return;
  await ctx.api.sendMessage(WELCOME_CHANNEL_ID, `Добро пожаловать, **${u.user.display_name}**!`);
});

// Бота добавили на сервер — сказать об этом в первый канал, где можно писать.
bot.on('my_chat_member', async (ctx) => {
  const u = ctx.payload;
  if (u.chat.type !== 'server' || u.new_status !== 'member') return;
  const server = await ctx.api.getServer(u.chat.id);
  const first = server.channels.find((c) => c.can_send);
  if (first) await ctx.api.sendMessage(first.id, 'Привет! Я модератор. /warn @ник причина — предупреждение.');
});

bot.catch((err) => console.error('Ошибка обработчика:', err));

for (const sig of ['SIGINT', 'SIGTERM'] as const) process.on(sig, () => void bot.stop());

bot
  .start({
    mode: process.env.MODE === 'polling' ? 'polling' : 'ws',
    onStart: async (me) => {
      console.log(`@${me.username} на связи`);
      // Команды для серверов — область all_group_chats (в ЛС бот этих команд не показывает).
      await bot.api.setMyCommands(
        [
          { command: 'ping', description: 'Проверить, что бот жив' },
          { command: 'warn', description: 'Предупредить участника: /warn @ник причина' },
        ],
        { scope: { type: 'all_group_chats' } },
      );
    },
  })
  .catch((e) => {
    console.error(e);
    process.exit(1);
  });
