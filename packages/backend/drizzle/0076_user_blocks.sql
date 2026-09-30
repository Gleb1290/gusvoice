-- #212 (этап 0 ЛС, Р12): минимальный чёрный список. Решение владельца 28.09 — «как в Telegram»:
-- заблокированный ничего не узнаёт. Его сообщение сохраняется и у него выглядит отправленным, но
-- помечается `withheld` и тому, кто заблокировал, не показывается никогда — ни сразу, ни после
-- разблокировки (у Telegram так же: написанное во время блокировки не доставляется).
CREATE TABLE IF NOT EXISTS user_blocks (
  blocker_id text NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  blocked_id text NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (blocker_id, blocked_id),
  CHECK (blocker_id <> blocked_id)
);
ALTER TABLE dm_messages ADD COLUMN IF NOT EXISTS withheld boolean NOT NULL DEFAULT false;
