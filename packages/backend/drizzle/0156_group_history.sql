-- Аудит ЛС #236, п.8 (решения владельца 26.10): «История для новых» — настройка создателя группы.
-- conversations.history_for_new — новые участники видят сообщения до своего добавления. У НОВЫХ групп по умолчанию СКРЫТА (false);
--   у УЖЕ существующих групп — видна (true): они ведут себя как раньше, создатель может выключить.
-- conversation_members.history_from_key — с какого ключа порядка (`sort_key`) участнику видна лента; ставится при
--   добавлении, когда история скрыта (ключ записи «добавил»). NULL — видно всё: у всех уже состоящих участников и у
--   создателей ничего не пропадает.
ALTER TABLE conversations ADD COLUMN IF NOT EXISTS history_for_new boolean NOT NULL DEFAULT true;
ALTER TABLE conversations ALTER COLUMN history_for_new SET DEFAULT false;
ALTER TABLE conversation_members ADD COLUMN IF NOT EXISTS history_from_key bigint;
