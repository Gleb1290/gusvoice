/**
 * Галочка «Также удалить для собеседника» в окне удаления сообщений (хвост `tails2`, решение владельца Р-1, `docs/design/
 * ui-playbook/14-telegram-plan.md`): как у Telegram по платформам.
 *  - ПК (широкая раскладка) — Telegram Desktop `DeleteMessagesBox`: галочка `_revoke` отмечена, пока человек не «запомнил»
 *    обратное (`rememberedDeleteMessageOnlyForYou`); «Запомнить выбор» (`_revokeRemember`, `lng_remember`) появляется только
 *    когда галочка стоит НЕ так, как по умолчанию, и сохраняется, только если отмечена. Запомнили «только у меня» — в следующий
 *    раз галочка снята и «запомнить» предлагает вернуть прежнее. Хранится на устройстве (localStorage).
 *  - Телефон (раскладка телефона: приложение и узкое окно веба) — Telegram Android `AlertsCreator.createDeleteMessagesAlert`:
 *    `deleteForAll` снята по умолчанию и «запомнить» нет.
 * Правила чистые: хранилище передаётся.
 */

/** Ключ запомненного «Удалять только у себя» (`'1'`); нет ключа — по умолчанию «у обоих». */
export const DELETE_ONLY_ME_KEY = 'gv_delete_only_me';

type StoreRead = Pick<Storage, 'getItem'>;
type StoreWrite = Pick<Storage, 'setItem' | 'removeItem'>;

function defaultStore(): Storage | null {
  try {
    return typeof localStorage === 'undefined' ? null : localStorage;
  } catch {
    return null;
  }
}

/** Отмечена ли галочка «Также удалить для …» при открытии окна. */
export function deleteBothDefault(phone: boolean, store: StoreRead | null = defaultStore()): boolean {
  if (phone) return false;
  try {
    return store?.getItem(DELETE_ONLY_ME_KEY) !== '1';
  } catch {
    return true;
  }
}

/** Показывать ли «Запомнить выбор» (когда галочка стоит не по умолчанию): на телефоне его нет. */
export function deleteRememberAvailable(phone: boolean): boolean {
  return !phone;
}

/** Запомнить выбор: `both` — галочка была отмечена. «Только у себя» пишется, «у обоих» — стирает запись (прежнее по умолчанию). */
export function rememberDeleteChoice(both: boolean, store: StoreWrite | null = defaultStore()): void {
  try {
    if (both) store?.removeItem(DELETE_ONLY_ME_KEY);
    else store?.setItem(DELETE_ONLY_ME_KEY, '1');
  } catch {
    /* хранилище закрыто — выбор живёт до закрытия окна */
  }
}

/** Видна ли строка «Запомнить выбор» сейчас: опция допускает запоминание, а галочка стоит не так, как при открытии. */
export function rememberRowVisible(spec: { checked: boolean; remember?: boolean } | undefined, current: boolean): boolean {
  return !!spec?.remember && current !== spec.checked;
}
