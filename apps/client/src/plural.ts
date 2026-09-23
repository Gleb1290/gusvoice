/**
 * Русское склонение числительных для интерфейса.
 *
 * Отдельным файлом, потому что нужно уже в двух местах (вкладки федерации и серия дней), а каждая
 * своя копия — это ещё один способ написать «3 раз подряд» и «2 человек».
 *
 * ⚠️ Правило не сводится к «1 — одно, остальное — другое»: в русском три формы, и выбирает их
 * ОСТАТОК, причём числа 11–14 ведут себя не как 1–4 (одиннадцать дней, а не одиннадцать день).
 */
export function plural(n: number, one: string, few: string, many: string): string {
  const abs = Math.abs(Math.trunc(n));
  const m100 = abs % 100;
  if (m100 >= 11 && m100 <= 14) return many;
  const m10 = abs % 10;
  if (m10 === 1) return one;
  if (m10 >= 2 && m10 <= 4) return few;
  return many;
}

/** Число вместе со словом: `count(3, 'раз', 'раза', 'раз')` → «3 раза». */
export function count(n: number, one: string, few: string, many: string): string {
  return `${n} ${plural(n, one, few, many)}`;
}
