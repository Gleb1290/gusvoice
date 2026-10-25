-- Карточки вебхука (#24, Discord Embed Object). Только добавления: старый код колонок не знает.
-- messages.embeds — до 10 карточек, уже проверенных сервером (`normalizeEmbeds` в webhookRules.ts); NULL — карточек нет.
-- messages.embeds_fallback — `content` не написан отправителем, а собран из карточек для старых клиентов (сообщение
--   вебхука без своего текста). Новый клиент такой текст не показывает — рисует карточки.
ALTER TABLE messages ADD COLUMN IF NOT EXISTS embeds jsonb;
ALTER TABLE messages ADD COLUMN IF NOT EXISTS embeds_fallback boolean NOT NULL DEFAULT false;
