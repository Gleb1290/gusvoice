-- Право «Упоминать @everyone, @here и все роли» (#76, Permission.MENTION_EVERYONE = бит 29 = 536870912). Только добавление.
-- 1) messages.mention_everyone — решено при отправке: true зовёт, false текст остался без пинга, NULL — обращений нет /
--    старое сообщение / вебхук (считается как «зовёт», поведение прежнее).
ALTER TABLE messages ADD COLUMN IF NOT EXISTS mention_everyone boolean;
-- 2) Раньше роли звал тот, у кого MANAGE_ROLES (бит 7 = 128) или ADMINISTRATOR (бит 12 = 4096); @everyone звал любой.
--    Как у Discord, право по умолчанию есть у @everyone (и у «Гостей» — копия @everyone), поэтому его получают роли
--    @everyone/«Гости» и роли с одним из этих двух прав. Права роли лежат десятичной строкой, до бита 29 влезают в bigint.
UPDATE roles
   SET permissions = ((permissions::bigint) | 536870912)::text
 WHERE (is_everyone OR is_guests OR ((permissions::bigint) & (128 | 4096)) <> 0)
   AND ((permissions::bigint) & 536870912) = 0;
