/**
 * Контакты держателя инстанса (#139, F1, план §5.1.1).
 *
 * Зачем вообще: если человеку закрыли доступ к серверу на чужом инстансе или у него что-то не
 * работает, ему нужно к кому-то обратиться — но админ соседнего инстанса ему не сосед по чату.
 * Поэтому держатель сам оставляет способы связи, и это не только почта: Telegram, Matrix, ссылка,
 * телефон или просто текст.
 *
 * 🔴 Здесь же правила БЕЗОПАСНОСТИ ССЫЛОК, и они не формальность: контакты приходят с ЧУЖОГО
 * инстанса и показываются нашим людям. Ссылка строится только из разрешённых схем; всё остальное —
 * `javascript:`, `data:`, произвольные схемы — показывается обычным текстом, а не ссылкой.
 *
 * Модуль чистый: ни базы, ни сети.
 */

import { hasHiddenChars } from './textGuards.js';

/** Способы связи. Неизвестный нам вид показывается как обычный текст (сосед новее нас). */
export const CONTACT_KINDS = ['email', 'telegram', 'matrix', 'url', 'phone', 'text'] as const;
export type ContactKind = (typeof CONTACT_KINDS)[number];

export interface HolderContact {
  kind: string;
  label: string;
  value: string;
}

/** Ограничения из плана: до пяти записей, подпись и значение до 200 знаков. */
export const CONTACTS_MAX = 5;
export const CONTACT_FIELD_MAX = 200;


export type ContactProblem = 'too-many' | 'empty-value' | 'too-long' | 'control-chars';


/** Проверить то, что ввёл держатель. */
export function checkContacts(list: HolderContact[]): ContactProblem | null {
  if (list.length > CONTACTS_MAX) return 'too-many';
  for (const c of list) {
    const value = c.value.trim();
    if (value.length === 0) return 'empty-value';
    if (value.length > CONTACT_FIELD_MAX || c.label.length > CONTACT_FIELD_MAX) return 'too-long';
    // Управляющие и невидимые символы: ими подделывают вид ссылки и ломают вёрстку.
    if (hasHiddenChars(value) || hasHiddenChars(c.label)) return 'control-chars';
  }
  return null;
}

const EMAIL = /^[^\s:@]+@[^\s:@]+\.[^\s:@]+$/;
const TELEGRAM_NAME = /^@?([A-Za-z][A-Za-z0-9_]{4,31})$/;
const TELEGRAM_LINK = /^https:\/\/t\.me\/([A-Za-z][A-Za-z0-9_]{4,31})\/?$/;
const MATRIX_ID = /^@[^:\s]+:[A-Za-z0-9.-]+$/;

/**
 * Во что превращается контакт при показе.
 *
 * `href === null` значит «показать текстом»: не ошибка, а безопасное поведение по умолчанию.
 * Телефон текстом НАМЕРЕННО — чтобы случайный клик с десктопа не начинал звонок.
 */
export function contactLink(contact: HolderContact): { href: string | null; text: string } {
  const value = contact.value.trim();
  switch (contact.kind) {
    case 'email':
      // 🪤 Проверка «есть собака и нет пробела» пропускала `javascript:alert(1)@x` — и адрес уезжал в
      // ссылку как `mailto:javascript:...`. Поймано смоуком. Теперь форма проверяется целиком, и
      // двоеточие в адресе запрещено: настоящей почты с ним не бывает, а чужая схема начинается с него.
      return EMAIL.test(value) ? { href: `mailto:${value}`, text: value } : { href: null, text: value };
    case 'telegram': {
      const name = TELEGRAM_NAME.exec(value)?.[1] ?? TELEGRAM_LINK.exec(value)?.[1];
      return name ? { href: `https://t.me/${name}`, text: `@${name}` } : { href: null, text: value };
    }
    case 'matrix':
      return MATRIX_ID.test(value) ? { href: `https://matrix.to/#/${value}`, text: value } : { href: null, text: value };
    case 'url':
      // 🔴 Только https: `http:` — открытый канал, остальные схемы — способ подсунуть код или файл.
      return value.startsWith('https://') && !value.includes(' ') ? { href: value, text: value } : { href: null, text: value };
    case 'phone':
    case 'text':
    default:
      return { href: null, text: value };
  }
}

export function serializeContacts(list: HolderContact[]): Record<string, unknown>[] {
  return list.map((c) => ({ kind: c.kind, label: c.label, value: c.value }));
}

/** Разбор контактов СОСЕДА: лишнее отбрасываем, негодные записи пропускаем, а не роняем весь список. */
export function parseContacts(raw: unknown): HolderContact[] {
  if (!Array.isArray(raw)) return [];
  const out: HolderContact[] = [];
  for (const item of raw) {
    if (!item || typeof item !== 'object') continue;
    const r = item as Record<string, unknown>;
    const kind = typeof r.kind === 'string' && r.kind.length > 0 ? r.kind : 'text';
    const value = typeof r.value === 'string' ? r.value.trim() : '';
    const label = typeof r.label === 'string' ? r.label.trim() : '';
    if (value.length === 0 || value.length > CONTACT_FIELD_MAX) continue;
    if (hasHiddenChars(value) || hasHiddenChars(label)) continue;
    out.push({ kind, label, value });
    // Больше пяти не берём даже от соседа: иначе список у нас в интерфейсе растягивает чужая сторона.
    if (out.length >= CONTACTS_MAX) break;
  }
  return out;
}
