/**
 * Отзыв ключа инстанса и перепривязка (#139, F1, план §5.1.3).
 *
 * Два разных несчастья, одно лечение:
 *  - **ключ потерян** (файл или пароль пропали, инстанс переустановили без бэкапа) — при следующем
 *    старте создастся новый ключ, а значит новая личность, и соседи перестанут нас узнавать;
 *  - **ключ украли** — тогда мы сами меняем ключ, не дожидаясь беды.
 *
 * 🔴 Разница в том, что при краже мы ещё можем подписать СТАРЫМ ключом, а при потере — нет. Поэтому
 * отзыв, подписанный старым ключом, соседи принимают автоматически: худшее, что сделает вор, подделав
 * отзыв, — заморозит связку, а не захватит её. Потеря же лечится только перепривязкой вручную: там
 * доказать нечем, и решение принимает человек.
 *
 * Здесь чистые правила — ни базы, ни сети, ни файлов.
 */

import { createPublicKey, sign as edSign, verify as edVerify, createPrivateKey } from 'node:crypto';

/** Что подписывается при отзыве. Длины полей — по той же причине, что в `signingKeys.ts`. */
export function revocationPayload(input: {
  oldInstanceId: string;
  newInstanceId: string;
  newRootKey: string;
  revokedAt: number;
}): Buffer {
  const parts = [input.oldInstanceId, input.newInstanceId, input.newRootKey, String(input.revokedAt)];
  return Buffer.from(parts.map((p) => `${p.length}:${p}`).join('|'), 'utf8');
}

export interface RevocationNotice {
  oldInstanceId: string;
  newInstanceId: string;
  /** Новый корневой ключ, base64url DER SPKI — чтобы сосед знал, кого ждать при перепривязке. */
  newRootKey: string;
  revokedAt: number;
  /** Подпись СТАРЫМ корневым ключом: только его владелец мог её поставить. */
  sig: string;
}

/** Подписать отзыв уходящим ключом. */
export function signRevocation(
  oldRootPrivateKeyDer: Uint8Array,
  input: Omit<RevocationNotice, 'sig'>,
): RevocationNotice {
  const key = createPrivateKey({ key: Buffer.from(oldRootPrivateKeyDer), format: 'der', type: 'pkcs8' });
  const sig = edSign(null, revocationPayload(input), key).toString('base64url');
  return { ...input, sig };
}

export type RevocationProblem = 'malformed' | 'wrong-instance' | 'bad-signature' | 'from-future' | 'same-key';

/**
 * Проверить пришедший отзыв.
 *
 * 🔴 Подпись сверяется СТАРЫМ ключом соседа — тем, что записан у нас в связке. Новый ключ в этом
 * сообщении ничего не доказывает: доверять ему нельзя, он здесь только чтобы человек при перепривязке
 * увидел, какой отпечаток ожидать.
 * 🔴 `same-key` — отдельный случай: «отзываю сам себя» не имеет смысла и означает либо ошибку, либо
 * попытку сбить нас с толку.
 */
export function checkRevocation(
  notice: RevocationNotice,
  ctx: { knownInstanceId: string; knownRootKeyDer: Uint8Array; now: number; toleranceMs?: number },
): RevocationProblem | null {
  if (!notice.oldInstanceId || !notice.newInstanceId || !notice.newRootKey || !notice.sig) return 'malformed';
  if (notice.oldInstanceId !== ctx.knownInstanceId) return 'wrong-instance';
  if (notice.newInstanceId === notice.oldInstanceId) return 'same-key';
  // Отзыв «из будущего» дальше допуска — часы разъехались или сообщение подделано.
  if (notice.revokedAt - ctx.now > (ctx.toleranceMs ?? 5 * 60 * 1000)) return 'from-future';
  try {
    const key = createPublicKey({ key: Buffer.from(ctx.knownRootKeyDer), format: 'der', type: 'spki' });
    const ok = edVerify(null, revocationPayload(notice), key, Buffer.from(notice.sig, 'base64url'));
    return ok ? null : 'bad-signature';
  } catch {
    return 'bad-signature';
  }
}

export function serializeRevocation(n: RevocationNotice): Record<string, unknown> {
  return {
    old_instance_id: n.oldInstanceId,
    new_instance_id: n.newInstanceId,
    new_root_key: n.newRootKey,
    revoked_at: n.revokedAt,
    sig: n.sig,
  };
}

export function parseRevocation(raw: unknown): RevocationNotice | null {
  if (!raw || typeof raw !== 'object') return null;
  const r = raw as Record<string, unknown>;
  const str = (v: unknown): string | null => (typeof v === 'string' && v.length > 0 ? v : null);
  const oldInstanceId = str(r.old_instance_id);
  const newInstanceId = str(r.new_instance_id);
  const newRootKey = str(r.new_root_key);
  const sig = str(r.sig);
  const revokedAt = typeof r.revoked_at === 'number' && Number.isFinite(r.revoked_at) ? r.revoked_at : null;
  if (!oldInstanceId || !newInstanceId || !newRootKey || !sig || revokedAt === null) return null;
  return { oldInstanceId, newInstanceId, newRootKey, revokedAt, sig };
}

/**
 * Что перенести на новую личность соседа при перепривязке.
 *
 * ⚠️ Переносится ТОЛЬКО то, что принадлежит связке: как мы его называем, состояние и наше решение о
 * доверии. Номера событий обнуляются — у соседа с новым ключом нумерация начинается заново, и старый
 * счётчик отбрасывал бы его первые события как уже виденные.
 */
export interface RebindPlan {
  fromInstanceId: string;
  toInstanceId: string;
  keepLocalName: boolean;
  resetEventCounters: boolean;
}

export function planRebind(fromInstanceId: string, toInstanceId: string): RebindPlan {
  return { fromInstanceId, toInstanceId, keepLocalName: true, resetEventCounters: true };
}
