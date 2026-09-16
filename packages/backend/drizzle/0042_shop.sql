-- Магазин наград и чеки покупок (этап 3-4, зонтик #117).
--
-- 🔴 **`price_minutes`, а не `price_coins`.** Цена хранится в МИНУТАХ сидения в голосе, а в монеты
-- пересчитывается сервером в момент покупки по текущей ставке. Иначе один сдвиг ползунка ставки
-- разом ломает весь прайс: вчера награда стоила вечер, сегодня — пять минут. Приём взят у Twitch,
-- где цены наград и назначают в минутах просмотра.
--
-- ⚠️ Строки может не быть вовсе: пока владелец не трогал каталог, действуют умолчания из
-- `shopRules.ts`. Так магазин работает «из коробки» на свежем сервере, и turnkey-инстансу не нужно
-- ничего заполнять руками.
CREATE TABLE IF NOT EXISTS server_shop (
  server_id     text NOT NULL REFERENCES servers(id) ON DELETE CASCADE,
  item          text NOT NULL,
  price_minutes integer NOT NULL,
  enabled       boolean NOT NULL DEFAULT true,
  updated_at    timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (server_id, item)
);

-- Чек на КАЖДУЮ покупку.
--
-- 🔴 Хранит не только «что купил», но и **по какой цене и при какой ставке**: `price_minutes`,
-- реально списанные монеты и версия ставки. Без этого спор «сколько это стоило в тот вторник»
-- неразрешим, а ставку первый месяц будут двигать часто.
-- ⚠️ Уже выданное по новому каталогу НЕ пересчитывается никогда — чек фиксирует условия сделки.
--
-- `expires_at` — для срочных наград (приоритет речи на N минут, звук входа на неделю). У расходников
-- вроде МЕГА пока он NULL: эффект случился и кончился, продлевать нечего.
-- `target_user_id` — кому адресована награда, если она адресная. Без FK-каскада на удаление НЕ
-- обойтись: чек должен пережить уход человека, поэтому ссылка обнуляется, а строка остаётся.
CREATE TABLE IF NOT EXISTS coin_purchases (
  id             text PRIMARY KEY,
  server_id      text NOT NULL REFERENCES servers(id) ON DELETE CASCADE,
  user_id        text NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  item           text NOT NULL,
  price_minutes  integer NOT NULL,
  price_coins    integer NOT NULL,
  rate_per_5min  integer NOT NULL,
  target_user_id text REFERENCES users(id) ON DELETE SET NULL,
  data           jsonb NOT NULL DEFAULT '{}'::jsonb,
  expires_at     timestamptz,
  created_at     timestamptz NOT NULL DEFAULT now()
);

-- «Что я покупал» и «действует ли ещё» — два вопроса, два индекса.
CREATE INDEX IF NOT EXISTS coin_purchases_wallet_idx ON coin_purchases (server_id, user_id, created_at);
CREATE INDEX IF NOT EXISTS coin_purchases_active_idx ON coin_purchases (server_id, item, expires_at)
  WHERE expires_at IS NOT NULL;
