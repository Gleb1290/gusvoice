-- Загрузка кусками (09.10, `bigfile1`, решение владельца: файл в ЛС до 500 МБ+). Файл больше одного куска идёт S3 multipart
-- в закрытый бакет; куски — через бэкенд (routes/uploads.ts). Строка загрузки живёт от начала до сборки; после сборки
-- становится обычной строкой attachments (тот же id и storage_key) и стирается вместе со своими кусками.
-- Только добавление: новые таблицы и индекс, существующие данные не трогаются.
CREATE TABLE IF NOT EXISTS attachment_uploads (
  -- Будущий attachments.id.
  id text PRIMARY KEY,
  conversation_id text NOT NULL,
  owner_id text NOT NULL,
  storage_key text NOT NULL UNIQUE,
  -- id загрузки в хранилище (S3 UploadId).
  s3_upload_id text NOT NULL,
  name text NOT NULL,
  -- Тип со слов клиента; по содержимому — content_type, когда пришёл первый кусок (attachmentRules.resolveAttachmentMime).
  declared_type text NOT NULL,
  content_type text,
  size bigint NOT NULL,
  part_size integer NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  -- Каскад — только при удалении строки участника (удаление беседы, человека). Выход из группы строку не удаляет (ставит
  -- left_at): загрузки вышедшего стирает сам выход (convGroups.removeGroupMember), куски в хранилище подберёт уборка по
  -- списку незавершённых (bigUploads.purgeStaleUploads). Куски, статус и сборка вышедшему отвечают 404 (bigUploads.ownUpload).
  FOREIGN KEY (conversation_id, owner_id) REFERENCES conversation_members (conversation_id, user_id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS attachment_uploads_owner_idx ON attachment_uploads (owner_id, created_at);
CREATE INDEX IF NOT EXISTS attachment_uploads_created_idx ON attachment_uploads (created_at);

CREATE TABLE IF NOT EXISTS attachment_upload_parts (
  upload_id text NOT NULL REFERENCES attachment_uploads (id) ON DELETE CASCADE,
  part_number integer NOT NULL,
  etag text NOT NULL,
  size integer NOT NULL,
  PRIMARY KEY (upload_id, part_number)
);

-- Суточный предел объёма загрузок на человека (attachmentRules.DM_DAILY_UPLOAD_BYTES): сумма за 24 ч по владельцу.
CREATE INDEX IF NOT EXISTS attachments_owner_created_idx ON attachments (owner_id, created_at);
