-- Свой порядок закреплённых в каждой папке бесед (09.10, #211, решение владельца; признак `pinorder2`): как `pinned_peers`
-- фильтра у Telegram. Закреплённые беседы папки сверху вниз; пусто — общий порядок по `conversation_members.pinned_at`.
-- Только добавление: старый бэкенд колонку не трогает (правка папки её не переписывает), старый клиент поле не знает.
ALTER TABLE dm_folders ADD COLUMN IF NOT EXISTS pinned_ids text[] NOT NULL DEFAULT '{}';
