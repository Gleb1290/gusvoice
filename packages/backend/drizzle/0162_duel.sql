-- ГусКоины 2, этап 3: «Гусиная дуэль» (28.10, `docs/guscoins-v2-plan.md`, `gameDuel.ts`).
--
-- Дуэль живёт строкой `game_rounds` (этап 1) `kind = 'duel'`: вызов `open` (без ставок, `lock_at` — срок ответа) →
-- принятие ставит обе ставки (`locked`, `settle_at` — дедлайн нажатия «Бросить», потом конец анимации) → `settled` |
-- `cancelled`. Индексы такта по `lock_at`/`settle_at` из 0161 общие для всех видов (`kind` — первая колонка), новых не надо.

-- 🔴 Одна живая дуэль на голосовой канал. Два вызова в одном канале в одну миллисекунду — второй упирается сюда
-- (`ON CONFLICT DO NOTHING`) и получает «в канале уже идёт дуэль».
CREATE UNIQUE INDEX IF NOT EXISTS game_rounds_duel_channel_live_uq
  ON game_rounds ((data->>'channelId')) WHERE kind = 'duel' AND state IN ('open', 'locked');
