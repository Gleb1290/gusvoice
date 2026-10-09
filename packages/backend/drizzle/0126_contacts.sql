-- Контакты (08.10, #211, признак `contacts1`, решение владельца 08.10 п.7). Только добавления: старый код таблицы не знает.
-- owner держит contact в своём списке «Контакты»; name — его личная подпись (NULL — собственное имя человека).
CREATE TABLE IF NOT EXISTS user_contacts (
  owner_id text NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  contact_id text NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  name text,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (owner_id, contact_id)
);
-- «У кого я в контактах» — для будущих правил приватности «Мои контакты» и стирания аккаунта в обе стороны.
CREATE INDEX IF NOT EXISTS user_contacts_contact_idx ON user_contacts (contact_id, owner_id);
