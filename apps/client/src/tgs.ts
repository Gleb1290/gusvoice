/**
 * `.tgs` — это Lottie-JSON, сжатый gzip (#68).
 *
 * Отдельной библиотеки для распаковки не нужно: `DecompressionStream('gzip')` есть во всех
 * браузерах, которые мы поддерживаем, и в Node — поэтому модуль тестируется без браузера.
 */

/** Первые два байта gzip. Проверяем их, потому что не всякий `.tgs` в природе реально сжат. */
function isGzip(bytes: Uint8Array): boolean {
  return bytes.length > 2 && bytes[0] === 0x1f && bytes[1] === 0x8b;
}

/**
 * Развернуть `.tgs` в объект анимации Lottie.
 *
 * Несжатый JSON тоже принимаем: встречается у файлов, прошедших через конвертеры, и падать на
 * них незачем — распаковка тут средство, а не цель.
 */
export async function unpackTgs(data: ArrayBuffer): Promise<unknown> {
  const bytes = new Uint8Array(data);
  const text = isGzip(bytes)
    ? await new Response(new Blob([data]).stream().pipeThrough(new DecompressionStream('gzip'))).text()
    : new TextDecoder().decode(bytes);
  const parsed: unknown = JSON.parse(text);
  // Минимальная проверка формы: у Lottie обязаны быть слои, и НЕПУСТЫЕ. Пустой массив формально
  // валиден, но рисует ровно ничего — а пустой квадрат в чате неотличим от поломки. Отвергнутый
  // файл покажет подпись-эмодзи, и это честнее (замечание Codex: комментарий обещал отсечь
  // пустоту, а код пропускал `layers: []`).
  const layers = (parsed as { layers?: unknown } | null)?.layers;
  if (!parsed || typeof parsed !== 'object' || !Array.isArray(layers) || layers.length === 0)
    throw new Error('это не анимация Lottie');
  return parsed;
}
