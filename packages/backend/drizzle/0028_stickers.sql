-- Стикеры из Telegram (#68, часть 2).
--
-- Файлы лежат в MinIO (префикс `stickers/`), здесь только записи о них — как у эмодзи и аватаров.
CREATE TABLE IF NOT EXISTS sticker_packs (
  id          text PRIMARY KEY,
  server_id   text NOT NULL REFERENCES servers(id) ON DELETE CASCADE,
  -- Имя набора у Telegram (t.me/addstickers/<name>). Проверяется shared/stickerRules.ts на обеих
  -- сторонах: оно подставляется в путь запроса к Bot API.
  name        text NOT NULL,
  title       text NOT NULL,
  created_by  text REFERENCES users(id) ON DELETE SET NULL,
  created_at  timestamptz NOT NULL DEFAULT now()
);

-- Один и тот же набор нельзя импортировать дважды на один сервер: иначе в пикере двоятся
-- одинаковые картинки, а место в бакете тратится вдвое.
CREATE UNIQUE INDEX IF NOT EXISTS sticker_packs_name_uq ON sticker_packs (server_id, name);
CREATE INDEX IF NOT EXISTS sticker_packs_server_idx ON sticker_packs (server_id);

CREATE TABLE IF NOT EXISTS stickers (
  id        text PRIMARY KEY,
  pack_id   text NOT NULL REFERENCES sticker_packs(id) ON DELETE CASCADE,
  -- Подпись-эмодзи из Telegram: именно по ней стикер ищут в пикере.
  emoji     text NOT NULL DEFAULT '',
  url       text NOT NULL,
  -- 'webp' | 'tgs' | 'webm' — от формата зависит, чем рисовать (картинка / Lottie / видео).
  format    text NOT NULL,
  -- Порядок внутри набора: в Telegram он осмысленный, и терять его не надо.
  position  integer NOT NULL DEFAULT 0
);

CREATE INDEX IF NOT EXISTS stickers_pack_idx ON stickers (pack_id, position);

-- Стикер в сообщении хранится КОПИЕЙ, а не ссылкой на строку выше.
-- Удаление набора иначе оставило бы в истории пустые сообщения без следа того, что там было;
-- ровно поэтому вложения тоже лежат в самом сообщении.
ALTER TABLE messages ADD COLUMN IF NOT EXISTS sticker jsonb;
