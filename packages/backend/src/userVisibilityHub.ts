import { FEATURE_PRESENCE4, FEATURE_PRESENCE5, type GatewayServerMessage } from '@gusvoice/shared';
import { aboutUserSteps, mayObserveUser, membershipDiff, visibleOnline, type DeliverWho } from './gatewayRules.js';

/**
 * Кто про кого знает на шлюзе (#136) — БЕЗ Redis, базы, Fastify и таймеров приложения.
 *
 * Здесь живёт вся память шлюза о людях: чьи это соединения, сколько их (онлайн), с кем у человека
 * есть общий сервер или ЛС, и какой состав серверов шлюз видел в прошлый раз. Транспорт (сокеты),
 * запросы в базу и подписка на шину остаются в `gateway.ts` и приходят сюда зависимостями.
 *
 * Вынесено по просьбе Codex (#143): раньше это были восемь переменных модуля и пять функций внутри
 * `gateway.ts`, который тянет за собой `db`, `env` и `Redis` — проверить срок кэша или порядок
 * событий тестом было нельзя, а именно там нашлись три бага обвязки F0.
 */

/** Минимум, который хабу нужен от соединения: кто за ним стоит (null — ещё не представился). */
export interface HubConn {
  userId: string | null;
  /** Возможности из `identify.caps` (`presence4` — получать `online.dm`); нет — ничего нового соединению не шлём. */
  caps?: ReadonlySet<string>;
}

export interface UserVisibilityDeps<C extends HubConn> {
  /** С кем у человека общий сервер или ЛС — единственный поход в базу, живёт снаружи. */
  loadPeers(userId: string): Promise<Set<string>>;
  /** Текущее время в мс. Отдельно от `Date.now`, чтобы срок кэша проверялся тестом. */
  now(): number;
  /** Кто супер-админ прямо сейчас; `null` — не задан. */
  superAdminId(): string | null;
  /** Отправить готовую строку в сокет: событие сериализуется ОДИН раз на всех получателей. */
  send(conn: C, data: string): void;
  /** Сколько ответ о «соседях» считается свежим. */
  peersTtlMs?: number;
  /** Потолок ожидания ответа базы: зависший запрос не держит событие вечно. */
  peersLoadTimeoutMs?: number;
  /** Грубый потолок записей в кэше соседей. */
  peersCacheMax?: number;
}

export interface UserVisibilityHub<C extends HubConn> {
  /** Соединение представилось: запомнить владельца. */
  attach(conn: C, userId: string): void;
  /** Соединение закрылось: забыть (по `conn.userId`, поэтому звать ДО его обнуления). */
  detach(conn: C): void;
  /** Живые соединения человека — адресная рассылка (ЛС, `gw:user:*`). */
  connsOf(userId: string): Iterable<C>;
  /** +1 сокет. `true` — человек только что стал онлайн (был 0). */
  goOnline(userId: string): boolean;
  /** −1 сокет. `true` — человек только что ушёл офлайн (стало 0). */
  goOffline(userId: string): boolean;
  /** Есть ли у человека хоть один живой сокет (гейт офлайн-пуша). */
  isOnline(userId: string): boolean;
  /** Кому можно знать об этом человеке (через кэш). */
  peersOf(userId: string): Promise<Set<string>>;
  /** Забыть, кого видит этот человек: следующий вызов спросит базу заново. */
  invalidatePeers(userId: string): void;
  /** Разослать событие О ЧЕЛОВЕКЕ только тем, кому о нём можно знать. */
  deliverAboutUser(subjectId: string, msg: GatewayServerMessage): void;
  /** Снимок «кто онлайн» одному соединению — только те, о ком ему можно знать. */
  sendOnlineSnapshot(conn: C): Promise<void>;
  /** Новый состав сервера: если менялся — пересобрать видимость задетым. */
  applyServerMembers(serverId: string, next: Set<string>): Promise<void>;
  /**
   * Связь между этими людьми поменялась не через сервер (блокировка и разблокировка, 05.10): забыть их «соседей» и
   * прислать каждому их соединению свежий снимок онлайна — как `applyServerMembers` задетым.
   */
  refreshPeers(userIds: readonly string[]): Promise<void>;
  /**
   * Статус «Невидимый» (приватность ЛС, 07.10): для всех, кроме самого человека, он «не в сети» — в снимках и в
   * `online.update`. Форма событий прежняя, меняются только значения. Смена флага у человека в сети тут же рассылается
   * соседям как `online.update` (ушёл / появился). Звать ДО рассылки `user.status` и до `goOnline` при `identify`.
   */
  setInvisible(userId: string, invisible: boolean): void;
  /** Невидим ли человек сейчас (для тестов и диагностики). */
  isInvisible(userId: string): boolean;
  /**
   * «Не в сети для ЛС» при открытом сокете (08.10, #211, D4, решение 42): приложение скрыто или простаивает. Соседям с
   * `presence5` — `online.away` на каждой смене (и `false`, когда человек вышел совсем: звать ПОСЛЕ рассылки `online.update`),
   * в снимке — `dmAway`. Серверный онлайн и `online.update` не трогает. `true` — значение поменялось.
   */
  setDmAway(userId: string, away: boolean): boolean;
  isDmAway(userId: string): boolean;
}

const DEFAULT_PEERS_TTL_MS = 60_000;
const DEFAULT_PEERS_LOAD_TIMEOUT_MS = 10_000;
const DEFAULT_PEERS_CACHE_MAX = 5000;

function withTimeout<T>(p: Promise<T>, ms: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const t = setTimeout(() => reject(new Error('peers load timeout')), ms);
    p.then(
      (v) => {
        clearTimeout(t);
        resolve(v);
      },
      (e) => {
        clearTimeout(t);
        reject(e);
      },
    );
  });
}

export function createUserVisibilityHub<C extends HubConn>(deps: UserVisibilityDeps<C>): UserVisibilityHub<C> {
  const {
    loadPeers,
    now,
    superAdminId,
    send,
    peersTtlMs = DEFAULT_PEERS_TTL_MS,
    peersLoadTimeoutMs = DEFAULT_PEERS_LOAD_TIMEOUT_MS,
    peersCacheMax = DEFAULT_PEERS_CACHE_MAX,
  } = deps;

  /** userId -> его собственные соединения (адресная рассылка). */
  const byUser = new Map<string, Set<C>>();
  /** userId -> сколько у него живых сокетов (онлайн, пока > 0). */
  const online = new Map<string, number>();
  /** Кто в статусе «Невидимый» (по последней известной шлюзу записи; живёт, пока жив процесс). */
  const invisible = new Set<string>();
  /** «Не в сети для ЛС» при открытом сокете (D4, `presence5`): приложение скрыто или простаивает, не в голосе и не в звонке. */
  const dmAway = new Set<string>();

  /**
   * С кем у человека есть общий сервер или ЛС (#136) — кому можно знать о его онлайне и статусе.
   *
   * ⚠️ В кэше лежит ПРОМИС, а не готовый набор: два события подряд об одном человеке (статус, затем
   * игра) дожидаются одного и того же запроса и уходят в том порядке, в каком возникли. С готовым
   * набором второе могло бы проскочить мимо первого, пока тот ждёт базу, и клиент остался бы со
   * старым статусом.
   * ⚠️ Срок короткий, а состав серверов шлюз отслеживает сам (`applyServerMembers`): кэш нужен не для
   * точности, а чтобы частые события не били в базу. ЛС в сроке догоняются сами.
   * ⚠️ Ошибка базы — пустой набор (никто лишний не получит) и запись из кэша удаляется, чтобы следующий
   * вызов спросил заново, а не держал человека «невидимым» весь срок.
   * 🔴 **Ещё не ответивший запрос не протухает** (нашёл Codex 15.09): срок считается от ОТВЕТА, а не от
   * начала. Раньше событие A запускало зависший запрос, через 60 с событие B считало запись старой и
   * запускало второй; второй отвечал первым — и получатель видел B раньше A. Сам запрос ограничен
   * `peersLoadTimeoutMs`, поэтому ожидание не бесконечно: по таймауту — пустой набор и новая попытка.
   */
  const peersCache = new Map<string, { at: number; settled: boolean; p: Promise<Set<string>> }>();

  /**
   * Последний известный шлюзу состав сервера — чтобы на `server.invalidate` понять, менялся ли он (#136).
   * Сам `server.invalidate` летит и на правку канала, и на роль; пересылать снимки всему серверу
   * имеет смысл, только когда кто-то вступил или ушёл.
   */
  const serverMembersSeen = new Map<string, Set<string>>();

  function peersOf(userId: string): Promise<Set<string>> {
    const hit = peersCache.get(userId);
    if (hit && (!hit.settled || now() - hit.at < peersTtlMs)) return hit.p;
    if (peersCache.size > peersCacheMax) {
      // Грубый потолок. Выкидываем только ответившие: ожидающий запрос держит порядок событий (см. выше).
      for (const [k, e] of peersCache) if (e.settled) peersCache.delete(k);
    }
    const entry = { at: now(), settled: false, p: Promise.resolve(new Set<string>()) };
    entry.p = withTimeout(loadPeers(userId), peersLoadTimeoutMs).then(
      (peers) => {
        entry.settled = true;
        entry.at = now();
        return peers;
      },
      () => {
        entry.settled = true;
        if (peersCache.get(userId) === entry) peersCache.delete(userId);
        return new Set<string>();
      },
    );
    peersCache.set(userId, entry);
    return entry.p;
  }

  /** Разослать событие О человеке: всем, кому можно знать (`all`), только его устройствам (`own`) или всем, кроме них (`others`). */
  function deliver(subjectId: string, msg: GatewayServerMessage, who: DeliverWho): void {
    void peersOf(subjectId).then((peers) => {
      const data = JSON.stringify(msg);
      const su = superAdminId();
      for (const [uid, set] of byUser) {
        if (who === 'own' ? uid !== subjectId : who === 'others' && uid === subjectId) continue;
        if (!mayObserveUser(uid, subjectId, peers, su)) continue;
        for (const c of set) send(c, data);
      }
    });
  }

  /**
   * `presence4` (решение владельца 08.10): «Невидимый» — только про серверы, в ЛС он в сети. Соседям с `caps: ['presence4']`
   * уходит `online.dm` — «в сети для ЛС» (`online` = true) или «уже нет» (вышел / снял «Невидимый»). Старые соединения его не
   * получают: для них невидимый по-прежнему не в сети.
   */
  /** `presence5` (D4): `online.away` тем же, кому можно знать о человеке, кроме его самого. */
  function deliverAway(subjectId: string, away: boolean): void {
    void peersOf(subjectId).then((peers) => {
      const data = JSON.stringify({ t: 'online.away', userId: subjectId, away } satisfies GatewayServerMessage);
      const su = superAdminId();
      for (const [uid, set] of byUser) {
        if (uid === subjectId || !mayObserveUser(uid, subjectId, peers, su)) continue;
        for (const c of set) if (c.caps?.has(FEATURE_PRESENCE5)) send(c, data);
      }
    });
  }

  function deliverDm(subjectId: string, value: boolean): void {
    void peersOf(subjectId).then((peers) => {
      const data = JSON.stringify({ t: 'online.dm', userId: subjectId, online: value } satisfies GatewayServerMessage);
      const su = superAdminId();
      for (const [uid, set] of byUser) {
        if (uid === subjectId || !mayObserveUser(uid, subjectId, peers, su)) continue;
        for (const c of set) if (c.caps?.has(FEATURE_PRESENCE4)) send(c, data);
      }
    });
  }

  async function sendOnlineSnapshot(conn: C): Promise<void> {
    const uid = conn.userId;
    if (!uid) return;
    const peers = await peersOf(uid);
    // Пока ждали базу, соединение могло закрыться или представиться другим — снимок уже не его.
    if (conn.userId !== uid) return;
    const users = visibleOnline(online.keys(), uid, peers, superAdminId(), invisible);
    // `presence4`: невидимые соседи в сети — отдельным списком, только для ЛС (`deliverDm`).
    const dmOnly = conn.caps?.has(FEATURE_PRESENCE4)
      ? visibleOnline(online.keys(), uid, peers, superAdminId()).filter((id) => id !== uid && invisible.has(id))
      : null;
    // `presence5` (D4): кто из видимых этому соединению в сети на серверах, но «не в сети» для ЛС.
    const dmAwayIds = conn.caps?.has(FEATURE_PRESENCE5)
      ? [...users, ...(dmOnly ?? [])].filter((id) => id !== uid && dmAway.has(id))
      : null;
    send(
      conn,
      JSON.stringify({ t: 'online.snapshot', users, ...(dmOnly ? { dmOnly } : {}), ...(dmAwayIds ? { dmAway: dmAwayIds } : {}) }),
    );
  }

  return {
    attach(conn, userId) {
      let set = byUser.get(userId);
      if (!set) byUser.set(userId, (set = new Set()));
      set.add(conn);
    },

    detach(conn) {
      if (!conn.userId) return;
      const set = byUser.get(conn.userId);
      if (!set) return;
      set.delete(conn);
      if (set.size === 0) byUser.delete(conn.userId);
    },

    connsOf(userId) {
      return byUser.get(userId) ?? [];
    },

    goOnline(userId) {
      const was = online.get(userId) ?? 0;
      online.set(userId, was + 1);
      return was === 0;
    },

    goOffline(userId) {
      const was = online.get(userId);
      // Незнакомый идентификатор — никто и не был онлайн, сообщать «вышел» не о ком (#147).
      // Раньше `?? 1` считало это переходом в offline, и лишний вызов разослал бы всем ложное событие.
      if (was === undefined) return false;
      const n = was - 1;
      if (n <= 0) {
        online.delete(userId);
        return true;
      }
      online.set(userId, n);
      return false;
    },

    isOnline(userId) {
      return (online.get(userId) ?? 0) > 0;
    },

    peersOf,

    invalidatePeers(userId) {
      peersCache.delete(userId);
    },

    /**
     * ⚠️ Обходим только представившихся (`byUser`) — безымянных соединений там нет по построению, а
     * `mayObserveUser` отбивает их ещё раз. Событие сериализуется один раз на всю рассылку.
     */
    deliverAboutUser(subjectId, msg) {
      // Решение «кому и что» — чистая `aboutUserSteps` (`gatewayRules.ts`): «Невидимому» онлайн-события только своим устройствам,
      // его статус `invisible` — своим настоящий, остальным обычный `online` (07.10, «приватность человека»).
      for (const step of aboutUserSteps(subjectId, msg, invisible.has(subjectId))) deliver(subjectId, step.msg, step.who);
      // `presence4`: вход / выход «Невидимого» соседям не рассылается, но в ЛС он в сети — `online.dm` новым клиентам.
      if (msg.t === 'online.update' && invisible.has(subjectId)) deliverDm(subjectId, msg.online);
    },

    setInvisible(userId, value) {
      if (invisible.has(userId) === value) return;
      if (value) invisible.add(userId);
      else invisible.delete(userId);
      // Человек в сети и стал невидимым — соседям «вышел»; перестал быть невидимым — «зашёл». Себе ничего: у него и так «в сети».
      if (online.has(userId)) deliver(userId, { t: 'online.update', userId, online: !value }, 'others');
      // `presence4`: в ЛС он остаётся в сети — стал невидимым: «в сети для ЛС»; перестал: снять (обычный `online.update` уже ушёл).
      if (online.has(userId)) deliverDm(userId, value);
    },

    isInvisible(userId) {
      return invisible.has(userId);
    },

    setDmAway(userId, away) {
      if (dmAway.has(userId) === away) return false;
      if (away) dmAway.add(userId);
      else dmAway.delete(userId);
      deliverAway(userId, away);
      return true;
    },

    isDmAway(userId) {
      return dmAway.has(userId);
    },

    sendOnlineSnapshot,

    async applyServerMembers(serverId, next) {
      const { changed, affected } = membershipDiff(serverMembersSeen.get(serverId), next);
      if (next.size === 0) serverMembersSeen.delete(serverId);
      else serverMembersSeen.set(serverId, next);
      if (!changed) return;
      for (const uid of affected) peersCache.delete(uid);
      const jobs: Promise<void>[] = [];
      for (const uid of affected) for (const c of byUser.get(uid) ?? []) jobs.push(sendOnlineSnapshot(c));
      await Promise.all(jobs);
    },

    async refreshPeers(userIds) {
      const people = [...new Set(userIds)];
      for (const uid of people) peersCache.delete(uid);
      const jobs: Promise<void>[] = [];
      for (const uid of people) for (const c of byUser.get(uid) ?? []) jobs.push(sendOnlineSnapshot(c));
      await Promise.all(jobs);
    },
  };
}
