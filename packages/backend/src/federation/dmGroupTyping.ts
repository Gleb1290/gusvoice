/**
 * ЛС между инстансами, Э7 часть 3 (#141, признак связки `dmgroup2`): «печатает» в группах со смешанным составом.
 * Провод тот же `POST /fed/v1/ephemeral` (`kind: typing`, `conversation_id` группы, `user` — кто печатает): новых полей нет.
 *
 * Звезда, как у сообщений группы (дома участников могут быть НЕ связаны между собой):
 * - наш человек печатает в группе ЧУЖОГО хоста → одна запись хосту (`dm3` + `dmgroup1`: старый хост покажет её своим людям);
 * - наш человек печатает в группе, чей хост МЫ → по записи домам остальных участников (`dm3` + `dmgroup2`);
 * - хост получил «печатает» участника с другого дома → показал своим (обычный `relayFedTyping`) и переслал остальным домам,
 *   кроме дома печатающего, с тем же `user` (человек ТРЕТЬЕГО инстанса);
 * - дом участника принимает запись о человеке третьего инстанса ТОЛЬКО от хоста этой группы (`acceptHostedTyping`), а
 *   участие и блокировки проверяет тот же путь, что у местного (`relayTyping`: группа → участник, заблокировавший, показ).
 * Предел частоты — как у 1:1 (`FED_TYPING_RESEND_MS` на беседу+человека+вид); у пересылки хоста чуть мягче, чтобы
 * шаг 3 с с дрожанием сети не пропускал каждую вторую запись. «В сети» в группах не передаётся (в шапке группы его нет).
 * Крючки в `dmEphemeral.ts` (`configureGroupTyping`) и шлюзе (`GatewayFedHooks.groupTyping`) ставит `index.ts`.
 */
import { and, eq, isNull } from 'drizzle-orm';
import {
  FED_EPHEMERAL_PATH,
  FED_FEATURES,
  FED_TYPING_RESEND_MS,
  FED_TYPING_TTL_MS,
  parseTypingAction,
  serializeEphemeralWire,
  type FedFeature,
  type FedTypingWire,
} from '@gusvoice/shared';
import { db } from '../db/index.js';
import { conversationMembers, conversations, federationLinks, users } from '../db/schema.js';
import { relayFedTyping } from '../gateway.js';
import { refreshCapabilities } from './directorySync.js';
import { shadowUserFor } from './guestHost.js';
import { federation } from './instance.js';
import type { StoredLink } from './linkService.js';
import { postSignedToPeer } from './peerClient.js';

/** Опоздавшее «печатает» (часы соседа + сеть) старше этого — уже не показываем (как в `dmEphemeral`). */
const TYPING_LATE_MS = 30_000;
/** Хост пересылает чуть чаще, чем отправитель шлёт: запись с дрожанием не должна отбрасываться как «слишком частая». */
const FORWARD_RESEND_MS = FED_TYPING_RESEND_MS - 500;
const CACHE_MS = 5 * 60_000;

type Answer = { status: number; body: Record<string, unknown> };

// ─── Связки ───────────────────────────────────────────────────────────────────────────────────────────────────────────

const linkCache = new Map<string, { at: number; link: StoredLink | null }>();

/** Рабочая связка с домом `instanceId`, объявившая ВСЕ `features`; иначе `null` (визитка — не чаще раза в час, общий счётчик). */
async function linkWith(instanceId: string, features: readonly FedFeature[]): Promise<StoredLink | null> {
  const key = `${instanceId}:${features.join(',')}`;
  const hit = linkCache.get(key);
  if (hit && Date.now() - hit.at < CACHE_MS) return hit.link;
  const [row] = await db.select().from(federationLinks).where(eq(federationLinks.instanceId, instanceId)).limit(1);
  let link: StoredLink | null = null;
  if (row && row.state === 'active') {
    let known = row.features;
    if (!features.every((f) => known.includes(f))) known = await refreshCapabilities(row, Date.now()).catch(() => row.features);
    if (features.every((f) => known.includes(f))) link = row as unknown as StoredLink;
  }
  if (linkCache.size > 2_000) linkCache.clear();
  linkCache.set(key, { at: Date.now(), link });
  return link;
}

async function post(link: StoredLink, e: FedTypingWire): Promise<void> {
  const key = federation.signingKey();
  const self = federation.identity();
  if (!key || !self) return;
  let host: string;
  try {
    host = new URL(link.apiBase).host;
  } catch {
    return;
  }
  const res = await postSignedToPeer({
    apiBase: link.apiBase,
    path: `/api${FED_EPHEMERAL_PATH}`,
    payload: serializeEphemeralWire(self.instanceId, e),
    keyid: key.kid,
    privateKeyDer: key.privateKeyDer,
    allowHosts: new Set([host]),
    now: Date.now(),
  });
  // Маршрута нет (сосед выключил ЛС, визитка устарела) — забыть связку из кеша, перечитаем через `CACHE_MS`.
  if (res.ok && res.value.status === 404) {
    for (const k of [...linkCache.keys()]) if (k.startsWith(`${link.instanceId}:`)) linkCache.set(k, { at: Date.now(), link: null });
  }
}

// ─── Беседа ───────────────────────────────────────────────────────────────────────────────────────────────────────────

/** Группа: `origin` — id дома-хоста, `null`, если хост — мы. Не группа / нет такой — `null`. */
async function groupInfo(conversationId: string): Promise<{ origin: string | null } | null> {
  const [c] = await db
    .select({ kind: conversations.kind, origin: conversations.originInstanceId })
    .from(conversations)
    .where(eq(conversations.id, conversationId))
    .limit(1);
  return c && c.kind === 'group' ? { origin: c.origin ?? null } : null;
}

/** Действующие участники группы: id и дом (`null` — наш местный). */
async function activeMembers(conversationId: string): Promise<{ userId: string; home: string | null }[]> {
  return db
    .select({ userId: conversationMembers.userId, home: users.homeInstanceId })
    .from(conversationMembers)
    .innerJoin(users, eq(users.id, conversationMembers.userId))
    .where(and(eq(conversationMembers.conversationId, conversationId), isNull(conversationMembers.leftAt)));
}

const sentAt = new Map<string, number>();
function throttled(key: string, gap: number, now: number): boolean {
  if (now - (sentAt.get(key) ?? 0) < gap) return true;
  if (sentAt.size > 20_000) sentAt.clear();
  sentAt.set(key, now);
  return false;
}

// ─── Отправка ─────────────────────────────────────────────────────────────────────────────────────────────────────────

/** Крючок шлюза: наш `senderId` печатает в группе `dmId`. Участникам других инстансов — через хост (или от хоста). */
export function fedGroupTyping(dmId: string, senderId: string, action: string): void {
  void sendGroupTyping(dmId, senderId, action).catch(() => {});
}

async function sendGroupTyping(dmId: string, senderId: string, rawAction: string): Promise<void> {
  const action = parseTypingAction(rawAction);
  const self = federation.identity();
  if (!self) return;
  const info = await groupInfo(dmId);
  if (!info) return;
  const members = await activeMembers(dmId);
  const me = members.find((m) => m.userId === senderId);
  if (!me || me.home) return; // не участник, или не наш человек — от чужого имени не говорим
  // Хост чужой — одна запись ему; хост мы — дома остальных участников (по одной на дом).
  const homes = info.origin !== null ? [info.origin] : [...new Set(members.map((m) => m.home).filter((h): h is string => !!h))];
  if (homes.length === 0) return;
  if (throttled(`${dmId}:${senderId}:${action}`, FED_TYPING_RESEND_MS, Date.now())) return;
  const now = Date.now();
  const wire: FedTypingWire = {
    kind: 'typing',
    conversationId: dmId,
    user: { instanceId: self.instanceId, userId: senderId },
    action,
    until: now + FED_TYPING_TTL_MS,
    stop: false,
  };
  for (const home of homes) {
    const link = await linkWith(home, info.origin !== null ? [FED_FEATURES.dm3, FED_FEATURES.dmgroup1] : [FED_FEATURES.dm3, FED_FEATURES.dmgroup2]);
    if (link) await post(link, wire);
  }
}

/**
 * Хост получил «печатает» участника с дома `from` (после показа своим): переслать остальным домам, кроме дома печатающего.
 * Зовёт `acceptEphemeral` через крючок. Не группа нашего хоста / печатающий не участник — ничего.
 */
export async function forwardGroupTyping(from: StoredLink, e: FedTypingWire, shadowId: string): Promise<void> {
  const info = await groupInfo(e.conversationId);
  if (!info || info.origin !== null) return; // не группа или хост не мы
  const members = await activeMembers(e.conversationId);
  if (!members.some((m) => m.userId === shadowId)) return;
  if (throttled(`fwd:${e.conversationId}:${shadowId}:${e.action}`, FORWARD_RESEND_MS, Date.now())) return;
  const homes = new Set(members.map((m) => m.home).filter((h): h is string => !!h && h !== from.instanceId));
  for (const home of homes) {
    const link = await linkWith(home, [FED_FEATURES.dm3, FED_FEATURES.dmgroup2]);
    if (link) await post(link, e);
  }
}

// ─── Приём ────────────────────────────────────────────────────────────────────────────────────────────────────────────

/**
 * «Печатает» человека ТРЕТЬЕГО инстанса (его дом — не отправитель записи): принимается только от хоста группы, и только о
 * человеке нашей теневой строки. Участие в группе и блокировки проверяет `relayFedTyping` (как у местного «печатает»).
 */
export async function acceptHostedTyping(link: StoredLink, e: FedTypingWire): Promise<Answer> {
  const self = federation.identity();
  // Запись о нашем же человеке (эхо) или о чьём-то, пока мы не знаем группы, — не наше дело.
  if (!self || e.user.instanceId === self.instanceId) return { status: 202, body: { ok: true, ignored: true } };
  const info = await groupInfo(e.conversationId);
  // Говорить за людей третьих домов вправе только хост этой группы.
  if (!info || info.origin !== link.instanceId) return { status: 403, body: { error: 'not-yours' } };
  const shadow = await shadowUserFor(e.user.instanceId, e.user.userId);
  if (!shadow || shadow.deletedAt) return { status: 202, body: { ok: true, ignored: true } };
  if (!e.stop && e.until > Date.now() - TYPING_LATE_MS) await relayFedTyping(shadow.id, e.conversationId, e.action);
  return { status: 202, body: { ok: true } };
}
