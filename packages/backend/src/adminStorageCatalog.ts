import { asc, eq, sql } from 'drizzle-orm';
import { db } from './db/index.js';
import { attachments, channels, servers, serverSoundboard, users } from './db/schema.js';
import type { StorageCatalog, StorageReference } from './adminStorageReport.js';

/** Снимок метаданных и ссылок, необходимых для распределения объектов по владельцам. */
export async function loadStorageCatalog(): Promise<StorageCatalog> {
  return db.transaction(async tx => {
    const serverRows = await tx.select({ id: servers.id, name: servers.name }).from(servers).orderBy(asc(servers.id));
    const channelRows = await tx.select({ id: channels.id, serverId: channels.serverId }).from(channels);
    const clips = await tx.select({
      id: serverSoundboard.id,
      serverId: serverSoundboard.serverId,
      url: serverSoundboard.url,
      userId: serverSoundboard.createdBy,
      name: users.displayName,
    }).from(serverSoundboard).leftJoin(users, eq(serverSoundboard.createdBy, users.id)).orderBy(asc(serverSoundboard.id));
    const privateAttachments = await tx.select({ key: attachments.storageKey }).from(attachments)
      .where(sql`${attachments.storageKey} NOT LIKE 'dm/%'`);

    // Выбираем только уникальные ссылки. Поля размера из JSON и таблиц в замере не участвуют.
    const { rows: references } = await tx.execute<StorageReference>(sql`
      SELECT DISTINCT ref.url, ref.server_id AS "serverId", ref.category
      FROM (
        SELECT server_id, url, 'eventSoundsBytes' AS category FROM server_sounds
        UNION ALL
        SELECT channels.server_id, channel_sounds.url, 'eventSoundsBytes'
          FROM channel_sounds JOIN channels ON channels.id = channel_sounds.channel_id
        UNION ALL
        SELECT id, icon_url, 'appearanceBytes' FROM servers
        UNION ALL
        SELECT server_id, icon_url, 'appearanceBytes' FROM server_economy
        UNION ALL
        SELECT server_id, icon, 'appearanceBytes' FROM channels
        UNION ALL
        SELECT server_id, url, 'appearanceBytes' FROM server_emojis
        UNION ALL
        SELECT sticker_packs.server_id, stickers.url, 'appearanceBytes'
          FROM stickers JOIN sticker_packs ON sticker_packs.id = stickers.pack_id
        UNION ALL
        SELECT channels.server_id, messages.sticker->>'url', 'appearanceBytes'
          FROM messages JOIN channels ON channels.id = messages.channel_id
          WHERE messages.sticker IS NOT NULL
        UNION ALL
        SELECT channels.server_id, item.value->>'url', 'channelAttachmentsBytes'
          FROM messages JOIN channels ON channels.id = messages.channel_id
          CROSS JOIN LATERAL jsonb_array_elements(messages.attachments) AS item(value)
        UNION ALL
        SELECT NULL, item.value->>'url', 'directMessagesBytes'
          FROM conversation_messages
          CROSS JOIN LATERAL jsonb_array_elements(conversation_messages.attachments) AS item(value)
          WHERE item.value->>'id' IS NULL
      ) AS ref
      WHERE ref.url IS NOT NULL
    `);

    return {
      servers: serverRows,
      channels: channelRows,
      clips,
      references,
      privateAttachmentKeys: new Set(privateAttachments.map(({ key }) => key)),
    };
  }, { isolationLevel: 'repeatable read', accessMode: 'read only' });
}
