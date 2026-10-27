-- Боты, этап 2 (#230): команды по «/» и кнопки под сообщением. Только добавления: старый код новых колонок не знает.
--
-- bots.commands — список команд (`setMyCommands`) одной колонкой: метод замещает его целиком, клиент читает целиком при
--   открытии беседы (`GET /api/conv/:id/bot`); ≤ 100 записей `{command, description}`, уже проверенных `bots/botWire.ts`.
ALTER TABLE bots ADD COLUMN IF NOT EXISTS commands jsonb NOT NULL DEFAULT '[]'::jsonb;
ALTER TABLE bots ADD COLUMN IF NOT EXISTS commands_updated_at timestamptz;
-- conversation_messages.keyboard — кнопки под сообщением бота: [[{text, callback_data}|{text, url}]] (проверены botWire).
--   NULL — кнопок нет. Только ЛС с ботом; в федерацию и при пересылке не уезжает.
ALTER TABLE conversation_messages ADD COLUMN IF NOT EXISTS keyboard jsonb;
