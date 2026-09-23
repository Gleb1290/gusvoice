-- Журнал отзывов сессий — по хостам (#139, §5.6.1; аудит федерации run-1 20.09, F-26).
--
-- **Зачем.** Хост, лежавший в момент «выйти везде», догоняет пропущенное запросом
-- `GET /fed/v1/revocations`. Ответ не был привязан к спрашивающему: в таблице не было колонки
-- инстанса, и ЛЮБОЙ сосед с рабочей связкой получал за 30 дней список «кто из наших и когда менял
-- пароль, жал «выйти везде», был удалён» — включая людей, которые у него никогда не гостили. Сами
-- личности сосед и так знает из каталога, утекала именно хронология событий безопасности.
--
-- Теперь строка отзыва пишется на КАЖДОГО хоста человека (по индексу членств и поручительствам),
-- а выдача отбирает строки инстанса спрашивающего. Поле ответа не меняется — протокол тот же.
ALTER TABLE federation_revocations ADD COLUMN IF NOT EXISTS instance_id TEXT NOT NULL DEFAULT '';

-- Уже записанное раздаём по поручительствам: хост, которому мы ручались за человека, вправе догнать
-- его отзыв. Старая строка без адресата после этого никому не отдаётся и удаляется.
INSERT INTO federation_revocations (id, user_id, kind, gen, created_at, instance_id)
SELECT r.id || ':' || g.instance_id, r.user_id, r.kind, r.gen, r.created_at, g.instance_id
FROM federation_revocations r
JOIN federation_guest_grants g ON g.user_id = r.user_id
WHERE r.instance_id = ''
ON CONFLICT (id) DO NOTHING;

DELETE FROM federation_revocations WHERE instance_id = '';

CREATE INDEX IF NOT EXISTS federation_revocations_peer_idx
  ON federation_revocations (instance_id, created_at, id);
