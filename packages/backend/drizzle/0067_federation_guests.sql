-- Гости (#139 F3, план §5.5–5.6) — человек с другого инстанса живёт на хосте настоящей строкой.
--
-- 🔴 Теневая строка заводится ИМЕННО в `users`, а не рядом в своей таблице. Внешние ключи на `users`
-- стоят почти везде — сообщения, реакции, роли, монеты, тыки, итоги сезонов, — и отдельная таблица
-- гостей означала бы вторую ветку в каждом из этих мест. «Гость сразу во всём» (требование 6) — это
-- не лозунг, а следствие одного решения о хранении.
--
-- ⚠️ Цена решения: каждый запрос, который перечисляет «наших людей», обязан спрашивать
-- `home_instance_id IS NULL`. Каталог соседям это уже делает (`directoryEntryOf`) — иначе список
-- людей инстанса C утекал бы к B через нас.

-- --- Теневая строка --------------------------------------------------------------------------------

-- Чей человек и кто он ДОМА. Пара уникальна: один и тот же идентификатор у разных инстансов означает
-- разных людей.
ALTER TABLE users ADD COLUMN IF NOT EXISTS home_instance_id TEXT;
ALTER TABLE users ADD COLUMN IF NOT EXISTS home_user_id TEXT;

-- Ник ДОМА и без домена (§5.5): домен и название инстанса дорисовываются из связки при показе.
-- Зашей мы домен сюда — переезд соседа на другой адрес закаменел бы в тысячах строк.
ALTER TABLE users ADD COLUMN IF NOT EXISTS home_username TEXT;

-- Поколение сессий на доме (§5.6.1). Нажали «выйти везде» — дом присылает новое поколение, и все
-- гостевые сессии со старым мертвы сразу. Без этого поля «выйти везде» кончалось бы на границе
-- своего инстанса, а угонщик оставался бы гостем на хостах.
ALTER TABLE users ADD COLUMN IF NOT EXISTS home_gen INTEGER NOT NULL DEFAULT 0;

-- Какой аватар гостя уже скачан к нам. Картинка перекачивается только при смене отпечатка (§5.4),
-- и клиенты хоста никогда не ходят за ней на чужой инстанс.
ALTER TABLE users ADD COLUMN IF NOT EXISTS home_avatar_hash TEXT;

CREATE UNIQUE INDEX IF NOT EXISTS users_home_identity_uniq ON users (home_instance_id, home_user_id)
  WHERE home_instance_id IS NOT NULL;

-- Списки «наших людей» (каталог соседям, админка, поиск) обязаны отсекать гостей — пусть это будет
-- дёшево.
CREATE INDEX IF NOT EXISTS users_home_instance_idx ON users (home_instance_id);

-- --- Членство гостя на нашем сервере ---------------------------------------------------------------

-- 🔴 Состояние, а не удаление строки (§5.3.1): сняли галочку федеративного доступа — гости выпадают,
-- но история, роли и монеты остаются. Вернули галочку — все внутри, как были. Удалять членство
-- значило бы наказывать людей за решение держателя.
ALTER TABLE server_members ADD COLUMN IF NOT EXISTS state TEXT NOT NULL DEFAULT 'active';

-- Как человек попал на сервер и кто создал ссылку. Нужно не для статистики: по этому дом показывает
-- скрывшему админу «скрыт от соседей, но виден: сервер «Кино» — вошёл по ссылке, ссылку создал N»
-- (§5.2.1).
ALTER TABLE server_members ADD COLUMN IF NOT EXISTS join_method TEXT;
ALTER TABLE server_members ADD COLUMN IF NOT EXISTS invited_by TEXT REFERENCES users(id) ON DELETE SET NULL;
ALTER TABLE server_members ADD COLUMN IF NOT EXISTS closed_at TIMESTAMPTZ;

-- Закрыть сервер для гостей = пройтись по членствам одной связки. Без индекса это полный проход по
-- всем участникам всех серверов.
CREATE INDEX IF NOT EXISTS server_members_state_idx ON server_members (server_id, state);

-- --- Системная роль «Гости» (§5.9) -----------------------------------------------------------------

-- 🔴 Для гостя она ЗАМЕНЯЕТ `@everyone`, а не добавляется к нему: роли только ПРИБАВЛЯЮТ права, и
-- ограничить гостей, оставив им `@everyone`, было бы нечем. При создании — точная копия прав
-- `@everyone`: по умолчанию гость равен своему, а сузить может владелец сервера.
ALTER TABLE roles ADD COLUMN IF NOT EXISTS is_guests BOOLEAN NOT NULL DEFAULT false;

-- Роль «Гости» заводится на КАЖДОМ сервере, включая уже существующие: иначе владелец сервера, который
-- открыли для федерации, не смог бы ограничить гостей, пока не пересоздаст сервер.
INSERT INTO roles (id, server_id, name, color, permissions, position, hoist, is_everyone, mentionable, members_can_assign, is_guests)
SELECT
  'guests-' || s.id,
  s.id,
  'Гости',
  0,
  COALESCE((SELECT r.permissions FROM roles r WHERE r.server_id = s.id AND r.is_everyone LIMIT 1), '0'),
  0,
  false,
  false,
  false,
  false,
  true
FROM servers s
WHERE NOT EXISTS (SELECT 1 FROM roles r WHERE r.server_id = s.id AND r.is_guests);

CREATE UNIQUE INDEX IF NOT EXISTS roles_guests_uniq ON roles (server_id) WHERE is_guests;

-- --- Индекс членств на ДОМЕ ------------------------------------------------------------------------

-- Где наши люди состоят гостями. Хост сообщает событием `membership.changed`, дом хранит здесь.
--
-- 🔴 Без этого индекса «выйти везде» (§5.6.1) не знало бы, КУДА слать отзыв: гостевая сессия живёт у
-- хоста и от дома не зависит — в этом и была вся устойчивость (требование 4). Отсюда же берутся
-- «Где я гость» (§5.7), рейл на новом устройстве и отметка §5.2.1 у скрывшего админа.
CREATE TABLE IF NOT EXISTS federation_memberships (
  -- Чей хост и чей человек: `user_id` — НАШ (пространство дома), `instance_id` — хоста.
  instance_id TEXT NOT NULL,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  server_id TEXT NOT NULL,
  server_name TEXT NOT NULL DEFAULT '',
  state TEXT NOT NULL DEFAULT 'active',
  -- Как вошёл и кто позвал — в пространстве ХОСТА (у нас этих строк нет, показываем как есть).
  method TEXT,
  invited_by TEXT,
  reason TEXT,
  -- Часы ХОСТА на момент события — они же версия: сеть переставляет события местами, и без версии
  -- старое «вышел» затирало бы свежее «вернулся».
  updated_at BIGINT NOT NULL,
  -- Когда мы последний раз сверяли индекс с хостом целиком (§5.4). Пусто — ещё ни разу.
  checked_at TIMESTAMPTZ,
  PRIMARY KEY (instance_id, user_id, server_id)
);

-- «Кому слать отзыв сессий этого человека» — запрос по человеку, а не по хосту.
CREATE INDEX IF NOT EXISTS federation_memberships_user_idx ON federation_memberships (user_id);

-- --- Журнал отзывов на ДОМЕ ------------------------------------------------------------------------

-- 🔴 Хост мог быть ВЫКЛЮЧЕН в момент, когда человек нажал «выйти везде» (§5.6.1). Событие до него не
-- доедет, повторы упрутся в мёртвый адрес, а когда хост поднимется, он обязан САМ забрать
-- пропущенное — `GET /fed/v1/revocations?since=`. Без журнала «выйти везде» было бы обещанием,
-- которое держится, только пока все живы.
CREATE TABLE IF NOT EXISTS federation_revocations (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  -- 'sessions' — новое поколение (человек жив, может войти заново); 'revoked' — аккаунта больше нет.
  kind TEXT NOT NULL,
  gen INTEGER,
  -- Наши часы: хост спрашивает «что после такого-то момента», называя момент из НАШЕГО прошлого
  -- ответа — те же грабли часов, что и в каталоге (0066).
  created_at BIGINT NOT NULL
);

CREATE INDEX IF NOT EXISTS federation_revocations_created_idx ON federation_revocations (created_at, id);
