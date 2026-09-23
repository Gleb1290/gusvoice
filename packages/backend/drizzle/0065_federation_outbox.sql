-- Очередь исходящих событий федерации (#139 F1, #148).
--
-- До этого событие отправлялось напрямую: сосед недоступен на секунду — событие потеряно навсегда,
-- и состояния разъезжаются молча. Теперь событие сначала ложится сюда, а доставкой занимается
-- отдельный проход с повторами.
--
-- 🔴 Порядок доставки по связке обязателен: у события есть порядковый номер, получатель помнит
-- последний принятый и отбрасывает то, что уже видел. Отправь мы пятое раньше четвёртого — четвёртое
-- будет отброшено как «старое», и изменение потеряется. Поэтому очередь разбирается строго по
-- возрастанию `seq`, и упёршись в недоставленное, проход по ЭТОЙ связке останавливается.

CREATE TABLE IF NOT EXISTS federation_outbox (
  id TEXT PRIMARY KEY,
  -- Кому. Внешнего ключа на federation_links нет намеренно: связку могут разорвать и завести заново,
  -- а хвост очереди должен пережить это и быть выброшенным по своим правилам, а не каскадом.
  instance_id TEXT NOT NULL,
  -- Номер события в рамках связки — он же порядок доставки.
  seq BIGINT NOT NULL,
  event_id TEXT NOT NULL,
  kind TEXT NOT NULL,
  version INTEGER,
  payload JSONB NOT NULL,
  attempts INTEGER NOT NULL DEFAULT 0,
  -- Когда пробовать снова: после неудачи отодвигается всё дальше, чтобы лежачий сосед не собирал
  -- на себя весь проход.
  next_attempt_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  last_error TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Выборка «что доставлять этой связке» идёт по паре: сначала связка, внутри — порядок номеров.
CREATE INDEX IF NOT EXISTS federation_outbox_delivery_idx ON federation_outbox (instance_id, seq);
-- Уборка протухших и выбор готовых к попытке.
CREATE INDEX IF NOT EXISTS federation_outbox_attempt_idx ON federation_outbox (next_attempt_at);
