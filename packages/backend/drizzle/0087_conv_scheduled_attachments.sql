-- ЛС, С4 + вложения (06.10, признак `conv10`): отложенное сообщение («Отправить позже» / «Когда будет в сети») с файлами.
--
-- Файлы загружаются сразу, как при обычной отправке (`POST /conv/:id/attachments`: строка `attachments` в `pending`, файл —
-- в закрытом бакете), а при создании отложенного «паркуются» за ним: `state = 'scheduled'` + `scheduled_id`. Вытеснение
-- незавершённых (`attachments.createPending`) и уборка просроченных `pending` таких строк не трогают. Уходит отложенное —
-- строки становятся `attached` (как при обычной отправке, `conversations.sendMessage`); удаляется отложенное или аккаунт
-- автора — `deleted`, файлы стираются после фиксации (`purgeDeleted`).
--
-- Порядок вложений и подсказки клиента (размеры картинки, огибающая голосового) — в самом отложенном:
-- `conversation_scheduled.attachments`, в том же виде, что `conversation_messages.attachments` (ссылка — заглушка, настоящую
-- выдача собирает под смотрящего).
--
-- 🔴 `attachments.scheduled_id` — ОТЛОЖЕННАЯ проверка ссылки (DEFERRABLE INITIALLY DEFERRED, без каскада): строку
-- отложенного нельзя удалить, пока на неё ссылаются её файлы, — это проверяется при фиксации. Новый бэкенд в той же
-- транзакции сперва уводит файлы (`attached` / `deleted`, `scheduled_id = NULL`). Бэкенд до `conv10` (откат или второй
-- процесс на той же базе) о файлах не знает: его такт отправил бы такое отложенное ОДНИМ ТЕКСТОМ, а удаление оставило бы
-- файлы без хозяина, — теперь такая транзакция не фиксируется: такт повторит позже, а после всех попыток пометит
-- «не отправлено». Лучше «не отправлено», чем подпись без фото у собеседника.
-- CHECK `attachments_scheduled_check`: состояние `scheduled` ⇔ есть `scheduled_id`.
--
-- Только добавления: новый столбец с умолчанием, новый столбец без значения, CHECK состояния — шире прежнего. Старый бэкенд
-- новых столбцов не читает, своих вставок не меняет (умолчания подходят под оба CHECK).
ALTER TABLE conversation_scheduled ADD COLUMN IF NOT EXISTS attachments jsonb NOT NULL DEFAULT '[]'::jsonb;

ALTER TABLE attachments ADD COLUMN IF NOT EXISTS scheduled_id text
  REFERENCES conversation_scheduled(id) DEFERRABLE INITIALLY DEFERRED;

ALTER TABLE attachments DROP CONSTRAINT IF EXISTS attachments_state_check;
ALTER TABLE attachments ADD CONSTRAINT attachments_state_check
  CHECK (state IN ('pending', 'attached', 'deleted', 'scheduled'));
ALTER TABLE attachments DROP CONSTRAINT IF EXISTS attachments_scheduled_check;
ALTER TABLE attachments ADD CONSTRAINT attachments_scheduled_check
  CHECK ((state = 'scheduled') = (scheduled_id IS NOT NULL));

-- Файлы отложенного (отправка, удаление) и проверка ссылки при удалении строки отложенного.
CREATE INDEX IF NOT EXISTS attachments_scheduled_idx ON attachments (scheduled_id) WHERE scheduled_id IS NOT NULL;
-- Предел объёма «припаркованных» файлов на человека (`scheduleRules.SCHEDULED_MEDIA_BYTES_PER_USER_MAX`).
CREATE INDEX IF NOT EXISTS attachments_owner_scheduled_idx ON attachments (owner_id) WHERE state = 'scheduled';
