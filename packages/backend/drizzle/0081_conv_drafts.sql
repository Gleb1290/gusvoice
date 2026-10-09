-- ЛС, Р7 (01.10, #211): черновик беседы ездит между МОИМИ устройствами — у моей строки участника. Пусто (ни текста,
-- ни ответа) = все поля NULL. `draft_device` — метка устройства-автора: своё эхо клиент не применяет.
ALTER TABLE conversation_members
  ADD COLUMN IF NOT EXISTS draft_text text,
  ADD COLUMN IF NOT EXISTS draft_reply_to text,
  ADD COLUMN IF NOT EXISTS draft_at timestamptz,
  ADD COLUMN IF NOT EXISTS draft_device text;

-- Строка журнала «черновик» — себе, как «прочитано»: остальные мои устройства получают сводку с новым черновиком.
-- Старый бэкенд (откат) такие строки читает как любые другие: догонка собирает по ним беседы, вид строки не разбирает.
ALTER TABLE user_changes DROP CONSTRAINT IF EXISTS user_changes_kind_check;
ALTER TABLE user_changes ADD CONSTRAINT user_changes_kind_check CHECK (kind IN ('msg', 'read', 'conv', 'draft'));
