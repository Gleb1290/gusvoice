-- Стрик: бонус за то, что человек заходит день за днём (план, модель F).
--
-- 🔴 Награждает РЕГУЛЯРНОСТЬ, а не длительность. Базовая ставка платит за часы; стрик — за то, что
-- пришёл сегодня. Сидящий вечерами понемногу получает столько же внимания, сколько марафонец по
-- выходным.
--
-- ⚠️ Ручка ОДНА — размер бонуса. Потолок стрика зафиксирован неделей в коде: неделя объясняется
-- одной фразой, а настраиваемый потолок в паре с размером давал бы числа, которые владелец сам не
-- предскажет. `streak_bonus = 0` — стрика нет.
ALTER TABLE server_economy ADD COLUMN IF NOT EXISTS streak_bonus integer NOT NULL DEFAULT 0;
-- Сутки, за которые бонус уже выдан (`ГГГГ-ММ-ДД` в поясе экономики), и длина цепочки.
ALTER TABLE coin_balances ADD COLUMN IF NOT EXISTS streak_day text NOT NULL DEFAULT '';
ALTER TABLE coin_balances ADD COLUMN IF NOT EXISTS streak_days integer NOT NULL DEFAULT 0;
