-- Разовый перерасчёт сезона по правилу «один — затухание не бьёт» (28.10, `aloneRecount.ts`).
--
-- Старое правило (до 0158) тратило затухание и на время одному: кто днём ждал компанию один, к вечеру
-- в компании получал заметно меньше пришедших сразу. Владелец решил доначислить разницу за текущий
-- сезон: срезы присутствия от начала сезона до смены правила прогоняются по новому и по старому
-- правилу, плюс идёт человеку. Минус не отбирается никогда.
--
-- `alone_recount_at` — одноразовая отметка сервера (как `retro_granted_at`): ставится условным UPDATE
-- по `IS NULL` в той же транзакции, что и начисления, и работает замком от второго запуска.
ALTER TABLE server_economy ADD COLUMN IF NOT EXISTS alone_recount_at timestamptz;

-- Одноразовые карточки «мы пересчитали твой сезон». `kind` — на случай будущих перерасчётов
-- (сейчас один: 'alone-2026-10'). `seen_at` пуст — карточка ещё не показана (снимок экономики отдаёт
-- её как `recount`, `PATCH .../me { recountSeen: true }` ставит отметку).
CREATE TABLE IF NOT EXISTS coin_recounts (
  server_id text NOT NULL REFERENCES servers(id) ON DELETE CASCADE,
  user_id text NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  kind text NOT NULL,
  amount integer NOT NULL,
  season_id text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  seen_at timestamptz,
  PRIMARY KEY (server_id, user_id, kind)
);
