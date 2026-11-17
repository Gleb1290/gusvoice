import { has, isGamesLaunchGift, isWheelPick, Permission, type GamesLaunchResult } from '@gusvoice/shared';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { writeAudit } from '../audit.js';
import { requireAuth } from '../auth.js';
import { economySeenBy, gamesOpenOnInstance } from '../coins.js';
import {
  GAMES_LAUNCH_REFUSAL_TEXT,
  gamesLaunchRefusalStatus,
  gamesLockedFor,
  launchRefusal,
  type GamesLaunchRefusal,
} from '../gameMoneyRules.js';
import {
  announceLaunch,
  inVoiceOfServer,
  launchGames,
  placeWheelBet,
  spinWheelNow,
  startWheelWorker,
  voiceUsersOfServer,
  wheelSnapshot,
} from '../gameWheel.js';
import {
  WHEEL_REFUSAL_TEXT,
  WHEEL_SPIN_REFUSAL_TEXT,
  wheelRefusalStatus,
  wheelSpinRefusalStatus,
  type WheelBetRefusal,
} from '../gameWheelRules.js';
import { gameBoardRoutes } from './gameBoard.js';
import { gameDuelRoutes } from './gameDuel.js';
import { gamePredictionRoutes } from './gamePredictions.js';
import { getMemberContext } from '../permissions.js';

/**
 * Колесо гусей-пиратов (ГусКоины 2, этап 2): снимок и ставка. Регистрируется рядом с экономикой (`index.ts`, только при
 * `ECONOMY_ENABLED`); такт раундов заводится здесь же по `onListen` — тесты на `inject` его не заводят (как фон ботов,
 * `routes/botApi.ts`). Логика — `gameWheel.ts`, правила — `gameWheelRules.ts`.
 */

const betSchema = z.object({
  pick: z.number().refine(isWheelPick, 'pick'),
  amount: z.number().int().min(1),
});

/** `reason` дублирует код: клиентский `parseResponse` кладёт в `Error.reason` именно его, а `error` уходит в текст ошибки. */
function refuse(code: WheelBetRefusal, extra: Record<string, unknown> = {}) {
  return { status: wheelRefusalStatus(code), body: { error: code, reason: code, message: WHEEL_REFUSAL_TEXT[code], ...extra } };
}

/**
 * Регистрация «игр» в `index.ts`: колесо, (этап 3) гусиная дуэль, (этап 5) ставки на события и (этап 6) лидерборд игр со
 * званиями и «Итогами» — СОСЕДНИМИ плагинами. Дуэль висит здесь, потому что у
 * `index.ts` закрытый перечень импортов (`federation/switchWiring.test.ts`). Соседи, а не вложенные: хуки Fastify
 * наследуются вниз даже от плагина, зарегистрированного раньше хука (проверено пробой), и `requireAuth` колеса
 * сработал бы на дуэли второй раз. Каждый вешает свои `requireAuth` и такт сам.
 */
export async function gameWheelRoutes(app: FastifyInstance): Promise<void> {
  await app.register(gameDuelRoutes);
  await app.register(gamePredictionRoutes);
  // Этап 6: лидерборд игр, звания месяца и «Итоги» (`routes/gameBoard.ts`).
  await app.register(gameBoardRoutes);
  // «Запустить игры» (29.10): разовая отметка + подарок сидевшим в голосе (`launchRoutes` ниже).
  await app.register(launchRoutes);
  await app.register(wheelRoutes);
}

async function wheelRoutes(app: FastifyInstance): Promise<void> {
  app.addHook('preHandler', requireAuth);
  app.addHook('onListen', async () => startWheelWorker());

  /** Снимок колеса: любой участник сервера. Экономика ему не видна или игры выключены — `enabled: false`. */
  app.get('/servers/:id/wheel', async (req, reply) => {
    const { id: serverId } = z.object({ id: z.string() }).parse(req.params);
    const ctx = await getMemberContext(serverId, req.user!.sub);
    if (!ctx) return reply.code(404).send({ error: 'not a member' });
    return reply.send(await wheelSnapshot(serverId, req.user!.sub));
  });

  /**
   * Ставка. Порядок проверок — от общего к частному: участник → игры на сервере (с учётом закрытого показа экономики)
   * → сидит в голосе ЭТОГО сервера (presence, fail-closed) → транзакция (`placeWheelBet`: замок от двойного нажатия,
   * раунд, лимиты этапа 1). Ответ 200 — свежий снимок.
   */
  app.post('/servers/:id/wheel/bets', async (req, reply) => {
    const { id: serverId } = z.object({ id: z.string() }).parse(req.params);
    const userId = req.user!.sub;
    const ctx = await getMemberContext(serverId, userId);
    if (!ctx) return reply.code(404).send({ error: 'not a member' });
    const { pick, amount } = betSchema.parse(req.body ?? {});
    const economy = await economySeenBy(serverId, userId);
    if (!economy?.enabled || !economy.gamesEnabled) {
      const r = refuse('games-off');
      return reply.code(r.status).send(r.body);
    }
    if (!(await inVoiceOfServer(serverId, userId))) {
      const r = refuse('not_in_voice');
      return reply.code(r.status).send(r.body);
    }
    const result = await placeWheelBet(serverId, userId, pick as Parameters<typeof placeWheelBet>[2], amount);
    if (!result.ok) {
      const r = refuse(result.code, result.retryAt ? { retryAt: result.retryAt } : {});
      return reply.code(r.status).send(r.body);
    }
    return reply.send(await wheelSnapshot(serverId, userId));
  });

  /**
   * «Крутить сейчас» (30.10): закрыть приём досрочно — может любой, кто поставил в этом раунде (`gameWheel.spinWheelNow`:
   * раунд `open` + своя ставка, иначе `no_round` 409 / `no_bet` 403). Сидеть в голосе не требуем: ставка уже сделана из
   * голоса. Повтор/гонка с тактом — тот же ответ 200. Ответ — свежий снимок; всем — `wheel.state` с `locked`.
   */
  app.post('/servers/:id/wheel/spin', async (req, reply) => {
    const { id: serverId } = z.object({ id: z.string() }).parse(req.params);
    const userId = req.user!.sub;
    const ctx = await getMemberContext(serverId, userId);
    if (!ctx) return reply.code(404).send({ error: 'not a member' });
    const economy = await economySeenBy(serverId, userId);
    if (!(economy?.enabled && economy.gamesEnabled)) {
      const r = refuse('games-off');
      return reply.code(r.status).send(r.body);
    }
    const result = await spinWheelNow(serverId, userId);
    if (!result.ok) {
      const text = WHEEL_SPIN_REFUSAL_TEXT[result.code];
      return reply.code(wheelSpinRefusalStatus(result.code)).send({ error: result.code, reason: result.code, message: text });
    }
    const fresh = await wheelSnapshot(serverId, userId);
    return reply.send(fresh);
  });
}

/**
 * Отказ запуска — `{error, reason, message}`. В отличие от ставки, `error` — текст для человека: кнопка запуска в панели
 * экономики показывает `Error.message` как есть (`parseResponse`), своей карты кодов у неё нет; код — в `reason`.
 */
function refuseLaunch(code: GamesLaunchRefusal) {
  const text = GAMES_LAUNCH_REFUSAL_TEXT[code];
  return { status: gamesLaunchRefusalStatus(code), body: { error: text, reason: code, message: text } };
}

const launchSchema = z.object({ gift: z.unknown() });

/**
 * «Запустить игры» (ГусКоины 2, решения владельца 29.10, пп. 8–9): `POST /servers/:id/games/launch` `{gift}` — соседом
 * колеса здесь же (у `index.ts` закрытый перечень импортов). Порядок проверок: участник → подарок (`isGamesLaunchGift`)
 * → замок (`GAMES_OPEN` или супер-админ, `ctx.superAdmin`) → `MANAGE_ECONOMY` → монеты включены → транзакция
 * (`gameWheel.launchGames`: отметка `IS NULL` держит повтор и гонку двух нажатий → `already-launched`). Ответ —
 * `GamesLaunchResult`; шина и журнал действий — после коммита.
 */
async function launchRoutes(app: FastifyInstance): Promise<void> {
  app.addHook('preHandler', requireAuth);

  app.post('/servers/:id/games/launch', async (req, reply) => {
    const { id: serverId } = z.object({ id: z.string() }).parse(req.params);
    const userId = req.user!.sub;
    const ctx = await getMemberContext(serverId, userId);
    if (!ctx) return reply.code(404).send({ error: 'not a member' });
    const { gift } = launchSchema.parse(req.body ?? {});
    if (!isGamesLaunchGift(gift)) {
      const r = refuseLaunch('bad-gift');
      return reply.code(r.status).send(r.body);
    }
    const economy = await economySeenBy(serverId, userId);
    const code =
      launchRefusal({
        locked: gamesLockedFor(gamesOpenOnInstance(), ctx.superAdmin === true),
        canManage: has(ctx.serverPermissions, Permission.MANAGE_ECONOMY),
        economyEnabled: !!economy?.enabled,
      }) ?? (economy ? null : 'economy-off');
    if (code || !economy) {
      const r = refuseLaunch(code ?? 'economy-off');
      return reply.code(r.status).send(r.body);
    }

    // Кто в голосе — ДО транзакции (Redis), сама выдача — в ней.
    const out = await launchGames(economy, userId, gift, await voiceUsersOfServer(serverId));
    if (!out.ok) {
      const r = refuseLaunch(out.code);
      return reply.code(r.status).send(r.body);
    }
    await announceLaunch(serverId, out);
    await writeAudit(serverId, userId, 'economy.games-launch', {
      targetType: 'server',
      targetId: serverId,
      data: { gift, people: out.userIds.length, minted: gift * out.userIds.length },
    });
    const res: GamesLaunchResult = { at: out.at.toISOString(), gift, people: out.userIds.length };
    return reply.send(res);
  });
}
