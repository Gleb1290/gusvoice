import { DM_REPORT_REASONS, type DmReportEvidence, type DmReportReason } from '@gusvoice/shared';

/**
 * Жалоба на собеседника из ЛС (08.10, #211, С7, G30, Р-10, признак `stranger1`) — чистые правила, без базы.
 *
 * У Telegram жалоба уходит модерации Telegram вместе с id сообщений (`messages.report`, причины `inputReportReason*`), а
 * комментарий режется на 512 знаков (`ReportBox`, `kReportReasonLengthMax`). У нас жалоба уходит держателю инстанса
 * (супер-админу), улики — до пяти последних сообщений собеседника (как `REPORT_EVIDENCE_MAX` у жалоб на гостей).
 */

/** Улик на жалобу — столько же, сколько у жалобы соседу (`federation/instanceBan.REPORT_EVIDENCE_MAX`). */
export const DM_REPORT_EVIDENCE_MAX = 5;
/** Предел комментария — как у Telegram Desktop. */
export const DM_REPORT_COMMENT_MAX = 512;
/** Предел текста одной улики: жалоба — не копия беседы. */
export const DM_REPORT_TEXT_MAX = 500;
/** Жалобы одного человека на одного и того же за сутки склеиваем в одну (как `REPORT_MERGE_MS` у соседей). */
export const DM_REPORT_MERGE_MS = 24 * 60 * 60 * 1000;
/** Жалоб в час от одного человека: плашка не должна быть способом заваливать держателя. */
export const DM_REPORT_LIMIT = { max: 10, windowS: 3600 } as const;

export function isDmReportReason(v: unknown): v is DmReportReason {
  return typeof v === 'string' && (DM_REPORT_REASONS as readonly string[]).includes(v);
}

/** Комментарий: обрезать пробелы и предел; пусто — `null`. */
export function cleanReportComment(v: unknown): string | null {
  if (typeof v !== 'string') return null;
  const t = v.trim().slice(0, DM_REPORT_COMMENT_MAX).trim();
  return t || null;
}

/** Строка сообщения собеседника, из которой делается улика. */
export interface ReportSourceMessage {
  id: string;
  content: string;
  attachmentCount: number;
  at: Date;
}

/**
 * Улики: до пяти самых свежих сообщений собеседника, от старых к новым (так их читает держатель). Текст режется на
 * `DM_REPORT_TEXT_MAX`; сообщение без текста — пометкой «[вложение]» (файл жалоба не несёт), пустое без вложений — пропуск.
 * `messages` приходят от новых к старым.
 */
export function evidenceFrom(messages: readonly ReportSourceMessage[]): DmReportEvidence[] {
  const out: DmReportEvidence[] = [];
  for (const m of messages) {
    if (out.length >= DM_REPORT_EVIDENCE_MAX) break;
    const text = m.content.trim().slice(0, DM_REPORT_TEXT_MAX) || (m.attachmentCount > 0 ? '[вложение]' : '');
    if (!text) continue;
    out.push({ messageId: m.id, text, at: m.at.getTime() });
  }
  return out.reverse();
}
