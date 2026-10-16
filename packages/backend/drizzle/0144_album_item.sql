-- G56 (13.10, признак `album1`): «удалить у меня» одно фото или видео альбома. Записи `<смотрящий>:<id вложения>` — элемент
-- спрятан только у этого человека, у остальных альбом целиком (`convRules.attachmentsForViewer`). Только добавление.
ALTER TABLE conversation_messages ADD COLUMN IF NOT EXISTS hidden_attachments text[] NOT NULL DEFAULT '{}'::text[];
