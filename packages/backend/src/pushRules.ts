/**
 * Чистые правила push-рассылки — БЕЗ env, базы и сети.
 *
 * Вынесено из `push.ts` по просьбе Codex (2026-07-27): тот модуль на импорте читает env и поднимает
 * Pool. `pushEndpointAllowed` — единственный заслон от SSRF: endpoint приходит С УСТРОЙСТВА, и без
 * проверки бэкенд из домашней сети POST'ил бы по любому адресу, который ему назвали.
 */

/**
 * SSRF guard (P2-5/P3-9): only POST to endpoints on our OWN ntfy gateway. Compare the PARSED origin
 * (scheme+host+port), not a string prefix, and require https. Invalid URL ⇒ rejected.
 *
 * ⚠️ Именно `origin`, а не `startsWith`: `https://ntfy.example.com.evil.com/` начинается с нашей базы,
 * а `https://ntfy.example.com@evil.com/` содержит её как user-info. Оба — чужие хосты.
 * Пустая база (ntfy не настроен) ⇒ не разрешаем ничего.
 */
export function endpointAllowed(endpoint: string, ntfyBase: string): boolean {
  if (!ntfyBase) return false;
  try {
    const ep = new URL(endpoint);
    return ep.protocol === 'https:' && ep.origin === new URL(ntfyBase).origin;
  } catch {
    return false;
  }
}

/**
 * Пуш для устройства БЕЗ ключей шифрования (#213): текст сообщения не отправляем вовсе.
 *
 * Такие устройства — установки до шифрования. Им по-прежнему приходит «кто и где» (заголовок и адрес
 * перехода), но не «что»: ntfy отдаёт тему на чтение без входа, и открытый текст ЛС лежал бы там, пока
 * человек не обновится. Обновится — пришлёт ключи и снова увидит текст в уведомлении.
 */
export function redactPushPayload<P extends { type: 'dm' | 'mention'; body: string }>(p: P): P {
  return { ...p, body: p.type === 'dm' ? 'Новое личное сообщение' : 'Вас упомянули' };
}

/** Trim message content to a short notification preview (or an attachment placeholder). */
export function contentPreview(content: string, attachmentCount: number): string {
  const t = content.trim();
  if (t) return t.length > 140 ? `${t.slice(0, 139)}…` : t;
  return attachmentCount > 0 ? '📎 Вложение' : '';
}
