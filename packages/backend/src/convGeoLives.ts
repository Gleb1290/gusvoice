import { geoLiveEnded, geoLiveStop, geoLiveUpdate, type ConvGeoLiveMedia, type GeoLivePoint } from '@gusvoice/shared';
import { eq } from 'drizzle-orm';
import { db } from './db/index.js';
import { conversationMessages } from './db/schema.js';
import { journal, lockMessage, msgEntries, type ConvAccess, type Delivery } from './conversations.js';
import { changeAudience, messageView } from './convRules.js';

/**
 * Геопозиция в реальном времени в ЛС (14.10, признак `geolive1`): новая точка автора и «Остановить». Правила — чистые
 * `shared/convGeoLive.ts` (`geoLiveUpdate`, `geoLiveStop`); здесь — то, что ходит в базу. Как у Telegram: Android
 * `LocationController.broadcastLastKnownLocation` (`messages.editMessage` с живой точкой) и `stopSharingLocation`
 * (`inputGeoPointLive.stopped`).
 *
 * Любое изменение — строка журнала о сообщении ВСЕМ участникам (как правка опроса): каждый получает `conv.change` с
 * сообщением, догонка `/api/conv/sync` отдаёт то же. `editedAt` НЕ ставится (пометки «изменено» нет), пуша нет (журнал, не
 * отправка), позиция беседы в списке не меняется (`sortKey` не трогаем). Истечение срока — на чтении (`geoLiveView` в
 * `toConvMessage`), здесь оно лишь отказ для новых точек.
 */

export type ConvGeoLiveActResult =
  | { kind: 'ok'; delivery: Delivery | null }
  | { kind: 'not-found' }
  | { kind: 'refused'; code: 400 | 403; error: string };

type Tx = Parameters<Parameters<typeof db.transaction>[0]>[0];

/** Сообщение-трансляция беседы под замком, видимое мне; иначе `null` (404). */
async function lockLive(tx: Tx, me: string, access: ConvAccess, messageId: string): Promise<{ live: ConvGeoLiveMedia; authorId: string; withheld: boolean } | null> {
  const m = await lockMessage(tx, access.conversationId, messageId);
  if (!m || m.deletedAt || messageView(m, me) !== 'full' || m.media?.kind !== 'geolive') return null;
  return { live: m.media, authorId: m.authorId, withheld: m.withheld };
}

async function journalLive(tx: Tx, me: string, access: ConvAccess, messageId: string, withheld: boolean): Promise<Delivery> {
  const audience = changeAudience({ action: 'edit', actorId: me, memberIds: access.memberIds, withheld, blockedActor: new Set() });
  const pts = await journal(tx, msgEntries(audience, access.conversationId, messageId));
  return { conversationId: access.conversationId, messageId, pts };
}

/** Новая точка трансляции — только автор, пока идёт; чаще `GEO_LIVE_LIMITS.minGapMs` — успех без записи. */
export async function updateConvGeoLive(me: string, access: ConvAccess, messageId: string, point: GeoLivePoint, now: number = Date.now()): Promise<ConvGeoLiveActResult> {
  return db.transaction(async (tx): Promise<ConvGeoLiveActResult> => {
    const p = await lockLive(tx, me, access, messageId);
    if (!p) return { kind: 'not-found' };
    if (p.authorId !== me) return { kind: 'refused', code: 403, error: 'точку обновляет только автор' };
    const res = geoLiveUpdate(p.live, point, now);
    if (!res.ok) return { kind: 'refused', code: res.code, error: res.error };
    if (!res.media) return { kind: 'ok', delivery: null };
    await tx.update(conversationMessages).set({ media: res.media }).where(eq(conversationMessages.id, messageId));
    return { kind: 'ok', delivery: await journalLive(tx, me, access, messageId, p.withheld) };
  });
}

/** «Остановить» — только автор, навсегда; повтор и уже истёкшая — успех без события. */
export async function stopConvGeoLive(me: string, access: ConvAccess, messageId: string, now: number = Date.now()): Promise<ConvGeoLiveActResult> {
  return db.transaction(async (tx): Promise<ConvGeoLiveActResult> => {
    const p = await lockLive(tx, me, access, messageId);
    if (!p) return { kind: 'not-found' };
    if (p.authorId !== me) return { kind: 'refused', code: 403, error: 'остановить трансляцию может только автор' };
    if (geoLiveEnded(p.live, now)) return { kind: 'ok', delivery: null };
    await tx.update(conversationMessages).set({ media: geoLiveStop(p.live) }).where(eq(conversationMessages.id, messageId));
    return { kind: 'ok', delivery: await journalLive(tx, me, access, messageId, p.withheld) };
  });
}
