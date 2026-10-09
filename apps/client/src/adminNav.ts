/**
 * Карта админ-панели (#153, дизайн round 9) — чистая, без React и DOM.
 *
 * **Повод тот же, что и у настроек:** шесть вкладок в одну строку, у каждой одно слово, и ни одна
 * не говорит, что внутри. «Инстанс» и «Экономика» звучат одинаково важно, хотя за первой — имя
 * сервера и правила регистрации, а за второй — выключатель монет. Рельс слева даёт каждой строку
 * пояснения, а не заставляет вспоминать.
 *
 * ⚠️ Порядок разделов — от частого к редкому: держатель заходит в админку ради людей и серверов,
 * а почту и экономику настраивает один раз за всё время.
 */

import type { IconName } from './components/Icon';

export type AdminSectionKey = 'users' | 'servers' | 'instance' | 'reports' | 'federation' | 'smtp' | 'economy';

export interface AdminSection {
  key: AdminSectionKey;
  label: string;
  /** Одна строка под заголовком: что здесь вообще лежит. */
  sub: string;
  icon: IconName;
  /** У этих разделов есть кнопка «обновить»: их содержимое приходит с сервера списком. */
  refreshable?: boolean;
}

export const ADMIN_SECTIONS: AdminSection[] = [
  { key: 'users', label: 'Пользователи', sub: 'Кто есть на инстансе, роли и доступ', icon: 'user', refreshable: true },
  { key: 'servers', label: 'Серверы', sub: 'Сообщества этого инстанса и их владельцы', icon: 'hash', refreshable: true },
  { key: 'instance', label: 'Инстанс', sub: 'Имя, регистрация, обновления и версия', icon: 'settings' },
  { key: 'reports', label: 'Жалобы', sub: 'Жалобы на собеседников из личных сообщений', icon: 'flag' },
  { key: 'federation', label: 'Федерация', sub: 'Связки с соседями, жалобы и запреты', icon: 'globe' },
  { key: 'smtp', label: 'Почта', sub: 'Отправка писем: коды и восстановление пароля', icon: 'mail' },
  { key: 'economy', label: 'Экономика', sub: 'Гускоины: выключатель и закрытый показ', icon: 'star' },
];

export function adminSectionOf(key: AdminSectionKey): AdminSection {
  const s = ADMIN_SECTIONS.find((x) => x.key === key);
  if (!s) throw new Error(`неизвестный раздел админки: ${key}`);
  return s;
}

/**
 * Подпись раздела в рельсе: у списков — со счётчиком.
 *
 * ⚠️ Счётчик показываем, только когда список УЖЕ приехал. «Пользователи (0)» во время загрузки
 * читается как «на инстансе никого» — а это самое тревожное, что держатель может здесь увидеть.
 */
export function adminSectionLabel(s: AdminSection, counts: { users?: number; servers?: number }): string {
  if (s.key === 'users' && counts.users != null) return `${s.label} (${counts.users})`;
  if (s.key === 'servers' && counts.servers != null) return `${s.label} (${counts.servers})`;
  return s.label;
}
