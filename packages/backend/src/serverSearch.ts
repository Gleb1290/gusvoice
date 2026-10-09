/**
 * Поиск сообщений по ВСЕМ моим серверам (G35, #211, признак `srvsearch1`): вкладка «Серверы» в поиске из списка ЛС.
 *
 * Права читать каналы — те же, что у поиска по одному серверу (`GET /servers/:id/search`): `getServerChannelPermissions`
 * (роли + запреты категории и канала + «закрытое членство» гостя) и `searchableChannelIds` (VIEW_CHANNEL и READ_HISTORY).
 * Своих упрощённых прав здесь нет. Ищутся только серверы ЭТОГО инстанса, где я участник (сервера соседей — нет).
 */
import type { ServerSearchResponse } from '@gusvoice/shared';
import { and, eq, sql, type SQL } from 'drizzle-orm';
import { db } from './db/index.js';
import { serverMembers } from './db/schema.js';
import { getServerChannelPermissions, searchableChannelIds } from './permissions.js';

/** Шаблон ILIKE по подстроке: `%` и `_` в запросе — обычные знаки. */
export function likePattern(q: string): string {
  return `%${q.replace(/[\\%_]/g, (c) => `\\${c}`)}%`;
}

/** Курсор «время|id»: время — текстом из Postgres (микросекунды сохраняются, у JS `Date` их нет). */
const CURSOR_RE = /^[0-9T:. +\-Z]{19,40}\|[A-Za-z0-9_-]{1,64}$/;

export function isSearchCursor(s: string): boolean {
  return CURSOR_RE.test(s);
}

/**
 * Время курсора — ровно как его печатает Postgres (`created_at::text`: `2026-10-08 05:49:11.123456+03`). Ревью 08.10: одна
 * маска знаков пропускала `9999-99-99 99:99:99`, и приведение `::timestamptz` роняло запрос в 500 (с текстом SQL в ответе).
 */
const CURSOR_AT_RE = /^(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2}):(\d{2})(\.\d{1,6})?(?:Z|[+-](\d{2})(?::?(\d{2}))?)$/;

/**
 * Предел смещения пояса, который принимает Postgres (`MAX_TZDISP_HOUR` = 15, минуты < 60; проверено на PGlite/PG 18:
 * `+15:59` проходит, `+16`, `+15:60`, `+99`, `+03:99` — ошибка 22009). Ревью Codex 08.10: без этой проверки такой курсор
 * доходил до `::timestamptz` и ронял поиск в 500.
 */
const TZ_MAX_HOUR = 15;

function cursorTimeOk(at: string): boolean {
  const p = CURSOR_AT_RE.exec(at);
  if (!p) return false;
  const [y, mo, d, h, mi, se] = p.slice(1, 7).map(Number) as [number, number, number, number, number, number];
  const day = new Date(Date.UTC(y, mo - 1, d));
  const dateOk = day.getUTCFullYear() === y && day.getUTCMonth() === mo - 1 && day.getUTCDate() === d;
  const tzh = p[8] === undefined ? 0 : Number(p[8]);
  const tzm = p[9] === undefined ? 0 : Number(p[9]);
  return dateOk && h < 24 && mi < 60 && se < 60 && tzh <= TZ_MAX_HOUR && tzm < 60;
}

export function splitCursor(s: string): { at: string; id: string } | null {
  if (!isSearchCursor(s)) return null;
  const i = s.lastIndexOf('|');
  const at = s.slice(0, i);
  if (!cursorTimeOk(at)) return null;
  return { at, id: s.slice(i + 1) };
}

/** Каналы всех моих серверов, по которым мне можно искать. */
export async function searchableChannelsOfMine(userId: string): Promise<string[]> {
  const mine = await db
    .select({ serverId: serverMembers.serverId })
    .from(serverMembers)
    .where(and(eq(serverMembers.userId, userId), eq(serverMembers.state, 'active')));
  const perms = await Promise.all(mine.map((m) => getServerChannelPermissions(m.serverId, userId)));
  return perms.flatMap((p) => (p ? searchableChannelIds(p) : []));
}

export async function searchAllServers(
  userId: string,
  qy: { q: string; before?: { at: string; id: string }; limit: number },
): Promise<ServerSearchResponse> {
  const chanIds = await searchableChannelsOfMine(userId);
  if (chanIds.length === 0) return { hits: [], next: null };
  const conds: SQL[] = [
    sql`m.channel_id IN (${sql.join(chanIds.map((i) => sql`${i}`), sql`, `)})`,
    sql`m.content ILIKE ${likePattern(qy.q)}`,
  ];
  if (qy.before) conds.push(sql`(m.created_at, m.id) < (${qy.before.at}::timestamptz, ${qy.before.id}::text)`);
  const res = await db.execute(sql`
    SELECT m.id, m.channel_id, left(m.content, 400) AS content, m.created_at::text AS at, m.author_id,
           u.display_name, u.avatar_url, sm.nickname, c.name AS channel_name, c.server_id, s.name AS server_name
    FROM messages m
    JOIN channels c ON c.id = m.channel_id
    JOIN servers s ON s.id = c.server_id
    JOIN users u ON u.id = m.author_id
    LEFT JOIN server_members sm ON sm.server_id = c.server_id AND sm.user_id = m.author_id
    WHERE ${sql.join(conds, sql` AND `)}
    ORDER BY m.created_at DESC, m.id DESC
    LIMIT ${qy.limit + 1}`);
  const rows = res.rows as Record<string, unknown>[];
  const page = rows.slice(0, qy.limit);
  const hits = page.map((r) => ({
    id: String(r.id),
    channelId: String(r.channel_id),
    channelName: String(r.channel_name),
    serverId: String(r.server_id),
    serverName: String(r.server_name),
    authorId: String(r.author_id),
    authorName: String(r.nickname || r.display_name),
    authorAvatarUrl: r.avatar_url ? String(r.avatar_url) : null,
    content: String(r.content ?? ''),
    createdAt: new Date(String(r.at)).toISOString(),
  }));
  const last = page[page.length - 1];
  return { hits, next: rows.length > qy.limit && last ? `${String(last.at)}|${String(last.id)}` : null };
}
