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

/** Trim message content to a short notification preview (or an attachment placeholder). */
export function contentPreview(content: string, attachmentCount: number): string {
  const t = content.trim();
  if (t) return t.length > 140 ? `${t.slice(0, 139)}…` : t;
  return attachmentCount > 0 ? '📎 Вложение' : '';
}
