-- Из чего сложилась выплата: вклад каждого множителя (#121).
--
-- 🔴 Зачем. Человек видит «+14» и не знает, почему не 20. Потолок выбран — начисление молча
-- прекращается; включилось затухание — ставка молча вдвое; один в канале — четверть, тоже молча.
-- Три РАЗНЫЕ причины выглядят одинаково: «сломалось». А на вопрос «почему у Пети больше» ответить
-- нечем: журнал хранит суммы и не хранит причин.
--
-- Выплата идёт раз в N минут и складывается из десятка минутных срезов с РАЗНОЙ обстановкой
-- (то один, то втроём, то в мьюте). Поэтому вклад каждого множителя копится вместе с ценностью и
-- обнуляется вместе с ней при выплате — иначе к моменту выплаты обстановка забыта.
--
-- ⚠️ Значения СО ЗНАКОМ: множитель компании бывает больше 100 % и тогда это надбавка, а не потеря.
-- Показывать надо и то и другое, иначе объяснение будет однобоким.
--
-- Инвариант, который держит эти четыре числа честными:
--   base + delta_presence + delta_company + delta_decay = pending_milli
ALTER TABLE coin_balances ADD COLUMN IF NOT EXISTS base_milli integer NOT NULL DEFAULT 0;
ALTER TABLE coin_balances ADD COLUMN IF NOT EXISTS delta_presence_milli integer NOT NULL DEFAULT 0;
ALTER TABLE coin_balances ADD COLUMN IF NOT EXISTS delta_company_milli integer NOT NULL DEFAULT 0;
ALTER TABLE coin_balances ADD COLUMN IF NOT EXISTS delta_decay_milli integer NOT NULL DEFAULT 0;
