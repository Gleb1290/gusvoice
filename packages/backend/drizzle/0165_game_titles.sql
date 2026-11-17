-- ГусКоины 2, этап 6: лидерборд игр, звания месяца и «Итоги» (28.10, `docs/guscoins-v2-plan.md`, `gameMonths.ts`).
--
-- 🔴 Итоги ЗАМОРАЖИВАЮТСЯ, а не считаются на лету (как `season_results`, `seasons.ts`): поздняя правка данных не должна
-- задним числом отнимать звание, а срезы голоса живут 90 дней — итог квартала потом уже не пересчитать.
-- Игровой месяц — календарный месяц МСК (`coinRules.seasonId(at, 'month')`) независимо от длины сезона сервера.

-- Последний закрытый игровой месяц сервера: первое наблюдение просто запоминает текущий, дальше смена = заморозка.
ALTER TABLE server_economy ADD COLUMN IF NOT EXISTS closed_game_month_id text;

-- Замороженный лидерборд игр месяца: чистый результат за месяц и место; `stats` — разбивка по играм, джекпоты, дуэли.
-- `user_id` удерживается при удалении аккаунта, как `season_results` (аккаунт обезличивается, каскад не срабатывает).
CREATE TABLE IF NOT EXISTS game_month_results (
  server_id text NOT NULL REFERENCES servers(id) ON DELETE CASCADE,
  month_id text NOT NULL,
  user_id text NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  net integer NOT NULL,
  place integer NOT NULL,
  stats jsonb NOT NULL DEFAULT '{}'::jsonb,
  frozen_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (server_id, month_id, user_id)
);

-- Выданные звания месяца: одно звание может достаться нескольким (равенство — «всем»). `value` — число повода в единицах
-- звания (`GAME_TITLE_UNIT`, shared `gameTitles.ts`). Удерживается при удалении аккаунта, как и лидерборд.
CREATE TABLE IF NOT EXISTS game_titles_awarded (
  server_id text NOT NULL REFERENCES servers(id) ON DELETE CASCADE,
  month_id text NOT NULL,
  title_key text NOT NULL,
  user_id text NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  value integer NOT NULL DEFAULT 0,
  awarded_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (server_id, month_id, title_key, user_id)
);
-- Последние звания человека (чип в таблице, карточка).
CREATE INDEX IF NOT EXISTS game_titles_awarded_user_idx ON game_titles_awarded (server_id, user_id, month_id);

-- Переименование званий владельцем сервера. Нет строки — название по умолчанию (`DEFAULT_GAME_TITLE_NAMES`).
CREATE TABLE IF NOT EXISTS server_game_titles (
  server_id text NOT NULL REFERENCES servers(id) ON DELETE CASCADE,
  title_key text NOT NULL,
  name text NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (server_id, title_key)
);

-- Замороженные «Итоги»: `kind` — 'economy' (сезон экономики) | 'games' (месяц игр); `user_id` '' — общая часть сервера,
-- иначе личная (отказавшимся строки нет). Без ссылки на `users`: у общей строки пусто.
CREATE TABLE IF NOT EXISTS season_recaps (
  server_id text NOT NULL REFERENCES servers(id) ON DELETE CASCADE,
  kind text NOT NULL CHECK (kind IN ('economy', 'games')),
  period_id text NOT NULL,
  user_id text NOT NULL DEFAULT '',
  data jsonb NOT NULL DEFAULT '{}'::jsonb,
  frozen_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (server_id, kind, period_id, user_id)
);

-- Агрегаты месяца без `user_id`: игровые строки журнала сервера за окно и рассчитанные раунды по виду.
CREATE INDEX IF NOT EXISTS coin_ledger_game_month_idx ON coin_ledger (server_id, created_at)
  WHERE reason IN ('wheel.bet', 'wheel.win', 'wheel.refund', 'wheel.jackpot', 'duel.stake', 'duel.win', 'duel.refund',
                   'prediction.bet', 'prediction.win', 'prediction.refund');
CREATE INDEX IF NOT EXISTS game_rounds_settled_idx ON game_rounds (server_id, kind, settled_at) WHERE state = 'settled';
