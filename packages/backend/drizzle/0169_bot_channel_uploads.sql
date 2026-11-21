-- Бюджет публичных вложений бота на всех серверах за скользящие сутки.
-- Запись создаётся перед MinIO и переживает удаление сообщения и перезапуск процесса.
CREATE TABLE bot_channel_upload_reservations (
  id text PRIMARY KEY,
  bot_id text NOT NULL REFERENCES bots(user_id) ON DELETE CASCADE,
  bytes integer NOT NULL CHECK (bytes > 0),
  reserved_at timestamptz NOT NULL DEFAULT statement_timestamp()
);
CREATE INDEX bot_channel_upload_by_bot_idx ON bot_channel_upload_reservations (bot_id, reserved_at);
CREATE INDEX bot_channel_upload_expiry_idx ON bot_channel_upload_reservations (reserved_at);
