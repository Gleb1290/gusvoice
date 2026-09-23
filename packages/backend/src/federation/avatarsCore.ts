/**
 * Копии аватаров соседей — порядок шагов без базы, хранилища и сети (вынос для тестов 22.09; проводка —
 * `avatars.ts`, там же шапка «почему копия, а не прямая ссылка»).
 *
 * Здесь: проверка картинки по содержимому, квота до записи и её возврат, имя копии, запись «если
 * строка всё ещё та» и уборка проигравшего. Снаружи — подпись и сеть, хранилище, квоты, предел
 * частоты и сами строки (`PeerCopyStore`/`GuestCopyStore`: их условия записи — SQL, проверяются на PGlite).
 */

import type { FedErrorCode } from '@gusvoice/shared';
import { isSupportedImage, sniffImageMime } from '../storageRules.js';
import type { PeerResult } from './peerClient.js';

/** Предел на аватар: столько же, сколько разрешено загрузить своему (5 МБ), плюс запас на заголовки. */
export const FED_AVATAR_MAX_BYTES = 5 * 1024 * 1024 + 64 * 1024;

/**
 * Годится ли присланная картинка: заголовок соседа — не доказательство (F-05, «под видом `image/png`
 * в публичный бакет ложатся любые байты»). Тип по СОДЕРЖИМОМУ обязан совпасть с объявленным.
 */
export function genuineImage(bytes: Uint8Array, declared: string): string | null {
  const mime = declared.split(';')[0]?.trim().toLowerCase() ?? '';
  if (!isSupportedImage(mime)) return null;
  const sniffed = sniffImageMime(bytes);
  return sniffed !== null && sniffed === (mime === 'image/jpg' ? 'image/jpeg' : mime) ? sniffed : null;
}

/**
 * Имя копии в хранилище — своё у КАЖДОЙ загрузки (#199 п. 8). Раньше это были связка, человек и
 * миллисекунда: две загрузки в одну миллисекунду (копия каталога и копия гостя одного человека, или
 * две гонящиеся) получали один файл, и уборка проигравшего стирала файл победителя. Префикс
 * `<связка>-<человек>-` сохранён.
 */
export function copyKey(instanceId: string, userId: string, suffix: string): string {
  return `${instanceId}-${userId}-${suffix}`;
}

/** Строка кеша каталога соседа — то, что читает и пишет копия для каталога. */
export interface PeerCopyStore {
  read: (
    instanceId: string,
    userId: string,
  ) => Promise<{ avatarHash: string | null; avatarLocalUrl: string | null; avatarCachedHash: string | null } | null>;
  /** Снять ссылку на копию, ТОЛЬКО если в строке всё ещё `expectUrl` (#198 п. 6). `true` — сняли. */
  clear: (instanceId: string, userId: string, expectUrl: string) => Promise<boolean>;
  /**
   * Записать новую копию, только если в строке всё ещё ТА копия (`expect.url`, `null` — пусто) и ТОТ
   * отпечаток (`expect.hash`), под который качали (#198 п. 6, #199 п. 8). `true` — записали.
   */
  swap: (
    instanceId: string,
    userId: string,
    next: { url: string; hash: string },
    expect: { hash: string; url: string | null },
  ) => Promise<boolean>;
  /** Какая копия в строке сейчас — после проигранной гонки. */
  current: (instanceId: string, userId: string) => Promise<string | null>;
}

/** Теневая строка гостя — то, что читает и пишет копия для гостя. */
export interface GuestCopyStore {
  read: (shadowUserId: string) => Promise<{ id: string; avatarUrl: string | null; homeAvatarHash: string | null } | null>;
  /** Снять ссылку и отпечаток, ТОЛЬКО если ссылка всё ещё `expectUrl`. `true` — сняли. */
  clear: (id: string, expectUrl: string) => Promise<boolean>;
  /** Записать новую копию, только если ссылка всё ещё `expectUrl` (`null` — пусто). `true` — записали. */
  swap: (id: string, next: { url: string; hash: string }, expectUrl: string | null) => Promise<boolean>;
  current: (id: string) => Promise<string | null>;
}

/** Квота: `reserve` → код отказа или `null` (место занято), `release` — вернуть байты. */
export interface QuotaOps {
  reserve: (owner: string, bytes: number) => Promise<FedErrorCode | null>;
  release: (owner: string, bytes: number) => Promise<void>;
}

export interface AvatarCopyDeps {
  getSignedFromPeer: (input: {
    apiBase: string;
    path: string;
    query?: Record<string, string | number | null | undefined>;
    keyid: string;
    privateKeyDer: Uint8Array;
    allowHosts: ReadonlySet<string>;
    now: number;
    binary?: boolean;
    maxBytes?: number;
  }) => Promise<PeerResult<{ status: number; body: string; bytes?: Buffer; contentType: string }>>;
  /** Чем подписывать: наша личность и сменный ключ; `null` — ходить нечем. */
  signer: () => { instanceId: string; kid: string; privateKeyDer: Uint8Array } | null;
  getLink: (instanceId: string) => Promise<{ apiBase: string } | null>;
  /** Предел частоты перекачки лица одного человека (F-05). `false` — рано, не качаем. */
  refetchAllowed: (kind: 'peer' | 'guest', instanceId: string, userId: string) => Promise<boolean>;
  putMedia: (category: string, key: string, bytes: Buffer, mime: string, stamp: number) => Promise<string>;
  /** Снять файл из своего хранилища; сколько байт освободилось (`0` — файла уже нет). */
  removeOwnMedia: (url: string) => Promise<number>;
  now: () => number;
  /** Случайный хвост имени копии (`copyKey`). */
  copySuffix: () => string;
  peer: PeerCopyStore;
  guest: GuestCopyStore;
  /** Квота связки — для копий каталога (владелец = `instanceId`). */
  linkQuota: QuotaOps;
  /** Квота гостя — от имени теневой строки (владелец = её `id`). */
  userQuota: QuotaOps;
}

export function createAvatarCopier(deps: AvatarCopyDeps) {
  /**
   * Снять нашу копию из хранилища и вернуть её байты — в фоне, ошибки глотая (#197 п. 12). Место не
   * возвращаем, если хранилище файла уже не знает (`0`). Возвращает промис — ждать его не обязательно.
   */
  function forgetCopy(url: string, release: (bytes: number) => Promise<void>): Promise<void> {
    return deps
      .removeOwnMedia(url)
      .then((freed) => (freed > 0 ? release(freed) : undefined))
      .catch(() => {});
  }

  /** Сходить к дому человека за картинкой. `null` — не вышло или картинка не годится. */
  async function fetchAvatar(apiBase: string, homeUserId: string): Promise<{ bytes: Buffer; mime: string } | null> {
    const signer = deps.signer();
    if (!signer) return null;
    let host: string;
    try {
      host = new URL(apiBase).host;
    } catch {
      return null;
    }
    const res = await deps.getSignedFromPeer({
      apiBase,
      path: `/api/fed/v1/avatar/${encodeURIComponent(homeUserId)}`,
      query: { instance_id: signer.instanceId },
      keyid: signer.kid,
      privateKeyDer: signer.privateKeyDer,
      allowHosts: new Set([host]),
      now: deps.now(),
      binary: true,
      maxBytes: FED_AVATAR_MAX_BYTES,
    });
    if (!res.ok || res.value.status < 200 || res.value.status >= 300 || !res.value.bytes) return null;
    // 🔴 Тип проверяем СВОЙ — и по содержимому, а не по заголовку соседа: в наше хранилище попадает
    // только то, что мы сами считаем картинкой, иначе связка превращается в способ положить нам в
    // публичный бакет произвольный файл под видом аватара (F-05).
    const mime = genuineImage(res.value.bytes, res.value.contentType);
    return mime ? { bytes: res.value.bytes, mime } : null;
  }

  /**
   * Место в квоте → файл в хранилище. `null` — квоты нет или хранилище не приняло (место тогда
   * возвращено, ревью #195 п. 7).
   */
  async function storeCopy(
    quota: QuotaOps,
    owner: string,
    instanceId: string,
    homeUserId: string,
    got: { bytes: Buffer; mime: string },
  ): Promise<string | null> {
    const bytes = got.bytes.length;
    if (await quota.reserve(owner, bytes)) return null;
    try {
      return await deps.putMedia('peer-avatars', copyKey(instanceId, homeUserId, deps.copySuffix()), got.bytes, got.mime, deps.now());
    } catch {
      // Хранилище недоступно — покажем прежнюю копию, если она есть. Не повод рушить список людей.
      await quota.release(owner, bytes).catch(() => {});
      return null;
    }
  }

  /**
   * Наша копия аватара человека с соседнего инстанса (каталог, лениво — §5.4).
   *
   * Возвращает адрес в НАШЕМ хранилище или `null` — аватара нет, сосед недоступен, картинка не годится.
   * `null` это не ошибка: интерфейс показывает кружок с буквой, как и для человека без аватара.
   */
  async function peerAvatarUrl(instanceId: string, userId: string): Promise<string | null> {
    const row = await deps.peer.read(instanceId, userId);
    if (!row) return null;
    const release = (bytes: number) => deps.linkQuota.release(instanceId, bytes);
    if (!row.avatarHash) {
      // Дома аватар сняли — снимаем и нашу копию: ссылку сразу, файл и место в квоте следом (#196 п. 6).
      // Только если это всё ещё ТА копия, что мы прочли (#198 п. 6): скачанную за это окно новую не
      // трогаем — иначе её файл остался бы сиротой, а место — невозвращённым.
      if (row.avatarLocalUrl && (await deps.peer.clear(instanceId, userId, row.avatarLocalUrl))) {
        void forgetCopy(row.avatarLocalUrl, release);
      }
      return null;
    }
    // Отпечаток совпал с тем, что уже скачано — картинка та же, ходить незачем (§5.4).
    if (row.avatarLocalUrl && row.avatarCachedHash === row.avatarHash) return row.avatarLocalUrl;

    const link = await deps.getLink(instanceId);
    if (!link) return null;
    if (!deps.signer()) return null;
    if (!(await deps.refetchAllowed('peer', instanceId, userId))) return row.avatarLocalUrl;
    try {
      new URL(link.apiBase);
    } catch {
      return null;
    }

    const got = await fetchAvatar(link.apiBase, userId);
    if (!got) return row.avatarLocalUrl;
    // Место — в квоту связки (F-05): раньше картинки соседа ложились мимо предела.
    const url = await storeCopy(deps.linkQuota, instanceId, instanceId, userId, got);
    if (!url) return row.avatarLocalUrl;

    // Отпечаток в строке — правда каталога, по нему и судим: медленная загрузка старой картинки не
    // перезапишет уже скачанную новую (#199 п. 8).
    const swapped = await deps.peer.swap(
      instanceId,
      userId,
      { url, hash: row.avatarHash },
      { hash: row.avatarHash, url: row.avatarLocalUrl },
    );
    if (!swapped) {
      const current = await deps.peer.current(instanceId, userId);
      // Проиграли гонку — лишний файл наш (имя у каждой загрузки своё, `copyKey`).
      void forgetCopy(url, release);
      return current;
    }
    // Прежняя копия больше никому не нужна — иначе каждая смена лица оставляла бы файл навсегда (F-05);
    // её байты возвращаются в квоту связки, чтобы смена лица не съедала предел (ревью #195 п. 7).
    if (row.avatarLocalUrl && row.avatarLocalUrl !== url) void forgetCopy(row.avatarLocalUrl, release);
    return url;
  }

  /**
   * Аватар ГОСТЯ на хосте (F3, §5.4) — сразу при входе и при смене отпечатка, не лениво: гость виден
   * каждому участнику в каждом сообщении. Зовётся БЕЗ ожидания — вход не ждёт чужую картинку.
   */
  async function refreshGuestAvatar(input: {
    shadowUserId: string;
    instanceId: string;
    homeUserId: string;
    avatarHash: string | null;
  }): Promise<string | null> {
    const row = await deps.guest.read(input.shadowUserId);
    if (!row) return null;
    const release = (bytes: number) => deps.userQuota.release(row.id, bytes);

    // Дома аватар сняли — снимаем и у себя: иначе на наших серверах он остался бы с прежним лицом.
    if (!input.avatarHash) {
      // Только если ссылка всё ещё та, что мы прочли (#198 п. 6). Файл и место в квоте — следом (#196 п. 6).
      if (row.avatarUrl && (await deps.guest.clear(row.id, row.avatarUrl))) void forgetCopy(row.avatarUrl, release);
      return null;
    }
    // Отпечаток тот же, картинка на месте — ходить незачем (§5.4).
    if (row.avatarUrl && row.homeAvatarHash === input.avatarHash) return row.avatarUrl;

    const link = await deps.getLink(input.instanceId);
    if (!link || !deps.signer()) return row.avatarUrl;
    if (!(await deps.refetchAllowed('guest', input.instanceId, input.homeUserId))) return row.avatarUrl;

    const got = await fetchAvatar(link.apiBase, input.homeUserId);
    if (!got) return row.avatarUrl;
    // Место — в квоту связки от имени теневой строки (F-05).
    const url = await storeCopy(deps.userQuota, row.id, input.instanceId, input.homeUserId, got);
    if (!url) return row.avatarUrl;

    if (!(await deps.guest.swap(row.id, { url, hash: input.avatarHash }, row.avatarUrl))) {
      /**
       * Пока качали, копию сменил другой заход (#198 п. 6): лишний файл — наш. ⚠️ Кто из двух загрузок
       * новее, мы не знаем (отпечаток приходит с токеном, а не из строки), поэтому остаётся успевший первым.
       * «Переписать поверх» пробовали (#199) и откатили: оно возвращало лицо, которое человек только что
       * снял, и старую картинку поверх новой. Одновременные загрузки у гостя и так редки — предел частоты.
       */
      void forgetCopy(url, release);
      return deps.guest.current(row.id);
    }
    if (row.avatarUrl && row.avatarUrl !== url) void forgetCopy(row.avatarUrl, release);
    return url;
  }

  return { peerAvatarUrl, refreshGuestAvatar, forgetCopy };
}

export type AvatarCopier = ReturnType<typeof createAvatarCopier>;
