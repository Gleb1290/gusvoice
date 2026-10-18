-- Тумблер федерации в админке (#224): федерацию и ЛС между инстансами включают во вкладке «Федерация» без `.env` и перезапуска.
-- Флаги — строка `federation_switch` в той же `instance_settings` (ключ → JSON), что `registration` и `smtp`; заводится
-- выключенной. `.env` главнее: `FEDERATION_ENABLED=true` / `FEDERATION_DM_ENABLED=true` включают и без строки (`federation/switch.ts`).
-- Пароль к ключу инстанса (`federation_key_passphrase`) здесь НЕ заводится: его генерирует бэкенд при первом включении из
-- админки, и только если `FEDERATION_KEY_PASSPHRASE` в `.env` пуст. Сам ключ — по-прежнему файл в `fed-keys`, не в базе.
-- Только добавление.
INSERT INTO instance_settings (key, value) VALUES ('federation_switch', '{"enabled": false, "dmEnabled": false}'::jsonb)
ON CONFLICT (key) DO NOTHING;
