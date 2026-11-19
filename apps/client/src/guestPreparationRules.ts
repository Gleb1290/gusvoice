import { parseInviteInput, type InvitePreviewView } from '@gusvoice/shared';
import type { InstanceServer } from './configRules';

type PeerInvite = InvitePreviewView & {
  instance: NonNullable<InvitePreviewView['instance']>;
  server: NonNullable<InvitePreviewView['server']>;
};

export function canPrepareGuestInvite(raw: string, view: InvitePreviewView | null, now: number): view is PeerInvite {
  const input = parseInviteInput(raw);
  return !!(
    input?.origin && view?.scope === 'peer' && input.code === view.code && !view.problem &&
    view.instance?.instanceId && view.server?.serverId && (view.server.expiresAt === null || view.server.expiresAt > now)
  );
}

/** Срок из JWT используется только для подписи результата проверки у хоста. */
export function guestTokenExpiry(token: string): number | null {
  const parts = token.split('.');
  if (parts.length !== 3) return null;
  try {
    const payload = JSON.parse(atob(parts[1]!.replace(/-/g, '+').replace(/_/g, '/'))) as { exp?: unknown } | null;
    const exp = payload?.exp;
    return typeof exp === 'number' && Number.isSafeInteger(exp * 1000) && exp > 0 && exp <= 8.64e12 ? exp * 1000 : null;
  } catch {
    return null;
  }
}

export function verifiedGuestServer(response: unknown, serverId: string): InstanceServer | null {
  const server = (response as { server?: Partial<InstanceServer> } | null)?.server;
  if (!server || server.id !== serverId || typeof server.name !== 'string') return null;
  return { id: serverId, name: server.name, iconUrl: server.iconUrl };
}

export interface PreparedGuestAccess {
  instanceId: string;
  serverName: string;
  verifiedAt: number;
  expiresAt: number | null;
}
