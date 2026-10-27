/**
 * Доставка событий на адрес бота (#229, `setWebhook`). По одному событию за запрос, строго по `update_id`: следующее — только
 * после 2xx на предыдущее (порядок как у Telegram). Тело — объект события провода (`{update_id, message: …}`), подпись —
 * `X-GusVoice-Signature: t=<unix>,v1=<hex HMAC-SHA256(secret, t + "." + body)>` (`botRules.webhookSignature`).
 *
 * Сбой (не 2xx, сеть, срок 10 с) — `webhook_failures + 1`, `webhook_last_error`, повтор через нарастающую паузу
 * (`webhookBackoffMs`); после `WEBHOOK_FAILURES_MAX` подряд — `webhook_disabled_at`: доставка стоит до нового `setWebhook`,
 * события копятся в журнале (24 ч). Успех обнуляет счётчик.
 *
 * Один доставщик на бота на весь кластер — замок в Redis (`SET NX PX`); таймеры повторов живут в процессе, после перезапуска
 * их подбирает обход раз в минуту (`startBotJobs`). 🔴 SSRF — `safeFetch.safeHookPost`: https (http — только с тумблером
 * админа), каждый адрес имени проверен и соединение на проверенный IP, без редиректов, ответ ≤ 4 КБ.
 */
import { and, eq, isNotNull, isNull, sql } from 'drizzle-orm';
import { db } from '../db/index.js';
import { bots, users } from '../db/schema.js';
import { safeHookPost } from '../safeFetch.js';
import {
  CALLBACK_QUERY_STALE_S,
  WEBHOOK_FAILURES_MAX,
  WEBHOOK_RESPONSE_MAX,
  WEBHOOK_TIMEOUT_MS,
  webhookBackoffMs,
  webhookErrorText,
  webhookSignature,
  unixSeconds,
} from './botRules.js';
import { markTakenRead } from './botRead.js';
import { botById, type BotUpdateRow, pruneBotUpdates, readBotSettings, updatesFrom, wireUpdateOf } from './botStore.js';

const running = new Set<string>();
const again = new Set<string>();
const retryTimers = new Map<string, NodeJS.Timeout>();
const LOCK_MS = 60_000;

/** Разбудить доставку бота (новое событие, новый адрес). Без адреса / выключена — ничего. */
export function kickWebhook(botId: string): void {
  if (running.has(botId)) {
    again.add(botId);
    return;
  }
  running.add(botId);
  void deliverLoop(botId)
    .catch((err) => console.warn(`[bots] доставка ${botId}:`, err instanceof Error ? err.message : err))
    .finally(() => {
      running.delete(botId);
      if (again.delete(botId)) kickWebhook(botId);
    });
}

/** Забыть отложенный повтор (адрес сменили/сняли — новый адрес начинает с чистого листа). */
export function resetWebhookRetry(botId: string): void {
  const t = retryTimers.get(botId);
  if (t) clearTimeout(t);
  retryTimers.delete(botId);
}

/** Событий в одном POST пакетной доставки (#231). */
const WEBHOOK_BATCH_MAX = 100;

async function deliverLoop(botId: string): Promise<void> {
  if (retryTimers.has(botId)) return; // ждём паузу после сбоя — повтор сам позовёт
  const { redisPub } = await import('../realtime.js');
  const lockKey = `bot:wh:lock:${botId}`;
  const got = await redisPub.set(lockKey, '1', 'PX', LOCK_MS, 'NX');
  if (got !== 'OK') return; // доставляет другой процесс
  // Принятые адресом (2xx) события — «прочитано» одной отметкой на беседу при выходе из цикла, а не на каждое событие.
  const taken: BotUpdateRow[] = [];
  try {
    for (;;) {
      const row = await botById(botId);
      if (!row || row.user.deletedAt || row.bot.disabledAt || !row.bot.webhookUrl || !row.bot.webhookSecret || row.bot.webhookDisabledAt) return;
      const settings = await readBotSettings();
      if (!settings.enabled) return;
      // Пакетная доставка (#231, `setWebhook batch=true`): тело — МАССИВ до 100 событий, подпись по всему телу; 2xx
      // подтверждает всю пачку, не-2xx — вся пачка повторяется (at-least-once). Без флага — по одному объекту, как раньше.
      const batch = row.bot.webhookBatch === true;
      const pack = await updatesFrom(botId, 0, batch ? WEBHOOK_BATCH_MAX : 1);
      const next = pack[0];
      if (!next) return;
      await redisPub.pexpire(lockKey, LOCK_MS);
      const body = JSON.stringify(batch ? pack.map(wireUpdateOf) : wireUpdateOf(next));
      let failure: string | null = null;
      try {
        const res = await safeHookPost(
          row.bot.webhookUrl,
          Buffer.from(body, 'utf8'),
          {
            'content-type': 'application/json',
            'user-agent': 'GusVoice-Bot-Webhook/1',
            'x-gusvoice-signature': webhookSignature(row.bot.webhookSecret, body, unixSeconds(Date.now())),
          },
          { allowInternal: settings.allowInternalWebhooks, deadlineMs: WEBHOOK_TIMEOUT_MS, maxBytes: WEBHOOK_RESPONSE_MAX },
        );
        if (res.status < 200 || res.status >= 300) failure = webhookErrorText({ status: res.status });
      } catch (err) {
        failure = webhookErrorText({ error: err });
      }
      // Адрес могли сменить, пока шёл запрос: итог относится к старому — не трогаем ни журнал, ни счётчик.
      const [now] = await db.select({ url: bots.webhookUrl }).from(bots).where(eq(bots.userId, botId)).limit(1);
      if (now?.url !== row.bot.webhookUrl) continue;
      if (!failure) {
        if (batch) {
          await db.execute(sql`DELETE FROM bot_updates WHERE update_id IN (${sql.join(pack.map((u) => sql`${u.updateId}`), sql`, `)})`);
          taken.push(...pack);
        } else {
          await db.execute(sql`DELETE FROM bot_updates WHERE update_id = ${next.updateId}`);
          taken.push(next);
        }
        if (row.bot.webhookFailures > 0 || row.bot.webhookLastError) {
          await db.update(bots).set({ webhookFailures: 0, webhookLastError: null }).where(eq(bots.userId, botId));
        }
        continue;
      }
      const failures = row.bot.webhookFailures + 1;
      const off = failures >= WEBHOOK_FAILURES_MAX;
      await db
        .update(bots)
        .set({ webhookFailures: failures, webhookLastError: failure, webhookLastErrorAt: new Date(), ...(off ? { webhookDisabledAt: new Date() } : {}) })
        .where(eq(bots.userId, botId));
      if (!off) {
        const t = setTimeout(() => {
          retryTimers.delete(botId);
          kickWebhook(botId);
        }, webhookBackoffMs(failures));
        t.unref();
        retryTimers.set(botId, t);
      }
      return;
    }
  } finally {
    if (taken.length > 0) await markTakenRead(botId, taken).catch(() => {});
    await redisPub.del(lockKey).catch(() => 0);
  }
}

/**
 * Фон ботов: раз в минуту — доставка тем, у кого есть адрес и ждут события (подбирает повторы после перезапуска и упавшие
 * замки), раз в час — уборка журнала (24 ч, потолок на бота).
 */
export function startBotJobs(): void {
  const sweep = async () => {
    try {
      const rows = await db
        .select({ id: bots.userId, failures: bots.webhookFailures, at: bots.webhookLastErrorAt })
        .from(bots)
        .innerJoin(users, eq(users.id, bots.userId))
        .where(
          and(
            isNotNull(bots.webhookUrl),
            isNull(bots.webhookDisabledAt),
            isNull(bots.disabledAt),
            isNull(users.deletedAt),
            // Протухшее нажатие (`notStale` журнала, аудит 26.10) — не повод будить доставку: отдавать его всё равно не будем.
            sql`EXISTS (SELECT 1 FROM bot_updates u WHERE u.bot_id = ${bots.userId}
              AND (u.type <> 'callback_query' OR u.created_at >= now() - make_interval(secs => ${CALLBACK_QUERY_STALE_S})))`,
          ),
        );
      const now = Date.now();
      for (const r of rows) {
        if (retryTimers.has(r.id)) continue;
        if (r.failures > 0 && r.at && now - r.at.getTime() < webhookBackoffMs(r.failures)) continue;
        kickWebhook(r.id);
      }
    } catch (err) {
      console.warn('[bots] обход доставки:', err instanceof Error ? err.message : err);
    }
    // Этап 4 (#232): страховка голоса — боты, которым больше нельзя в канал, и одинокие дольше 5 минут выкидываются. Лениво:
    // модуль голоса тянет LiveKit; ошибки обход ловит и пишет сам.
    await import('./botVoice.js').then((m) => m.sweepBotVoice(), () => undefined);
  };
  const prune = async () => {
    try {
      const n = await pruneBotUpdates();
      if (n > 0) console.log(`[bots] убрано ${n} старых событий ботов`);
    } catch (err) {
      console.warn('[bots] уборка журнала:', err instanceof Error ? err.message : err);
    }
  };
  void prune();
  setInterval(sweep, 60_000).unref();
  setInterval(prune, 60 * 60_000).unref();
}
