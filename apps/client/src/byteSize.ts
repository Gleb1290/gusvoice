/**
 * Размер в байтах — словами для человека.
 *
 * ⚠️ Двоичные ступени (1 КБ = 1024 Б): предел квоты хранится и сравнивается в байтах, и «2 ГБ» в
 * подписи обязано значить ровно те 2147483648, с которыми работает база, — иначе держатель ставит
 * предел, а упирается человек в другой.
 * ⚠️ Дробная часть только у крупных ступеней: «1.5 ГБ» человеку полезно, «1.5 Б» — нет.
 */
const STEPS = [
  { unit: 'ТБ', size: 1024 ** 4 },
  { unit: 'ГБ', size: 1024 ** 3 },
  { unit: 'МБ', size: 1024 ** 2 },
  { unit: 'КБ', size: 1024 },
] as const;

export function formatBytes(bytes: number): string {
  const n = Math.max(0, Math.trunc(bytes));
  for (const step of STEPS) {
    if (n >= step.size) {
      const v = n / step.size;
      // Округляем до десятых, но целое показываем целым: «2 ГБ», а не «2.0 ГБ».
      const shown = v >= 10 ? Math.round(v) : Math.round(v * 10) / 10;
      return `${shown} ${step.unit}`;
    }
  }
  return `${n} Б`;
}

/** Гигабайты в байты — для поля ввода предела. Пусто или мусор → `null` (значение не менялось). */
export function gigabytesToBytes(input: string): number | null {
  const normalized = input.trim().replace(',', '.');
  if (!normalized) return null;
  const v = Number(normalized);
  if (!Number.isFinite(v) || v < 0) return null;
  return Math.round(v * 1024 ** 3);
}
