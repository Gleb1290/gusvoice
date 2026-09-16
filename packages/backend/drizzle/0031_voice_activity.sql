-- Сырая статистика присутствия в голосе — ШАГ 0 экономики GusCoins (docs/guscoins-plan.md).
--
-- Пишем СЕКУНДЫ и обстановку, а НЕ монеты: ставка, множитель компании, затухание и потолок ещё не
-- назначены, их назначат по этим же данным. По сырым секундам можно пересчитать любую формулу
-- задним числом; по посчитанным монетам — никакую.
--
-- Строка = один отрезок присутствия одного человека (срез раз в минуту). Объём: ~17 человек по
-- несколько часов в день — сотни строк в сутки.
CREATE TABLE IF NOT EXISTS voice_activity (
  id text PRIMARY KEY,
  server_id text NOT NULL REFERENCES servers(id) ON DELETE CASCADE,
  user_id text NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  -- Без внешнего ключа НАМЕРЕННО: канал могут удалить, а факт «человек тут сидел» от этого не
  -- перестаёт быть фактом. Каскад стёр бы часть недели вместе с удалённым каналом.
  channel_id text NOT NULL,
  seconds integer NOT NULL,
  -- Сколько ДРУГИХ живых людей было в канале в этот момент: по этому столбцу и подбирается
  -- множитель компании, главный анти-фарм-рычаг.
  peers integer NOT NULL,
  muted boolean NOT NULL DEFAULT false,
  deafened boolean NOT NULL DEFAULT false,
  screensharing boolean NOT NULL DEFAULT false,
  created_at timestamptz NOT NULL DEFAULT now()
);

-- Оба разреза, по которым эти данные будут читать: «что было на сервере за неделю» и
-- «сколько вышло у конкретного человека».
CREATE INDEX IF NOT EXISTS voice_activity_server_created_idx ON voice_activity (server_id, created_at);
CREATE INDEX IF NOT EXISTS voice_activity_user_created_idx ON voice_activity (user_id, created_at);
