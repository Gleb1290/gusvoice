/**
 * Музыкальный бот на `@gusvoice/bot` + `@gusvoice/bot-voice` (API 4, голос): `/play <адрес>`, `/skip`, `/pause`, `/resume`,
 * `/stop`, `/leave`, `/queue`. Бот заходит в голосовой канал, где сидит автор команды.
 *
 * Запуск (Node 22+; на Node 18–21 — MODE=polling; нужен ffmpeg в PATH или FFMPEG_PATH; образ — node:24-bookworm-slim +
 * `apt install ffmpeg`, на Alpine нативный модуль LiveKit не работает):
 *   GUSVOICE_URL=https://voice.example.com GUSVOICE_BOT_TOKEN=gvb_… npx tsx music.ts
 *
 * Добавить бота на сервер: «Настройки сервера → Интеграции → Боты → Добавить бота», права — «Видеть канал», «Писать»
 * (команды и ответы), «Подключаться» и «Говорить» (голос). Владелец инстанса должен разрешить ботам голос.
 *
 * Адреса. `/play` принимает прямые ссылки на аудио (mp3, ogg, потоки радио…): ffmpeg скачивает их НА МАШИНЕ БОТА. Страницы
 * YouTube и т.п. ffmpeg не открывает (нужен отдельный загрузчик). Пример пускает только https и отсекает localhost и
 * адреса-числа, но это не защита от обращений к локальной сети: проверку ссылок, которые приносят люди, пишет автор бота.
 * Авторские права на музыку — на совести владельца бота и сервера.
 *
 * Бот людей не слышит: токен LiveKit выдан без права слушать, это держит сервер. Остался один в канале — сервер сам выводит
 * его через 5 минут: `disconnected({ kicked: true })`, очередь сохранена, вернуться можно командой `/play`.
 */
import { Bot, type Context, type VoiceConnection } from '@gusvoice/bot';

const env = (name: string, fallback?: string): string => {
  const v = process.env[name]?.trim() || fallback;
  if (v === undefined) {
    console.error(`Set ${name}`);
    process.exit(1);
  }
  return v;
};

const bot = new Bot(env('GUSVOICE_BOT_TOKEN'), { baseUrl: env('GUSVOICE_URL') });

/** Подключения по серверам (на сервере бот сидит в одном голосовом канале). */
const connections = new Map<string, VoiceConnection>();
/** В какой текстовый канал писать «играет …» (куда в последний раз пришла команда). */
const textChats = new Map<string, string>();

/** Прямая ссылка https; localhost и IP-адреса отсекаются (грубо!). */
function safeUrl(text: string): string | null {
  try {
    const u = new URL(text);
    if (u.protocol !== 'https:' || u.username || u.password) return null;
    if (u.hostname === 'localhost' || u.hostname.endsWith('.local') || /^[\d.]+$/.test(u.hostname) || u.hostname.includes(':')) return null;
    return u.href;
  } catch {
    return null;
  }
}

/** Голосовой канал сервера, где сейчас сидит автор команды (по срезу presence: `getVoiceChatMembers`). */
async function voiceChannelOf(ctx: Context): Promise<string | null> {
  const serverId = ctx.serverId;
  const userId = ctx.from?.id;
  if (!serverId || !userId) return null;
  const server = await ctx.api.getServer(serverId);
  for (const ch of server.channels.filter((c) => c.type === 'voice')) {
    const members = await ctx.api.getVoiceChatMembers(ch.id).catch(() => []);
    if (members.some((m) => m.user.id === userId)) return ch.id;
  }
  return null;
}

async function connectionFor(ctx: Context): Promise<VoiceConnection | null> {
  const serverId = ctx.serverId!;
  const channelId = await voiceChannelOf(ctx);
  if (!channelId) {
    await ctx.reply('Зайдите в голосовой канал');
    return null;
  }
  let vc = connections.get(serverId);
  if (vc && vc.state !== 'closed' && vc.channelId === channelId) return vc;
  if (vc) {
    await vc.leave();
    connections.delete(serverId);
  }
  vc = await bot.voice.join(channelId, { normalize: true });
  connections.set(serverId, vc);
  const say = (text: string) => {
    const chat = textChats.get(serverId);
    if (chat) void bot.api.sendMessage(chat, text).catch(() => {});
  };
  vc.on('trackStart', (t) => say(`Играет: ${t.title}`));
  vc.on('error', (err, t) => say(`Ошибка воспроизведения${t ? ` «${t.title}»` : ''}: ${err.message}`));
  vc.on('muted', () => say('Меня заглушили на сервере'));
  vc.on('disconnected', ({ kicked }) => {
    // Штатно: отключил модератор или остался один (5 минут). Очередь жива; новый /play зайдёт снова.
    say(kicked ? 'Меня убрали из голосового канала' : 'Связь потеряна');
    if (connections.get(serverId) === vc) connections.delete(serverId);
  });
  return vc;
}

bot.command(
  'play',
  async (ctx) => {
    if (!ctx.serverId) return ctx.reply('Команда работает в каналах сервера');
    const url = safeUrl(ctx.argsText);
    if (!url) return ctx.reply('Формат: /play https://example.com/track.mp3 (прямая https-ссылка на аудио)');
    textChats.set(ctx.serverId, ctx.chat.id);
    const vc = await connectionFor(ctx);
    if (!vc) return;
    const track = vc.play(url);
    if (vc.current !== track) await ctx.reply(`В очереди (${vc.queue.length}): ${track.title}`);
  },
  { description: 'Играть аудио по ссылке' },
);

/** Команда управления уже подключённым ботом. */
function control(name: string, description: string, act: (vc: VoiceConnection, ctx: Context) => unknown): void {
  bot.command(
    name,
    async (ctx) => {
      const vc = ctx.serverId ? connections.get(ctx.serverId) : undefined;
      if (!vc) return ctx.reply('Я не в голосовом канале. /play <ссылка>');
      return act(vc, ctx);
    },
    { description },
  );
}

control('skip', 'Следующий трек', (vc, ctx) => ctx.reply(vc.skip() ? 'Пропущено' : 'Ничего не играет'));
control('pause', 'Пауза', (vc, ctx) => ctx.reply(vc.pause() ? 'Пауза' : 'Нечего ставить на паузу'));
control('resume', 'Продолжить', (vc, ctx) => ctx.reply(vc.resume() ? 'Играю' : 'Пауза не включена'));
control('stop', 'Остановить и очистить очередь', (vc, ctx) => {
  vc.stop();
  return ctx.reply('Остановлено');
});
control('queue', 'Очередь', (vc, ctx) => {
  const lines = [vc.current ? `Играет: ${vc.current.title}` : 'Ничего не играет', ...vc.queue.map((t, i) => `${i + 1}. ${t.title}`)];
  return ctx.reply(lines.join('\n'));
});
control('leave', 'Выйти из голосового канала', async (vc, ctx) => {
  connections.delete(ctx.serverId!);
  await vc.leave();
  return ctx.reply('Вышел');
});

for (const sig of ['SIGINT', 'SIGTERM'] as const) process.on(sig, () => void bot.stop());

bot
  .start({
    mode: process.env.MODE === 'polling' ? 'polling' : 'ws',
    onStart: async (me) => {
      console.log(`@${me.username} на связи`);
      // Команды для серверов — область all_group_chats (в ЛС бот этих команд не показывает).
      await bot.api.setMyCommands(
        [
          { command: 'play', description: 'Играть аудио по ссылке' },
          { command: 'skip', description: 'Следующий трек' },
          { command: 'pause', description: 'Пауза' },
          { command: 'resume', description: 'Продолжить' },
          { command: 'stop', description: 'Остановить и очистить очередь' },
          { command: 'queue', description: 'Очередь' },
          { command: 'leave', description: 'Выйти из голосового канала' },
        ],
        { scope: { type: 'all_group_chats' } },
      );
    },
  })
  .catch((e) => {
    console.error(e);
    process.exit(1);
  });
