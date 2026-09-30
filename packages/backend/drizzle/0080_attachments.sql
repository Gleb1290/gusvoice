-- ЛС, шаг 1в (#211, #213, docs/dm/STAGE1.md «Файлы»): вложения новых ЛС — отдельные строки со своим состоянием, файл —
-- в ЗАКРЫТОМ бакете (MINIO_PRIVATE_BUCKET, без политики). Выдача — только через бэкенд (routes/att.ts) с проверкой
-- доступа смотрящего на каждый запрос. Старые вложения ЛС (публичный бакет, до 1в) остаются как есть (Р17).
--
-- Владелец ссылается на участие в беседе, а не на users: загрузить в беседу может только её участник, а вложение —
-- часть переписки, как сообщение (при удалении аккаунта остаётся, доступ удалённому закрыт convRules.attachmentAccess).
CREATE TABLE IF NOT EXISTS attachments (
  id text PRIMARY KEY,
  conversation_id text NOT NULL,
  owner_id text NOT NULL,
  -- Сообщение, к которому прикреплено (NULL — ещё не отправлено).
  message_id text REFERENCES conversation_messages(id) ON DELETE SET NULL,
  storage_key text NOT NULL UNIQUE,
  name text NOT NULL,
  -- Тип по СОДЕРЖИМОМУ (attachmentRules.resolveAttachmentMime), не со слов клиента.
  content_type text NOT NULL,
  size bigint NOT NULL,
  -- pending — загружено, не отправлено (сутки, потом уборка); attached — в сообщении; deleted — удалено у обоих или
  -- просрочено: файл удаляется из хранилища после фиксации, строка — вслед за файлом (cleanup повторяет сбои).
  state text NOT NULL DEFAULT 'pending' CHECK (state IN ('pending', 'attached', 'deleted')),
  created_at timestamptz NOT NULL DEFAULT now(),
  deleted_at timestamptz,
  FOREIGN KEY (conversation_id, owner_id) REFERENCES conversation_members (conversation_id, user_id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS attachments_owner_pending_idx ON attachments (owner_id) WHERE state = 'pending';
CREATE INDEX IF NOT EXISTS attachments_message_idx ON attachments (message_id);
CREATE INDEX IF NOT EXISTS attachments_state_created_idx ON attachments (state, created_at);
