-- ГусКоины 2, этап 2: «Колесо гусей-пиратов» (28.10, `docs/guscoins-v2-plan.md`, `gameWheel.ts`).
--
-- Раунд колеса живёт строкой `game_rounds` (этап 1): open → locked → settled | cancelled. Сроки — колонками, а не в
-- `data`: такт (`gameWheel.ts`, раз в секунду) ищет созревшие раунды по индексу, и после перезапуска бэкенда первый же
-- такт подбирает просроченное — таймеров в памяти нет.

-- Конец окна ставок и момент итога. У не-колёсных раундов пусто.
ALTER TABLE game_rounds ADD COLUMN IF NOT EXISTS lock_at timestamptz;
ALTER TABLE game_rounds ADD COLUMN IF NOT EXISTS settle_at timestamptz;

-- 🔴 Одно живое колесо на сервер. Две первые ставки в одну миллисекунду обе пытаются завести раунд — вторая упирается
-- сюда (`ON CONFLICT DO NOTHING`) и ставит в уже заведённый.
CREATE UNIQUE INDEX IF NOT EXISTS game_rounds_wheel_live_uq
  ON game_rounds (server_id) WHERE kind = 'wheel' AND state IN ('open', 'locked');

-- Такт: созревшие по `lock_at` (открытые) и по `settle_at` (запертые).
CREATE INDEX IF NOT EXISTS game_rounds_wheel_lock_idx
  ON game_rounds (kind, state, lock_at) WHERE state = 'open';
CREATE INDEX IF NOT EXISTS game_rounds_wheel_settle_idx
  ON game_rounds (kind, state, settle_at) WHERE state = 'locked';
-- Снимок и пауза после итога: последний рассчитанный раунд колеса сервера.
CREATE INDEX IF NOT EXISTS game_rounds_wheel_last_idx
  ON game_rounds (server_id, settled_at DESC) WHERE kind = 'wheel' AND state = 'settled';

-- Сундук-джекпот сервера, в СОТЫХ монеты: взнос 1.5 % ставки дробный, а округлять каждую ставку вниз значило бы
-- не копить ничего на мелких ставках. Взнос — из доли дома (выплаты колеса не уменьшаются), при отмене раунда
-- не возвращается.
ALTER TABLE server_economy ADD COLUMN IF NOT EXISTS wheel_jackpot_cents bigint NOT NULL DEFAULT 0;

-- Новая причина журнала `wheel.jackpot` (доля сундука, `data: {roundId, pick: 'jackpot'}`). Второй рубеж от двойной
-- выплаты (0160) перечисляет причины — пересоздаём с ней.
DROP INDEX IF EXISTS coin_ledger_game_once_uq;
CREATE UNIQUE INDEX IF NOT EXISTS coin_ledger_game_once_uq
  ON coin_ledger ((data->>'roundId'), (data->>'pick'), user_id, reason)
  WHERE reason IN ('wheel.bet', 'wheel.win', 'wheel.refund', 'wheel.jackpot', 'duel.stake', 'duel.win', 'duel.refund',
                   'prediction.bet', 'prediction.win', 'prediction.refund');
