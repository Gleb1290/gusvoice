-- Избранные и недавние стикеры ЛС на сервере (С2 порция 2, #211, признак stickers3) — синхронно на всех устройствах человека,
-- как у Telegram (tdesktop `Data::Stickers::FavedSetId` / `RecentSetId`, лимит избранных `stickers_faved_limit_default` = 5).
-- Только добавления (правило 11): старый код таблиц не знает. Ссылка на строку стикера каталога — набор убрали из каталога,
-- стикер уходит из списков сам (каскад); удаление аккаунта — тоже каскад (и явная чистка в accountRows.ts).
CREATE TABLE IF NOT EXISTS user_faved_stickers (
  user_id     text NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  sticker_id  text NOT NULL REFERENCES stickers(id) ON DELETE CASCADE,
  added_at    timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (user_id, sticker_id)
);
CREATE INDEX IF NOT EXISTS user_faved_stickers_order_idx ON user_faved_stickers (user_id, added_at DESC);

CREATE TABLE IF NOT EXISTS user_recent_stickers (
  user_id     text NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  sticker_id  text NOT NULL REFERENCES stickers(id) ON DELETE CASCADE,
  used_at     timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (user_id, sticker_id)
);
CREATE INDEX IF NOT EXISTS user_recent_stickers_order_idx ON user_recent_stickers (user_id, used_at DESC);
