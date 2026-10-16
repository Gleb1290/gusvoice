-- ЛС между инстансами, этап Э3 часть 1 (#141, docs/dm/FEDERATION.md §3.5, Ф3): вложения из копий сообщений соседа.
--
-- Копия сообщения человека другого инстанса несёт метаданные файлов; у нас каждое — строка `attachments` в НОВОМ состоянии
-- `remote` (файл ещё лежит только у дома автора), `origin_instance_id` — его инстанс, `owner_id` — теневой автор, `id` —
-- глобальный id из провода. Файл до 25 МБ мы копируем к себе сразу (`federation/convAtt.ts`): удалось — `attached`.
--
-- `storage_key` (UNIQUE NOT NULL) не ослабляется: у `remote` он сразу равен будущему ключу копии (`dm/<id>`), а «файла ещё
-- нет» выражает само состояние. Так старому коду не встречается пустой ключ, а уникальность продолжает ловить столкновение id.
--
-- Только добавления: новый столбец без значения; CHECK состояния — шире прежнего (старый бэкенд `remote` не пишет; его
-- выдача `/api/att` такую строку отдаёт 404 — файла по ключу нет); новый CHECK держит `remote` ⇒ известен дом файла.
ALTER TABLE attachments ADD COLUMN IF NOT EXISTS origin_instance_id text;

ALTER TABLE attachments DROP CONSTRAINT IF EXISTS attachments_state_check;
ALTER TABLE attachments ADD CONSTRAINT attachments_state_check
  CHECK (state IN ('pending', 'attached', 'deleted', 'scheduled', 'remote'));
ALTER TABLE attachments DROP CONSTRAINT IF EXISTS attachments_remote_check;
ALTER TABLE attachments ADD CONSTRAINT attachments_remote_check
  CHECK (state <> 'remote' OR origin_instance_id IS NOT NULL);

-- Очередь копирования: не скопированные файлы по дому (повтор после сбоя соседа, такт раз в минуту).
CREATE INDEX IF NOT EXISTS attachments_remote_idx ON attachments (origin_instance_id, created_at) WHERE state = 'remote';
