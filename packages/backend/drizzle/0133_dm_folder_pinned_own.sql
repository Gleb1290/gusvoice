-- Свой НАБОР закреплённых в папке бесед (09.10, #211, решение владельца; признак `pinset1`): как `pinned_peers` фильтра у
-- Telegram. `true` — `pinned_ids` папки = её закреплённые (набор и порядок), общий закреп (`conversation_members.pinned_at`)
-- в ней не действует; `false` — прежний смысл `pinorder2` (`pinned_ids` = порядок общих закреплённых). Переводит клиент с
-- `pinset1` один раз (`POST /api/dm-folders/pinned-own`) — набор = текущие закреплённые папки в её порядке.
-- Только добавление: старый бэкенд колонку не знает, старый клиент поле `pinnedOwn` не читает.
ALTER TABLE dm_folders ADD COLUMN IF NOT EXISTS pinned_own boolean NOT NULL DEFAULT false;
