import { broadcastSqlPattern, has, mentionSqlPattern, Permission, type ServerLastMessage, type UnreadSummary } from '@gusvoice/shared';
import { eq, sql } from 'drizzle-orm';
import { myConversationIds, unreadCounts } from './conversations.js';
import { lastAttachmentPreview, stickerAwarePreview, stickerOf } from './convRules.js';
import { db } from './db/index.js';
import { serverMembers, users } from './db/schema.js';
import { instanceLabel } from './federation/instanceLabels.js';
import { getChannelPermissionsForServers, type MemberContext } from './permissions.js';

/**
 * Текстовые каналы, которые СЧИТАЮТСЯ в непрочитанном, — правило `buildBootstrap`: админ сервера (владелец,
 * MANAGE_CHANNELS, MANAGE_SERVER) видит всё, остальные — где есть `VIEW_CHANNEL`. Разойдись правило — значок в списке
 * спорил бы с числом внутри сервера.
 */
function countedChannel(ctx: MemberContext, perm: bigint): boolean {
  const seesEverything =
    ctx.isOwner ||
    has(ctx.serverPermissions, Permission.MANAGE_CHANNELS) ||
    has(ctx.serverPermissions, Permission.MANAGE_SERVER);
  return seesEverything || has(perm, Permission.VIEW_CHANNEL);
}

/** Шаблон упоминания смотрящего — у гостя `@ник@домен` (§5.5), как в `buildBootstrap`. */
async function myMentionPattern(userId: string): Promise<string> {
  const [me] = await db
    .select({ username: users.username, homeInstanceId: users.homeInstanceId, homeUsername: users.homeUsername })
    .from(users)
    .where(eq(users.id, userId))
    .limit(1);
  const meHome =
    me?.homeInstanceId && me.homeUsername ? { username: me.homeUsername, domain: instanceLabel(me.homeInstanceId).domain } : null;
  return mentionSqlPattern(meHome ? null : me?.username, meHome, false);
}

/**
 * Непрочитанное и упоминания по каналам ОДНИМ запросом — то же правило, что `bootstrap.reads`.
 * Упоминание роли (#76): `m.mention_roles` (кого сообщение позвало, решено при отправке) пересекается с моими ролями —
 * `member_roles.role_id` уникален по всему инстансу, поэтому сервер в условии не нужен. Подзапрос без привязки к строке
 * считается один раз на запрос.
 */
async function countUnreadByChannel(userId: string, chanIds: readonly string[]): Promise<{ id: string; unread: number; mentions: number }[]> {
  if (!chanIds.length) return [];
  const mentionRe = await myMentionPattern(userId);
  const broadcastRe = broadcastSqlPattern();
  const res = await db.execute(sql`
    SELECT m.channel_id AS id,
           COUNT(*)::int AS unread,
           (COUNT(*) FILTER (WHERE (m.content ~* ${mentionRe} OR (m.mention_everyone IS DISTINCT FROM false AND m.content ~* ${broadcastRe}) OR m.mention_roles && ARRAY(SELECT mr.role_id FROM member_roles mr WHERE mr.user_id = ${userId}))))::int AS mentions
    FROM messages m
    LEFT JOIN channel_reads r ON r.channel_id = m.channel_id AND r.user_id = ${userId}
    WHERE m.channel_id IN (${sql.join(chanIds.map((i) => sql`${i}`), sql`, `)})
      AND m.author_id <> ${userId}
      AND m.created_at > GREATEST(COALESCE(r.last_read_at, to_timestamp(0)), now() - interval '14 days')
    GROUP BY m.channel_id
  `);
  return res.rows as { id: string; unread: number; mentions: number }[];
}

/** Счётчики и последнее сообщение одного сервера для `GET /servers` (`Server.unread` / `mentions` / `lastMessage`). */
export interface ServerListExtras {
  unread: number;
  mentions: number;
  lastMessage: ServerLastMessage | null;
}

/**
 * Счётчики и последнее сообщение для КАЖДОГО сервера списка (12.10, #218) — вторая строка и число в строке сервера на
 * телефоне сразу после холодного старта, а не только от событий шлюза этой сессии.
 *
 * Без запроса на сервер: права — `getChannelPermissionsForServers` (постоянное число запросов), дальше два агрегата
 * параллельно — непрочитанное по каналам (то же правило, что `bootstrap.reads` / `GET /unread`) и последнее сообщение:
 * по каналу — одна строка по индексу `(channel_id, created_at DESC)` (`LATERAL … LIMIT 1`), из них по серверу —
 * самая свежая (`DISTINCT ON`).
 * 🔴 Последнее сообщение — только из каналов, которые человек видит И может читать (`VIEW_CHANNEL` + `READ_HISTORY`,
 * правило поиска `searchableChannelIds`): превью не должно показывать текст канала, куда он не войдёт. Счётчики — по
 * правилу bootstrap (админ сервера считает и скрытые каналы — он их видит в дереве).
 * Сервера без членства (закрыт держателем, нет в списке) в ответе нет — вызывающий оставляет его DTO без полей.
 */
export async function serverListExtras(userId: string, serverIds: readonly string[]): Promise<Map<string, ServerListExtras>> {
  const out = new Map<string, ServerListExtras>();
  const access = await getChannelPermissionsForServers(userId, serverIds);
  const countedOf = new Map<string, string>();
  const readableOf = new Map<string, string>();
  for (const [sid, { ctx, channels: chans, perms }] of access) {
    out.set(sid, { unread: 0, mentions: 0, lastMessage: null });
    for (const c of chans) {
      if (c.type !== 'text') continue;
      const p = perms.get(c.id) ?? 0n;
      if (countedChannel(ctx, p)) countedOf.set(c.id, sid);
      if (has(p, Permission.VIEW_CHANNEL) && has(p, Permission.READ_HISTORY)) readableOf.set(c.id, sid);
    }
  }
  const readableIds = [...readableOf.keys()];
  const [counts, lastRes] = await Promise.all([
    countUnreadByChannel(userId, [...countedOf.keys()]),
    readableIds.length
      ? db.execute(sql`
          SELECT DISTINCT ON (c.server_id)
                 c.server_id, c.id AS channel_id, c.name AS channel_name,
                 lm.id, lm.author_id, lm.content, lm.attachments, lm.sticker, lm.created_at,
                 u.display_name AS author_name
          FROM channels c
          CROSS JOIN LATERAL (
            SELECT m.id, m.author_id, m.content, m.attachments, m.sticker, m.created_at
            FROM messages m
            WHERE m.channel_id = c.id
            ORDER BY m.created_at DESC
            LIMIT 1
          ) lm
          JOIN users u ON u.id = lm.author_id
          WHERE c.id IN (${sql.join(readableIds.map((i) => sql`${i}`), sql`, `)})
          ORDER BY c.server_id, lm.created_at DESC
        `)
      : Promise.resolve({ rows: [] as unknown[] }),
  ]);
  for (const row of counts) {
    const e = out.get(countedOf.get(row.id) ?? '');
    if (!e) continue;
    e.unread += row.unread;
    e.mentions += row.mentions;
  }
  for (const r of lastRes.rows as {
    server_id: string;
    channel_id: string;
    channel_name: string;
    id: string;
    author_id: string;
    content: string;
    attachments: unknown;
    sticker: unknown;
    created_at: Date | string;
    author_name: string;
  }[]) {
    const e = out.get(r.server_id);
    if (!e) continue;
    const list = Array.isArray(r.attachments) ? r.attachments : [];
    const kind = lastAttachmentPreview(list);
    const sticker = !list.length && stickerOf(r.sticker) ? ({ attachmentKind: 'sticker' } as const) : {};
    e.lastMessage = {
      id: r.id,
      channelId: r.channel_id,
      channelName: r.channel_name,
      authorId: r.author_id,
      authorName: r.author_name,
      text: stickerAwarePreview(r.content ?? '', r.sticker).text,
      attachments: list.length,
      ...(kind ?? {}),
      ...sticker,
      createdAt: new Date(r.created_at).toISOString(),
    };
  }
  return out;
}

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
    // Права — одним проходом на весь список (`getChannelPermissionsForServers`, 12.10): раньше по два-три запроса на сервер.
    const access = await getChannelPermissionsForServers(userId, serverIds);
    // Канал → сервер: SQL считает по каналам, а значок в рейле стоит у сервера.
    const serverOf = new Map<string, string>();
    for (const [sid, { ctx, channels: chans, perms }] of access) {
      for (const c of chans) {
        if (c.type === 'text' && countedChannel(ctx, perms.get(c.id) ?? 0n)) serverOf.set(c.id, sid);
      }
    }
    /**
     * 🔴 Гостя зовут `@ник@домен`, и его `username` в базе — служебная строка (§5.5): шаблон строит `myMentionPattern`,
     * без второго варианта у гостя не считались бы упоминания вовсе.
     */
    for (const row of await countUnreadByChannel(userId, [...serverOf.keys()])) {
      const sid = serverOf.get(row.id);
      if (!sid) continue;
      const cur = out.servers[sid] ?? { unread: 0, mentions: 0 };
      out.servers[sid] = { unread: cur.unread + row.unread, mentions: cur.mentions + row.mentions };
    }
  }

  // Личка: то же правило, что в `GET /dm`, но наружу отдаём только числа — беседы фоновому
  // инстансу не нужны, а их список тянет за собой профили собеседников. С шага 1б — по беседам
  // (`conversations.unreadCounts`): точное «прочитано до», без окна 14 дней.
  const dmCounts = await unreadCounts(userId, await myConversationIds(userId));
  for (const n of dmCounts.values()) {
    if (n <= 0) continue;
    out.dms += 1;
    out.dmUnread += n;
  }

  return out;
}
