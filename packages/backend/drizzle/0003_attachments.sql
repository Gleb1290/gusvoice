-- Message attachments (images / files), stored as a JSON array of {url,name,contentType,size,width?,height?}.
ALTER TABLE messages ADD COLUMN IF NOT EXISTS attachments jsonb NOT NULL DEFAULT '[]'::jsonb;
