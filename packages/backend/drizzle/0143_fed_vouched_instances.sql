-- ЛС между инстансами, Э7 часть 3 (#141, D): название и домен инстанса третьего человека группы — со слов дома группы.
-- У дома участника с этим инстансом связки нет, и без строки значок подписан «с другого инстанса». Только добавление.
CREATE TABLE IF NOT EXISTS federation_vouched_instances (
  instance_id text PRIMARY KEY,
  name text,
  domain text NOT NULL,
  vouched_by text NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now()
);
