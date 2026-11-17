-- ГусКоины 2: «Запустить игры» (решения владельца 29.10, пп. 8–9; `gameLaunch.ts`, `routes/gameLaunch.ts`).
--
-- Запуск — разовое действие: включает игры сервера, ставит отметку и дарит монеты каждому, кто в этот момент сидит в
-- голосовых каналах сервера. Отметка ставится условием `games_launched_at IS NULL` в той же транзакции, что и подарки, —
-- второе нажатие ждёт на строке и видит её занятой.

ALTER TABLE server_economy ADD COLUMN IF NOT EXISTS games_launched_at timestamptz;
-- Кем — без внешнего ключа: справка рядом с записью журнала действий `economy.games-launch` (аккаунт обезличивается, не удаляется).
ALTER TABLE server_economy ADD COLUMN IF NOT EXISTS games_launched_by text;
ALTER TABLE server_economy ADD COLUMN IF NOT EXISTS games_launch_gift integer;

-- Второй рубеж от двойного подарка: одна строка «подарок за запуск» на человека и сервер. Подарок — эмиссия (как ретро),
-- НЕ заработок: `earned_total`/`season_earned` не растут.
CREATE UNIQUE INDEX IF NOT EXISTS coin_ledger_games_launch_uq
  ON coin_ledger (server_id, user_id)
  WHERE reason = 'games.launch';
