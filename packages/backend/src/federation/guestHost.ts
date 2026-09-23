/**
 * Сторона ХОСТА: как чужой человек становится нашим гостем (#139, F3, план §5.5).
 *
 * 🔴 Этот запрос приходит НЕ от соседа, а от клиента самого человека — значит подписи запроса нет и
 * `authenticateLinkedPeer` здесь неприменим. Вся тяжесть проверки лежит на токене личности: он
 * подписан домом, годен две минуты, выписан именно нам и принимается ровно один раз.
 *
 * ⚠️ Гостевая сессия = «личность подтверждена», а НЕ «участник сервера» (§5.6). Доступ к каждому
 * серверу, каналу и беседе проверяется отдельно и дальше — иначе личка без общего сервера (§7) не
 * легла бы на этот механизм, а сессия сама по себе открывала бы двери.
 */

import { randomUUID } from 'node:crypto';
import { and, eq, sql } from 'drizzle-orm';
import { FED_ERRORS, FED_IDENTITY_SKEW_MS, type FedErrorCode, type FedIdentityClaims } from '@gusvoice/shared';
import { db } from '../db/index.js';
import { users } from '../db/schema.js';
import { bumpTokenGeneration, hashPassword, signToken } from '../auth.js';
import { TOKEN_TTL_S } from '../authRules.js';
import { federation } from './instance.js';
import { getLink } from './links.js';
import { linkVerdict } from './linkRules.js';
import { readInstanceMeta } from './instanceMeta.js';
import { peerPublicKey } from './peerAuth.js';
import { peekIdentityToken, verifyIdentityToken } from './identityToken.js';
import { GUEST_LIMITS, guestGenVerdict, identityRefusal, shadowUsername } from './guestRules.js';
import { fedRateBlock, seenIdentityJti } from './guardsRuntime.js';
import { instanceBanFor } from './instanceBan.js';
import { refreshGuestAvatar } from './avatars.js';
import type { StoredLink } from './linkService.js';

export type GuestSessionResult =
  | { ok: true; userId: string; token: string; expiresAt: number; created: boolean }
  | {
      ok: false;
      status: number;
      error: FedErrorCode | 'identity-invalid' | 'rate-limited';
      detail?: string;
      /** Для `429`: через сколько секунд пробовать снова. */
      retryAfterS?: number;
    };

/**
 * Чем искать публичный ключ дома. По умолчанию — кеш визиток (`peerPublicKey`).
 *
 * Отдельным параметром, потому что иначе весь вход гостя нельзя проверить, не подняв два инстанса в
 * разных сетях: защита от SSRF (справедливо) не пускает наш бэкенд на loopback, а любой адрес,
 * который можно поднять в проверке, — это loopback. Тот же приём, что у связки (`createLinkService`).
 */
export type PeerKeyLookup = (link: StoredLink, kid: string, force: boolean) => Promise<Buffer | null>;

/**
 * Всё, что сторона хоста берёт СНАРУЖИ (#139, F3; вынесено по просьбе Codex 16.09).
 *
 * 🔴 Раньше инъецировался только поиск ключа, а личность, связка, пауза, одноразовые метки и запрет
 * оставались глобальными — и вход гостя нельзя было проверить честно: ни первый вход, ни то, что
 * подделка НЕ заводит человека, ни немедленную смерть старой сессии при новом поколении. То есть
 * проверялось всё, кроме главного.
 *
 * ⚠️ База намеренно осталась общей: она в проверках настоящая (PGlite), и подменять её значило бы
 * проверять подделку вместо `ON CONFLICT` и внешних ключей.
 */
export interface GuestHostDeps {
  /** Наша личность. `null` — федерация не поднялась. */
  identity(): { instanceId: string } | null;
  getLink(instanceId: string): Promise<StoredLink | null>;
  /** Аварийная пауза держателя: связка может быть рабочей, а федерация целиком — на паузе. */
  readMeta(): Promise<{ paused: boolean }>;
  lookupKey: PeerKeyLookup;
  /** Видели ли мы этот токен раньше (одноразовость `jti`). */
  seenJti(jti: string): Promise<boolean>;
  banned(instanceId: string, homeUserId: string, now: number): Promise<boolean>;
  /**
   * Предел частоты по СВЯЗКЕ — считается только после верной подписи токена (аудит 19.09, F-07).
   * Возвращает секунды до следующей попытки, 0 — предел не превышен. Нет — предела по связке нет.
   */
  rateLimited?(instanceId: string): Promise<number>;
  /** Лицо гостя. Не ждём его: вход не должен зависеть от чужой картинки. */
  refreshAvatar(input: {
    shadowUserId: string;
    instanceId: string;
    homeUserId: string;
    avatarHash: string | null;
  }): void;
}

/**
 * Принять токен личности и выдать гостевую сессию.
 *
 * Возвращает `created: true`, когда теневая строка заведена впервые, — вызывающий по этому решает,
 * надо ли качать аватар и писать в журнал аудита «первый вход гостя».
 */
export function createGuestHost(deps: GuestHostDeps) {
  return { acceptIdentity: (input: { token: string; now: number }) => accept(deps, input) };
}

/**
 * Живая сторона хоста: настоящие личность, связки, Redis, запреты и хранилище.
 *
 * ⚠️ Одна строка на весь процесс — здесь и только здесь федерация «включается» по-настоящему;
 * всё выше от этого не зависит и проверяется подставными зависимостями.
 */
function liveDeps(): GuestHostDeps {
  return {
    identity: () => federation.identity(),
    getLink,
    readMeta: async () => ({ paused: (await readInstanceMeta()).paused }),
    lookupKey: peerPublicKey,
    seenJti: seenIdentityJti,
    banned: instanceBanFor,
    rateLimited: (instanceId) => fedRateBlock('guestSession', instanceId),
    refreshAvatar: (input) => {
      void refreshGuestAvatar(input).catch(() => {});
    },
  };
}

export const guestHost = createGuestHost(liveDeps());

/**
 * Принять токен личности и выдать гостевую сессию.
 *
 * Возвращает `created: true`, когда теневая строка заведена впервые, — вызывающий по этому решает,
 * надо ли писать в журнал аудита «первый вход гостя».
 */
export async function acceptIdentity(input: {
  token: string;
  now: number;
  lookupKey?: PeerKeyLookup;
}): Promise<GuestSessionResult> {
  // Совместимость для вызывающих, которым нужен только подменный ключ (и для смоуков).
  return input.lookupKey
    ? await accept({ ...liveDeps(), lookupKey: input.lookupKey }, input)
    : await guestHost.acceptIdentity(input);
}

async function accept(
  deps: GuestHostDeps,
  input: { token: string; now: number },
): Promise<GuestSessionResult> {
  const self = deps.identity();
  if (!self) return { ok: false, status: 503, error: FED_ERRORS.paused, detail: 'federation-off' };

  const peeked = peekIdentityToken(input.token);
  // 🔴 На «не разобрался», «нет такой связки» и «подпись не сошлась» ответ ОДИН: по разнице ответов
  // посторонний перебором узнавал бы, с кем мы связаны и какая половина подделки уже верна.
  if (!peeked) return { ok: false, status: 401, error: 'identity-invalid', detail: 'malformed' };

  const link = await deps.getLink(peeked.iss);
  if (!link) return { ok: false, status: 401, error: 'identity-invalid', detail: 'no-link' };
  // Разорванная и потерявшая доверие связка получает свой честный `409` ниже — после подписи, как и
  // пауза (решение держателя по #196 п. 2). Поход за визиткой ради этого ограничен её кешем (`peerAuth`).

  const verdict = await verifyWithRetry(input.token, link, input.now, deps.lookupKey);
  if (!verdict.ok) return { ok: false, status: 401, error: 'identity-invalid', detail: verdict.reason };
  const claims = verdict.claims;

  /**
   * Пауза федерации и состояние связки — отдельный, ЧЕСТНЫЙ ответ: человек должен узнать, что дело
   * не в нём, а в решении держателя. 🔴 Но только ПОСЛЕ верной подписи (аудит 19.09, F-12): до неё
   * посторонний, вписав в `iss` id нашего соседа, по коду `409` читал состояние связки — пауза,
   * разрыв, потеря доверия. Тот, чей токен подписан домом, и так знает, что связка есть.
   */
  const refusal = linkVerdict(link, (await deps.readMeta()).paused);
  if (refusal) return { ok: false, status: 409, error: refusal };

  // Предел по СВЯЗКЕ — только для токенов с верной подписью (F-07): подделка с чужим `iss` тратит
  // счётчик своего адреса (маршрут), а не соседа, которым назвалась.
  if (deps.rateLimited) {
    const wait = await deps.rateLimited(link.instanceId);
    if (wait > 0) return { ok: false, status: 429, error: 'rate-limited', retryAfterS: wait };
  }

  const why = identityRefusal({
    claims,
    selfInstanceId: self.instanceId,
    signedBy: link.instanceId,
    now: input.now,
    skewMs: FED_IDENTITY_SKEW_MS,
  });
  if (why) return { ok: false, status: 401, error: 'identity-invalid', detail: why };

  /**
   * 🔴 Одноразовость. Токен живёт две минуты, и всё это время перехвативший его мог бы завести себе
   * сессию от чужого имени. Метка ставится ДО заведения строки и атомарно — иначе два одновременных
   * запроса с одним токеном оба прошли бы проверку.
   */
  if (await deps.seenJti(claims.jti)) {
    return { ok: false, status: 401, error: 'identity-invalid', detail: 'replay' };
  }

  /**
   * Запрет на инстанс (§5.11) — ЧЕСТНЫЙ отказ, а не «личность негодна».
   *
   * 🔴 Человек должен понять, что дело в нём и что это решение держателя, иначе он будет чинить
   * свой аккаунт и звать своего админа. Причина при этом не называется намеренно: запрет — не
   * приглашение к переписке.
   */
  if (await deps.banned(link.instanceId, claims.sub, input.now)) {
    return { ok: false, status: 403, error: FED_ERRORS.banned };
  }

  return await upsertShadowSession(deps, link, claims, input.now);
}

/** Проверка подписи с одним перечитыванием визитки: дом мог выпустить сменный ключ минуту назад. */
async function verifyWithRetry(
  token: string,
  link: StoredLink,
  now: number,
  lookupKey: PeerKeyLookup,
): Promise<{ ok: true; claims: FedIdentityClaims } | { ok: false; reason: string }> {
  const peeked = peekIdentityToken(token);
  if (!peeked) return { ok: false, reason: 'malformed' };

  let key = await lookupKey(link, peeked.kid, false);
  let result = verifyIdentityToken({ token, findKey: () => key, now });
  // 🔴 Незнакомый ключ — не повод отказывать сразу: дом мог выпустить сменный ключ только что, и без
  // повторного чтения визитки мы отвергали бы его людей всю минуту жизни кеша.
  if (!result.ok && result.reason === 'unknown-key') {
    key = await lookupKey(link, peeked.kid, true);
    result = verifyIdentityToken({ token, findKey: () => key, now });
  }
  return result;
}

/**
 * Завести или обновить теневую строку и выдать токен хоста.
 *
 * ⚠️ Профиль берётся ИЗ ТОКЕНА, а не из кеша каталога: скрытого от соседей в каталоге нет вовсе
 * (§5.2.1), но войти по ссылке он вправе — и тогда на сервере он виден как обычный участник.
 */
async function upsertShadowSession(
  deps: GuestHostDeps,
  link: StoredLink,
  claims: FedIdentityClaims,
  now: number,
): Promise<GuestSessionResult> {
  const [existing] = await db
    .select()
    .from(users)
    .where(and(eq(users.homeInstanceId, link.instanceId), eq(users.homeUserId, claims.sub)))
    .limit(1);

  if (!existing) {
    /**
     * 🔴 Предел теневых строк на связку (аудит 19.09, F-06). `GUEST_LIMITS.shadowUsers` был объявлен,
     * но не читался нигде: сосед заводил по 240 строк `users` в час на выдуманные `sub` — без
     * приглашений, с хешированием пароля и походом за аватаром на каждую. Упёрлись — новый человек
     * не входит, старые работают; код отказа тот же, что у квоты хранилища: это тоже место у нас.
     */
    const [count] = await db
      .select({
        // Обезличенные (удалённые дома) в живых не считаются (ревью #195 п. 6): они хранят
        // `home_instance_id` навсегда, и за годы предел стал бы пожизненным. Окно гонки между счётом
        // и вставкой есть и осознанно терпимо: две лишние строки на пределе в две тысячи — не дыра.
        live: sql<number>`count(*) filter (where ${users.deletedAt} is null)::int`,
        fresh: sql<number>`count(*) filter (where ${users.createdAt} > now() - interval '1 day')::int`,
      })
      .from(users)
      .where(eq(users.homeInstanceId, link.instanceId));
    if ((count?.live ?? 0) >= GUEST_LIMITS.shadowUsers) {
      return { ok: false, status: 403, error: FED_ERRORS.quotaExceeded, detail: 'shadow-limit' };
    }
    /**
     * 🔴 Второй предел — на ВСЕ строки связки за сутки, обезличенные включая (#196 п. 4): обезличивание
     * запускает сам сосед (`deleted`/`user.revoked`), и без этого он заводил бы 2000 строк, «удалял»
     * их и заводил ещё 2000 — таблица `users` росла бы без предела, от чего F-06 и защищала.
     */
    if ((count?.fresh ?? 0) >= GUEST_LIMITS.shadowUsersPerDay) {
      return { ok: false, status: 403, error: FED_ERRORS.quotaExceeded, detail: 'shadow-limit-day' };
    }
    const id = randomUUID();
    // Пароля у гостя нет и быть не может: вход делается дома. Хеш от случайных байтов, чтобы проверка
    // пароля честно отвечала «не подходит», а не падала на пустой строке.
    const unusable = await hashPassword(randomUUID());
    await db.insert(users).values({
      id,
      username: shadowUsername(link.instanceId, claims.sub),
      email: null,
      // Подтверждение и одобрение — про НАШУ регистрацию; за гостя ручается его дом, и держать его в
      // «ждёт одобрения» значило бы запереть человека в состоянии, из которого у нас нет выхода.
      verified: true,
      approvedAt: new Date(now),
      canCreateServers: false,
      displayName: claims.displayName,
      passwordHash: unusable,
      homeInstanceId: link.instanceId,
      homeUserId: claims.sub,
      homeUsername: claims.username,
      homeGen: claims.gen,
      homeAvatarHash: claims.avatarHash,
    });
    // Лицо гостя видно каждому участнику в каждом сообщении — качаем сразу, но НЕ ждём: вход не
    // должен зависеть от чужой картинки (§5.4).
    deps.refreshAvatar({
      shadowUserId: id,
      instanceId: link.instanceId,
      homeUserId: claims.sub,
      avatarHash: claims.avatarHash,
    });
    return { ok: true, ...(await mintFor(id, link.instanceId, claims.sub, now)), created: true };
  }

  // Удалённого дома (обезличенного по `user.revoked`) не оживляем: дом за него больше не ручается, и
  // предъявленный токен может быть только старым.
  if (existing.deletedAt !== null) {
    return { ok: false, status: 401, error: 'identity-invalid', detail: 'deleted' };
  }

  const gen = guestGenVerdict(claims.gen, existing.homeGen);
  if (gen === 'stale') {
    // Поколение ниже запомненного: либо токен отозван, либо дом откатился из бэкапа (§5.6.1).
    return { ok: false, status: 401, error: 'identity-invalid', detail: 'stale-gen' };
  }

  await db
    .update(users)
    .set({
      displayName: claims.displayName,
      homeUsername: claims.username,
      homeGen: claims.gen,
      homeAvatarHash: claims.avatarHash,
    })
    .where(eq(users.id, existing.id));

  if (existing.homeAvatarHash !== claims.avatarHash) {
    deps.refreshAvatar({
      shadowUserId: existing.id,
      instanceId: link.instanceId,
      homeUserId: claims.sub,
      avatarHash: claims.avatarHash,
    });
  }

  if (gen === 'bumped') {
    // 🔴 Дом ушёл вперёд — прежние гостевые сессии этого человека обязаны умереть В ЭТОТ ЖЕ МОМЕНТ,
    // до выдачи новой. Иначе угонщик, уже сидящий у нас, пережил бы нажатие «выйти везде».
    await bumpTokenGeneration(existing.id);
  }

  return { ok: true, ...(await mintFor(existing.id, link.instanceId, claims.sub, now)), created: false };
}

/** Обычный токен хоста — гость дальше живёт им, как местный (в этом и устойчивость, требование 4). */
async function mintFor(
  userId: string,
  instanceId: string,
  homeUserId: string,
  now: number,
): Promise<{ userId: string; token: string; expiresAt: number }> {
  const [row] = await db
    .select({ gen: users.tokenGeneration })
    .from(users)
    .where(eq(users.id, userId))
    .limit(1);
  const token = signToken({
    sub: userId,
    username: shadowUsername(instanceId, homeUserId),
    gen: row?.gen ?? 0,
  });
  return { userId, token, expiresAt: now + TOKEN_TTL_S * 1000 };
}

/** Теневая строка по домашней личности — `null`, если этот человек у нас ещё не был. */
export async function shadowUserFor(instanceId: string, homeUserId: string) {
  const [row] = await db
    .select()
    .from(users)
    .where(and(eq(users.homeInstanceId, instanceId), eq(users.homeUserId, homeUserId)))
    .limit(1);
  return row ?? null;
}
