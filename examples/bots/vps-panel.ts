/**
 * Бот-панель VPS на `@gusvoice/bot`: `/panel` — панель с кнопками «Статус / Перезапустить… → служба → Да/Нет»; те же
 * действия текстом: `/status` — аптайм, нагрузка, память, диск; `/restart <служба>` — перезапуск службы из белого списка;
 * `/whoami` — ваш id и id беседы (для OWNER_IDS и notify.sh). Команды с описаниями публикуются в подсказку по «/» при старте.
 *
 * Запуск (Node 22+; на Node 18–21 — MODE=polling):
 *   GUSVOICE_URL=https://voice.example.com GUSVOICE_BOT_TOKEN=gvb_… OWNER_IDS=<ваш id> RESTART_SERVICES=nginx,docker \
 *     npx tsx vps-panel.ts
 *
 * Безопасность: команды выполняются ТОЛЬКО для id из OWNER_IDS (бот находят по нику — без проверки перезагрузить сервер
 * мог бы любой); держите бота приватным («Доступен всем» выкл); токен — только из переменной окружения. Кнопки — то же
 * самое: `callback_data` приходит от клиента человека, поэтому каждое нажатие проверяет `from.id`, а имя службы из
 * `callback_data` — по белому списку ещё раз. Перезапуск — только через подтверждение «Да».
 * Перезапуск служб требует прав: запускайте бота от root или задайте SUDO=1 и правило sudoers на `systemctl restart <служба>`.
 */
import { execFile } from 'node:child_process'; // nosemgrep: gv-no-child-process — пример панели VPS: execFile без оболочки, команда-литерал, служба из белого списка
import { statfs, readFile } from 'node:fs/promises';
import os from 'node:os';
import { Bot, type Context, InlineKeyboard } from '@gusvoice/bot';

const env = (name: string, fallback?: string): string => {
  const v = process.env[name]?.trim() || fallback;
  if (v === undefined) {
    console.error(`Set ${name}`);
    process.exit(1);
  }
  return v;
};
const list = (s: string) => s.split(',').map((x) => x.trim()).filter(Boolean);

const OWNERS = new Set(list(env('OWNER_IDS', '')));
const SERVICES = new Set(list(env('RESTART_SERVICES', '')));
const SUDO = process.env.SUDO === '1';
// Имя службы уходит в `callback_data` (`ry:<служба>`, не больше 64 байт) и в `systemctl` — проверяем при старте.
for (const s of SERVICES) {
  if (!/^[A-Za-z0-9@._-]+$/.test(s) || new TextEncoder().encode(`ry:${s}`).length > 64) {
    console.error(`RESTART_SERVICES: "${s}" — только A-Z a-z 0-9 @ . _ -, не длиннее 61 байта`);
    process.exit(1);
  }
}

const bot = new Bot(env('GUSVOICE_BOT_TOKEN'), { baseUrl: env('GUSVOICE_URL') });

/** Владелец ли пишет; чужим — отказ с их id (чтобы владелец мог себя добавить). */
async function ownerOnly(ctx: Context): Promise<boolean> {
  if (ctx.from && OWNERS.has(ctx.from.id)) return true;
  await ctx.reply(`Нет доступа. Ваш id: ${ctx.from?.id ?? '?'}`);
  return false;
}

const gb = (bytes: number) => `${(bytes / 1024 ** 3).toFixed(1)} ГБ`;

function uptime(sec: number): string {
  const d = Math.floor(sec / 86400);
  const h = Math.floor((sec % 86400) / 3600);
  const m = Math.floor((sec % 3600) / 60);
  return `${d ? `${d} д ` : ''}${h} ч ${m} мин`;
}

/** Доступная память: на Linux — MemAvailable (кеш можно отдать), иначе `os.freemem()`. */
async function availableMem(): Promise<number> {
  try {
    const m = /^MemAvailable:\s+(\d+) kB/m.exec(await readFile('/proc/meminfo', 'utf8'));
    if (m) return Number(m[1]) * 1024;
  } catch {
    /* не Linux */
  }
  return os.freemem();
}

async function statusText(): Promise<string> {
  const total = os.totalmem();
  const avail = await availableMem();
  const disk = await statfs('/');
  const diskTotal = disk.blocks * disk.bsize;
  const diskFree = disk.bavail * disk.bsize;
  const load = os.loadavg().map((x) => x.toFixed(2)).join(' ');
  return [
    `${os.hostname()} — работает ${uptime(os.uptime())}`,
    `Нагрузка: ${load}`,
    `Память: занято ${gb(total - avail)} из ${gb(total)}`,
    `Диск /: свободно ${gb(diskFree)} из ${gb(diskTotal)}`,
  ].join('\n');
}

const allowedService = (s: string | undefined): s is string => !!s && SERVICES.has(s) && /^[A-Za-z0-9@._-]+$/.test(s);

/** Перезапуск службы (уже проверенной по белому списку) — итог строкой. */
function restart(service: string): Promise<string> {
  const [cmd, args] = SUDO ? ['sudo', ['-n', 'systemctl', 'restart', service]] : ['systemctl', ['restart', service]];
  return new Promise((resolve) => {
    execFile(cmd, args, { timeout: 60_000 }, (err, _out, stderr) => {
      resolve(err ? `Не удалось перезапустить ${service}: ${(stderr || err.message).trim().slice(0, 500)}` : `${service} перезапущен`);
    });
  });
}

// ─── Команды (текстом работают и у старых клиентов без кнопок) ──────────────────────────────────────────────────────

const panelKeyboard = () => new InlineKeyboard().text('Статус', 'st').text('Перезапустить…', 'rs');

bot.command(
  ['start', 'panel'],
  async (ctx) => {
    if (!(await ownerOnly(ctx))) return;
    await ctx.reply('Панель сервера', { reply_markup: panelKeyboard() });
  },
  { description: 'Панель с кнопками' },
);

bot.command('help', (ctx) =>
  ctx.reply('Панель сервера.\n/panel — кнопки\n/status — состояние\n/restart <служба> — перезапуск\n/whoami — ваш id и id беседы'),
);

bot.command('whoami', (ctx) => ctx.reply(`Ваш id: ${ctx.from?.id}\nid беседы: ${ctx.chat.id}`), { description: 'Ваш id и id беседы' });

bot.command(
  'status',
  async (ctx) => {
    if (!(await ownerOnly(ctx))) return;
    await ctx.reply(await statusText());
  },
  { description: 'Аптайм, нагрузка, память, диск' },
);

bot.command(
  'restart',
  async (ctx) => {
    if (!(await ownerOnly(ctx))) return;
    const service = ctx.args[0];
    if (!allowedService(service)) {
      await ctx.reply(`Можно перезапустить: ${[...SERVICES].join(', ') || 'ничего (задайте RESTART_SERVICES)'}`);
      return;
    }
    await ctx.typing();
    await ctx.reply(await restart(service));
  },
  { description: 'Перезапустить службу: /restart <служба>' },
);

// ─── Кнопки ──────────────────────────────────────────────────────────────────────────────────────────────────────────

function servicesKeyboard(): InlineKeyboard {
  const kb = new InlineKeyboard();
  [...SERVICES].forEach((s, i) => {
    if (i > 0 && i % 2 === 0) kb.row();
    kb.text(s, `rs:${s}`);
  });
  return kb.row().text('Отмена', 'back');
}

/** Кнопки панели — только владельцам: кнопку видит и нажимает любой, кому бот её прислал. */
async function ownerOnlyButton(ctx: Context<'callback_query'>): Promise<boolean> {
  if (OWNERS.has(ctx.from?.id ?? '')) return true;
  await ctx.answerCallbackQuery({ text: `Нет доступа. Ваш id: ${ctx.from?.id ?? '?'}`, show_alert: true });
  return false;
}

bot.callbackQuery('st', async (ctx) => {
  if (!(await ownerOnlyButton(ctx))) return;
  await ctx.answerCallbackQuery();
  // Без reply_markup кнопки снялись бы (как в Telegram) — передаём их снова.
  await ctx.editMessageText(await statusText(), {
    reply_markup: new InlineKeyboard().text('Обновить', 'st').text('Перезапустить…', 'rs').row().text('Назад', 'back'),
  });
});

bot.callbackQuery('rs', async (ctx) => {
  if (!(await ownerOnlyButton(ctx))) return;
  if (SERVICES.size === 0) {
    await ctx.answerCallbackQuery({ text: 'Список служб пуст: задайте RESTART_SERVICES', show_alert: true });
    return;
  }
  await ctx.editMessageText('Какую службу перезапустить?', { reply_markup: servicesKeyboard() });
});

bot.callbackQuery(/^rs:(.+)$/, async (ctx) => {
  if (!(await ownerOnlyButton(ctx))) return;
  const service = ctx.match?.[1];
  // Имя службы пришло от клиента человека — сверка с белым списком ещё раз, «своей же» кнопке не доверяем.
  if (!allowedService(service)) {
    await ctx.answerCallbackQuery({ text: 'Такой службы нет в списке', show_alert: true });
    return;
  }
  await ctx.editMessageText(`Перезапустить ${service}?`, {
    reply_markup: new InlineKeyboard().text('Да, перезапустить', `ry:${service}`).text('Нет', 'back'),
  });
});

bot.callbackQuery(/^ry:(.+)$/, async (ctx) => {
  if (!(await ownerOnlyButton(ctx))) return;
  const service = ctx.match?.[1];
  if (!allowedService(service)) {
    await ctx.answerCallbackQuery({ text: 'Такой службы нет в списке', show_alert: true });
    return;
  }
  // Ответить сразу (часики гаснут), убрать кнопки (второе «Да» уже не нажмётся), потом — сам перезапуск.
  await ctx.answerCallbackQuery(`Перезапускаю ${service}…`);
  await ctx.editMessageText(`Перезапускаю ${service}…`);
  await ctx.editMessageText(await restart(service), { reply_markup: panelKeyboard() });
});

bot.callbackQuery('back', async (ctx) => {
  if (!(await ownerOnlyButton(ctx))) return;
  await ctx.editMessageText('Панель сервера', { reply_markup: panelKeyboard() });
});

// Кнопка старой панели, которой нет среди обработчиков (бот обновился), — сказать об этом, а не молчать.
bot.on('callback_query', (ctx) => ctx.answerCallbackQuery('Эта кнопка устарела — /panel'));

bot.on('message', (ctx) => ctx.reply('Не понял. /panel — кнопки, /help — список команд'));

bot.catch((err) => console.error('Ошибка обработчика:', err));

for (const sig of ['SIGINT', 'SIGTERM'] as const) process.on(sig, () => void bot.stop());

bot
  .start({
    mode: process.env.MODE === 'polling' ? 'polling' : 'ws',
    onStart: async (me) => {
      console.log(`@${me.username} на связи`);
      // Подсказка по «/» у человека — команды с description.
      await bot.setCommands().catch((e) => console.error('setCommands:', e));
    },
  })
  .catch((err) => {
    // 401 — токен перевыпущен или бот выключен, 403 — боты выключены на инстансе, 409 — у бота задан адрес доставки.
    console.error(err);
    process.exit(1);
  });
