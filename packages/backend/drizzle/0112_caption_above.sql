-- «Подпись над медиа» (08.10, #211, G48, признак `media2`): у сообщения с подписью и вложением подпись рисуется над фото или
-- альбомом, как `Type::CaptionUp` в окне отправки файлов Telegram Desktop. Флаг — у самого сообщения; DTO несёт
-- `captionAbove: true` только у таких, пересылка его переносит. Спойлер хранится в самом вложении (jsonb), колонки не нужно.
-- Только добавление: колонка со значением по умолчанию, старые строки остаются «подпись снизу».
ALTER TABLE conversation_messages ADD COLUMN IF NOT EXISTS caption_above boolean NOT NULL DEFAULT false;
