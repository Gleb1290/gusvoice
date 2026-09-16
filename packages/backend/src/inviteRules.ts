/**
 * Чистые правила приглашений — БЕЗ базы и Fastify.
 *
 * Вынесено из `routes/invites.ts` по просьбе Codex (2026-07-27): правило было заперто внутри роута,
 * а роут на импорте требует env и поднимает Pool. Ошибка тут принимает исчерпанное или просроченное
 * приглашение — то есть впускает на сервер того, кого уже не звали.
 */

export interface InviteState {
  expiresAt: Date | null;
  maxUses: number | null;
  uses: number;
}

/**
 * True if the invite is past its expiry or has hit its use limit.
 *
 * ⚠️ Полуинтервал `<=`: ровно в миллисекунду истечения приглашение уже НЕдействительно. Раньше тут
 * стояло `<`, и та же граница в опросах и статусах считалась через `<=` — расхождение на одну
 * миллисекунду ничего не ломало, но выбор должен быть один на проект (заметил Codex).
 * ⚠️ `uses >= maxUses`, а не `>`: приглашение на 1 использование после первого входа исчерпано.
 */
export function isInviteSpent(i: InviteState, now: number): boolean {
  if (i.expiresAt && i.expiresAt.getTime() <= now) return true;
  if (i.maxUses != null && i.uses >= i.maxUses) return true;
  return false;
}
