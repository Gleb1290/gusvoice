-- #197 п. 4 (F-08): отметка последнего изменения улик — по ней держателя оповещают о жалобе и о её
-- дополнении, а не по числу улик в ключе журнала. У старых строк улики менялись не позже created_at.
ALTER TABLE federation_reports ADD COLUMN IF NOT EXISTS evidence_at TIMESTAMPTZ NOT NULL DEFAULT now();
UPDATE federation_reports SET evidence_at = date_trunc('milliseconds', created_at);

-- Журнал оповещений переводится на новый ключ (<id>#<evidence_at в мс>), чтобы после выкатки старые
-- жалобы не пришли держателю заново. Промежуточный ключ <id>#<число улик> (83b99bc2) — туда же; если
-- есть обе формы, промежуточную убираем.
DELETE FROM federation_alerts a
 USING federation_reports r
 WHERE a.kind = 'report-received'
   AND r.direction = 'in'
   AND a.detail = r.id || '#' || jsonb_array_length(r.evidence)::text
   AND EXISTS (
     SELECT 1 FROM federation_alerts b
      WHERE b.kind = 'report-received' AND b.instance_id = a.instance_id AND b.detail = r.id
   );
UPDATE federation_alerts a
   SET detail = r.id || '#' || (floor(extract(epoch FROM r.evidence_at) * 1000))::bigint::text
  FROM federation_reports r
 WHERE a.kind = 'report-received'
   AND r.direction = 'in'
   AND (a.detail = r.id OR a.detail = r.id || '#' || jsonb_array_length(r.evidence)::text);
