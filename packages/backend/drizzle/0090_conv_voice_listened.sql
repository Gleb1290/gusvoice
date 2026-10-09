-- ЛС (#211, 07.10, признак сервера `voice1`): «не прослушано» у голосовых сообщений, как в Telegram (G12).
--
-- Строка = «этот человек прослушал это сообщение» (нажал «играть» на голосовом). Пишет только получатель (не автор):
-- клиент шлёт `POST /conv/:id/messages/:mid/listened`. Сообщение-голосовое глазами получателя «не прослушано», пока строки
-- нет; глазами автора — «не прослушано собеседником», пока нет строки ни от кого из других участников
-- (`ConvMessage.voiceListened`, только у голосовых). Таблица новая — старый бэкенд при откате её не читает, голосовые для
-- него просто без признака (только добавление, правило 11). Удалилось сообщение — строки уходят каскадом.
CREATE TABLE IF NOT EXISTS conversation_voice_listens (
  message_id  text        NOT NULL REFERENCES conversation_messages (id) ON DELETE CASCADE,
  user_id     text        NOT NULL, -- без FK на users: аккаунт обезличивается, а не удаляется (как у реакций)
  listened_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (message_id, user_id)
);

-- Голосовые, пришедшие ДО признака, считаем прослушанными: иначе вся история разом получила бы синие точки. Признак
-- голосового — огибающая на аудио-вложении (`shared/voiceMessage.isVoiceMessage`); слушателем ставим каждого участника
-- беседы, кроме автора.
INSERT INTO conversation_voice_listens (message_id, user_id)
SELECT m.id, cm.user_id
FROM conversation_messages m
JOIN conversation_members cm ON cm.conversation_id = m.conversation_id AND cm.user_id <> m.author_id
WHERE EXISTS (
  SELECT 1 FROM jsonb_array_elements(m.attachments) a
  WHERE jsonb_typeof(a -> 'waveform') = 'array' AND jsonb_array_length(a -> 'waveform') > 0
    AND coalesce(a ->> 'contentType', '') LIKE 'audio/%'
)
ON CONFLICT DO NOTHING;
