import { FEATURE_LASTSEEN3, FEATURE_PRESENCE4, type LastSeenExceptions, type LastSeenExceptionUser, type LastSeenPrivacy } from '@gusvoice/shared';

/**
 * Исключения «Времени захода» (G07, #211, `lastseen3`) — ЧИСТЫЕ правила вида.
 *
 * Источник — tdesktop (код не копировали): `boxes/edit_privacy_box.cpp` — ссылка «Always share with» видна при «Мои контакты» и
 * «Никто» (`showExceptionLink`), «Never share with» — при «Все» и «Мои контакты»; сохранение списка убирает выбранных из
 * ДРУГОГО списка (`editExceptions` → `removeFrom`); `settings_privacy_controllers.cpp` `LastSeenPrivacyController` — подписи
 * «Always share with» / «Never share with», пояснение «исключения перекрывают настройки выше».
 */

export type ExceptionKind = 'always' | 'never';

/** Предел людей в списке (как на сервере, `LAST_SEEN_EXCEPTIONS_MAX`). */
export const EXCEPTION_PICK_MAX = 200;

/** Сервер умеет исключения «Времени захода» (`lastseen3`). */
export function serverLastSeenExceptions(features: readonly string[] | null | undefined): boolean {
  return !!features?.includes(FEATURE_LASTSEEN3);
}

/** Какие два списка показывать при правиле `privacy` (скрытый список сервер всё равно не применяет — результат тот же). */
export function exceptionKindsShown(privacy: LastSeenPrivacy): ExceptionKind[] {
  if (privacy === 'everyone') return ['never'];
  if (privacy === 'nobody') return ['always'];
  return ['always', 'never'];
}

export const EXCEPTION_TITLE: Record<ExceptionKind, string> = {
  always: 'Всегда показывать',
  never: 'Никогда не показывать',
};

/**
 * Чья это настройка (`presence4`): те же два списка у «Кто может звонить» (tdesktop `CallsPrivacyController`:
 * `lng_edit_privacy_calls_always_empty` / `_never_empty` — «Always allow» / «Never allow», пояснение
 * `lng_edit_privacy_calls_exceptions`). Ручки — `/users/me/call-exceptions`.
 */
export type PrivacySetting = 'lastSeen' | 'calls';

export const CALL_EXCEPTION_TITLE: Record<ExceptionKind, string> = {
  always: 'Всегда разрешать',
  never: 'Никогда не разрешать',
};

/** Подписи списков настройки. */
export function exceptionTitles(setting: PrivacySetting): Record<ExceptionKind, string> {
  return setting === 'calls' ? CALL_EXCEPTION_TITLE : EXCEPTION_TITLE;
}

/** Сервер умеет «Кто может звонить» с исключениями (`presence4`). */
export function serverCallPrivacy(features: readonly string[] | null | undefined): boolean {
  return !!features?.includes(FEATURE_PRESENCE4);
}

/** Правая подпись строки списка: «Добавить» или «3 человека». */
export function exceptionCountLabel(n: number): string {
  if (n <= 0) return 'Добавить';
  const m10 = n % 10;
  const m100 = n % 100;
  const few = m10 >= 2 && m10 <= 4 && (m100 < 12 || m100 > 14);
  return `${n} ${few ? 'человека' : 'человек'}`;
}

/** Итог после «Сохранить» в окне списка `kind`: выбранные уходят из ДРУГОГО списка (Telegram `editExceptions`). */
export function applyExceptionPick(
  lists: LastSeenExceptions,
  kind: ExceptionKind,
  picked: readonly LastSeenExceptionUser[],
): LastSeenExceptions {
  const other: ExceptionKind = kind === 'always' ? 'never' : 'always';
  const ids = new Set(picked.map((p) => p.id));
  return { ...lists, [kind]: [...picked], [other]: lists[other].filter((u) => !ids.has(u.id)) } as LastSeenExceptions;
}

/** Тело `PUT /users/me/last-seen-exceptions`. */
export function exceptionsBody(lists: LastSeenExceptions): { always: string[]; never: string[] } {
  return { always: lists.always.map((u) => u.id), never: lists.never.map((u) => u.id) };
}
