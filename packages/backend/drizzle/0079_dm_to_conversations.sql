-- ЛС, шаг 1б (#211, docs/dm/STAGE1.md): перенос живых ЛС из dm_* в беседы. Применяется ОДНОЙ транзакцией при старте
-- бэкенда (db/index.ts), ДО того как он начнёт принимать запросы; старый контейнер к этому моменту остановлен
-- (deploy.sh → docker compose up -d). Упала — откатилась целиком, бэкенд не поднялся, dm_* целы.
--
-- После переноса dm_* НЕ пишутся и лежат замороженными как эталон (Р16): старые ручки /api/dm* читают и пишут беседы.
-- Откат снимком ВМ — только до первой записи (уточнение Codex 30.09); дальше — исправление вперёд.
--
-- id бесед и сообщений — ПРЕЖНИЕ: на них ссылаются ответы, кеши клиентов и уведомления.

-- 🔴 Беседы должны быть пусты: в 1а ручки /api/conv/* на проде были выключены. Не пусты — это не прод (стенд
-- после опытов) или ошибка выкатки; падаем громко, а не сливаем две модели наугад.
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM conversations) THEN
    RAISE EXCEPTION 'перенос ЛС 1б: таблица conversations не пуста — перенос поверх чужих бесед запрещён';
  END IF;
END $$;

-- Пара в dm_channels уже упорядочена (user_a < user_b, dmRules.dmPair) — ключ пары тот же, что у convRules.directKey.
INSERT INTO conversations (id, kind, direct_key, created_by, created_at, last_message_at, last_sort_key)
SELECT id, 'direct', user_a || ':' || user_b, NULL, created_at, last_message_at, 0
FROM dm_channels;

INSERT INTO conversation_members (conversation_id, user_id, role, joined_at, last_read_key)
SELECT c.id, u.user_id, 'member', c.created_at, 0
FROM dm_channels c
CROSS JOIN LATERAL (VALUES (c.user_a), (c.user_b)) AS u(user_id);

-- Ключ порядка — «бегущий максимум» по (created_at, id) внутри беседы: rn + max(мкс − rn) от начала беседы.
-- Строго растёт (разность соседних ≥ 1), равен created_at в микросекундах, пока нет совпадений, и в точности
-- повторяет прежний порядок старых ручек (created_at, id) — включая одну миллисекунду с разными микросекундами
-- (разбор Codex 30.09, п. 4).
INSERT INTO conversation_messages (
  id, conversation_id, author_id, client_id, payload_hash, sort_key, content, attachments, reply_to_id,
  created_at, edited_at, deleted_at, withheld, hidden_for
)
SELECT
  id, dm_channel_id, author_id, NULL, NULL,
  rn + max(us - rn) OVER (PARTITION BY dm_channel_id ORDER BY created_at, id ROWS BETWEEN UNBOUNDED PRECEDING AND CURRENT ROW),
  content, attachments, reply_to_id, created_at, edited_at, NULL, withheld, hidden_for
FROM (
  SELECT m.*,
    (extract(epoch FROM m.created_at) * 1000000)::bigint AS us,
    row_number() OVER (PARTITION BY m.dm_channel_id ORDER BY m.created_at, m.id) AS rn
  FROM dm_messages m
) s;

INSERT INTO conversation_message_reactions (message_id, user_id, emoji)
SELECT message_id, user_id, emoji FROM dm_message_reactions;

UPDATE conversations c SET last_sort_key = s.k
FROM (SELECT conversation_id, max(sort_key) AS k FROM conversation_messages GROUP BY conversation_id) s
WHERE c.id = s.conversation_id;

-- «Прочитано до» — ключ последнего сообщения не новее прежней отметки. Прежнее непрочитанное жило в окне 14 дней:
-- старше — не считалось никогда. Берём ту же границу, чтобы в момент переноса у людей не вспыхнули сотни «новых»
-- в давно брошенных беседах: число на значке остаётся тем же, а дальше считается точно, без окна.
-- Отметка в будущем (часы ушли вперёд) — просто «прочитано всё».
UPDATE conversation_members m SET last_read_key = COALESCE((
  SELECT max(x.sort_key) FROM conversation_messages x
  WHERE x.conversation_id = m.conversation_id
    AND x.created_at <= GREATEST(
      COALESCE(
        (SELECT r.last_read_at FROM dm_reads r WHERE r.user_id = m.user_id AND r.dm_channel_id = m.conversation_id),
        '-infinity'::timestamptz
      ),
      now() - interval '14 days'
    )
), 0);
