/**
 * Контакты держателя соседнего инстанса (#139, §5.1.1) — спрашиваем, когда есть что объяснить.
 *
 * Сами контакты отдаёт маршрут `/fed/v1/host/contacts` (F1); здесь — сторона спрашивающего. Нужны
 * они в двух местах, и оба про одно: человек упёрся в чужое решение и должен знать, к кому идти —
 * «сервер закрыт для других инстансов» (§4.2.1) и «сервер закрыт держателем» (§5.3.1).
 *
 * ⚠️ Короткий кеш обязателен: без него каждая неудачная вставка ссылки дёргала бы соседа лишним
 * запросом, а вставляют их подряд. Контакты меняются раз в годы — минуты жизни хватает с избытком.
 */

import type { HolderContact } from './contacts.js';
import { parseContacts } from './contacts.js';
import { federation } from './instance.js';
import { postSignedToPeer } from './peerClient.js';
import type { StoredLink } from './linkService.js';

const CACHE_TTL_MS = 10 * 60_000;
const cache = new Map<string, { at: number; contacts: HolderContact[] }>();

/** Контакты держателя связки. Пустой список — держатель их не заполнил или сосед не ответил. */
export async function peerContacts(link: StoredLink): Promise<HolderContact[]> {
  const cached = cache.get(link.instanceId);
  if (cached && Date.now() - cached.at < CACHE_TTL_MS) return cached.contacts;

  const self = federation.identity();
  const key = federation.signingKey();
  if (!self || !key) return cached?.contacts ?? [];

  let host: string;
  try {
    host = new URL(link.apiBase).host;
  } catch {
    return [];
  }

  const res = await postSignedToPeer({
    apiBase: link.apiBase,
    path: '/api/fed/v1/host/contacts',
    payload: { instance_id: self.instanceId },
    keyid: key.kid,
    privateKeyDer: key.privateKeyDer,
    allowHosts: new Set([host]),
    now: Date.now(),
  });
  if (!res.ok || res.value.status < 200 || res.value.status >= 300) return cached?.contacts ?? [];

  let body: unknown;
  try {
    body = JSON.parse(res.value.body);
  } catch {
    return cached?.contacts ?? [];
  }
  const contacts = parseContacts((body as { contacts?: unknown } | null)?.contacts);
  cache.set(link.instanceId, { at: Date.now(), contacts });
  return contacts;
}

/** Забыть контакты связки — при разрыве, перепривязке и потере доверия. */
export function forgetPeerContacts(instanceId: string): void {
  cache.delete(instanceId);
}
