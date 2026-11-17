import { canRunPredictions } from '@gusvoice/shared';
import type { FastifyInstance, FastifyReply } from 'fastify';
import { z } from 'zod';
import { requireAuth } from '../auth.js';
import { economySeenBy } from '../coins.js';
import { inVoiceOfServer } from '../gameWheel.js';
import {
  cancelPrediction,
  closePrediction,
  createPrediction,
  placePredictionBet,
  predictionSnapshot,
  settlePrediction,
  startPredictionWorker,
  type PredictionResult,
} from '../gamePredictions.js';
import { PREDICTION_REFUSAL_TEXT, predictionRefusalStatus, validatePredictionDraft, type PredictionRefusal } from '../gamePredictionRules.js';
import { getMemberContext } from '../permissions.js';

/**
 * Ставки на события (ГусКоины 2, этап 5): снимок, создание, ставка, закрытие приёма, итог, отмена. Регистрируется изнутри
 * `gameWheelRoutes` (`routes/gameWheel.ts`) соседним плагином — без нового импорта в `index.ts`. Такт — по `onListen`
 * (тесты на `inject` его не заводят). Логика — `gamePredictions.ts`, правила — `gamePredictionRules.ts`.
 *
 * Права (`canRunPredictions`): создать — `MANAGE_PREDICTIONS` или `MANAGE_ECONOMY` (владелец и администратор — неявно);
 * закрыть приём вручную и подвести итог — ТОЛЬКО создатель; отменить — создатель или они же; ставить — сидящий в голосе этого сервера,
 * не создатель, не бот.
 */

const params = z.object({ id: z.string(), eventId: z.string().max(64) });
/** Форма редактора; длины и пределы проверяет `validatePredictionDraft` (с указанием поля). */
const createSchema = z.object({
  title: z.string().max(1000),
  lockInSec: z.number().nullable().optional(),
  questions: z.array(z.object({ question: z.string().max(1000), options: z.array(z.string().max(1000)).max(50) })).max(50),
});
const betSchema = z.object({
  questionId: z.string().min(1).max(64),
  optionId: z.string().min(1).max(64),
  amount: z.number().int().min(1),
});
const settleSchema = z.object({ winners: z.record(z.string().max(64), z.string().max(64).nullable()) });

/** `reason` дублирует код: клиентский `parseResponse` кладёт в `Error.reason` именно его, а `error` уходит в текст ошибки. */
function refuse(code: PredictionRefusal, extra: Record<string, unknown> = {}) {
  return { status: predictionRefusalStatus(code), body: { error: code, reason: code, message: PREDICTION_REFUSAL_TEXT[code], ...extra } };
}

export async function gamePredictionRoutes(app: FastifyInstance): Promise<void> {
  app.addHook('preHandler', requireAuth);
  app.addHook('onListen', async () => startPredictionWorker());

  const answer = (reply: FastifyReply, r: PredictionResult) => {
    if (!r.ok) {
      const x = refuse(r.code, r.field ? { field: r.field } : {});
      return reply.code(x.status).send(x.body);
    }
    return reply.code(200).send({ event: r.event, serverNow: new Date().toISOString() });
  };

  /** Игры сервера видны человеку и включены (с учётом закрытого показа экономики). */
  const gamesOn = async (serverId: string, userId: string) => {
    const economy = await economySeenBy(serverId, userId);
    return (economy?.enabled ?? false) && (economy?.gamesEnabled ?? false);
  };

  /** Снимок: живые события и закончившиеся за сутки. Любой участник; экономика не видна — `enabled: false`. */
  app.get('/servers/:id/predictions', async (req, reply) => {
    const { id: serverId } = z.object({ id: z.string() }).parse(req.params);
    const ctx = await getMemberContext(serverId, req.user!.sub);
    if (!ctx) return reply.code(404).send({ error: 'not a member' });
    return reply.send(await predictionSnapshot(serverId, req.user!.sub, canRunPredictions(ctx.serverPermissions)));
  });

  /** Создать событие (`MANAGE_PREDICTIONS`/`MANAGE_ECONOMY`). Ответ — DTO нового события. */
  app.post('/servers/:id/predictions', async (req, reply) => {
    const { id: serverId } = z.object({ id: z.string() }).parse(req.params);
    const userId = req.user!.sub;
    const ctx = await getMemberContext(serverId, userId);
    if (!ctx) return reply.code(404).send({ error: 'not a member' });
    if (!canRunPredictions(ctx.serverPermissions)) return answer(reply, { ok: false, code: 'forbidden' });
    if (!(await gamesOn(serverId, userId))) return answer(reply, { ok: false, code: 'games-off' });
    const parsed = createSchema.safeParse(req.body ?? {});
    if (!parsed.success) return answer(reply, { ok: false, code: 'bad_draft' });
    const draft = validatePredictionDraft(parsed.data);
    if (!draft.ok) return answer(reply, { ok: false, code: 'bad_draft', field: draft.field });
    return answer(reply, await createPrediction(serverId, userId, draft.draft));
  });

  /**
   * Ставка. Порядок проверок — от общего к частному: участник → игры на сервере → сидит в голосе ЭТОГО сервера
   * (presence, fail-closed) → транзакция (`placePredictionBet`: событие открыто, не создатель, одна ставка на вопрос,
   * лимиты этапа 1). Ответ — событие со своей ставкой (`mine`).
   */
  app.post('/servers/:id/predictions/:eventId/bets', async (req, reply) => {
    const { id: serverId, eventId } = params.parse(req.params);
    const userId = req.user!.sub;
    const ctx = await getMemberContext(serverId, userId);
    if (!ctx) return reply.code(404).send({ error: 'not a member' });
    const body = betSchema.parse(req.body ?? {});
    if (!(await gamesOn(serverId, userId))) return answer(reply, { ok: false, code: 'games-off' });
    if (!(await inVoiceOfServer(serverId, userId))) return answer(reply, { ok: false, code: 'not_in_voice' });
    return answer(reply, await placePredictionBet({ serverId, eventId, userId, ...body }));
  });

  /** Закрыть приём вручную: только создатель, независимо от текущих прав управления. Авторство проверяется под замком события. */
  app.post('/servers/:id/predictions/:eventId/close', async (req, reply) => {
    const { id: serverId, eventId } = params.parse(req.params);
    const userId = req.user!.sub;
    const ctx = await getMemberContext(serverId, userId);
    if (!ctx) return reply.code(404).send({ error: 'not a member' });
    const result = await closePrediction(serverId, eventId, userId, canRunPredictions(ctx.serverPermissions));
    if (!result.ok && result.code === 'forbidden') {
      const { status, body } = refuse(result.code);
      return reply.code(status).send({ ...body, message: 'Закрыть приём может только создатель события' });
    }
    return answer(reply, result);
  });

  /** Итог: только создатель, после закрытия. `winners` — `{questionId: optionId | null}` на КАЖДЫЙ вопрос (null — не состоялся). */
  app.post('/servers/:id/predictions/:eventId/settle', async (req, reply) => {
    const { id: serverId, eventId } = params.parse(req.params);
    const userId = req.user!.sub;
    const ctx = await getMemberContext(serverId, userId);
    if (!ctx) return reply.code(404).send({ error: 'not a member' });
    const parsed = settleSchema.safeParse(req.body ?? {});
    if (!parsed.success) return answer(reply, { ok: false, code: 'bad_winners' });
    if (!(await gamesOn(serverId, userId))) return answer(reply, { ok: false, code: 'games-off' });
    return answer(reply, await settlePrediction(serverId, eventId, userId, parsed.data.winners));
  });

  /** Отмена с возвратом всех ставок: создатель или `MANAGE_PREDICTIONS`/`MANAGE_ECONOMY`, до итога. */
  app.post('/servers/:id/predictions/:eventId/cancel', async (req, reply) => {
    const { id: serverId, eventId } = params.parse(req.params);
    const userId = req.user!.sub;
    const ctx = await getMemberContext(serverId, userId);
    if (!ctx) return reply.code(404).send({ error: 'not a member' });
    return answer(reply, await cancelPrediction(serverId, eventId, userId, canRunPredictions(ctx.serverPermissions)));
  });
}
