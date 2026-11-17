-- ГусКоины 2, этап 5: «Ставки на события» (прогнозы; 28.10, `docs/guscoins-v2-plan.md`, `gamePredictions.ts`).
--
-- Событие уровня сервера — строка `prediction_events`; его вопросы — строки `game_rounds kind = 'prediction'`
-- (`data = {eventId, pos, question, options:[{id,label}], feePercent, winnerOptionId?, void?, pool?, fee?}`), ставки —
-- `game_stakes` (`pick` = id варианта). Состояние вопросов = состояние события: закрываются, рассчитываются и
-- отменяются разом, одной транзакцией. `open` → (таймер `lock_at` или «Закрыть») `locked` → итог `settled` | `cancelled`.
-- `fee_percent` заморожен при создании (`server_economy.games_fee_percent`), берётся только с проигравшего пула.
-- `settled_at` — конец события: итог ИЛИ отмена (по нему снимок держит закончившиеся сутки).
-- `created_by` — как у `game_rounds`: аккаунт обезличивается, а не удаляется (`accountRows.ts`); живые события
-- удаляемого создателя отменяет `gameMoney.cancelPredictionsOf` с возвратом всех ставок.
CREATE TABLE IF NOT EXISTS prediction_events (
  id text PRIMARY KEY,
  server_id text NOT NULL REFERENCES servers(id) ON DELETE CASCADE,
  created_by text REFERENCES users(id) ON DELETE SET NULL,
  title text NOT NULL,
  state text NOT NULL DEFAULT 'open' CHECK (state IN ('open', 'locked', 'settled', 'cancelled')),
  fee_percent integer NOT NULL DEFAULT 10 CHECK (fee_percent >= 0 AND fee_percent <= 100),
  lock_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  locked_at timestamptz,
  settled_at timestamptz,
  cancel_reason text
);

-- Лента сервера и предел «≤ 3 живых на сервер».
CREATE INDEX IF NOT EXISTS prediction_events_server_state_idx ON prediction_events (server_id, state);
-- Такт: созревший таймер закрытия и автоотмена закрытого без итога.
CREATE INDEX IF NOT EXISTS prediction_events_lock_due_idx ON prediction_events (lock_at) WHERE state = 'open';
CREATE INDEX IF NOT EXISTS prediction_events_locked_idx ON prediction_events (locked_at) WHERE state = 'locked';
-- Удаление аккаунта создателя: его живые события.
CREATE INDEX IF NOT EXISTS prediction_events_creator_live_idx ON prediction_events (created_by) WHERE state IN ('open', 'locked');
-- Вопросы события.
CREATE INDEX IF NOT EXISTS game_rounds_prediction_event_idx ON game_rounds ((data->>'eventId')) WHERE kind = 'prediction';
