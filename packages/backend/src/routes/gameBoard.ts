import { GAME_TITLE_NAME_MAX, has, isGameTitleKey, Permission, type GameLeaderboardDto } from '@gusvoice/shared';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { requireAuth } from '../auth.js';
import { economySeenBy } from '../coins.js';
import { seasonId, seasonName, seasonRange } from '../coinRules.js';
import { closeGameMonthIfNeeded, freezeEconomyRecap, frozenRecap, gameLeaderboard, gameMonthOf, gameTitles, hasFrozenMonth, previewRecap, renameGameTitle, titleNamesOf } from '../gameMonths.js';
import { getMemberContext } from '../permissions.js';
import { closeSeasonIfNeeded, configureSeasonHooks } from '../seasons.js';

/**
 * Лидерборд игр, звания месяца и «Итоги» (ГусКоины 2, этап 6). Регистрируется изнутри `gameWheelRoutes`
 * (`routes/gameWheel.ts`) соседним плагином — без нового импорта в `index.ts`. Логика — `gameMonths.ts`, выборка —
 * `gameTitlesData.ts`, правила — `gameTitlesRules.ts`, DTO — shared `gameTitles.ts`.
 *
 * Видимость: участник сервера, экономике которого он виден (`economySeenBy`); игры выключены — лидерборд `enabled: false`.
 * Права: переименовать звание и сухой прогон «Итогов» — `MANAGE_ECONOMY`.
 */

const params = z.object({ id: z.string() });
const MONTH_ID = /^m\d{4}-\d{2}$/;
const PERIOD_ID = /^(m\d{4}-\d{2}|(winter|spring|summer|autumn)-\d{4})$/;

export async function gameBoardRoutes(app: FastifyInstance): Promise<void> {
  app.addHook('preHandler', requireAuth);
  // Закрытие игрового месяца и заморозка «Итогов сезона» едут вместе с закрытием сезона (`seasons.closeSeasonIfNeeded`):
  // тик голоса раз в минуту и лидерборды. Внедряем при регистрации — у `seasons.ts` закрытый круг импортов.
  configureSeasonHooks({ afterClose: closeGameMonthIfNeeded, freezeRecap: freezeEconomyRecap });

  /**
   * Таблица игр: `period=month` (по умолчанию) — текущий месяц МСК вживую, `month=mYYYY-MM` — прошлый закрытый из заморозки;
   * `period=season` — текущий сезон экономики сервера вживую. Отказавшиеся и боты не видны.
   */
  app.get('/servers/:id/games/leaderboard', async (req, reply) => {
    const { id: serverId } = params.parse(req.params);
    const query = z
      .object({ period: z.enum(['month', 'season']).optional(), month: z.string().regex(MONTH_ID).optional() })
      .safeParse(req.query ?? {});
    if (!query.success) return reply.code(400).send({ error: 'bad query' });
    const userId = req.user!.sub;
    const ctx = await getMemberContext(serverId, userId);
    if (!ctx) return reply.code(404).send({ error: 'not a member' });
    const now = new Date();
    const economy = await economySeenBy(serverId, userId);
    const titleNames = await titleNamesOf(serverId);
    if (!economy?.enabled || !economy.gamesEnabled) {
      const off: GameLeaderboardDto = { enabled: false, period: null, frozen: false, people: [], titleNames };
      return reply.send(off);
    }
    // Как `economy/leaderboard`: перед чтением закрыть сезон и месяц, если сменились, — звания видны сразу.
    await closeSeasonIfNeeded(serverId, now);
    const kind = query.data.period ?? 'month';
    const current = gameMonthOf(now);
    let id = kind === 'season' ? seasonId(now, economy.seasonLength) : current;
    let frozenMonth: string | null = null;
    if (kind === 'month' && query.data.month && query.data.month < current) {
      if (!(await hasFrozenMonth(serverId, query.data.month))) return reply.code(404).send({ error: 'no such month' });
      id = query.data.month;
      frozenMonth = id;
    }
    const r = seasonRange(id);
    const board = await gameLeaderboard(serverId, { from: r.from, to: r.to }, frozenMonth);
    const out: GameLeaderboardDto = {
      enabled: true,
      period: { kind, id, name: seasonName(id), from: r.from.toISOString(), to: r.to.toISOString() },
      frozen: board.frozen,
      people: board.people,
      titleNames,
    };
    return reply.send(out);
  });

  /** Звания: все 27 с названиями сервера и носителями последнего закрытого месяца. */
  app.get('/servers/:id/games/titles', async (req, reply) => {
    const { id: serverId } = params.parse(req.params);
    const ctx = await getMemberContext(serverId, req.user!.sub);
    if (!ctx) return reply.code(404).send({ error: 'not a member' });
    const economy = await economySeenBy(serverId, req.user!.sub);
    if (!economy?.enabled) return reply.code(404).send({ error: 'economy disabled' });
    return reply.send(await gameTitles(serverId, has(ctx.serverPermissions, Permission.MANAGE_ECONOMY)));
  });

  /** Переименовать звание (`MANAGE_ECONOMY`). `name: null` или название по умолчанию — вернуть по умолчанию. */
  app.patch('/servers/:id/games/titles/:titleId', async (req, reply) => {
    const { id: serverId, titleId } = z.object({ id: z.string(), titleId: z.string().max(64) }).parse(req.params);
    const ctx = await getMemberContext(serverId, req.user!.sub);
    if (!ctx) return reply.code(404).send({ error: 'not a member' });
    if (!has(ctx.serverPermissions, Permission.MANAGE_ECONOMY)) return reply.code(403).send({ error: 'forbidden' });
    if (!isGameTitleKey(titleId)) return reply.code(404).send({ error: 'no such title' });
    const body = z.object({ name: z.string().max(1000).nullable() }).safeParse(req.body ?? {});
    if (!body.success) return reply.code(400).send({ error: 'bad name', reason: 'bad_name' });
    // Пробелы по краям и внутри схлопываем; пустое — то же, что «по умолчанию».
    const name = body.data.name === null ? null : body.data.name.replace(/\s+/g, ' ').trim();
    if (name !== null && name.length > GAME_TITLE_NAME_MAX) return reply.code(400).send({ error: 'bad name', reason: 'bad_name' });
    await renameGameTitle(serverId, titleId, name === '' ? null : name);
    return reply.send(await gameTitles(serverId, true));
  });

  const recapQuery = z.object({ kind: z.enum(['economy', 'games']), period: z.string().regex(PERIOD_ID).optional() });

  /** Замороженные «Итоги»: без `period` — последние своего вида. Нет — `{recap: null}`. */
  app.get('/servers/:id/economy/recap', async (req, reply) => {
    const { id: serverId } = params.parse(req.params);
    const query = recapQuery.safeParse(req.query ?? {});
    if (!query.success) return reply.code(400).send({ error: 'bad query' });
    const userId = req.user!.sub;
    const ctx = await getMemberContext(serverId, userId);
    if (!ctx) return reply.code(404).send({ error: 'not a member' });
    const economy = await economySeenBy(serverId, userId);
    if (!economy?.enabled) return reply.send({ recap: null });
    return reply.send({ recap: await frozenRecap(serverId, query.data.kind, query.data.period ?? null, userId) });
  });

  /**
   * Сухой прогон «Итогов» на текущих данных (`MANAGE_ECONOMY`, ничего не пишет). Без `period`: экономика — текущий сезон
   * сервера, игры — текущий месяц. Окно — от начала периода до сейчас (или до конца прошедшего периода).
   */
  app.get('/servers/:id/economy/recap/preview', async (req, reply) => {
    const { id: serverId } = params.parse(req.params);
    const query = recapQuery.safeParse(req.query ?? {});
    if (!query.success) return reply.code(400).send({ error: 'bad query' });
    const userId = req.user!.sub;
    const ctx = await getMemberContext(serverId, userId);
    if (!ctx) return reply.code(404).send({ error: 'not a member' });
    if (!has(ctx.serverPermissions, Permission.MANAGE_ECONOMY)) return reply.code(403).send({ error: 'forbidden' });
    const economy = await economySeenBy(serverId, userId);
    if (!economy?.enabled) return reply.send({ recap: null });
    const now = new Date();
    const { kind } = query.data;
    const period = query.data.period ?? (kind === 'games' ? gameMonthOf(now) : seasonId(now, economy.seasonLength));
    if (kind === 'games' && !MONTH_ID.test(period)) return reply.code(400).send({ error: 'bad query' });
    if (seasonRange(period).from > now) return reply.code(400).send({ error: 'bad query' });
    return reply.send({ recap: await previewRecap(serverId, kind, period, userId, now) });
  });
}
