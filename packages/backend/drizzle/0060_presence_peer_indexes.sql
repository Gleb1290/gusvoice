-- Индексы под адресную рассылку онлайна и статусов (#136).
--
-- Шлюз больше не шлёт `online.*` / `user.*` всему инстансу: получатели — те, с кем у человека есть
-- общий сервер или ЛС (`gateway.ts` → `loadPeers`). Этот запрос идёт по `server_members.user_id` и по
-- `dm_channels.user_b`, а у обеих таблиц ключ начинается с ДРУГОЙ колонки (`(server_id, user_id)` и
-- уникальность `(user_a, user_b)`), так что без индексов это полный проход таблицы на каждый вход в сеть.
CREATE INDEX IF NOT EXISTS server_members_user_idx ON server_members (user_id);
CREATE INDEX IF NOT EXISTS dm_channels_user_b_idx ON dm_channels (user_b);
