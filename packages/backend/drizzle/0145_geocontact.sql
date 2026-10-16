-- G69 (14.10, признак `geocontact1`): вид сообщения беседы — геопозиция `{ kind: 'geo', lat, lon, accuracy }` или карточка
-- контакта `{ kind: 'contact', userId, username, displayName, avatarUrl, home? }` (`shared/convMedia.ts`). `content` у такого —
-- запасная фраза для старого клиента. NULL — обычное сообщение. Только добавление.
ALTER TABLE conversation_messages ADD COLUMN IF NOT EXISTS media jsonb;
