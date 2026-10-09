/**
 * Превью ссылки над полем ввода (07.10, #211, G19) — чистые правила. Источник — Telegram Desktop:
 * `history/view/controls/history_view_webpage_processor.cpp` (`WebpageProcessor::checkPreview`: берётся ПЕРВАЯ ссылка текста;
 * убрал превью крестиком — `_draft.removed`, оно не возвращается, пока в тексте остаются ссылки; ссылок не осталось —
 * признак сбрасывается) и `chat_helpers/message_field.cpp` / `MessageLinksParser` (разбор ссылок с задержкой после ввода);
 * Web A — `composer/WebPagePreview.tsx`.
 */

/** Сколько ждать после последней буквы, прежде чем искать превью (ТЗ: «через ~1 с после ввода URL, как TG»). */
export const LINK_PREVIEW_DELAY_MS = 1000;

/**
 * Первая ссылка текста — по ней строится превью над полем. Хвостовая пунктуация — не часть адреса; свои ссылки инстанса
 * (`isOwn`) превью не получают (как и у карточки под сообщением, `previewableLinks`) — берётся следующая.
 */
export function composerPreviewLink(text: string, isOwn: (url: string) => boolean = () => false): string | null {
  const found = text.match(/https?:\/\/[^\s<>"]+/g) ?? [];
  for (const raw of found) {
    const url = raw.replace(/[.,;:!?)\]]+$/, '');
    if (url.length > 'https://'.length && !isOwn(url)) return url;
  }
  return null;
}

/**
 * Признак «превью убрано крестиком»: остаётся, пока в тексте есть ссылка; когда ссылок нет — гасится (`checkPreview`:
 * `if (_parsedLinks.empty()) _draft.removed = false`).
 */
export function nextDismissed(dismissed: boolean, link: string | null): boolean {
  return link === null ? false : dismissed;
}

/** Флаг отправки «без превью»: убрано крестиком и ссылка в тексте ещё есть. Без признака сервера флага нет. */
export function sendNoPreview(dismissed: boolean, link: string | null, serverFlag: boolean): boolean {
  return serverFlag && dismissed && link !== null;
}
