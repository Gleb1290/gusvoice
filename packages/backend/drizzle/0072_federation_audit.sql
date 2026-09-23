-- Журнал федерации уровня инстанса (#139; аудит федерации 19.09, F-25).
--
-- События связок (код выдан, заявка, подтверждение, пауза, разрыв, перепривязка, потеря доверия),
-- первый вход гостя и отказы гостевых сессий писались только в вывод процесса — и терялись при
-- пересоздании контейнера. Серверный `audit_log` для них не годится: он ведётся по серверу
-- (`server_id`, `actor_id`), а связка — событие инстанса. Читается во вкладке «Федерация».
CREATE TABLE IF NOT EXISTS federation_audit (
  id TEXT PRIMARY KEY,
  at TIMESTAMPTZ NOT NULL DEFAULT now(),
  event TEXT NOT NULL,
  -- Связка, о которой речь (если есть). Без ссылки на federation_links: запись переживает разрыв.
  instance_id TEXT,
  -- Кто из наших нажал кнопку (если событие от человека, а не от соседа или расписания).
  actor_id TEXT,
  detail JSONB NOT NULL DEFAULT '{}'::jsonb
);

CREATE INDEX IF NOT EXISTS federation_audit_at_idx ON federation_audit (at DESC);
