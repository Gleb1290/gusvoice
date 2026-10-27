/**
 * Проверка входящего запроса от связанного соседа — сама логика (вынос для тестов 22.09; проводка — `peerAuth.ts`).
 *
 * Здесь кеш визиток, пределы частоты, одна загрузка на соседа, порядок «подпись → состояние связки»
 * и счёт отказов. Снаружи — сеть (`fetchPeerDocument`), часы, база (`getLink`, пауза) и два побочных
 * действия (`markTrustLost`, `noteSignatureFailure`). Импорт модуля не тянет ни `env`, ни базу.
 *
 * Почему цепочка одна и почему подпись первой — см. шапку `peerAuth.ts`.
 */

import type { FastifyRequest } from 'fastify';
import type { FedErrorCode, FedInstanceDocument } from '@gusvoice/shared';
import { createHash } from 'node:crypto';
import { CLOCK_SKEW_TOLERANCE_S, verifyRequest, type VerifyFailure } from './httpSignature.js';
import { findPeerKey, type PeerDocument, type PeerResult } from './peerClient.js';
import { linkVerdict } from './linkRules.js';
import type { StoredLink } from './linkService.js';

type SignatureHeaders = { 'content-digest'?: string; 'signature-input'?: string; signature?: string };

/**
 * Короткий кеш визиток соседей.
 *
 * Без него каждый входящий запрос соседа тянул бы за собой НАШ запрос к нему же за визиткой: одна
 * полная сверка каталога в пять страниц — это пять походов в сеть только ради ключей. Визитка меняется
 * редко (ротация ключа — раз в месяц), поэтому минуты жизни достаточно.
 *
 * 🔴 Но «ключ не найден» кеш обязан уметь пробить: сосед мог выпустить новый сменный ключ только что,
 * и без повторного чтения мы отвергали бы его запросы всю минуту. Поэтому на `unknown-key` визитка
 * перечитывается мимо кеша — но не чаще раза в полминуты на связку (см. `DOC_FORCE_MIN_INTERVAL_MS`).
 */
export const DOC_CACHE_TTL_MS = 60_000;

/**
 * Сколько ещё можно верить визитке, если сосед перестал отвечать.
 *
 * 🔴 Предел обязателен: без него связка с лежащим соседом вечно проверяла бы подписи по последней
 * известной визитке — а её могли сменить как раз потому, что сменный ключ утёк.
 */
export const DOC_STALE_MAX_MS = 15 * 60_000;

/**
 * Не чаще раза в полминуты на связку перечитываем визитку МИМО кеша (аудит 19.09, F-13).
 *
 * До ветки `unknown-key` доходит любой, кто правильно посчитал `content-digest` и поставил текущее
 * время, — ключ для этого не нужен. Без предела посторонний с незнакомым `keyid` заставлял наш
 * бэкенд ходить к соседу за визиткой на каждый запрос: отражённая нагрузка на соседа с нашего адреса.
 * Полминуты — с запасом дольше, чем сосед выпускает ключ, и короче, чем кто-то это заметит.
 */
export const DOC_FORCE_MIN_INTERVAL_MS = 30_000;

/**
 * Полминуты после неудачи (сосед не ответил или по адресу другая личность) за визиткой не ходим
 * (#196 п. 2). Без этого пустой кеш означал бы поход к соседу на КАЖДЫЙ запрос с его `instance_id`:
 * к отрезанному (`blocked`/`trust-lost`) соседу нас так гонял бы любой посторонний, потому что
 * честный `409` о состоянии связки отдаётся только после проверки подписи, то есть после визитки.
 */
export const DOC_RETRY_AFTER_MS = 30_000;

export type PeerDocumentEntry = { at: number; doc: FedInstanceDocument; instanceId: string };

export type PeerAuthResult =
  | { ok: true; link: StoredLink }
  | { ok: false; status: number; error: VerifyFailure | FedErrorCode | 'unknown'; skewS?: number };

/** Сколько от запроса нужно проверке подписи. `FastifyRequest` подходит как есть. */
export type PeerRequestLike = Pick<FastifyRequest, 'method' | 'url' | 'headers'>;

/**
 * Что ответить на неудачную проверку подписи — и считать ли её в «всплеск» (§5.10).
 *
 * 🔴 `malformed`, `unknown-key` и `bad-signature` снаружи неотличимы от «нет связки» (F-12): дойти до
 * них может посторонний без ключа, а `kid` соседа публичен в его визитке. `clock-skew` и `expired`
 * получает только тот, чья подпись СОШЛАСЬ (`verifyRequest` проверяет её до часов), — то есть сам
 * сосед, и ему расхождение в секундах нужно, чтобы починить время.
 *
 * В «всплеск» считаем всё, где ключ соседа нашёлся: несошедшуюся подпись под его `kid` и его же
 * запросы с ушедшими часами. Мусор без ключа (`malformed`, `unknown-key`) держателю не сигнал.
 */
export function refusalFor(
  reason: VerifyFailure,
  skewS?: number,
): { status: number; error: VerifyFailure | 'unknown'; skewS?: number; storm: boolean } {
  if (reason === 'malformed' || reason === 'unknown-key') return { status: 401, error: 'unknown', storm: false };
  if (reason === 'bad-signature') return { status: 401, error: 'unknown', storm: true };
  return { status: 401, error: reason, skewS, storm: true };
}

export interface PeerAuthDeps {
  /** Визитка соседа по сети (`peerClient.fetchPeerDocument`). */
  fetchPeerDocument: (input: {
    apiBase: string;
    allowHosts: ReadonlySet<string>;
    now: number;
  }) => Promise<PeerResult<PeerDocument>>;
  now: () => number;
  /** По адресу соседа другая личность — «доверие потеряно» (`trustLoss.markTrustLost`, F-19). */
  markTrustLost: (instanceId: string, reason: string) => Promise<unknown>;
  /** Отказ подписи в «всплеск» (`alerts.noteSignatureFailure`, §5.10). */
  noteSignatureFailure: (instanceId: string) => void;
  getLink: (instanceId: string) => Promise<StoredLink | null>;
  /** Аварийная пауза держателя (`readInstanceMeta().paused`). */
  paused: () => Promise<boolean>;
  /**
   * Отметка «эта подпись уже была» (аудит ЛС #236, п.15): `true` — повтор. Ставится на `ttlS` секунд (до конца срока
   * подписи с допуском часов). Нет крючка — проверки нет (как раньше).
   */
  seenSignature?: (key: string, ttlS: number) => Promise<boolean>;
  /** Наш публичный адрес API — отправитель подписывал полный адрес (`env.federation.apiBase`). */
  apiBase: string;
}

export function createPeerAuth(deps: PeerAuthDeps) {
  const docCache = new Map<string, PeerDocumentEntry>();
  const forcedAt = new Map<string, number>();
  const failedAt = new Map<string, number>();
  /** Загрузки, которые идут прямо сейчас, — одна на соседа (#197 п. 5): сто одновременных запросов при пустом кеше — один поход. */
  const inflight = new Map<string, Promise<PeerDocumentEntry | null>>();

  async function peerDocument(link: StoredLink, force: boolean): Promise<PeerDocumentEntry | null> {
    const now = deps.now();
    if (force) {
      const last = forcedAt.get(link.instanceId) ?? 0;
      // Только что перечитывали — второй незнакомый `kid` подряд визитку не пробьёт: отвечаем по кешу.
      if (now - last < DOC_FORCE_MIN_INTERVAL_MS) force = false;
      else forcedAt.set(link.instanceId, now);
    }
    const cached = docCache.get(link.instanceId);
    if (!force && cached && now - cached.at < DOC_CACHE_TTL_MS) return cached;
    // Недавно не вышло — не пробуем снова: отвечаем тем, что есть (устаревшей визиткой или ничем).
    if (!force && now - (failedAt.get(link.instanceId) ?? 0) < DOC_RETRY_AFTER_MS) {
      return cached && now - cached.at < DOC_STALE_MAX_MS ? cached : null;
    }
    // Кто-то уже пошёл за этой визиткой — ждём его, а не идём следом.
    const running = inflight.get(link.instanceId);
    if (running) return running;
    const load = loadPeerDocument(link, cached, now).finally(() => {
      inflight.delete(link.instanceId);
    });
    inflight.set(link.instanceId, load);
    return load;
  }

  async function loadPeerDocument(
    link: StoredLink,
    cached: PeerDocumentEntry | undefined,
    now: number,
  ): Promise<PeerDocumentEntry | null> {
    let host: string;
    try {
      host = new URL(link.apiBase).host;
    } catch {
      return null;
    }
    const peer = await deps.fetchPeerDocument({ apiBase: link.apiBase, allowHosts: new Set([host]), now });
    if (!peer.ok) {
      failedAt.set(link.instanceId, now);
      // Сосед не ответил. Свежая визитка была бы лучше, но отвергать его запросы из-за нашей неудачи
      // нельзя — берём последнюю известную, пока она не протухла совсем (см. предел выше).
      if (cached && now - cached.at < DOC_STALE_MAX_MS) return cached;
      docCache.delete(link.instanceId);
      return null;
    }
    /**
     * 🔴 По адресу соседа отвечает ДРУГАЯ личность (аудит 19.09, F-19): ключ сменился без отзыва —
     * потеря, переустановка, перехваченный домен. Раньше запрос просто отвергался, а связка оставалась
     * `active` и «живой»; теперь это то же «доверие потеряно», что и по присланному отзыву: связка
     * замораживается вместе с гостями, держатель получает оповещение, лечится перепривязкой (§5.1.3).
     */
    if (peer.value.instanceId !== link.instanceId) {
      docCache.delete(link.instanceId);
      try {
        await deps.markTrustLost(link.instanceId, `по адресу ${host} отвечает личность ${peer.value.instanceId}`);
      } finally {
        // ПОСЛЕ `markTrustLost` (#197 п. 10): тот забывает всё о связке, включая эту отметку. И даже
        // если он упал на базе (#198 п. 11) — иначе к соседу возвращалась бы нагрузка на каждый запрос.
        failedAt.set(link.instanceId, now);
      }
      return null;
    }
    const value: PeerDocumentEntry = { at: now, doc: peer.value.doc, instanceId: peer.value.instanceId };
    docCache.set(link.instanceId, value);
    failedAt.delete(link.instanceId);
    return value;
  }

  /** Забыть визитку соседа — при разрыве, перепривязке и потере доверия. */
  function forgetPeerDocument(instanceId: string): void {
    docCache.delete(instanceId);
    forcedAt.delete(instanceId);
    failedAt.delete(instanceId);
  }

  /**
   * Публичный ключ соседа по `kid` — через тот же кеш визиток, что и проверка подписей (F3).
   *
   * Нужен токену личности (§5.5): его подписывает дом гостя своим сменным ключом, а проверяет хост,
   * которому этот запрос приходит НЕ от соседа, а от клиента человека, — то есть мимо
   * `authenticateLinkedPeer`. Ходить за визиткой мимо кеша значило бы дёргать дом на каждый вход.
   *
   * `force` — перечитать визитку, минуя кеш: сосед мог выпустить ключ минуту назад, и на незнакомом
   * `kid` вызывающий обязан попробовать ещё раз, ровно как это делает проверка подписей (и с тем же
   * пределом частоты).
   */
  async function peerPublicKey(link: StoredLink, kid: string, force = false): Promise<Buffer | null> {
    const peer = await peerDocument(link, force);
    // 🔴 Личность обязана совпасть с той, что в связке: сменился ключ — это уже другой инстанс по тому
    // же адресу, и ручаться за людей прежнего он не может (§5.1.3).
    if (!peer || peer.instanceId !== link.instanceId) return null;
    const found = findPeerKey(peer.doc, kid, deps.now());
    return found && !found.expired ? Buffer.from(found.key.publicKey, 'base64url') : null;
  }

  /** Адрес запроса ровно в том виде, в каком его подписывал отправитель (вместе со строкой запроса). */
  function targetUriOf(req: Pick<FastifyRequest, 'url'>): string {
    return `${deps.apiBase.replace(/\/+$/, '')}${req.url}`;
  }

  /**
   * Проверить, что запрос пришёл от того, за кого себя выдаёт, и что с ним можно разговаривать.
   *
   * `requireActive: false` — только для подтверждения заявки: связка в этот момент ещё не работает, и
   * требовать от неё рабочего состояния значило бы никогда её не установить.
   *
   * 🔴 Состояние связки (пауза, разрыв, потеря доверия) сообщается ТОЛЬКО после верной подписи: тот,
   * кто подписал, и так знает, что связка есть. Посторонний на любой из этих веток получает `unknown`.
   */
  async function authenticateLinkedPeer(
    req: PeerRequestLike,
    instanceId: string,
    opts: { requireActive?: boolean; replayGuard?: boolean } = {},
  ): Promise<PeerAuthResult> {
    const unknown: PeerAuthResult = { ok: false, status: 401, error: 'unknown' };
    const link = await deps.getLink(instanceId);
    if (!link) return unknown;
    /**
     * Разорванная и потерявшая доверие связка отвечает честным `409` (`server_closed`/`trust_lost`) —
     * но ТОЛЬКО после верной подписи, как и пауза (решение держателя по #196 п. 2, вариант Б; отменяет
     * #195 п. 15). Коды отказов — часть протокола (правило совместимости 11): по ним сосед прежней
     * версии объясняет человеку, что связь разорвана и чинит это админ его инстанса, и показывает
     * контакты держателя в предпросмотре. Цена — поход за визиткой отрезанного соседа; он ограничен
     * кешем визитки (`DOC_CACHE_TTL_MS`, `DOC_RETRY_AFTER_MS`, `DOC_FORCE_MIN_INTERVAL_MS`).
     */

    const check = async (force: boolean) => {
      const peer = await peerDocument(link, force);
      // 🔴 Личность обязана совпасть с той, что в связке: сменился ключ — это уже другой инстанс по тому
      // же адресу, и говорить от имени прежнего он не может (сюда же приходит потеря ключа, §5.1.3).
      if (!peer || peer.instanceId !== link.instanceId) return null;
      const now = deps.now();
      return verifyRequest({
        method: req.method,
        targetUri: targetUriOf(req),
        // У GET тела нет, и подписывается отпечаток пустой строки — ровно то же, что посчитал отправитель.
        body: (req as { rawBody?: string }).rawBody ?? '',
        headers: req.headers as SignatureHeaders,
        findKey: (kid) => {
          const found = findPeerKey(peer.doc, kid, now);
          return found && !found.expired ? Buffer.from(found.key.publicKey, 'base64url') : null;
        },
        nowS: Math.floor(now / 1000),
      });
    };

    let verdict = await check(false);
    // Ключ незнаком — возможно, сосед только что выпустил новый: перечитываем визитку мимо кеша.
    if (verdict && !verdict.ok && verdict.reason === 'unknown-key') verdict = await check(true);
    if (!verdict) return unknown;
    if (!verdict.ok) {
      const refusal = refusalFor(verdict.reason, verdict.skewS);
      // Считаем отказы подписи: десять за десять минут — повод сказать держателю (§5.10). Чаще всего
      // это разъехавшиеся часы у одной из сторон, реже — попытка подделки; и то и другое он видеть
      // обязан, потому что снаружи оба случая выглядят как «у соседа ничего не работает».
      // Отрезанную связку в «всплеск» не считаем (#197 п. 6): десять мусорных подписей — не повод писать
      // держателю о соседе, которого он сам заблокировал или которому уже не верит.
      if (refusal.storm && link.state !== 'blocked' && link.state !== 'trust-lost') deps.noteSignatureFailure(instanceId);
      return { ok: false, status: refusal.status, error: refusal.error, skewS: refusal.skewS };
    }

    /*
     * Повтор подписанного запроса (аудит ЛС #236, п.15). Подпись без одноразового числа: перехвативший запрос (журнал
     * прокси, зеркало трафика) мог повторить его до конца срока. Протокол не меняем (соседи прежних версий нонс не шлют):
     * отметка — сама подпись. Ed25519 детерминирован, и два одинаковых GET в одну секунду дают одну подпись — поэтому
     * только меняющие запросы; повтор отвечает как просроченная подпись (`expired` — код протокола, сосед его знает).
     *
     * 🔴 Два законно одинаковых POST в одну секунду (одно тело, один адрес) дают одну подпись, и второй получал `401`. Поэтому
     * (а) идемпотентные маршруты («печатает» и «в сети», `routes/fedEphemeral.ts`) отметку не ставят — `replayGuard: false`:
     * повторить их безвредно, а их отправитель не повторяет по 401; (б) на остальных ответ остаётся отказом, а не `200`: отметка
     * ставится ДО обработчика, и `200` на дубль подтвердил бы доставку, которая могла оборваться (500 первого) — отправитель
     * (`outbox.ts`) удалил бы пачку. `401` он считает неудачей и повторяет уже с новой секундой (новая подпись) — потери нет, ни
     * тревоги, ни порчи связки: `noteSignatureFailure` и состояние связки здесь не трогаются (ветка идёт после проверки подписи).
     */
    if (opts.replayGuard !== false && deps.seenSignature && req.method !== 'GET' && req.method !== 'HEAD') {
      const sig = String((req.headers as SignatureHeaders).signature ?? '');
      const ttlS = Math.max(1, (verdict.expires ?? Math.floor(deps.now() / 1000)) - Math.floor(deps.now() / 1000) + CLOCK_SKEW_TOLERANCE_S);
      if (await deps.seenSignature(`${instanceId}:${createHash('sha256').update(sig).digest('base64url')}`, ttlS)) {
        return { ok: false, status: 401, error: 'expired' };
      }
    }

    if (opts.requireActive !== false) {
      // Аварийная пауза держателя читается здесь, а не берётся из состояния связки: связка может быть
      // рабочей, а федерация целиком — на паузе.
      const refusal = linkVerdict(link, await deps.paused());
      if (refusal) return { ok: false, status: 409, error: refusal };
    }

    return { ok: true, link };
  }

  return { peerPublicKey, forgetPeerDocument, authenticateLinkedPeer, targetUriOf };
}

export type PeerAuth = ReturnType<typeof createPeerAuth>;
