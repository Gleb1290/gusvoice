-- Экономика сервера GusCoins (#117, план — docs/guscoins-plan.md).
--
-- Три таблицы: настройки сервера (то, что крутится ползунками), кошельки и журнал операций.

-- Настройки экономики. Строки нет => экономика выключена и все значения по умолчанию.
--
-- 🔴 Все числа ЗДЕСЬ, а не в коде: ставку и множители владелец крутит сам, без правки кода и без
-- релиза. Умолчания взяты от Twitch (10 баллов за 5 минут) и Arcane (25 XP за 5 минут) — порядок
-- величин у обоих один, и наш должен встать рядом.
CREATE TABLE IF NOT EXISTS server_economy (
  server_id text PRIMARY KEY REFERENCES servers(id) ON DELETE CASCADE,
  -- Выключено по умолчанию: чужой владелец не должен обнаружить у себя игровую валюту, просто
  -- обновившись (тот же принцип, что у DIAG_ENABLED).
  enabled boolean NOT NULL DEFAULT false,
  currency_name text NOT NULL DEFAULT 'ГусКоины',
  icon_url text,
  rate_per_5min integer NOT NULL DEFAULT 10,
  -- Один в канале — четверть ставки. Не ноль: зашедший первым и ждущий друзей должен получать,
  -- иначе привычка «сижу в канале, подтягивайтесь» наказывается, а пустой канал никого не притянет.
  alone_percent integer NOT NULL DEFAULT 25,
  company_percent integer NOT NULL DEFAULT 150,
  daily_cap integer NOT NULL DEFAULT 400,
  decay_after_minutes integer NOT NULL DEFAULT 120,
  decay_percent integer NOT NULL DEFAULT 50,
  ignore_muted boolean NOT NULL DEFAULT false,
  ignore_deafened boolean NOT NULL DEFAULT true,
  tip_amount integer NOT NULL DEFAULT 5,
  tip_tax_percent integer NOT NULL DEFAULT 20,
  tip_daily_out integer NOT NULL DEFAULT 100,
  tip_daily_in integer NOT NULL DEFAULT 100,
  -- Отметка «ретроначисление за сухой прогон уже выдано»: операция обязана быть одноразовой, иначе
  -- повторный запуск удвоит всем балансы.
  retro_granted_at timestamptz,
  updated_at timestamptz NOT NULL DEFAULT now()
);

-- Кошелёк: пара «сервер + человек».
--
-- 🔴 Три счётчика, а не один. `balance` тратится; `earned_total` не убывает НИКОГДА (по нему уровни
-- и звания — иначе покупка отбрасывает человека назад в статусе, и копить выгоднее, чем тратить);
-- `season_earned` обнуляется на границе сезона и кормит таблицу лидеров.
-- ⚠️ `earned_total` и `season_earned` растут ТОЛЬКО от своих источников (голос, гусь, стрик).
-- Входящие типы и ручные выдачи пополняют лишь `balance` — иначе уровни и место в топе покупаются,
-- а это ровно то, ради чего заводят альтов.
CREATE TABLE IF NOT EXISTS coin_balances (
  server_id text NOT NULL REFERENCES servers(id) ON DELETE CASCADE,
  user_id text NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  balance integer NOT NULL DEFAULT 0,
  earned_total integer NOT NULL DEFAULT 0,
  season_earned integer NOT NULL DEFAULT 0,
  season_id text NOT NULL DEFAULT '',
  -- Недоначисленные тысячные монеты. Без переноса остатка округление вниз на каждом срезе
  -- обкрадывало бы человека почти на полмонеты шестьдесят раз в час.
  carry_milli integer NOT NULL DEFAULT 0,
  -- Сутки экономики. Граница — МЕСТНАЯ полночь (МСК), а не полночь UTC: по UTC она наступала бы в
  -- три часа ночи по Москве, то есть посреди вечера у половины людей.
  day text NOT NULL DEFAULT '',
  seconds_today integer NOT NULL DEFAULT 0,
  earned_today integer NOT NULL DEFAULT 0,
  given_today integer NOT NULL DEFAULT 0,
  received_today integer NOT NULL DEFAULT 0,
  -- Человек может не участвовать: не копит и не попадает в таблицу лидеров. Отказ — нормальный
  -- выбор, а не наказание.
  opted_out boolean NOT NULL DEFAULT false,
  PRIMARY KEY (server_id, user_id)
);

-- Журнал операций. Без него вопрос «было 500, стало 300, куда делись» не имеет ответа, а задним
-- числом журнал не восстанавливается: не заведёшь сразу — не заведёшь никогда.
CREATE TABLE IF NOT EXISTS coin_ledger (
  id text PRIMARY KEY,
  server_id text NOT NULL REFERENCES servers(id) ON DELETE CASCADE,
  user_id text NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  -- Со знаком: плюс — приход, минус — расход.
  amount integer NOT NULL,
  -- 'voice' | 'tip.out' | 'tip.in' | 'grant' | 'retro' | 'rescale'
  reason text NOT NULL,
  -- Вторая сторона операции (у типа — кто кому).
  ref_user_id text REFERENCES users(id) ON DELETE SET NULL,
  data jsonb NOT NULL DEFAULT '{}',
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS coin_ledger_wallet_idx ON coin_ledger (server_id, user_id, created_at DESC);
