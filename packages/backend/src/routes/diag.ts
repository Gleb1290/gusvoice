import type { FastifyInstance } from 'fastify';
import { requireAuth } from '../auth.js';
import { db } from '../db/index.js';
import { and, eq, gt, sql } from 'drizzle-orm';
import { diagReports } from '../db/schema.js';
import { id } from '../util.js';
import { diagReportTooBig } from '../diagRules.js';
import { parseDiagReport } from '../diagSchema.js';
import { BAD_PICTURE_PER_HOUR, isBadPictureBody, parseBadPicture } from '../diagBadPicture.js';

/**
 * Приём отчётов диагностики из клиента (#100).
 *
 * Появилось после двух неудачных подходов к тому же багу: сначала я просил людей вручную снимать
 * цифры в диспетчере задач (не приехало ни одного), потом дал PowerShell-скрипт (непонятно, как
 * запускать). Теперь отчёт собирает и отправляет само приложение — без спроса и без кнопки: кнопку
 * «Сломалось» за первые сутки не нажал ни один из четверых приславших отчёты, потому что баг отбирает
 * Alt+Tab, то есть саму возможность дойти до окна приложения. Отметка момента живёт на глобальном
 * хоткее, а сбор идёт всё время, пока человек в голосовом канале.
 */

export async function diagRoutes(app: FastifyInstance): Promise<void> {
  app.addHook('preHandler', requireAuth);

  app.post('/diag/report', async (req, reply) => {
    // «Плохая картинка» от зрителя (06.10, #207) — та же таблица, свой вид отчёта (`diagBadPicture.ts`).
    // Рядом со срезами показывающего: свести их — `scripts/ops/bad-picture.sh`.
    if (isBadPictureBody(req.body)) {
      const mark = parseBadPicture(req.body);
      if (!mark) return reply.code(400).send({ error: 'некорректная отметка' });
      const [{ count }] = await db
        .select({ count: sql<number>`count(*)::int` })
        .from(diagReports)
        .where(
          and(
            eq(diagReports.userId, req.user!.sub),
            eq(diagReports.kind, 'badpic'),
            gt(diagReports.createdAt, sql`now() - interval '1 hour'`),
          ),
        );
      if (count >= BAD_PICTURE_PER_HOUR) return reply.code(429).send({ error: 'слишком много отметок' });
      await db.insert(diagReports).values({ id: id(), userId: req.user!.sub, kind: 'badpic', payload: mark });
      return { ok: true };
    }

    // ⚠️ Великанов отсекаем ДО разбора, по сырым длинам. Раньше проверка стояла ПОСЛЕ, и ветка 413
    // была недостижима: потолок в самой схеме срабатывал раньше и отдавал 400 (нашёл Codex). Так
    // отсечение и дешевле — гигантский массив не разбирается впустую.
    const raw = req.body as { samples?: unknown[]; marks?: unknown[] } | null;
    if (diagReportTooBig(raw?.samples?.length ?? 0, raw?.marks?.length ?? 0)) {
      return reply.code(413).send({ error: 'отчёт слишком большой' });
    }

    const body = parseDiagReport(req.body);
    if (!body) return reply.code(400).send({ error: 'некорректный отчёт' });

    const { ok: samples, dropped, firstError } = body.samples;
    if (dropped > 0) {
      // Не молча и С ПРИЧИНОЙ. Счётчик без причины — тупик: видно, что данные теряются, и нельзя
      // понять почему. Ровно в такой тупик упёрлись 2026-08-22 на отчёте с 19 потерянными срезами.
      req.log.warn(
        { dropped, kept: samples.length, user: req.user!.sub, firstError },
        'diag: срезы отброшены',
      );
    }
    if (!samples.length && !body.marks.length) {
      return reply.code(400).send({ error: 'в отчёте не осталось ни одного годного среза' });
    }

    await db.insert(diagReports).values({
      id: id(),
      userId: req.user!.sub,
      kind: body.kind,
      // `samplesDropped` кладём в сам отчёт: при разборе сразу видно, что в нём дыра.
      // Причина едет в самом отчёте: разбирать потери по логам, которые ротируются, — плохая опора.
      payload: { ...body, samples, samplesDropped: dropped, samplesDropReason: firstError },
    });
    return { ok: true, dropped };
  });

  /**
   * Удалить ВСЕ свои отчёты (#113).
   *
   * Дешёвая кнопка, снимающая главный вопрос доверия: согласие ничего не стоит, если отозвать его
   * можно только на будущее. Удаляет строго по своему `user_id` — чужие отчёты этим маршрутом не
   * трогаются никак, даже супер-админом: для разбора чужих есть админ-панель, а это личная кнопка.
   */
  app.delete('/diag/mine', async (req) => {
    const gone = await db.delete(diagReports).where(eq(diagReports.userId, req.user!.sub)).returning({ id: diagReports.id });
    return { deleted: gone.length };
  });
}
