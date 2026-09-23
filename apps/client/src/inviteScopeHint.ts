import type { InviteScopeView } from '@gusvoice/shared';

/**
 * Подсказка «где сработает ссылка» (#139, F4, план §4.2, требование 13).
 *
 * 🔴 Правило, которое эта строка обязана донести: **бессрочная ссылка работает только для своих**.
 * Со стороны это выглядит произволом, поэтому подсказка не просто запрещает, а говорит, что делать:
 * «выберите срок». Без неё человек отправляет другу бессрочную ссылку, тот получает отказ, и оба
 * решают, что сломалась федерация.
 *
 * ⚠️ Строка пересчитывается на КАЖДУЮ смену срока: подсказка, не меняющаяся вместе с выбором, хуже
 * отсутствующей — она приучает на себя не смотреть.
 */
export function inviteScopeHint(
  scope: InviteScopeView | null,
  expiresInMinutes: number | null,
  now: number = Date.now(),
): string | null {
  if (!scope) return null;
  const mine = scope.instanceName?.trim() ? `«${scope.instanceName.trim()}»` : 'этого инстанса';

  if (!scope.federated) {
    return `Сработает только для людей с ${mine}: сервер закрыт для других инстансов. Открыть доступ может админ инстанса.`;
  }
  if (expiresInMinutes === null) {
    return `Бессрочная ссылка сработает только для людей с ${mine}. Чтобы позвать человека с другого инстанса, выберите срок.`;
  }
  if (scope.peers.length === 0) {
    return `Сработает только для людей с ${mine} — доверенных инстансов пока нет.`;
  }
  const until = new Date(now + expiresInMinutes * 60_000).toLocaleString('ru-RU', {
    day: 'numeric',
    month: 'short',
    hour: '2-digit',
    minute: '2-digit',
  });
  const peers = scope.peers.map((p) => `«${p}»`).join(', ');
  return `Сработает для людей с ${mine} и с доверенных инстансов: ${peers}. Действует до ${until}.`;
}
