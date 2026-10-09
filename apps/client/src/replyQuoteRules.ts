import { REPLY_QUOTE_MAX, type MessageReplyPreview } from '@gusvoice/shared';

/**
 * Цитата фрагмента и «Ответить в другом чате» (08.10, #211, G55, признак сервера `quote1`) — чистые правила клиента.
 * Сверка — Telegram Desktop `history_view_draft_options.cpp` (окно «Ответ на сообщение»: «Цитировать фрагмент», «Ответить в
 * другом чате», «Показать в чате», «Убрать ответ»; длинная цитата — тост «Слишком длинная цитата»), `main_app_config.cpp`
 * (`quote_length_max`, по умолчанию 1024), Android `ChatActivity` (`replyingQuote`, панель выделения «Цитировать»).
 */

/** Цитата в поле ответа: кусок текста цитируемого и его смещение в сыром тексте сообщения. */
export interface ReplyQuoteDraft {
  text: string;
  offset: number;
}

/**
 * Выделенный текст → цитата. Выделение берётся из отрисованного пузыря, а сервер сверяет цитату с СЫРЫМ текстом
 * (`convRules.resolveReplyQuote`): годится только кусок, который в сыром тексте есть дословно (разметка внутри выделения —
 * `**`, `||` — его рвёт; такое выделение цитатой не становится, пункта нет). Пробелы по краям срезаются. `too-long` —
 * длиннее `REPLY_QUOTE_MAX` знаков UTF-16 (у Telegram — тост «Слишком длинная цитата»). Смещение — вхождение, ближайшее к
 * `near` (примерное место выделения в тексте), иначе первое.
 */
export function quoteFromSelection(content: string, selected: string, near = 0): ReplyQuoteDraft | 'too-long' | null {
  const text = selected.replace(/\r\n?/g, '\n').trim();
  if (!text) return null;
  if (text.length > REPLY_QUOTE_MAX) return 'too-long';
  let best = -1;
  for (let at = content.indexOf(text); at >= 0; at = content.indexOf(text, at + 1)) {
    if (best < 0 || Math.abs(at - near) < Math.abs(best - near)) best = at;
  }
  return best < 0 ? null : { text, offset: best };
}

/**
 * Что писать в цитате ответа внутри пузыря: выбранный фрагмент (`quote`) — он, а не начало сообщения; ответ из чужой
 * беседы без доступа (`foreign` без `conversationId`) — снимок, который прислал сервер (`content`). `null` — обычная
 * цитата (правило раунда 10, `bubbleRules.replyQuoteLook`).
 */
export function replyQuoteFragment(reply: Pick<MessageReplyPreview, 'quote' | 'foreign' | 'conversationId' | 'content' | 'deleted'>): string | null {
  if (reply.deleted) return null;
  if (reply.quote) return reply.quote;
  if (reply.foreign && !reply.conversationId) return reply.content || null;
  return null;
}

/**
 * Куда ведёт нажатие на цитату ответа в пузыре: `here` — к сообщению этой беседы (как было); `other` — открыть беседу
 * цитируемого (ответ из другой беседы, где читатель состоит); `none` — перехода нет (ответ из беседы, где читателя нет:
 * у Telegram — подсказка «Сообщение находится в личном чате»).
 */
export function replyJumpTarget(reply: Pick<MessageReplyPreview, 'foreign' | 'conversationId'>): 'here' | 'other' | 'none' {
  if (!reply.foreign) return 'here';
  return reply.conversationId ? 'other' : 'none';
}
