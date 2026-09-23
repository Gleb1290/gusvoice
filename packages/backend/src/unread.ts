import { has, mentionSqlPattern, Permission, type UnreadSummary } from '@gusvoice/shared';
import { eq, inArray, or, sql } from 'drizzle-orm';
import { db } from './db/index.js';
import { channels, dmChannels, serverMembers, users } from './db/schema.js';
import { instanceLabel } from './federation/instanceLabels.js';
import { getMemberContext, getServerChannelPermissions } from './permissions.js';

/**
 * Сводка непрочитанного по ВСЕМ серверам человека и по личке (#139, §5.7).
 *
 * **Зачем она есть.** Непрочитанное до сих пор приезжало только внутри `GET /servers/:id` — вместе
 * с деревом каналов, ролями, эмодзи и стикерами. Для ОТКРЫТОГО сервера это правильно: всё равно
 * грузим. Но с одновременными шлюзами клиент держит соединение с инстансом, КУДА СЕЙЧАС НЕ СМОТРИТ,
 * и нужен ему оттуда ровно один десяток чисел — значки в рейле. Тянуть ради них полный bootstrap
 * каждого сервера значит просить у соседа мегабайты на каждом запуске.
 *
 * 🔴 **Правило подсчёта ТО ЖЕ, что в `buildBootstrap`** (окно 14 дней, чужое авторство, общий шаблон
 * упоминания из `shared/mentions.ts`). Разойдись они — значок в рейле спорил бы с числом внутри
 * сервера, и человек не понимал бы, кому верить.
 *
 * ⚠️ Видимость каналов считается как в bootstrap: админ сервера видит всё, остальные — только то, где
 * есть `VIEW_CHANNEL`. Иначе значок обещал бы сообщения в закрытом канале, куда человек не войдёт.
 */
export async function unreadSummary(userId: string): Promise<UnreadSummary> {
  const out: UnreadSummary = { servers: {}, dms: 0, dmUnread: 0 };

  const memberRows = await db
    .select({ serverId: serverMembers.serverId })
    .from(serverMembers)
    .where(eq(serverMembers.userId, userId));
  const serverIds = [...new Set(memberRows.map((r) => r.serverId))];

  if (serverIds.length) {
    const chanRows = await db.select().from(channels).where(inArray(channels.serverId, serverIds));
    // Канал → сервер: SQL считает по каналам, а значок в рейле стоит у сервера.
    const serverOf = new Map<string, string>();
    for (const sid of serverIds) {
      const ctx = await getMemberContext(sid, userId);
      if (!ctx) continue;
      const seesEverything =
        ctx.isOwner ||
        has(ctx.serverPermissions, Permission.MANAGE_CHANNELS) ||
        has(ctx.serverPermissions, Permission.MANAGE_SERVER);
      const perms = seesEverything ? null : await getServerChannelPermissions(sid, userId);
      for (const c of chanRows) {
        if (c.serverId !== sid || c.type !== 'text') continue;
        if (seesEverything || has(perms?.get(c.id) ?? 0n, Permission.VIEW_CHANNEL)) serverOf.set(c.id, sid);
      }
    }

    const chanIds = [...serverOf.keys()];
    if (chanIds.length) {
      /**
       * 🔴 Гостя зовут `@ник@домен`, и его `username` в базе — служебная строка (§5.5). Тот же
       * приём, что в `buildBootstrap`: без второго варианта шаблона у гостя не считались бы
       * упоминания вовсе — то есть красный значок инстанса, где он гость, не загорался бы никогда.
       */
      const [me] = await db
        .select({ username: users.username, homeInstanceId: users.homeInstanceId, homeUsername: users.homeUsername })
        .from(users)
        .where(eq(users.id, userId))
        .limit(1);
      const meHome =
        me?.homeInstanceId && me.homeUsername
          ? { username: me.homeUsername, domain: instanceLabel(me.homeInstanceId).domain }
          : null;
      const mentionRe = mentionSqlPattern(meHome ? null : me?.username, meHome);
      const res = await db.execute(sql`
        SELECT m.channel_id AS id,
               COUNT(*)::int AS unread,
               (COUNT(*) FILTER (WHERE m.content ~* ${mentionRe}))::int AS mentions
        FROM messages m
        LEFT JOIN channel_reads r ON r.channel_id = m.channel_id AND r.user_id = ${userId}
        WHERE m.channel_id IN (${sql.join(chanIds.map((i) => sql`${i}`), sql`, `)})
          AND m.author_id <> ${userId}
          AND m.created_at > GREATEST(COALESCE(r.last_read_at, to_timestamp(0)), now() - interval '14 days')
        GROUP BY m.channel_id
      `);
      for (const row of res.rows as { id: string; unread: number; mentions: number }[]) {
        const sid = serverOf.get(row.id);
        if (!sid) continue;
        const cur = out.servers[sid] ?? { unread: 0, mentions: 0 };
        out.servers[sid] = { unread: cur.unread + row.unread, mentions: cur.mentions + row.mentions };
      }
    }
  }

  // Личка: то же правило, что в `GET /dm`, но наружу отдаём только числа — беседы фоновому
  // инстансу не нужны, а их список тянет за собой профили собеседников.
  const dmRows = await db
    .select({ id: dmChannels.id })
    .from(dmChannels)
    .where(or(eq(dmChannels.userA, userId), eq(dmChannels.userB, userId)));
  if (dmRows.length) {
    const counts = await db.execute(sql`
      SELECT dm.dm_channel_id AS id, COUNT(*)::int AS unread
      FROM dm_messages dm
      LEFT JOIN dm_reads r ON r.dm_channel_id = dm.dm_channel_id AND r.user_id = ${userId}
      WHERE dm.dm_channel_id IN (${sql.join(dmRows.map((r) => sql`${r.id}`), sql`, `)})
        AND dm.author_id <> ${userId}
        AND dm.created_at > GREATEST(COALESCE(r.last_read_at, to_timestamp(0)), now() - interval '14 days')
      GROUP BY dm.dm_channel_id
    `);
    for (const row of counts.rows as { id: string; unread: number }[]) {
      if (row.unread <= 0) continue;
      out.dms += 1;
      out.dmUnread += row.unread;
    }
  }

  return out;
}
