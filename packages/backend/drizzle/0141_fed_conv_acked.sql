-- ЛС между инстансами, исправления ревью 12.10 (#141, п. 7): «Сообщения ждут, пока сосед их заберёт». Только добавления.
-- acked_seq — `since` последнего забора соседом журнала на связку (его курсор = всё до этого номера он забрал), acked_at — время
-- этого забора. Старые строки: 0 и NULL — «сосед ещё не подтверждал»; плашка считается по возрасту незабранных строк журнала.
ALTER TABLE fed_conv_sync ADD COLUMN IF NOT EXISTS acked_seq bigint NOT NULL DEFAULT 0;
ALTER TABLE fed_conv_sync ADD COLUMN IF NOT EXISTS acked_at timestamptz;
