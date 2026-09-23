/**
 * «Доверие потеряно» БЕЗ присланного отзыва (#139, §5.1.3; аудит 19.09, F-19).
 *
 * Сосед мог потерять ключ, переустановиться или лишиться домена — отзыва в таких случаях никто не
 * шлёт. Его запросы и так отвергались (личность не совпадала), но связка оставалась `active`:
 * событие `trust-broken` не вызывалось нигде, вкладка показывала связку рабочей и «живой», гости
 * соседа не замораживались. Держатель не узнавал о самом тревожном событии связки.
 *
 * Теперь то же, что делает `receiveRevocation`, срабатывает и по факту: визитка получена, а
 * выведенная из ключа личность не равна той, что в связке.
 *
 * ⚠️ Разорванную человеком связку (`blocked`) не трогаем: это его решение, и «доверие потеряно»
 * поверх него только сбило бы с толку.
 */

import { eq } from 'drizzle-orm';
import { db } from '../db/index.js';
import { federationLinks } from '../db/schema.js';
import { nextLinkState, type LinkState } from './linkRules.js';
import { forgetEventWindow } from './eventStream.js';
import { forgetPeerDocument } from './peerAuth.js';
import { freezeGuestsOf } from './guestAccess.js';
import { fedAudit } from './auditLog.js';

/** Перевести связку в «доверие потеряно». `false` — связки нет или переводить нечего. */
export async function markTrustLost(instanceId: string, reason: string): Promise<boolean> {
  const [link] = await db
    .select({ state: federationLinks.state })
    .from(federationLinks)
    .where(eq(federationLinks.instanceId, instanceId))
    .limit(1);
  if (!link) return false;
  const state = link.state as LinkState;
  if (state === 'trust-lost' || state === 'blocked') return false;
  const next = nextLinkState(state, 'trust-broken');
  if (!next) return false;

  await db
    .update(federationLinks)
    .set({ state: next, updatedAt: new Date() })
    .where(eq(federationLinks.instanceId, instanceId));
  forgetEventWindow(instanceId);
  forgetPeerDocument(instanceId);
  // Гости этой связки замораживаются, как и при отзыве: их поручительства подписаны ключом,
  // которого у соседа больше нет (§5.6.2).
  await freezeGuestsOf(instanceId);
  fedAudit('federation.trust_lost', { instanceId, reason, from: state });
  console.warn(`[fed] связка ${instanceId}: доверие потеряно (${reason})`);
  return true;
}
