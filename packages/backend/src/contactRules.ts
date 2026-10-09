import { CONTACT_NAME_MAX } from '@gusvoice/shared';

/**
 * Чистые правила контактов (08.10, #211, `contacts1`). Подпись контакта — одна строка: пробелы по краям срезаются, переносы и
 * управляющие знаки становятся пробелом, подряд идущие пробелы — одним, длина — до `CONTACT_NAME_MAX` (лишнее отрезается, а не
 * отказ: Telegram тоже просто не даёт набрать больше). Пусто — `null`, то есть снова собственное имя человека.
 */
export function cleanContactName(raw: string | null | undefined): string | null {
  if (raw === null || raw === undefined) return null;
  // eslint-disable-next-line no-control-regex
  const one = raw.replace(/[\u0000-\u001f\u007f]+/g, ' ').replace(/\s+/g, ' ').trim();
  if (!one) return null;
  const cut = [...one].slice(0, CONTACT_NAME_MAX).join('').trim();
  return cut || null;
}

/** Имя автора в пуше получателю `ownerId`: его подпись контакта (`contacts.contactNamesFor`), иначе собственное имя автора. */
export function pushNameFor(names: ReadonlyMap<string, string>, ownerId: string, fallback: string): string {
  return names.get(ownerId) ?? fallback;
}
