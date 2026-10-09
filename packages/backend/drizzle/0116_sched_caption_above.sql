-- «Подпись над медиа» у отложенного (08.10, #211, G48, признак `media2`, хвост `tails2`): «Отправить позже» из окна отправки
-- файлов переносит `captionAbove` в сообщение, которое уйдёт (спойлер лежит в самом вложении jsonb, колонки не нужно).
-- Только добавление: колонка со значением по умолчанию, старые строки остаются «подпись снизу».
ALTER TABLE conversation_scheduled ADD COLUMN IF NOT EXISTS caption_above boolean NOT NULL DEFAULT false;
