-- ЛС между инстансами, этап Э3 часть 2 (#141, docs/dm/FEDERATION.md §3.5): квота связки под копии файлов соседа.
--
-- Копия файла соседа у нас (`attachments` с `origin_instance_id`, `attached`) занимает место связки его дома —
-- `federation_links.used_bytes` (тот же счётчик, что у файлов гостей, `federation/guestQuota.ts`). Занимает бэкенд ДО
-- записи (`reserveLinkQuota`, атомарно против `quota_bytes`). Возвращает место — этот триггер: копия ушла из `attached`
-- (надгробие, «удалить у обоих», удаление аккаунта, уборка) или строка стёрта. Триггер, а не код: путей стирания много,
-- и пропущенный путь копил бы занятое без файла.
--
-- Только добавления: функция и триггер новые; файлы гостей (`origin_instance_id` пуст) не затрагиваются.
CREATE OR REPLACE FUNCTION gv_fed_att_copy_release() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF OLD.origin_instance_id IS NOT NULL AND OLD.state = 'attached'
     AND (TG_OP = 'DELETE' OR NEW.state IS DISTINCT FROM 'attached') THEN
    UPDATE federation_links SET used_bytes = GREATEST(used_bytes - OLD.size, 0)
      WHERE instance_id = OLD.origin_instance_id;
  END IF;
  RETURN NULL;
END;
$$;

DROP TRIGGER IF EXISTS attachments_fed_copy_release ON attachments;
CREATE TRIGGER attachments_fed_copy_release
  AFTER UPDATE OF state OR DELETE ON attachments
  FOR EACH ROW EXECUTE FUNCTION gv_fed_att_copy_release();

-- Копии, сделанные частью 1 до учёта, — в занятое (иначе их стирание увело бы счётчик ниже правды).
UPDATE federation_links fl SET used_bytes = fl.used_bytes + c.bytes
  FROM (SELECT origin_instance_id AS home, SUM(size)::bigint AS bytes FROM attachments
        WHERE state = 'attached' AND origin_instance_id IS NOT NULL GROUP BY origin_instance_id) c
  WHERE fl.instance_id = c.home;
