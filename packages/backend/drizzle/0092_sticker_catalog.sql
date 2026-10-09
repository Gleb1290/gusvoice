-- Стикеры в ЛС (С2, #211, решение владельца Р-6): общий каталог наборов инстанса + «мои наборы» человека.
--
-- Каталог — строки `sticker_packs` БЕЗ сервера (`server_id IS NULL`). Наборы серверов остаются как были (их видят и
-- правят только на своём сервере), а каталожная копия того же набора делит с ними файлы в бакете: строки `stickers`
-- копируются со ссылками на те же картинки, второй раз из Telegram ничего не качается. Копия, а не ссылка на набор
-- сервера: удалили сервер или набор на нём — у людей в ЛС набор остаётся.
ALTER TABLE sticker_packs ALTER COLUMN server_id DROP NOT NULL;

-- Один набор Telegram в каталоге — один раз (имя набора у Telegram и есть его личность).
CREATE UNIQUE INDEX IF NOT EXISTS sticker_packs_catalog_name_uq ON sticker_packs (name) WHERE server_id IS NULL;
-- Предел «40 загруженных наборов на человека» считается по каталогу.
CREATE INDEX IF NOT EXISTS sticker_packs_catalog_owner_idx ON sticker_packs (created_by) WHERE server_id IS NULL;
-- «Добавить набор» из полученного стикера ищет набор по картинке: у копий одна и та же ссылка.
CREATE INDEX IF NOT EXISTS stickers_url_idx ON stickers (url);

-- Всё, что уже загружено на серверы инстанса, — сразу в каталоге: по одному набору на имя, от самого раннего импорта
-- (его загрузивший — «автор» в каталоге). id копий детерминированы: повторный прогон не плодит строк.
INSERT INTO sticker_packs (id, server_id, name, title, created_by, created_at)
SELECT DISTINCT ON (p.name) 'cat_' || md5(p.id), NULL, p.name, p.title, p.created_by, p.created_at
FROM sticker_packs p
WHERE p.server_id IS NOT NULL
ORDER BY p.name, p.created_at, p.id
ON CONFLICT DO NOTHING;

INSERT INTO stickers (id, pack_id, emoji, url, format, position)
SELECT 'cat_' || md5(s.id), 'cat_' || md5(p.id), s.emoji, s.url, s.format, s.position
FROM stickers s
JOIN sticker_packs p ON p.id = s.pack_id
JOIN sticker_packs c ON c.id = 'cat_' || md5(p.id) AND c.server_id IS NULL
ON CONFLICT DO NOTHING;

-- «Мои наборы» (как у Telegram): что человек добавил себе, в его порядке. Меньше `position` — выше в панели.
CREATE TABLE IF NOT EXISTS user_sticker_packs (
  user_id   text NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  pack_id   text NOT NULL REFERENCES sticker_packs(id) ON DELETE CASCADE,
  position  integer NOT NULL DEFAULT 0,
  added_at  timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (user_id, pack_id)
);
CREATE INDEX IF NOT EXISTS user_sticker_packs_order_idx ON user_sticker_packs (user_id, position);

-- Стикер в сообщении беседы — КОПИЕЙ, как в каналах (`messages.sticker`, 0028): удаление набора не оставит пустых строк.
ALTER TABLE conversation_messages ADD COLUMN IF NOT EXISTS sticker jsonb;
