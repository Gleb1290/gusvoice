-- Мои GIF (Р-7, #211, признак gifs1): сохранённые GIF человека на сервере — одни на всех его устройствах, как у Telegram
-- (tdesktop `chat_helpers/gifs_list_widget.cpp`, «Сохранить GIF» в меню, `messages.saveGif`; предел `saved_gifs_limit` = 200,
-- новые — первыми, повторное сохранение поднимает наверх). Файл — СВОЯ копия в закрытом хранилище (`gif/<id>`), а не ссылка
-- на вложение сообщения: сообщение удалят — GIF остаётся. Только добавления (правило 11): старый код таблицы не знает.
-- Удаление аккаунта — каскад (файлы уберёт accountRows вместе с вложениями человека).
CREATE TABLE IF NOT EXISTS user_saved_gifs (
  id            text PRIMARY KEY,
  user_id       text NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  storage_key   text NOT NULL,
  content_type  text NOT NULL,
  size          integer NOT NULL,
  width         integer,
  height        integer,
  duration_ms   integer,
  -- Откуда сохранён (id вложения или адрес у поставщика) — повторное сохранение того же поднимает строку, а не плодит копию.
  origin        text NOT NULL,
  added_at      timestamptz NOT NULL DEFAULT now(),
  UNIQUE (user_id, origin)
);
CREATE INDEX IF NOT EXISTS user_saved_gifs_order_idx ON user_saved_gifs (user_id, added_at DESC);
