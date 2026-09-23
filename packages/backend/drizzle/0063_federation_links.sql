-- Связки между инстансами (федерация, #139, фаза F1, план §5.1).
--
-- Связка — отношение двух ДЕРЖАТЕЛЕЙ, а не настройка: заводится кодом, который один передал другому
-- вне приложения, и подтверждается обеими сторонами. Ключ соседа хранится здесь же: именно по нему
-- дальше проверяется каждый его запрос, а домен — лишь адрес.
--
-- 🔴 Ничего секретного НАШЕГО тут нет: наш корневой ключ живёт отдельным зашифрованным файлом
-- (см. FEDERATION_KEY_PASSPHRASE), чтобы дамп этой базы не уносил печать инстанса. Здесь только
-- ПУБЛИЧНЫЕ ключи соседей и хеши одноразовых секретов.
--
-- Таблицы пустые у всех, кто не включал федерацию (по умолчанию она выключена), поэтому миграция
-- ничего не меняет ни на проде, ни на чужих коробках.

CREATE TABLE IF NOT EXISTS federation_links (
  -- Личность соседа, выведенная из его корневого ключа. Первичный ключ именно она, а не домен:
  -- домен сосед может сменить, оставшись собой; сменившийся ключ — это уже другой инстанс.
  instance_id TEXT PRIMARY KEY,
  domain TEXT NOT NULL,
  api_base TEXT NOT NULL,
  client_origin TEXT NOT NULL,
  -- Публичный корневой ключ соседа (base64url DER SPKI) — им проверяются его сменные ключи подписи.
  root_key TEXT NOT NULL,
  -- Как сосед назвал себя сам и как его назвал у себя НАШ держатель (второе перебивает первое, §5.1.2).
  their_name TEXT,
  local_name TEXT,
  icon_hash TEXT,
  -- requested | pending | active | paused | blocked | trust-lost (переходы — linkRules.ts).
  state TEXT NOT NULL,
  -- Согласованная версия протокола и объявленные соседом возможности: решения принимаются по ним,
  -- а НЕ по версии его приложения (docs/federation-compat.md).
  protocol_version INTEGER,
  features JSONB NOT NULL DEFAULT '[]'::jsonb,
  -- Последнее замеренное расхождение часов, чтобы вкладка «Федерация» показывала причину отказов
  -- подписи, а держатель не гадал.
  clock_skew_ms INTEGER,
  -- Номера событий: последний принятый от соседа (дедуп входящих) и наш счётчик исходящих.
  last_event_seq BIGINT NOT NULL DEFAULT 0,
  out_event_seq BIGINT NOT NULL DEFAULT 0,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  confirmed_at TIMESTAMPTZ,
  last_seen_at TIMESTAMPTZ
);

-- Списки во вкладке «Федерация» и выборки «кому слать» идут по состоянию.
CREATE INDEX IF NOT EXISTS federation_links_state_idx ON federation_links (state);
-- Домен не уникален намеренно: после перепривязки (§5.1.3) у старой замороженной связки и новой
-- какое-то время один и тот же домен, и падать на этом нельзя.
CREATE INDEX IF NOT EXISTS federation_links_domain_idx ON federation_links (domain);

CREATE TABLE IF NOT EXISTS federation_link_codes (
  id TEXT PRIMARY KEY,
  -- 🔴 Только ХЕШ секрета, как у пароля: дамп базы не должен давать возможность завести связку от
  -- нашего имени. Сам код существует лишь в сообщении, которым держатели обменялись.
  secret_hash TEXT NOT NULL UNIQUE,
  -- link | rebind (перепривязка после потери или кражи ключа).
  purpose TEXT NOT NULL DEFAULT 'link',
  -- Для перепривязки: какой instance_id был у нас до смены ключа — по нему сосед найдёт старую связку.
  previous_instance_id TEXT,
  -- 🔴 Кто выдал код — НЕ здесь, а в журнале аудита. Ссылка на users сделала бы эту таблицу ещё одним
  -- местом с личными данными, которое надо чистить при удалении аккаунта, — ради строки, живущей сутки.
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  expires_at TIMESTAMPTZ NOT NULL,
  -- Одноразовость: использованный код больше не принимается, даже если срок ещё не вышел.
  used_at TIMESTAMPTZ,
  used_by_instance_id TEXT
);

-- Уборка просроченных кодов и поиск действующих.
CREATE INDEX IF NOT EXISTS federation_link_codes_expires_idx ON federation_link_codes (expires_at);
