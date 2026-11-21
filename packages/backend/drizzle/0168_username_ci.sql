-- Сохраняем прежние варианты регистра. Каждый занятый ник резервируется одной строкой, даже если у него несколько владельцев.
LOCK TABLE users IN SHARE ROW EXCLUSIVE MODE;

CREATE TABLE user_username_claims (
  username text CONSTRAINT users_username_ci_key PRIMARY KEY,
  holders bigint NOT NULL CHECK (holders >= 0)
);

INSERT INTO user_username_claims (username, holders)
SELECT lower(username), count(*) FROM users GROUP BY lower(username);

CREATE FUNCTION sync_user_username_claim() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'UPDATE' AND lower(OLD.username) = lower(NEW.username) THEN
    RETURN NEW;
  END IF;

  -- Обычный уникальный ключ ждёт параллельную транзакцию и отклоняет новый конфликт даже при старом снимке.
  IF TG_OP <> 'DELETE' THEN
    INSERT INTO user_username_claims (username, holders) VALUES (lower(NEW.username), 1);
  END IF;

  IF TG_OP <> 'INSERT' THEN
    UPDATE user_username_claims SET holders = holders - 1 WHERE username = lower(OLD.username);
    DELETE FROM user_username_claims WHERE username = lower(OLD.username) AND holders = 0;
  END IF;
  RETURN NULL;
END;
$$;

CREATE TRIGGER users_username_ci
AFTER INSERT OR UPDATE OF username OR DELETE ON users
FOR EACH ROW EXECUTE FUNCTION sync_user_username_claim();
