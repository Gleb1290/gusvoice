/**
 * Предпросмотр ссылки-приглашения (#139, F3, план §4.2.1) — обе стороны разговора.
 *
 * 🔴 Клиент человека к чужому инстансу НЕ ходит. Ссылку проверяет его собственный дом: подписанным
 * GET спрашивает хост и пересказывает ответ. Так адрес человека не уходит к соседу до его согласия,
 * а сосед не узнаёт, кто просто посмотрел ссылку и передумал.
 *
 * 🔴 Поэтому же в запросе НЕТ идентификатора человека: «вы уже на этом сервере» дом выясняет по
 * своему индексу членств, получив от хоста `server_id`. Спроси мы хост напрямую — он бы и узнал,
 * кто именно смотрит.
 */

import { and, eq, sql } from 'drizzle-orm';
import {
  FED_ERRORS,
  FED_FEATURES,
  parseInvitePreview,
  parseInviteInput,
  sameOrigin,
  type FedInvitePreview,
  type InvitePreviewView,
} from '@gusvoice/shared';
import { db } from '../db/index.js';
import { env } from '../env.js';
import { federationMemberships, invites, serverFederationExclusions, serverMembers, servers } from '../db/schema.js';
import { federation } from './instance.js';
import { getSignedFromPeer } from './peerClient.js';
import { listLinks } from './links.js';
import { linkDisplayNames, linkVerdict } from './linkRules.js';
import { readInstanceMeta } from './instanceMeta.js';
import { mediaHashOf } from './directoryRules.js';
import { inviteRefusalForGuest } from './guestRules.js';
import { peerContacts } from './peerContacts.js';
import type { HolderContact } from './contacts.js';

// --------------------------------------------------------------------------------------------
// Сторона ХОСТА: что мы рассказываем о своей ссылке связанному соседу.
// --------------------------------------------------------------------------------------------

export type HostPreview = { ok: true; preview: FedInvitePreview } | { ok: false; problem: string };

/**
 * Карточка нашей ссылки для соседа.
 *
 * ⚠️ При отказе наружу уходит ТОЛЬКО код: ни имени сервера, ни его существования. Код приглашения
 * — шесть символов, и предпросмотр доступен всякому, кто его назовёт; рассказывать по нему про
 * закрытый сервер значило бы сделать перебор кодов способом разведать чужой инстанс.
 */
export async function previewForPeer(input: {
  code: string;
  peerInstanceId: string;
  now: number;
}): Promise<HostPreview> {
  const [invite] = await db.select().from(invites).where(eq(invites.code, input.code)).limit(1);
  if (!invite) return { ok: false, problem: FED_ERRORS.inviteInvalid };

  const [server] = await db.select().from(servers).where(eq(servers.id, invite.serverId)).limit(1);
  const [excluded] = server
    ? await db
        .select()
        .from(serverFederationExclusions)
        .where(
          and(
            eq(serverFederationExclusions.serverId, server.id),
            eq(serverFederationExclusions.instanceId, input.peerInstanceId),
          ),
        )
        .limit(1)
    : [];

  const refusal = inviteRefusalForGuest({
    invite,
    server: server ?? null,
    excludedForLink: Boolean(excluded),
    now: input.now,
  });
  if (refusal) return { ok: false, problem: refusal };

  const [count] = await db
    .select({ n: sql<number>`count(*)::int` })
    .from(serverMembers)
    .where(eq(serverMembers.serverId, server!.id));

  return {
    ok: true,
    preview: {
      code: input.code,
      serverId: server!.id,
      serverName: server!.name,
      iconHash: mediaHashOf(server!.iconUrl),
      members: count?.n ?? 0,
      expiresAt: invite.expiresAt?.getTime() ?? null,
    },
  };
}

// --------------------------------------------------------------------------------------------
// Сторона ДОМА: что мы показываем своему человеку.
// --------------------------------------------------------------------------------------------

/**
 * Проверить вставленную ссылку и собрать карточку для окна «Войти по приглашению».
 *
 * Ответ всегда есть — даже отказ это ответ с причиной и, где уместно, контактами того, к кому идти.
 * «Просто не получилось» здесь худший из возможных исходов: человек не поймёт, чинить ему что-то или
 * звать держателя.
 */
export async function previewInvite(input: {
  userId: string;
  raw: string;
  now: number;
}): Promise<InvitePreviewView | null> {
  const parsed = parseInviteInput(input.raw);
  if (!parsed) return null;

  // Контакты едут В КЛИЕНТ как есть: это наш собственный вид, не провод федерации, — поэтому без
  // snake_case-сериализатора протокола.
  const asView = (list: HolderContact[]) => list.map((c) => ({ kind: c.kind, label: c.label, value: c.value }));
  const ownContacts = async () => asView((await readInstanceMeta()).contacts);
  const empty: InvitePreviewView = {
    scope: 'peer',
    code: parsed.code,
    instance: null,
    server: null,
    problem: null,
    alreadyMember: false,
    contacts: [],
  };

  // Свой инстанс: короткий код или наш собственный адрес. Дальше — обычный путь клиента, федерация
  // тут ни при чём.
  if (!parsed.origin || sameOrigin(parsed.origin, env.clientOrigin)) {
    return { ...empty, scope: 'local' };
  }

  const links = await listLinks();
  const link = links.find((l) => sameOrigin(l.clientOrigin, parsed.origin!));
  if (!link) {
    // 🔴 Звать надо СВОЕГО держателя: связку заводит он, а не человек и не чужой инстанс.
    return { ...empty, problem: FED_ERRORS.noLink, contacts: await ownContacts() };
  }

  const meta = await readInstanceMeta();
  // Имя — с защитой от одноимённых (F-11): человек проверяет ссылку, и сосед, назвавшийся как мы, не
  // должен выглядеть «нашим» инстансом (мегаприёмка 23.09 — здесь стояло сырое имя).
  const instance = { instanceId: link.instanceId, name: linkDisplayNames(links, meta.name).get(link.instanceId) ?? null, domain: link.domain };
  const refusal = linkVerdict(link, meta.paused);
  if (refusal) return { ...empty, instance, problem: refusal, contacts: await ownContacts() };

  if (!link.features.includes(FED_FEATURES.guests)) {
    return { ...empty, instance, problem: FED_ERRORS.unsupported };
  }

  const self = federation.identity();
  const key = federation.signingKey();
  if (!self || !key) return { ...empty, instance, problem: 'unavailable' };

  let host: string;
  try {
    host = new URL(link.apiBase).host;
  } catch {
    return { ...empty, instance, problem: 'unreachable' };
  }

  const res = await getSignedFromPeer({
    apiBase: link.apiBase,
    path: `/api/fed/v1/invites/${encodeURIComponent(parsed.code)}/preview`,
    query: { instance_id: self.instanceId },
    keyid: key.kid,
    privateKeyDer: key.privateKeyDer,
    allowHosts: new Set([host]),
    now: input.now,
  });
  // Сосед не ответил — это «попробуйте позже», а не «ссылка плохая». Разница важна: во втором
  // случае человек пойдёт просить новую ссылку, хотя с ней всё хорошо.
  if (!res.ok) return { ...empty, instance, problem: 'unreachable' };

  let body: unknown;
  try {
    body = JSON.parse(res.value.body);
  } catch {
    return { ...empty, instance, problem: 'unreachable' };
  }

  if (res.value.status < 200 || res.value.status >= 300) {
    const problem = typeof (body as { error?: unknown })?.error === 'string' ? (body as { error: string }).error : 'unreachable';
    // Сервер закрыт для чужих — единственный случай, когда человеку нужны контакты ЧУЖОГО держателя:
    // решение принял он, и только он может его отменить.
    const contacts = problem === FED_ERRORS.serverClosed ? asView(await peerContacts(link)) : [];
    return { ...empty, instance, problem, contacts };
  }

  const preview = parseInvitePreview(body);
  if (!preview) return { ...empty, instance, problem: 'unreachable' };

  const [member] = await db
    .select()
    .from(federationMemberships)
    .where(
      and(
        eq(federationMemberships.instanceId, link.instanceId),
        eq(federationMemberships.userId, input.userId),
        eq(federationMemberships.serverId, preview.serverId),
      ),
    )
    .limit(1);

  return {
    scope: 'peer',
    code: preview.code,
    instance,
    server: {
      serverId: preview.serverId,
      name: preview.serverName,
      iconHash: preview.iconHash,
      members: preview.members,
      expiresAt: preview.expiresAt,
    },
    problem: null,
    // Состояние `closed_by_host` — это не «уже участник»: войти сейчас нельзя, и предлагать «Открыть»
    // было бы обманом.
    alreadyMember: member?.state === 'active',
    contacts: [],
  };
}
