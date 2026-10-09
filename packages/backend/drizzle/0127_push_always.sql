-- «Исключения: уведомления включены» (08.10, #211, решение владельца 38, признак `push4`). Только добавление: старый код
-- таблицы не знает. Строка = «беседа уведомляет, хотя общий выключатель её вида выключен» (как Telegram `notify2_<did>` = 0
-- поверх выключенных «Личные чаты»): scope='dm_user', target_id — id собеседника 1:1 или `group:<id беседы>`.
-- Заглушки (`push_mutes`) не трогаются; у беседы действует одно из двух — ставя одно, сервер снимает другое.
CREATE TABLE IF NOT EXISTS push_always (
  user_id text NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  scope text NOT NULL,
  target_id text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (user_id, scope, target_id)
);
