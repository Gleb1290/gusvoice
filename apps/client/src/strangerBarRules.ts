import { DM_REPORT_REASONS, FEATURE_STRANGER1, type DmReportReason } from '@gusvoice/shared';

/**
 * Плашка незнакомца над лентой ЛС и жалоба (08.10, #211, С7, G30, Р-10, признак сервера `stranger1`) — правила без стора и разметки
 * (`components/StrangerBar.tsx`). Источники (Telegram): `tdesktop history/view/history_view_contact_status.cpp` (плашка
 * «Добавить / Заблокировать» у начавшего первым; крестик — `hide_peer_settings_bar`; блокировка — `PeerMenuBlockUserBox`),
 * `tweb components/chat/actions.tsx` (`block_contact`, `report_spam`, `freeze` — кнопки гаснут на время запроса).
 */

/** Сервер умеет плашку незнакомца и жалобу из ЛС. */
export function serverStranger(features: readonly string[] | null | undefined): boolean {
  return !!features?.includes(FEATURE_STRANGER1);
}

/**
 * Показывать ли плашку. Сервер решает, кто незнакомец (`stranger` в сводке: нет общего сервера, не отвечал, не скрывал);
 * клиент гасит её сразу, не дожидаясь события: я заблокировал, или в ленте уже есть МОЁ сообщение (ответ ушёл, но `conv.change`
 * ещё в пути), и это не группа.
 */
export function strangerBarShown(input: {
  feature: boolean;
  stranger: boolean;
  blocked: boolean;
  group: boolean;
  hasOwnMessage: boolean;
}): boolean {
  return input.feature && input.stranger && !input.blocked && !input.group && !input.hasOwnMessage;
}

/** Подписи причин жалобы (список Telegram `lng_report_reason_*`, урезанный): порядок — `DM_REPORT_REASONS`. */
export const REPORT_REASON_LABEL: Record<DmReportReason, { title: string; text: string }> = {
  spam: { title: 'Спам', text: 'Навязчивая реклама, рассылки, ссылки' },
  scam: { title: 'Мошенничество', text: 'Обман, выманивание денег и паролей, выдаёт себя за другого' },
  violence: { title: 'Насилие и угрозы', text: 'Угрозы, травля, призывы к насилию' },
  child_abuse: { title: 'Насилие над детьми', text: 'Материалы, где пострадали дети' },
  porn: { title: 'Непристойное', text: 'Порнография и сцены интимного характера' },
  illegal: { title: 'Запрещённое', text: 'Наркотики, оружие, чужие личные данные' },
  other: { title: 'Другое', text: 'Опишите, что не так, ниже' },
};

export const REPORT_REASONS: readonly DmReportReason[] = DM_REPORT_REASONS;

/** Сколько знаков в комментарии к жалобе (как у сервера и у Telegram Desktop). */
export const REPORT_COMMENT_MAX = 512;

/** Подпись причины в списке держателя; незнакомая (сервер новее клиента) — как пришла. */
export function reportReasonTitle(reason: string): string {
  return (REPORT_REASON_LABEL as Record<string, { title: string } | undefined>)[reason]?.title ?? reason;
}
