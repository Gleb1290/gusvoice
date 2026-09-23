/**
 * Поиск приглашения под защитой от перебора и ответ «что за сервер» — без базы, Redis и Fastify
 * (вынос для тестов 22.09; проводка — `routes/invites.ts`).
 *
 * Здесь порядок, который и есть защита (аудит 19.09, F-18): заблокированный за перебор код не ищет
 * вовсе; промах считается; найденный код счётчик НЕ обнуляет (ревью #195 п. 3); гостю на закрытый
 * для него сервер — тот же ответ, что на неизвестный код.
 */

import { inviteRefusalForGuest } from './federation/guestRules.js';
import { isInviteSpent } from './inviteRules.js';

/** Текст отказа при блокировке за перебор. */
export function inviteLockMessage(seconds: number): string {
  return `Слишком много неверных кодов. Попробуйте через ${Math.ceil(seconds / 60)} мин.`;
}

export interface InviteLookupDeps<I> {
  /** Сколько секунд ещё действует блокировка за перебор (`inviteGuard.inviteLockRemaining`); `0` — нет. */
  lockRemaining: (userId: string) => Promise<number>;
  /** Засчитать промах; сколько секунд блокировки он включил (`inviteGuard.recordInviteFailure`); `0` — нет. */
  recordFailure: (userId: string, ip: string) => Promise<number>;
  findInvite: (code: string) => Promise<I | null>;
}

export type InviteLookup<I> = { kind: 'locked'; retryS: number } | { kind: 'missing' } | { kind: 'found'; invite: I };

/**
 * Найти приглашение для чтения или вступления. Замок общий у обоих маршрутов: заблокированный за
 * перебор не читает коды так же, как не вступает (F-18 — раньше счётчик стоял только на вступлении).
 *
 * ⚠️ Найденный код промахи НЕ обнуляет: иначе четыре промаха → свой код → ещё четыре, и блокировка
 * не наступала бы никогда (ревью #195 п. 3). Обнуляет только настоящее вступление — это решает маршрут.
 */
export async function lookupInviteGuarded<I>(
  deps: InviteLookupDeps<I>,
  input: { userId: string; ip: string; code: string },
): Promise<InviteLookup<I>> {
  const lockedFor = await deps.lockRemaining(input.userId);
  if (lockedFor > 0) return { kind: 'locked', retryS: lockedFor };
  const invite = await deps.findInvite(input.code);
  if (!invite) {
    const lock = await deps.recordFailure(input.userId, input.ip);
    return lock > 0 ? { kind: 'locked', retryS: lock } : { kind: 'missing' };
  }
  return { kind: 'found', invite };
}

export type PreviewInvite = { serverId: string; expiresAt: Date | null; maxUses: number | null; uses: number };
export type PreviewServer = { id: string; name: string; iconUrl: string | null; federatedAccess: boolean };

export interface InvitePreviewDeps<I extends PreviewInvite> extends InviteLookupDeps<I> {
  findServer: (serverId: string) => Promise<PreviewServer | null>;
  /** Дом человека: `null` — местный, иначе `instance_id` его инстанса (гость). */
  homeOf: (userId: string) => Promise<string | null>;
  /** Сервер закрыт для этой связки (`server_federation_exclusions`). */
  excludedFor: (serverId: string, instanceId: string) => Promise<boolean>;
  now: () => number;
}

export type InvitePreviewResult =
  | { status: 200; body: { code: string; server: { id: string; name: string; iconUrl: string | null } } }
  | { status: 404 | 410 | 429; body: { error: string } };

/** `GET /invites/:code` — какой сервер за кодом. */
export async function invitePreview<I extends PreviewInvite>(
  deps: InvitePreviewDeps<I>,
  input: { userId: string; ip: string; code: string },
): Promise<InvitePreviewResult> {
  const found = await lookupInviteGuarded(deps, input);
  if (found.kind === 'locked') return { status: 429, body: { error: inviteLockMessage(found.retryS) } };
  if (found.kind === 'missing') return { status: 404, body: { error: 'invalid invite' } };
  const invite = found.invite;
  if (isInviteSpent(invite, deps.now())) return { status: 410, body: { error: 'invite expired' } };
  const server = await deps.findServer(invite.serverId);

  /**
   * 🔴 Гостю — тот же отказ, что при вступлении и в предпросмотре для соседа, и в том же виде, что
   * на неизвестный код (F-18): имя и значок сервера, закрытого для федерации или для его связки,
   * ему знать не положено — предпросмотр соседу на такой код отвечает одним кодом отказа.
   */
  const home = await deps.homeOf(input.userId);
  if (home) {
    const refusal = inviteRefusalForGuest({
      invite,
      server,
      excludedForLink: await deps.excludedFor(invite.serverId, home),
      now: deps.now(),
    });
    if (refusal) return { status: 404, body: { error: 'invalid invite' } };
  }
  // Приглашения без сервера не бывает (внешний ключ), но и падать на нём незачем — как неизвестный код.
  if (!server) return { status: 404, body: { error: 'invalid invite' } };
  return { status: 200, body: { code: input.code, server: { id: server.id, name: server.name, iconUrl: server.iconUrl } } };
}
