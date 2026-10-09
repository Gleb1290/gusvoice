import type { DmChannel } from '@gusvoice/shared';
import { confirmAction, confirmWithOption } from '../confirm';
import { useStore } from '../store';
import { plural } from '../dmRowRules';
import { toastError } from '../toast';

/**
 * Окна «Очистить историю» и «Удалить чат» беседы ЛС — общие для меню строки списка (`DmRowMenu`) и меню «⋯» в шапке
 * открытой беседы (`DmChatView`, G06 плейбука 14; Telegram ПК 03·2.3.1 — «Очистить историю», «Удалить чат» в конце меню).
 * Отдельный файл — чтобы два компонента не импортировали друг друга по кругу.
 */

/**
 * Имя собеседника в окне: подпись из моих контактов (решение владельца 08.10 п.27) — вызывающий передаёт `usePeerName()` или
 * `peerNameNow` (`peerName.ts`); без него — имя из беседы. Импорта `peerName.ts` здесь нет: модуль проверяется с подменой
 * импортов поимённо.
 */
type NameOf = (userId: string, fallback: string) => string;
const PLAIN: NameOf = (_id, n) => n;

/**
 * «Очистить историю» (07.10, G01, сервер `conv12`): окно с галочкой «Также удалить для собеседника» (по умолчанию снята,
 * как у Telegram, 03·1.2.9 / 1.3.8; имя не склоняем — решение владельца 04.10 для окон удаления).
 */
export async function clearHistory(dm: DmChannel, nameOf: NameOf = PLAIN): Promise<boolean> {
  const name = nameOf(dm.otherUser.id, dm.otherUser.displayName);
  const r = await confirmWithOption({
    title: 'Очистить историю?',
    body: `Без галочки переписка исчезнет только у вас, а ${name} её по-прежнему увидит. Вернуть удалённое нельзя.`,
    tone: 'danger',
    confirmLabel: 'Очистить историю',
    option: { label: 'Также удалить для собеседника', checked: false },
  });
  if (!r) return false;
  await useStore
    .getState()
    .clearConvHistory(dm.id, r.option ? 'both' : 'me')
    .catch(toastError);
  return true;
}

/**
 * «Удалить чат» (07.10, G01, `conv12`): беседа уходит из списка и переписка очищается; с галочкой — и у собеседника.
 * Новое сообщение возвращает беседу, как у Telegram (03·1.2.10).
 */
export async function deleteChat(dm: DmChannel, nameOf: NameOf = PLAIN): Promise<boolean> {
  const name = nameOf(dm.otherUser.id, dm.otherUser.displayName);
  const r = await confirmWithOption({
    title: 'Удалить чат?',
    body: `Беседа пропадёт из списка вместе с перепиской и вернётся, когда придёт новое сообщение. Без галочки — только у вас, а ${name} переписку по-прежнему увидит. Вернуть удалённое нельзя.`,
    tone: 'danger',
    confirmLabel: 'Удалить чат',
    option: { label: 'Также удалить для собеседника', checked: false },
  });
  if (!r) return false;
  await useStore
    .getState()
    .hideConv(dm.id, r.option ? 'both' : 'me')
    .catch(toastError);
  return true;
}

/**
 * «Удалить группу» у бывшей группы (08.10, `groups3`; Telegram Android `DeleteThisGroup` на плашке вместо поля ввода):
 * беседа уходит из списка на всех моих устройствах и новым сообщением НЕ возвращается — я в ней больше не участник.
 */
export async function deleteFormerGroup(dm: DmChannel): Promise<boolean> {
  const ok = await confirmAction({
    title: 'Удалить группу?',
    body: `«${dm.group?.title || dm.otherUser.displayName}» пропадёт из списка вместе с перепиской. Вернуть её нельзя.`,
    tone: 'danger',
    confirmLabel: 'Удалить группу',
  });
  if (!ok) return false;
  await useStore.getState().hideConv(dm.id, 'me').catch(toastError);
  return true;
}

/**
 * «Удалить» в режиме выбора бесед (07.10, G01; Telegram Android `DialogsActivity`, действие `delete` панели выбора): одно
 * окно на всю пачку, та же галочка, что у «Удалить чат» (снята — решение Р-1 для телефона). Одна выбранная — обычное окно.
 * `true` — удаление подтверждено (вызывающий выходит из выбора).
 */
export async function deleteChats(dms: readonly DmChannel[], nameOf: NameOf = PLAIN): Promise<boolean> {
  if (dms.length === 0) return false;
  if (dms.length === 1) return deleteChat(dms[0], nameOf);
  const n = dms.length;
  const r = await confirmWithOption({
    title: `Удалить ${n} ${plural(n, 'чат', 'чата', 'чатов')}?`,
    body: 'Беседы пропадут из списка вместе с перепиской и вернутся, когда придёт новое сообщение. Без галочки — только у вас, собеседники переписку по-прежнему увидят. Вернуть удалённое нельзя.',
    tone: 'danger',
    confirmLabel: 'Удалить',
    option: { label: 'Также удалить для собеседников', checked: false },
  });
  if (!r) return false;
  const scope = r.option ? 'both' : 'me';
  for (const dm of dms) await useStore.getState().hideConv(dm.id, scope).catch(toastError);
  return true;
}

/**
 * «Очистить историю» в режиме выбора бесед (G01; Telegram Android `DialogsActivity`, действие `clear` в «⋮» панели выбора,
 * строка `AreYouSureClearHistoryFewChats`): одно окно на всю пачку, галочка «для собеседников» снята по умолчанию. Одна
 * выбранная — обычное окно (`clearHistory`). `true` — подтверждено (вызывающий выходит из выбора).
 */
export async function clearHistories(dms: readonly DmChannel[], nameOf: NameOf = PLAIN): Promise<boolean> {
  if (dms.length === 0) return false;
  if (dms.length === 1) return clearHistory(dms[0], nameOf);
  const n = dms.length;
  const r = await confirmWithOption({
    title: `Очистить историю ${n} ${plural(n, 'чата', 'чатов', 'чатов')}?`,
    body: 'Без галочки переписка исчезнет только у вас, собеседники её по-прежнему увидят. Вернуть удалённое нельзя.',
    tone: 'danger',
    confirmLabel: 'Очистить историю',
    option: { label: 'Также удалить для собеседников', checked: false },
  });
  if (!r) return false;
  const scope = r.option ? 'both' : 'me';
  for (const dm of dms) await useStore.getState().clearConvHistory(dm.id, scope).catch(toastError);
  return true;
}
