-- ЛС, плашка незнакомца и жалоба из ЛС (08.10, #211, С7, G30, Р-10, признак `stranger1`): как плашка «Добавить / Заблокировать»
-- у Telegram (`history_view_contact_status.cpp`) с крестиком «скрыть» и жалобой держателю инстанса.
--
-- Крестик запоминается в МОЕЙ строке участника (между моими устройствами; собеседник о нём не узнаёт). Жалоба — своя таблица:
-- `federation_reports` про письма между инстансами (направление, связка, действие), а здесь жалоба местного человека на
-- местного. Улики — до пяти последних сообщений собеседника, которые жалующийся видел сам (снимок текста, не ссылка).
--
-- Ссылки на users без внешнего ключа: аккаунт обезличивается, а не стирается, и жалоба переживает обоих.
--
-- Только добавление: колонка без умолчания (у прежних строк NULL — плашку не скрывали), новая таблица.
ALTER TABLE conversation_members ADD COLUMN IF NOT EXISTS stranger_hidden_at timestamptz;

CREATE TABLE IF NOT EXISTS dm_reports (
  id text PRIMARY KEY,
  reporter_id text NOT NULL,
  reported_id text NOT NULL,
  conversation_id text,
  reason text NOT NULL,
  comment text,
  evidence jsonb NOT NULL DEFAULT '[]'::jsonb,
  status text NOT NULL DEFAULT 'new',
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS dm_reports_status_idx ON dm_reports (status, created_at DESC);
CREATE INDEX IF NOT EXISTS dm_reports_pair_idx ON dm_reports (reporter_id, reported_id, created_at DESC);
