/**
 * Заглушка вместо секрета — сервер с ней не стартует (О5, 15.09).
 *
 * В `.env.example` стоят подсказки вида `JWT_SECRET=change-me-with-openssl-rand-hex-32`. Скопировал шаблон и не заменил —
 * и подпись токенов известна любому, кто читал репозиторий: подделка входа под кем угодно, включая супер-админа. С
 * открытым кодом этот шаблон читают все. Проверяются только очевидные заглушки, а не длина: длину боевого секрета мы
 * не знаем и молча ронять работающий сервер не хотим.
 */
export function isPlaceholderSecret(value: string | undefined): boolean {
  // Пустое значение — не заглушка: его отдельно и с понятным текстом ловит `required()` в env.ts.
  return /^change[-_ ]?me/i.test((value ?? '').trim());
}

/** Имя первой переменной с заглушкой или `null`, если все настоящие. */
export function firstPlaceholderSecret(values: Record<string, string | undefined>): string | null {
  for (const [name, value] of Object.entries(values)) if (isPlaceholderSecret(value)) return name;
  return null;
}
