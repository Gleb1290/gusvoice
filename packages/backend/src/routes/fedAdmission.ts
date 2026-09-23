/**
 * Допуск подписанного запроса соседа и приём пачки событий — без Redis, базы и сети (вынос для тестов
 * 22.09; проводка — `routes/federation.ts`). Тест регистрирует обработчик на пустом `Fastify()` с
 * подставными зависимостями и гоняет `inject`: порядок проверок виден по тому, какие зависимости
 * позваны и что ответили.
 */

import type { FastifyReply, FastifyRequest } from 'fastify';
import { isInstanceId } from '../federation/instanceIdentity.js';
import { EVENTS_BATCH_MAX, type FED_LIMITS } from '../federation/guards.js';
import type { PeerAuthResult } from '../federation/peerAuthCore.js';
import type { StoredLink } from '../federation/linkService.js';

export type FedLimitKind = keyof typeof FED_LIMITS;

export interface AdmitPeerDeps {
  /** Сколько секунд ждать по пределу `kind` для `who` (`guardsRuntime.fedRateBlock`); `0` — можно. */
  rateBlock: (kind: FedLimitKind, who: string) => Promise<number>;
  /** Подпись и состояние связки (`peerAuth.authenticateLinkedPeer`). */
  authenticate: (req: FastifyRequest, instanceId: string, opts: { requireActive?: boolean }) => Promise<PeerAuthResult>;
  /** Адрес отправителя с учётом доверенных прокси. */
  clientIp: (req: FastifyRequest) => string;
}

/**
 * Общий порядок допуска подписанного запроса соседа (аудит 19.09, F-07 и F-12):
 * форма `instance_id` → предел по АДРЕСУ → подпись и состояние связки → предел по СВЯЗКЕ.
 *
 * 🔴 Раньше предел по связке стоял ДО подписи и ключевался `instance_id` из запроса: посторонний
 * называл id соседа и выжигал его часовой лимит — каталог, аватары, сверка членств и догон «выйти
 * везде» отвечали `429` честному соседу. Теперь до подписи считается адрес отправителя (дёшево и
 * своё у каждого), а имя соседа тратит счётчик только после того, как доказано подписью.
 *
 * Возвращает связку либо `null` — ответ уже отправлен.
 */
export function createAdmitPeer(deps: AdmitPeerDeps) {
  return async function admitPeer(
    req: FastifyRequest,
    reply: FastifyReply,
    instanceId: unknown,
    kind: FedLimitKind,
    opts: { requireActive?: boolean } = {},
  ): Promise<StoredLink | null> {
    // Форма — до всякого похода в Redis: иначе там копились бы ключи с любыми присланными строками.
    if (!isInstanceId(instanceId)) {
      await reply.code(400).send({ error: 'bad-request' });
      return null;
    }
    const byAddress = await deps.rateBlock('peerAddress', deps.clientIp(req));
    if (byAddress > 0) {
      await reply.code(429).header('retry-after', String(byAddress)).send({ error: 'rate-limited' });
      return null;
    }
    const auth = await deps.authenticate(req, instanceId, opts);
    if (!auth.ok) {
      await reply.code(auth.status).send({ error: auth.error, skew_s: auth.skewS });
      return null;
    }
    const byLink = await deps.rateBlock(kind, instanceId);
    if (byLink > 0) {
      await reply.code(429).header('retry-after', String(byLink)).send({ error: 'rate-limited' });
      return null;
    }
    return auth.link;
  };
}

export type AdmitPeer = ReturnType<typeof createAdmitPeer>;

/** Заголовок подписи строкой: повторённый заголовок приходит массивом, и это уже не наш формат. */
export function signatureOf(req: Pick<FastifyRequest, 'headers'>): string {
  const raw = req.headers.signature;
  return typeof raw === 'string' ? raw : '';
}

export interface EventsRouteDeps {
  admitPeer: AdmitPeer;
  /** Та же подпись уже была (`guardsRuntime.seenSignature`, #148). */
  seenSignature: (signatureHeader: string) => Promise<boolean>;
  receiveEvents: (instanceId: string, events: unknown[]) => Promise<unknown>;
}

/**
 * `POST /fed/v1/events` — пачка событий от связанного соседа (§5.1).
 *
 * 🔴 Связка обязана быть УЖЕ рабочей: события меняют состояние у нас, и принимать их от того, с
 * кем связка на паузе, разорвана или потеряла доверие, нельзя. Поэтому вердикт считается до
 * всякой работы с содержимым.
 * ⚠️ Форма и размер пачки — ДО допуска: мусорное тело не тратит ни пределов, ни проверки подписи.
 * ⚠️ Повтор — не ошибка: отправитель мог не дождаться ответа и послать снова. Отвечаем тем, что
 * реально приняли, а дубли считаем отдельно.
 */
export function createEventsHandler(deps: EventsRouteDeps) {
  return async function eventsHandler(req: FastifyRequest, reply: FastifyReply): Promise<unknown> {
    const body = (req.body ?? {}) as Record<string, unknown>;
    const events = Array.isArray(body.events) ? body.events : null;
    if (!events) return reply.code(400).send({ error: 'bad-request' });
    // 🔴 Пачка не больше ста (аудит 19.09, F-14): предел `events` считает запросы, а в одном теле
    // помещались тысячи событий — каждое по нескольку запросов в базу строго по очереди.
    if (events.length > EVENTS_BATCH_MAX) {
      return reply.code(413).send({ error: 'batch-too-large', max: EVENTS_BATCH_MAX });
    }

    const link = await deps.admitPeer(req, reply, body.instance_id, 'events');
    if (!link) return;
    // 🔴 Тот же самый запрос второй раз (#148): подпись верна и срок не вышел, но применять его
    // повторно нельзя — событие вроде «человека забанили» меняет состояние при каждом применении.
    if (await deps.seenSignature(signatureOf(req))) return reply.code(409).send({ error: 'replay' });

    return await deps.receiveEvents(link.instanceId, events);
  };
}
