-- Кэш предпросмотра ссылок (#64).
--
-- Кэш здесь не про скорость, а про приличия и безопасность: без него КАЖДЫЙ рендер сообщения со
-- ссылкой = новый запрос нашего сервера наружу. Двадцать человек открыли канал — двадцать запросов
-- на чужой сайт с одного IP, и это уже похоже на атаку. Плюс так виден потолок исходящего трафика.
--
-- Ключ — url целиком, а не хэш: на длину URL стоит ограничение в коде, а по префиксу удобно искать
-- глазами при разборе. `ok = false` кэшируется ТОЖЕ (с более коротким TTL в коде) — иначе битая
-- ссылка в популярном канале долбится наружу при каждом рендере.
CREATE TABLE IF NOT EXISTS link_previews (
  url          text PRIMARY KEY,
  ok           boolean NOT NULL,
  title        text,
  description  text,
  image_url    text,
  site_name    text,
  fetched_at   timestamptz NOT NULL DEFAULT now()
);

-- Чистка протухших идёт по времени.
CREATE INDEX IF NOT EXISTS link_previews_fetched_idx ON link_previews (fetched_at);
