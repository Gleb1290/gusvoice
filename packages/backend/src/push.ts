import { BROADCAST_MENTIONS, mentionedHandles } from '@gusvoice/shared';
import { instanceIdByDomain } from './federation/instanceLabels.js';
import { getChannelAudience } from './permissions.js';
import { and, eq, inArray, sql } from 'drizzle-orm';
import { db } from './db/index.js';
import { pushDevices, pushMutes, serverMembers, users } from './db/schema.js';
import { env } from './env.js';
import { endpointAllowed } from './pushRules.js';
import { id } from './util.js';

// Чистые правила — в `pushRules.ts`. Реэкспорт, чтобы роуты продолжали брать `contentPreview`
// из `push.js` (там же рядом `sendPushToUsers`, который они и зовут).
export { contentPreview } from './pushRules.js';

/**
 * A background-wake push payload. Delivered as the raw POST body to a device's UnifiedPush endpoint;
 * the Android receiver parses this JSON and builds the local notification (so it works even when the
 * app process is dead). Web/desktop already notify in-app via the Notification path — this is Android.
 */
export interface PushPayload {
  type: 'dm' | 'mention';
  title: string;
  body: string;
  dmId?: string;
  channelId?: string;
  serverId?: string;
  /**
   * На каком инстансе это случилось (#139, F5, требование 33) — `instance_id` федерации.
   *
   * Пусто — у нас же, как было всегда. Заполнено — пуш приехал с ЧУЖОГО инстанса через дом, и по
   * тапу приложение обязано перейти туда: серверов и каналов с такими идентификаторами у дома нет,
   * и без этого поля тап привёл бы в пустоту.
   */
  instanceId?: string;
}

export type PushMuteScope = 'server' | 'dm_user';

/**
 * Where a push originates, so recipients who muted that source get filtered out before we wake their
 * phone. `server` => the @mention's server; `dm_user` => the DM author. See sendPushToUsers.
 */
export interface PushSource {
  scope: PushMuteScope;
  targetId: string;
}

const NTFY_BASE = env.ntfy.baseUrl; // e.g. https://ntfy.example.com
const NTFY_TOKEN = env.ntfy.token;

/** `endpointAllowed` с нашей базой ntfy — единственный заслон от SSRF (endpoint приходит с устройства). */
export function pushEndpointAllowed(endpoint: string): boolean {
  return endpointAllowed(endpoint, NTFY_BASE);
}

/** Upsert a device's UnifiedPush endpoint for a user (one row per user+device). */
export async function registerPushDevice(
  userId: string,
  deviceId: string,
  endpoint: string,
  platform: string | null,
): Promise<void> {
  await db
    .insert(pushDevices)
    .values({ id: id(), userId, deviceId, endpoint, platform, updatedAt: new Date() })
    .onConflictDoUpdate({
      target: [pushDevices.userId, pushDevices.deviceId],
      set: { endpoint, platform, updatedAt: new Date() },
    });
}

export async function unregisterPushDevice(userId: string, deviceId: string): Promise<void> {
  await db.delete(pushDevices).where(and(eq(pushDevices.userId, userId), eq(pushDevices.deviceId, deviceId)));
}

/**
 * Best-effort: POST a wake payload to every registered device of each recipient, REGARDLESS of whether
 * they're online elsewhere — so a DM/@mention still buzzes your phone while you sit at the desktop.
 * Fire-and-forget — never blocks or throws into the message path. (Per-device foreground suppression —
 * so the phone doesn't double-notify while you're actively in the app on it — is a device-side follow-up.)
 *
 * `source` (optional) lets recipients opt out per-source: any recipient with a matching push_mute row
 * (e.g. muted this server, or muted DMs from this person) is dropped before their phone is woken.
 */
export async function sendPushToUsers(
  recipientIds: string[],
  payload: PushPayload,
  source?: PushSource,
): Promise<void> {
  let ids = [...new Set(recipientIds)];
  if (ids.length === 0) return;
  if (source) {
    const muted = await db
      .select({ userId: pushMutes.userId })
      .from(pushMutes)
      .where(
        and(
          inArray(pushMutes.userId, ids),
          eq(pushMutes.scope, source.scope),
          eq(pushMutes.targetId, source.targetId),
        ),
      );
    if (muted.length > 0) {
      const drop = new Set(muted.map((m) => m.userId));
      ids = ids.filter((uid) => !drop.has(uid));
      if (ids.length === 0) return;
    }
  }
  /**
   * 🔴 Гостей будим ЧЕРЕЗ ИХ ДОМ (требование 33). Устройство гостя зарегистрировано в пушах дома, а
   * не у нас: своей рассылкой мы до его телефона не достучимся в принципе — раньше он просто не
   * узнавал, что его позвали, пока сам не открывал приложение.
   *
   * ⚠️ Содержимое сообщения дому НЕ уходит: он получает «вашего человека позвали там-то» и будит
   * телефон своим пушем. Текст клиент забирает у нас, когда человек откроет приложение.
   */
  const rows = await db
    .select({ id: users.id, homeInstanceId: users.homeInstanceId, homeUserId: users.homeUserId })
    .from(users)
    .where(inArray(users.id, ids));
  const guests = rows.filter((r) => r.homeInstanceId && r.homeUserId);
  if (guests.length > 0) {
    void import('./federation/guestPush.js')
      .then(({ notifyGuestHomes }) =>
        notifyGuestHomes(
          guests.map((g) => ({ instanceId: g.homeInstanceId!, homeUserId: g.homeUserId! })),
          payload,
        ),
      )
      .catch(() => {
        /* дом недоступен — событие осталось в очереди и уедет само */
      });
    const guestIds = new Set(guests.map((g) => g.id));
    ids = ids.filter((uid) => !guestIds.has(uid));
    if (ids.length === 0) return;
  }

  // Своим — как раньше, напрямую через наш ntfy. ⚠️ Проверка настройки стоит ЗДЕСЬ, а не в начале:
  // инстанс без своих пушей всё равно обязан разбудить гостя через его дом.
  if (!NTFY_BASE || !NTFY_TOKEN) return;
  const devices = await db.select().from(pushDevices).where(inArray(pushDevices.userId, ids));
  if (devices.length === 0) return;
  const body = JSON.stringify(payload);
  await Promise.all(
    devices.map(async (d) => {
      if (!pushEndpointAllowed(d.endpoint)) return;
      try {
        const res = await fetch(d.endpoint, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${NTFY_TOKEN}` },
          body,
          redirect: 'manual', // SSRF (P2-5): NEVER follow a 3xx into the internal network
        });
        // A redirect (3xx) from a push endpoint is anomalous/malicious — don't follow it, drop the
        // device. Topic gone / payload too large (404/413) => stale registration, also drop.
        const redirected = res.type === 'opaqueredirect' || (res.status >= 300 && res.status < 400);
        if (redirected || res.status === 404 || res.status === 413) {
          await db.delete(pushDevices).where(eq(pushDevices.id, d.id)).catch(() => {});
        }
      } catch {
        /* best-effort; the message itself already delivered over the gateway */
      }
    }),
  );
}

/**
 * Resolve @username mentions in `content` to member userIds of `serverId` (excluding the author).
 *
 * ⚠️ Имена достаёт ОБЩЕЕ правило (`shared/mentions.ts`), то же самое, по которому клиент решает
 * звенеть ли звуком. Своя регулярка тут была и расходилась с клиентской: `@super.` в конце
 * предложения превращалось в имя «super.», такого пользователя в базе нет, и пуш не уходил —
 * при том что на десктопе упоминание отрабатывало.
 */
export async function resolveMentionedMembers(
  content: string,
  serverId: string,
  authorId: string,
  /** Канал сообщения — по нему считается, кого будит `@everyone`. Без него `@everyone` пуш не шлёт. */
  channelId?: string,
): Promise<string[]> {
  const handles = mentionedHandles(content);
  if (handles.length === 0) return [];
  const isBroadcast = (name: string) => (BROADCAST_MENTIONS as readonly string[]).includes(name);
  const names = handles.filter((h) => h.domain === null && !isBroadcast(h.name)).map((h) => h.name);
  const guests = handles.filter((h) => h.domain !== null);

  const found: string[] = [];

  /**
   * `@everyone` (#76, мегаприёмка 23.09): раньше уходил в поиск пользователя с именем «everyone» и не
   * будил никого, хотя звук и значок у людей в приложении срабатывали. Будим всех, кто ВИДИТ канал, —
   * ту же аудиторию, что получает само сообщение (`getChannelAudience`), и только настоящих участников:
   * супер-админ входит в аудиторию любого канала виртуально, и пуш с чужих серверов ему не нужен.
   *
   * ⚠️ `@here` пуш не шлёт намеренно: он про тех, кто сейчас в приложении, а они получают звук и значок
   * живьём. Разбудить телефон спящему — ровно то, чем `@here` отличается от `@everyone`.
   */
  if (channelId && handles.some((h) => h.domain === null && h.name === 'everyone')) {
    const audience = await getChannelAudience(channelId);
    if (audience && audience.serverId === serverId && audience.userIds.length > 0) {
      const rows = await db
        .select({ id: serverMembers.userId })
        .from(serverMembers)
        .where(and(eq(serverMembers.serverId, serverId), inArray(serverMembers.userId, audience.userIds)));
      found.push(...rows.map((r) => r.id));
    }
  }
  if (names.length > 0) {
    const rows = await db
      .select({ id: users.id })
      .from(users)
      .innerJoin(serverMembers, and(eq(serverMembers.userId, users.id), eq(serverMembers.serverId, serverId)))
      .where(inArray(sql`lower(${users.username})`, names));
    found.push(...rows.map((r) => r.id));
  }

  /**
   * Гость (#139, F4, §5.5): к нему обращаются `@ник@домен`, и найти его можно только по ПАРЕ.
   *
   * 🔴 По одному нику искать нельзя: на сервере бывает свой Вася и Вася с соседнего инстанса, и
   * поиск по имени позвонил бы не тому — ровно поэтому домен в обращении и появился.
   * ⚠️ Домен → инстанс берём из кеша связок: имя инстанса меняется раз в недели, а сообщения идут
   * потоком, и лишний запрос в базу на каждое упоминание тут ни к чему.
   */
  for (const h of guests) {
    const instanceId = instanceIdByDomain(h.domain!);
    if (!instanceId) continue;
    const rows = await db
      .select({ id: users.id })
      .from(users)
      .innerJoin(serverMembers, and(eq(serverMembers.userId, users.id), eq(serverMembers.serverId, serverId)))
      .where(and(eq(users.homeInstanceId, instanceId), eq(sql`lower(${users.homeUsername})`, h.name)));
    found.push(...rows.map((r) => r.id));
  }

  return [...new Set(found)].filter((uid) => uid !== authorId);
}

/** List a user's active push-mute rules (for bootstrap / settings UI). */
export async function listPushMutes(userId: string): Promise<{ scope: PushMuteScope; targetId: string }[]> {
  const rows = await db
    .select({ scope: pushMutes.scope, targetId: pushMutes.targetId })
    .from(pushMutes)
    .where(eq(pushMutes.userId, userId));
  return rows.map((r) => ({ scope: r.scope as PushMuteScope, targetId: r.targetId }));
}

/** Mute pushes from a source (server or DM-person) for this user. Idempotent. */
export async function setPushMute(userId: string, scope: PushMuteScope, targetId: string): Promise<void> {
  await db.insert(pushMutes).values({ userId, scope, targetId }).onConflictDoNothing();
}

/** Un-mute a previously muted source. */
export async function removePushMute(userId: string, scope: PushMuteScope, targetId: string): Promise<void> {
  await db
    .delete(pushMutes)
    .where(and(eq(pushMutes.userId, userId), eq(pushMutes.scope, scope), eq(pushMutes.targetId, targetId)));
}
