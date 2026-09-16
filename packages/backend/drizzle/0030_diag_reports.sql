-- Отчёты диагностики из клиента (#100). Кладём в БД, а не на диск: не нужен ни новый том в compose,
-- ни правка деплоя — читать можно обычным psql на VM.
CREATE TABLE IF NOT EXISTS diag_reports (
  id text PRIMARY KEY,
  user_id text NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  kind text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  payload jsonb NOT NULL
);
CREATE INDEX IF NOT EXISTS diag_reports_created_idx ON diag_reports (created_at DESC);
