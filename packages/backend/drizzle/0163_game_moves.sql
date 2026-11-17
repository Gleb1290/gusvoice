-- ГусКоины 2, этап 4: дуэли с выбором — «Камень-ножницы-бумага» и «Жадный гусь» (28.10, `docs/guscoins-v2-plan.md`,
-- `gameDuel.ts`), и суточный предел пары для них.
--
-- Ход игрока — строка `game_moves`. Ключ `(round_id, user_id, seq)`: повтор нажатия и повтор после обрыва упираются в
-- него (`ON CONFLICT DO NOTHING`) — ход идемпотентен, передумать нельзя. `seq`: КНБ — номер раунда (оба игрока пишут
-- свой ход в одну `seq`), Жадный гусь — сквозной номер действия партии (ходит один за раз; ход за молчащего пишет сервер
-- с `move.auto`). 🔴 Рука КНБ лежит ТОЛЬКО здесь: наружу её отдаёт лишь раскрытие обоих (`game_rounds.data.rps.rounds`).
-- `think_ms` — сколько думал (у хода сервера пусто).
-- `user_id` — как у `game_stakes`: аккаунт обезличивается, а не удаляется (`accountRows.ts`), так что каскад не срабатывает
-- и ходы остаются историей; живую партию удаление отменяет с возвратом обоим (`gameMoney.cancelDuelsOf`).
CREATE TABLE IF NOT EXISTS game_moves (
  round_id text NOT NULL REFERENCES game_rounds(id) ON DELETE CASCADE,
  user_id text NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  seq integer NOT NULL CHECK (seq >= 0),
  move jsonb NOT NULL,
  think_ms integer,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (round_id, user_id, seq)
);

-- Предел пары: сколько одна пара может выиграть друг у друга за сутки МСК в играх с выбором (чистый поток, кубики не
-- считаются). 0 — без предела.
ALTER TABLE server_economy ADD COLUMN IF NOT EXISTS games_pair_daily_max integer NOT NULL DEFAULT 1000;
