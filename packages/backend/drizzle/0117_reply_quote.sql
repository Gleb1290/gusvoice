-- Цитата фрагмента и «Ответить в другом чате» (08.10, #211, G55, признак `quote1`). Только добавление: старый код колонку не знает.
-- conversation_messages.reply_quote — `{ text, offset, auto? }` (`convRules.ReplyQuoteMark`): выбранный фрагмент цитируемого
--   или (`auto`) снимок начала его текста у ответа на сообщение другой беседы. `null` — обычный ответ или не ответ.
ALTER TABLE conversation_messages ADD COLUMN IF NOT EXISTS reply_quote jsonb;
