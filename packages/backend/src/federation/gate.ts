/**
 * Проверка «федерация включена» на каждом запросе (#224).
 *
 * До #224 маршруты федерации регистрировались только при `FEDERATION_ENABLED=true`: выключено — маршрута нет, сосед получал
 * обычный 404. Теперь федерацию включают тумблером в админке без перезапуска, поэтому маршруты регистрируются всегда, а этот
 * крючок `onRequest` отвечает ТЕМ ЖЕ 404 (обработчик «не найдено» самого Fastify), пока флаг выключен. Снаружи разницы нет:
 * выключенный инстанс по-прежнему не похож на федеративный.
 *
 * Зависимости — только `env.js`: крючок стоит и в маршрутах, которые проверяются с подменённым окружением.
 */

import type { FastifyReply, FastifyRequest } from 'fastify';
import { env } from '../env.js';

/** Вся федерация (`/api/fed/*`, вкладка админки): выключена — 404 как у незарегистрированного маршрута. */
export async function federationGate(_req: FastifyRequest, reply: FastifyReply): Promise<FastifyReply | void> {
  if (env.federation.enabled) return;
  reply.callNotFound();
  return reply;
}

/**
 * ЛС между инстансами (`FEDERATION_DM_ENABLED` / второй тумблер): выключено — тот же 404. `env.federation.dmEnabled` уже
 * учитывает общий флаг (`env.ts`), поэтому отдельной проверки `enabled` здесь нет.
 */
export async function federationDmGate(_req: FastifyRequest, reply: FastifyReply): Promise<FastifyReply | void> {
  if (env.federation.dmEnabled) return;
  reply.callNotFound();
  return reply;
}
