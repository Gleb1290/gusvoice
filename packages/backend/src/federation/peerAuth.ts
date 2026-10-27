/**
 * Проверка входящего запроса от связанного соседа (#139; вынесено в F2).
 *
 * До этого одна и та же цепочка — «найти связку → сверить вердикт → забрать визитку → проверить
 * подпись» — стояла в каждом маршруте своей копией. Пять копий одной проверки безопасности это не
 * стилистическая беда: достаточно подправить четыре и забыть пятую, и забытая молча пускает всех.
 * Поэтому цепочка здесь одна, а маршруты только говорят, чего им нужно.
 *
 * ⚠️ Не переехали сюда два маршрута, и намеренно: заявка на связку проверяется ключом из визитки
 * ЗАЯВИТЕЛЯ (связки ещё нет), а отзыв ключа — корневым ключом ИЗ СВЯЗКИ (визитка уже отдаёт новую
 * личность). Свести их с остальными можно было бы только флагами, а флаг в проверке подписи — это
 * ровно тот рычаг, которым её потом и отключают.
 *
 * 🔴 Порядок с 22.09 (аудит 19.09, F-12): подпись ПЕРВОЙ, состояние связки — после неё. До верной
 * подписи ответ один на всех — `401 unknown`: «нет связки», «подпись не разобралась», «ключ
 * незнаком» и «подпись не сошлась» снаружи неразличимы. Иначе посторонний, перебирая известные
 * инстансы в `instance_id`, читал карту наших связок и их состояний, а десятью запросами поднимал
 * держателю оповещение «всплеск отказов подписи» от имени честного соседа.
 *
 * Здесь только проводка: сеть, база, часы, `env`. Кеш визиток и сама проверка — `peerAuthCore.ts`
 * (вынос для тестов 22.09). Экспорты — объявления функций, а не `const { … } = auth`: модуль в кольце
 * импортов (`links` → `peerAuth` → `links`), и взять функцию как значение до конца его вычисления
 * (`createLinkService({ … })` в `links.ts`) должно быть можно — `const` там упёрся бы в TDZ.
 */

import type { FastifyRequest } from 'fastify';
import { fetchPeerDocument } from './peerClient.js';
import { noteSignatureFailure } from './alerts.js';
import { getLink } from './links.js';
import { readInstanceMeta } from './instanceMeta.js';
import { markTrustLost } from './trustLoss.js';
import type { StoredLink } from './linkService.js';
import { createPeerAuth, type PeerAuthResult, type PeerRequestLike } from './peerAuthCore.js';
import { env } from '../env.js';

export {
  DOC_FORCE_MIN_INTERVAL_MS,
  DOC_RETRY_AFTER_MS,
  refusalFor,
  type PeerAuthResult,
} from './peerAuthCore.js';

// Зависимости — через стрелки: связка `links`/`trustLoss`/`alerts` может быть ещё не вычислена.
const auth = createPeerAuth({
  fetchPeerDocument: (input) => fetchPeerDocument(input),
  now: () => Date.now(),
  markTrustLost: (instanceId, reason) => markTrustLost(instanceId, reason),
  noteSignatureFailure: (instanceId) => noteSignatureFailure(instanceId),
  getLink: (instanceId) => getLink(instanceId),
  paused: async () => (await readInstanceMeta()).paused,
  apiBase: env.federation.apiBase,
  // Аудит ЛС #236, п.15: отметка подписи в Redis (`SET NX EX`); лениво — `realtime.ts` открывает Redis при загрузке.
  seenSignature: async (key, ttlS) => {
    try {
      const { redisPub } = await import('../realtime.js');
      return (await redisPub.set(`fedsig:${key}`, '1', 'EX', ttlS, 'NX')) === null;
    } catch {
      return false; // Redis недоступен — не отрезать соседа: проверка повтора — заслон сверху, не условие связи
    }
  },
});

/** Забыть визитку соседа — при разрыве, перепривязке и потере доверия. */
export function forgetPeerDocument(instanceId: string): void {
  auth.forgetPeerDocument(instanceId);
}

/** Публичный ключ соседа по `kid` через кеш визиток (токен личности, §5.5). См. `peerAuthCore.ts`. */
export function peerPublicKey(link: StoredLink, kid: string, force = false): Promise<Buffer | null> {
  return auth.peerPublicKey(link, kid, force);
}

/** Адрес запроса ровно в том виде, в каком его подписывал отправитель (вместе со строкой запроса). */
export function targetUriOf(req: FastifyRequest): string {
  return auth.targetUriOf(req);
}

/** Подпись соседа, затем состояние связки. `requireActive: false` — только подтверждение заявки. */
export function authenticateLinkedPeer(
  req: PeerRequestLike,
  instanceId: string,
  opts: { requireActive?: boolean; replayGuard?: boolean } = {},
): Promise<PeerAuthResult> {
  return auth.authenticateLinkedPeer(req, instanceId, opts);
}
