-- «Кто может мне писать» (13.10, #218, решение владельца, признак `msgpriv1`). Только добавления: старый код колонку не знает,
-- а ключ исключений 'messages' не читает (выбирает свой 'calls').
-- users.message_privacy: everyone | contacts; по умолчанию everyone — писать может кто угодно (как было до настройки).
-- Telegram: GlobalPrivacySettings.new_noncontact_peers_require_premium («Мои контакты и Premium»; Premium у нас нет).
ALTER TABLE users ADD COLUMN IF NOT EXISTS message_privacy text NOT NULL DEFAULT 'everyone';
-- Исключения «Всегда разрешать» — в общей privacy_exceptions (0122) под ключом 'messages': расширяем проверку ключа.
ALTER TABLE privacy_exceptions DROP CONSTRAINT IF EXISTS privacy_exceptions_key_check;
ALTER TABLE privacy_exceptions ADD CONSTRAINT privacy_exceptions_key_check CHECK (key IN ('calls', 'messages'));
