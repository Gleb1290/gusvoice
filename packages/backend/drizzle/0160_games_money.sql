-- ГусКоины 2, этап 1: каркас денег мини-игр (28.10, `docs/guscoins-v2-plan.md`, `gameMoney.ts`).
--
-- Только фундамент: игр и маршрутов «сделать ставку» ещё нет, всё выключено по умолчанию.
-- Ставка — эскроу: монеты уходят из `balance` строкой журнала в момент ставки и висят в `game_stakes`
-- до выплаты или возврата. Комиссия строкой журнала не пишется — она сгорает (разница банка и выплат,
-- пишется в `game_rounds.data`). Баланс по-прежнему равен сумме журнала (`drift` пуст).

-- Настройки сервера: игры выключены; потолки — высокий предел сервера (самоограничение человека ниже).
-- `games_daily_loss_max` 0 = без потолка; `games_fee_percent` — комиссия дуэлей и прогнозов, сгорает.
ALTER TABLE server_economy ADD COLUMN IF NOT EXISTS games_enabled boolean NOT NULL DEFAULT false;
ALTER TABLE server_economy ADD COLUMN IF NOT EXISTS games_bet_max integer NOT NULL DEFAULT 300;
ALTER TABLE server_economy ADD COLUMN IF NOT EXISTS games_daily_loss_max integer NOT NULL DEFAULT 3000;
ALTER TABLE server_economy ADD COLUMN IF NOT EXISTS games_fee_percent integer NOT NULL DEFAULT 10;

-- Самоограничение человека. `games_loss_limit` NULL — как на сервере. Понижение — сразу; повышение
-- откладывается до начала следующих суток МСК: `games_loss_limit_raise_at` не пуст — повышение ждёт,
-- `games_loss_limit_raise` — его значение (NULL при непустой отметке = «как на сервере»).
ALTER TABLE coin_balances ADD COLUMN IF NOT EXISTS games_opt_out boolean NOT NULL DEFAULT false;
ALTER TABLE coin_balances ADD COLUMN IF NOT EXISTS games_loss_limit integer;
ALTER TABLE coin_balances ADD COLUMN IF NOT EXISTS games_loss_limit_raise integer;
ALTER TABLE coin_balances ADD COLUMN IF NOT EXISTS games_loss_limit_raise_at timestamptz;

-- Раунд игры: колесо, дуэль или прогноз. Индекс `(server_id, state)` — восстановление незакрытых
-- раундов после перезапуска.
CREATE TABLE IF NOT EXISTS game_rounds (
  id text PRIMARY KEY,
  server_id text NOT NULL REFERENCES servers(id) ON DELETE CASCADE,
  kind text NOT NULL,
  state text NOT NULL DEFAULT 'open',
  data jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_by text REFERENCES users(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  settled_at timestamptz
);
CREATE INDEX IF NOT EXISTS game_rounds_server_state_idx ON game_rounds (server_id, state);

-- Ставка = эскроу. Ключ `(round_id, user_id, pick)`: на колесе можно поставить на несколько чисел, а
-- повтор той же ставки упирается в ключ и второй раз денег не списывает. `paid_at`/`refunded_at` —
-- замки идемпотентности: выплата и возврат ставятся условным UPDATE по `IS NULL`.
CREATE TABLE IF NOT EXISTS game_stakes (
  round_id text NOT NULL REFERENCES game_rounds(id) ON DELETE CASCADE,
  user_id text NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  server_id text NOT NULL,
  pick text NOT NULL,
  amount integer NOT NULL CHECK (amount > 0),
  payout integer,
  paid_at timestamptz,
  refunded_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (round_id, user_id, pick)
);
CREATE INDEX IF NOT EXISTS game_stakes_user_idx ON game_stakes (user_id);

-- Второй рубеж от двойного движения денег: одна строка журнала на (раунд, выбор, человек, причина).
-- Первый — условный UPDATE `game_stakes` в той же транзакции.
CREATE UNIQUE INDEX IF NOT EXISTS coin_ledger_game_once_uq
  ON coin_ledger ((data->>'roundId'), (data->>'pick'), user_id, reason)
  WHERE reason IN ('wheel.bet', 'wheel.win', 'wheel.refund', 'duel.stake', 'duel.win', 'duel.refund',
                   'prediction.bet', 'prediction.win', 'prediction.refund');
