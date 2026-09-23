-- Каталоги федерации (#139 F2, план §5.2–5.4): кого и что мы показываем соседям, и чей кеш храним.
--
-- Две половины одной задачи:
--   * НАША сторона — отметки «скрыт от соседей» и «разрешён федеративный доступ» плюс время правки,
--     по которому строится дельта;
--   * СТОРОНА СОСЕДА — кеш его каталога у нас. Именно кеш: из него строятся выпадающие списки в
--     админке, и когда сосед лежит, списки остаются на месте с пометкой «обновлено N назад».
--
-- 🔴 `directory_updated_at` — часы ТОГО, кто отдаёт. Дельта запрашивается «с момента, который назвал
-- сам сосед в прошлом ответе»: свои часы для этого не годятся, они у двух инстансов разные, и записи,
-- попавшие в зазор, разъехались бы навсегда.

-- --- Наши люди -------------------------------------------------------------------------------------

-- Решение АДМИНА ИНСТАНСА (§5.2.1): человек пропадает из каталога у всех соседей. Войти по ссылке он
-- при этом может, и тогда на сервере соседа виден как обычный участник — иначе сломались бы переписка
-- и голос.
ALTER TABLE users ADD COLUMN IF NOT EXISTS hidden_from_peers BOOLEAN NOT NULL DEFAULT false;

-- Когда запись каталога менялась. Двигается при смене ника, имени, аватара, подтверждения, скрытия и
-- удаления. Пропущенный вызов не ломает федерацию навсегда: суточная полная сверка отдаёт состояние
-- целиком, не глядя на это поле, — она для того и нужна.
ALTER TABLE users ADD COLUMN IF NOT EXISTS directory_updated_at TIMESTAMPTZ NOT NULL DEFAULT now();

-- Страница каталога идёт по паре (время, id): без id записи с одинаковым временем либо повторялись бы
-- на границе страниц, либо терялись.
CREATE INDEX IF NOT EXISTS users_directory_updated_idx ON users (directory_updated_at, id);

-- --- Наши серверы ----------------------------------------------------------------------------------

-- Галочка «Разрешить федеративный доступ» (§5.3). Ставит ТОЛЬКО админ инстанса; владелец сервера
-- видит её у себя только для чтения. По умолчанию выключено: открытость наружу — осознанное действие.
ALTER TABLE servers ADD COLUMN IF NOT EXISTS federated_access BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE servers ADD COLUMN IF NOT EXISTS directory_updated_at TIMESTAMPTZ NOT NULL DEFAULT now();
CREATE INDEX IF NOT EXISTS servers_directory_updated_idx ON servers (directory_updated_at, id);

-- Исключения по связке (требование 32): галочка открывает сервер ВСЕМ соседям, а здесь перечислено,
-- кому именно не открывать. Пусто = всем, у кого есть связка.
--
-- ⚠️ Внешнего ключа на federation_links нет намеренно, как и в очереди исходящих: связку могут
-- разорвать и завести заново. Осиротевшая строка при этом оставляет сервер ЗАКРЫТЫМ для вернувшегося
-- соседа — безопасная сторона ошибки; каскад же тихо ОТКРЫЛ бы его.
CREATE TABLE IF NOT EXISTS server_federation_exclusions (
  server_id TEXT NOT NULL REFERENCES servers(id) ON DELETE CASCADE,
  instance_id TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (server_id, instance_id)
);

-- --- Кеш каталога соседа ---------------------------------------------------------------------------

-- Люди соседа. Первичный ключ — пара: один и тот же идентификатор у разных инстансов означает разных
-- людей, и сводить их в одну строку нельзя.
CREATE TABLE IF NOT EXISTS federation_peer_users (
  instance_id TEXT NOT NULL,
  user_id TEXT NOT NULL,
  username TEXT NOT NULL,
  display_name TEXT NOT NULL,
  -- Отпечаток аватара у соседа. Картинку качаем ЛЕНИВО и только при несовпадении с уже скачанным
  -- (§5.4): клиенты хоста никогда не ходят за ней на чужой инстанс и не светят там свой адрес.
  avatar_hash TEXT,
  avatar_local_url TEXT,
  avatar_cached_hash TEXT,
  -- Часы СОСЕДА на момент правки записи — они же версия состояния.
  updated_at BIGINT NOT NULL,
  cached_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (instance_id, user_id)
);

CREATE INDEX IF NOT EXISTS federation_peer_users_name_idx ON federation_peer_users (instance_id, username);

-- Серверы соседа, открытые для федеративного доступа. Только просмотр: вступают в них через ссылку (F3).
CREATE TABLE IF NOT EXISTS federation_peer_servers (
  instance_id TEXT NOT NULL,
  server_id TEXT NOT NULL,
  name TEXT NOT NULL,
  icon_hash TEXT,
  members INTEGER NOT NULL DEFAULT 0,
  updated_at BIGINT NOT NULL,
  cached_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (instance_id, server_id)
);

-- Состояние синхронизации по связке и виду каталога (directory | servers).
--
-- 🔴 `needs_full` по умолчанию true: новая связка начинает с полной сверки, потому что дельта «с
-- момента» у неё есть от чего отсчитывать только после первой полной выдачи.
CREATE TABLE IF NOT EXISTS federation_sync_state (
  instance_id TEXT NOT NULL,
  kind TEXT NOT NULL,
  -- С какого момента просить следующую дельту. Время в часах СОСЕДА, см. шапку файла.
  since BIGINT,
  last_delta_at TIMESTAMPTZ,
  last_full_at TIMESTAMPTZ,
  -- Сколько попыток подряд не удались — по ним растёт отступление, чтобы лежачий сосед не собирал
  -- на себя каждый проход.
  failures INTEGER NOT NULL DEFAULT 0,
  needs_full BOOLEAN NOT NULL DEFAULT true,
  last_problem TEXT,
  -- Сколько записей в кеше после последней удачи — это и показывает вкладка «Федерация».
  entries INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (instance_id, kind)
);
