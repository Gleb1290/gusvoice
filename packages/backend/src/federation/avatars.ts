/**
 * Аватары соседей: качаются ЛЕНИВО и через хост (#139, F2, план §5.4).
 *
 * 🔴 Клиенты никогда не ходят за картинкой на чужой инстанс. Иначе достаточно показать человеку
 * список людей соседа, чтобы его браузер сходил на чужой домен и оставил там свой адрес — а держатель
 * того инстанса получил бы список адресов всех, кто открыл вкладку. Поэтому картинку забирает наш
 * бэкенд, кладёт в СВОЁ хранилище и отдаёт из него.
 *
 * ⚠️ «Лениво» здесь не оптимизация, а отказ качать то, что никто не смотрел: каталог на тысячу
 * человек это тысяча картинок, и тянуть их все при каждой сверке значит гонять гигабайты ради
 * десятка лиц, которые реально откроют.
 *
 * Порядок шагов (проверка картинки, квота, запись «если строка всё ещё та», уборка проигравшего) —
 * `avatarsCore.ts` (вынос для тестов 22.09). Здесь — база, хранилище, сеть и условия записи в SQL:
 * `peerCopyStore`/`guestCopyStore` экспортированы, чтобы их CAS проверялся на PGlite.
 */

import { randomBytes } from 'node:crypto';
import { and, eq, isNull } from 'drizzle-orm';
import { db } from '../db/index.js';
import { federationPeerUsers, users } from '../db/schema.js';
import { federation } from './instance.js';
import { getSignedFromPeer } from './peerClient.js';
import { getLink } from './links.js';
import { mediaHashOf } from './directoryRules.js';
import { avatarUrlForPeer } from './avatarRules.js';
import { putMedia, readOwnMedia, removeOwnMedia } from '../storage.js';
import { rateHit } from '../authGuard.js';
import { releaseLinkQuota, releaseQuota, reserveLinkQuota, reserveQuota } from './guestQuota.js';
import { createAvatarCopier, FED_AVATAR_MAX_BYTES, type GuestCopyStore, type PeerCopyStore } from './avatarsCore.js';

// Правило «кому отдавать лицо» живёт в `avatarRules.ts` (ЧИСТОМ): этот модуль на импорте тянет
// базу, хранилище и сеть, и проверить по нему матрицу видимости было нельзя без живого инстанса.
export { avatarUrlForPeer } from './avatarRules.js';
export { FED_AVATAR_MAX_BYTES } from './avatarsCore.js';

/**
 * Не чаще раза в десять минут качаем лицо одного человека (аудит 19.09, F-05): сосед, меняя хеши
 * аватаров, иначе гонял бы к нам по 5 МБ на каждую смену. Redis лежит — не ограничиваем.
 *
 * ⚠️ Ключ — свой у каждого пути (ревью #195 п. 9): копия для каталога и копия для гостя — разные
 * файлы, и открытый админом каталог не должен оставлять вошедшего следом гостя с буквой вместо лица.
 */
const AVATAR_REFETCH_WINDOW_S = 600;

async function refetchAllowed(kind: 'peer' | 'guest', instanceId: string, userId: string): Promise<boolean> {
  const wait = await rateHit(`fed:avatar:${kind}:${instanceId}:${userId}`, 1, AVATAR_REFETCH_WINDOW_S).catch(() => 0);
  return wait === 0;
}

const peerRow = (instanceId: string, userId: string) =>
  and(eq(federationPeerUsers.instanceId, instanceId), eq(federationPeerUsers.userId, userId));

/** Копия для каталога: строка `federation_peer_users`. Условия записи — CAS в `WHERE` (#198 п. 6, #199 п. 8). */
export const peerCopyStore: PeerCopyStore = {
  async read(instanceId, userId) {
    const [row] = await db.select().from(federationPeerUsers).where(peerRow(instanceId, userId)).limit(1);
    return row ?? null;
  },
  async clear(instanceId, userId, expectUrl) {
    const cleared = await db
      .update(federationPeerUsers)
      .set({ avatarLocalUrl: null, avatarCachedHash: null })
      .where(and(peerRow(instanceId, userId), eq(federationPeerUsers.avatarLocalUrl, expectUrl)))
      .returning({ userId: federationPeerUsers.userId });
    return cleared.length > 0;
  },
  async swap(instanceId, userId, next, expect) {
    const swapped = await db
      .update(federationPeerUsers)
      .set({ avatarLocalUrl: next.url, avatarCachedHash: next.hash })
      .where(
        and(
          peerRow(instanceId, userId),
          eq(federationPeerUsers.avatarHash, expect.hash),
          expect.url ? eq(federationPeerUsers.avatarLocalUrl, expect.url) : isNull(federationPeerUsers.avatarLocalUrl),
        ),
      )
      .returning({ userId: federationPeerUsers.userId });
    return swapped.length > 0;
  },
  async current(instanceId, userId) {
    const [row] = await db
      .select({ url: federationPeerUsers.avatarLocalUrl })
      .from(federationPeerUsers)
      .where(peerRow(instanceId, userId))
      .limit(1);
    return row?.url ?? null;
  },
};

/** Копия для гостя: теневая строка `users`. Условие записи — ссылка всё ещё та, что прочли (#198 п. 6). */
export const guestCopyStore: GuestCopyStore = {
  async read(shadowUserId) {
    const [row] = await db
      .select({ id: users.id, avatarUrl: users.avatarUrl, homeAvatarHash: users.homeAvatarHash })
      .from(users)
      .where(eq(users.id, shadowUserId))
      .limit(1);
    return row ?? null;
  },
  async clear(id, expectUrl) {
    const cleared = await db
      .update(users)
      .set({ avatarUrl: null, homeAvatarHash: null })
      .where(and(eq(users.id, id), eq(users.avatarUrl, expectUrl)))
      .returning({ id: users.id });
    return cleared.length > 0;
  },
  async swap(id, next, expectUrl) {
    const swapped = await db
      .update(users)
      .set({ avatarUrl: next.url, homeAvatarHash: next.hash })
      .where(and(eq(users.id, id), expectUrl ? eq(users.avatarUrl, expectUrl) : isNull(users.avatarUrl)))
      .returning({ id: users.id });
    return swapped.length > 0;
  },
  async current(id) {
    const [row] = await db.select({ url: users.avatarUrl }).from(users).where(eq(users.id, id)).limit(1);
    return row?.url ?? null;
  },
};

// Зависимости — через стрелки: `links` в кольце импортов и может быть ещё не вычислен.
const copier = createAvatarCopier({
  getSignedFromPeer: (input) => getSignedFromPeer(input),
  signer: () => {
    const self = federation.identity();
    const key = federation.signingKey();
    return self && key ? { instanceId: self.instanceId, kid: key.kid, privateKeyDer: key.privateKeyDer } : null;
  },
  getLink: (instanceId) => getLink(instanceId),
  refetchAllowed,
  putMedia: (category, key, bytes, mime, stamp) => putMedia(category, key, bytes, mime, stamp),
  removeOwnMedia: (url) => removeOwnMedia(url),
  now: () => Date.now(),
  copySuffix: () => randomBytes(4).toString('hex'),
  peer: peerCopyStore,
  guest: guestCopyStore,
  linkQuota: { reserve: (owner, bytes) => reserveLinkQuota(owner, bytes), release: (owner, bytes) => releaseLinkQuota(owner, bytes) },
  userQuota: { reserve: (owner, bytes) => reserveQuota(owner, bytes), release: (owner, bytes) => releaseQuota(owner, bytes) },
});

export async function ownAvatarFor(userId: string): Promise<{ bytes: Buffer; contentType: string } | null> {
  const [row] = await db.select().from(users).where(eq(users.id, userId)).limit(1);
  if (!row) return null;
  const url = avatarUrlForPeer(row);
  if (!url) return null;
  return readOwnMedia(url, FED_AVATAR_MAX_BYTES);
}

/**
 * Наша копия аватара человека с соседнего инстанса — лениво, при открытии каталога (§5.4).
 * `null` — аватара нет, сосед недоступен, картинка не годится: интерфейс покажет кружок с буквой.
 */
export function peerAvatarUrl(instanceId: string, userId: string): Promise<string | null> {
  return copier.peerAvatarUrl(instanceId, userId);
}

/** Отпечаток нашей картинки — тот же способ, что и в каталоге (сравнение идёт по нему). */
export const avatarFingerprint = mediaHashOf;

/**
 * Аватар ГОСТЯ на хосте (F3, §5.4).
 *
 * 🔴 Качается сразу при входе и при смене отпечатка — не лениво, в отличие от каталога. Разница по
 * делу: в каталоге тысяча человек, из которых откроют десяток, а гость на сервере виден каждому
 * участнику в каждом сообщении, и «ленивая» загрузка означала бы пустой кружок ровно там, где лицо
 * и нужно.
 *
 * ⚠️ Зовётся БЕЗ ожидания: вход гостя не должен ждать чужую картинку. Не вышло — останется кружок с
 * буквой, а следующая попытка будет при следующем входе или смене аватара.
 */
export function refreshGuestAvatar(input: {
  shadowUserId: string;
  instanceId: string;
  homeUserId: string;
  avatarHash: string | null;
}): Promise<string | null> {
  return copier.refreshGuestAvatar(input);
}
