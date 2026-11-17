import { FEATURE_DUEL2, FEATURE_DUEL21, isDuelChoiceGame, isDuelGame, type DuelGame } from '@gusvoice/shared';
import type { FastifyInstance, FastifyReply } from 'fastify';
import { z } from 'zod';
import { requireAuth } from '../auth.js';
import { economySeenBy } from '../coins.js';
import { acceptDuel, challengeDuel, controlDuelSeries, duelSnapshot, endInvite, moveDuel, rollDuel, startDuelWorker, type DuelResult } from '../gameDuel.js';
import { userHasCap } from '../gateway.js';
import { DUEL_REFUSAL_TEXT, duelRefusalStatus, type DuelRefusal } from '../gameDuelRules.js';
import { getMemberContext } from '../permissions.js';

/**
 * Гусиная дуэль (ГусКоины 2, этапы 3–4): снимок, вызов, принятие, отказ, отзыв, бросок, ход в игре с выбором. Регистрируется изнутри
 * `gameWheelRoutes` (`routes/gameWheel.ts`) — та же регистрация «игр» в `index.ts` (только при `ECONOMY_ENABLED`), без
 * нового импорта в `index.ts`. Такт заводится здесь же по `onListen` — тесты на `inject` его не заводят.
 * Логика — `gameDuel.ts`, правила — `gameDuelRules.ts`.
 */

const challengeSchema = z.object({
  channelId: z.string().min(1).max(64),
  targetId: z.string().min(1).max(64),
  game: z.string().refine(isDuelGame, 'game'),
  amount: z.number().int().min(1),
  series: z.boolean().optional(),
});
const params = z.object({ id: z.string(), duelId: z.string() });
/** Ход (этап 4): `seq` — номер, который видел клиент; `move` — рука КНБ или `roll|stop` (проверяет `moveDuel` по игре). */
const moveSchema = z.object({ seq: z.number().int().min(0).max(100_000), move: z.string().min(1).max(16) });
const acceptSchema = z.object({ series: z.boolean().optional() });
const rollSchema = z.object({ rollNo: z.number().int().nonnegative().optional() });
const pulseSchema = z.object({
  clientId: z.string().min(1).max(128), roundId: z.string().min(1).max(64),
  visible: z.boolean(), ready: z.boolean(),
});

/** `reason` дублирует код: клиентский `parseResponse` кладёт в `Error.reason` именно его, а `error` уходит в текст ошибки. */
function refuse(code: DuelRefusal, extra: Record<string, unknown> = {}) {
  return { status: duelRefusalStatus(code), body: { error: code, reason: code, message: DUEL_REFUSAL_TEXT[code], ...extra } };
}

export async function gameDuelRoutes(app: FastifyInstance): Promise<void> {
  app.addHook('preHandler', requireAuth);
  app.addHook('onListen', async () => startDuelWorker());

  const answer = (reply: FastifyReply, r: DuelResult) => {
    if (!r.ok) {
      const x = refuse(r.code, r.retryAt ? { retryAt: r.retryAt } : {});
      return reply.code(x.status).send(x.body);
    }
    return reply.code(200).send({ duel: r.duel, ...(r.myHand !== undefined ? { myHand: r.myHand } : {}), serverNow: new Date().toISOString() });
  };

  /** Игры сервера видны человеку и включены (с учётом закрытого показа экономики). */
  const gamesOn = async (serverId: string, userId: string) => {
    const economy = await economySeenBy(serverId, userId);
    return (economy?.enabled ?? false) && (economy?.gamesEnabled ?? false);
  };

  /** Снимок: партия канала (только сидящему в нём или игроку) и входящий вызов мне на этом сервере. */
  app.get('/servers/:id/duel', async (req, reply) => {
    const { id: serverId } = z.object({ id: z.string() }).parse(req.params);
    const { channelId } = z.object({ channelId: z.string().max(64).optional() }).parse(req.query ?? {});
    const ctx = await getMemberContext(serverId, req.user!.sub);
    if (!ctx) return reply.code(404).send({ error: 'not a member' });
    return reply.send(await duelSnapshot(serverId, channelId ?? '', req.user!.sub));
  });

  /**
   * Вызов. Порядок проверок — от общего к частному: участник → игры на сервере → соперник участник и экономика ему видна
   * (иначе обезличенное `target_unavailable`) → `challengeDuel` (канал, голос обоих fail-closed, пауза пары, транзакция).
   */
  app.post('/servers/:id/duels', async (req, reply) => {
    const { id: serverId } = z.object({ id: z.string() }).parse(req.params);
    const userId = req.user!.sub;
    const ctx = await getMemberContext(serverId, userId);
    if (!ctx) return reply.code(404).send({ error: 'not a member' });
    const body = challengeSchema.parse(req.body ?? {});
    if (!(await gamesOn(serverId, userId))) return answer(reply, { ok: false, code: 'games-off' });
    if (body.targetId === userId) return answer(reply, { ok: false, code: 'self' });
    if (!(await getMemberContext(serverId, body.targetId)) || !(await gamesOn(serverId, body.targetId))) {
      return answer(reply, { ok: false, code: 'target_unavailable' });
    }
    const game = body.game as DuelGame;
    // Этап 4: игру с выбором — только сопернику, чей клиент её умеет (`duel2` в `identify.caps` хоть одного соединения
    // шлюза). Fail-closed: нет соединения или старый клиент — обезличенное «не может играть».
    if (isDuelChoiceGame(game) && !userHasCap(body.targetId, game === 'twentyone' ? FEATURE_DUEL21 : FEATURE_DUEL2)) return answer(reply, { ok: false, code: 'target_unavailable' });
    return answer(reply, await challengeDuel({ serverId, channelId: body.channelId, challengerId: userId, targetId: body.targetId, game, amount: body.amount, series: body.series }));
  });

  app.post('/servers/:id/duels/:duelId/accept', async (req, reply) => {
    const { id: serverId, duelId } = params.parse(req.params);
    const userId = req.user!.sub;
    if (!(await getMemberContext(serverId, userId))) return reply.code(404).send({ error: 'not a member' });
    if (!(await gamesOn(serverId, userId))) return answer(reply, { ok: false, code: 'games-off' });
    const body = acceptSchema.parse(req.body ?? {});
    return answer(reply, await acceptDuel(serverId, duelId, userId, new Date(), body.series === true));
  });

  for (const action of ['pulse', 'pause', 'stop'] as const) {
    app.post(`/servers/:id/duels/:duelId/series/${action}`, async (req, reply) => {
      const { id: serverId, duelId } = params.parse(req.params);
      // Participant authorization is checked against the round, not current economy/member visibility:
      // leaving a server or disabling games must never prevent stopping future wagers.
      const pulse = action === 'pulse' ? pulseSchema.parse(req.body ?? {}) : undefined;
      return answer(reply, await controlDuelSeries(serverId, duelId, req.user!.sub, action, pulse));
    });
  }

  app.post('/servers/:id/duels/:duelId/decline', async (req, reply) => {
    const { id: serverId, duelId } = params.parse(req.params);
    const userId = req.user!.sub;
    if (!(await getMemberContext(serverId, userId))) return reply.code(404).send({ error: 'not a member' });
    return answer(reply, await endInvite(serverId, duelId, userId, 'declined'));
  });

  app.post('/servers/:id/duels/:duelId/withdraw', async (req, reply) => {
    const { id: serverId, duelId } = params.parse(req.params);
    const userId = req.user!.sub;
    if (!(await getMemberContext(serverId, userId))) return reply.code(404).send({ error: 'not a member' });
    return answer(reply, await endInvite(serverId, duelId, userId, 'withdrawn'));
  });

  /** «Бросить» — раскрыть свои кости текущего броска; повтор безопасен. */
  app.post('/servers/:id/duels/:duelId/roll', async (req, reply) => {
    const { id: serverId, duelId } = params.parse(req.params);
    const userId = req.user!.sub;
    if (!(await getMemberContext(serverId, userId))) return reply.code(404).send({ error: 'not a member' });
    const body = rollSchema.parse(req.body ?? {});
    return answer(reply, await rollDuel(serverId, duelId, userId, new Date(), body.rollNo));
  });

  /**
   * Ход в игре с выбором (этап 4): КНБ — рука, Жадный гусь — «Бросить ещё»/«Стоп». Повтор того же `seq` безопасен и
   * ничего не меняет; ответ на ход КНБ несёт `myHand` — свою руку видит только сам игрок.
   */
  app.post('/servers/:id/duels/:duelId/move', async (req, reply) => {
    const { id: serverId, duelId } = params.parse(req.params);
    const userId = req.user!.sub;
    if (!(await getMemberContext(serverId, userId))) return reply.code(404).send({ error: 'not a member' });
    const body = moveSchema.parse(req.body ?? {});
    return answer(reply, await moveDuel(serverId, duelId, userId, body.seq, body.move));
  });
}
