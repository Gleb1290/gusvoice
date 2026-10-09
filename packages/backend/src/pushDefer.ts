import { and, eq } from 'drizzle-orm';
import { db } from './db/index.js';
import { conversationMembers, conversationMessages } from './db/schema.js';
import type { PushPayload, PushSource } from './push.js';
import { deferredPushRead, PUSH_DEFER_MS } from './pushRules.js';
import { redisPub as redis } from './realtime.js';

/**
 * Отложенный пуш на телефон, пока человек за ПК (08.10, #211, G38, признак `push2`).
 *
 * Как у Telegram: пока жив другой клиент, уведомление ждёт 30 с (`notifyCloudDelay`) — человек успевает прочитать
 * сообщение на ПК, и телефон молчит. Здесь то же на сервере: пуш ЛС получателю, у которого есть соединение шлюза с
 * признаком жизни (`gateway.ts`, кадр `active`), кладётся в Redis со сроком; через 30 с такт смотрит «прочитано до»
 * получателя в беседе и шлёт пуш, только если сообщение так и не прочитано.
 *
 * Очередь — в Redis (сортированное множество по сроку + сами пуши в хеше), а не в таймере процесса: перезапуск бэкенда
 * её не теряет, и после старта первый же такт досылает просроченное («недостающий придёт»). Лишнего не будет: пуш
 * забирает тот, чей атомарный забор (`CLAIM_LUA`) его вернул, и прочитанное не уходит. Остаётся окно «забрали и упали до отправки» — этот пуш
 * теряется (сообщение при этом уже доставлено по сокетам).
 */
const ZKEY = 'push:defer';
const HKEY = 'push:defer:item';
const TICK_MS = 2000;
const BATCH = 100;

export interface DeferredPush {
  uid: string;
  payload: PushPayload;
  source?: PushSource;
  /** Пуш личной беседы 1:1 (`sendPushToUsers` `opts.private`): к нему применяются «Личные сообщения» и повтор. */
  private?: true;
  /** Номер повтора (G38, `push3`): у пуша из очереди «повторить через N минут» — сколько раз он уже повторён. */
  repeat?: number;
  /**
   * Когда ушёл первый пуш этой цепочки повторов (мс, `Date.now()`; ревью Codex 08.10): по нему `push.ts` держит окно «сутки от
   * первого пуша» (`notifyRepeatInWindow`) и при переносах за ПК. Поле добавлено позже — у старых записей очереди его нет,
   * такой повтор считается от текущего такта.
   */
  firstAt?: number;
}

/** Кто сейчас за устройством — ставит `index.ts` (`gateway.isUserActive`); по умолчанию никто (откладывать нечего). */
let activeProbe: (userId: string) => boolean = () => false;
export function setPushActivityProbe(fn: (userId: string) => boolean): void {
  activeProbe = fn;
}
export function recipientActive(userId: string): boolean {
  try {
    return activeProbe(userId);
  } catch {
    return false;
  }
}

/** Положить пуш в очередь на `PUSH_DEFER_MS`. Ошибка Redis — наверх: вызывающий пошлёт пуш сразу. */
export async function deferPush(item: DeferredPush, now = Date.now()): Promise<void> {
  const id = `${item.uid}:${item.payload.mid ?? item.payload.key ?? ''}:${now}:${Math.random().toString(36).slice(2, 8)}`;
  await redis
    .multi()
    .hset(HKEY, id, JSON.stringify(item))
    .zadd(ZKEY, now + PUSH_DEFER_MS, id)
    .exec();
}

/**
 * Поставить повтор пуша висящей беседы через `minutes` (G38, `push3`, Android «Повторять уведомления»). Ключ — «получатель ×
 * беседа»: новое сообщение ПЕРЕПИСЫВАЕТ ещё не отправленный повтор (один повтор на беседу за интервал, с самым свежим
 * сообщением) и сдвигает срок. Прочитанное снимает `runPushDeferTick`. Ошибка Redis не мешает — повтор просто не будет.
 */
export async function scheduleRepeatPush(item: DeferredPush, minutes: number, now = Date.now()): Promise<void> {
  const id = `rep:${item.uid}:${item.payload.dmId ?? ''}`;
  try {
    await redis
      .multi()
      .hset(HKEY, id, JSON.stringify(item))
      .zadd(ZKEY, now + minutes * 60_000, id)
      .exec();
  } catch {
    /* повтор — удобство, не гарантия */
  }
}

/**
 * Отложить повтор, пока получатель за ПК (08.10, решение владельца 14; `push.ts` `sendPushToUsers` с `opts.repeat`): тот же ключ
 * `rep:<uid>:<беседа>`, срок — `PUSH_DEFER_MS`, как у первого пуша при живом ПК; такт проверит снова (прочитано — снимет). Не
 * перезаписывает: если новое сообщение уже поставило свежий повтор этой беседы, остаётся он (`HSETNX` + `ZADD NX`). Ошибка
 * Redis — наверх: вызывающий пошлёт повтор сразу, как раньше.
 */
export async function postponeRepeatPush(item: DeferredPush, now = Date.now(), delayMs = PUSH_DEFER_MS): Promise<void> {
  const id = `rep:${item.uid}:${item.payload.dmId ?? ''}`;
  await redis
    .multi()
    .hsetnx(HKEY, id, JSON.stringify(item))
    .zadd(ZKEY, 'NX', now + delayMs, id)
    .exec();
}

/** Прочитал ли получатель сообщение отложенного пуша (`conversation_members.last_read_key`). */
async function alreadyRead(item: DeferredPush): Promise<boolean> {
  const key = item.payload.key;
  if (!item.payload.dmId || typeof key !== 'number') return false;
  const [row] = await db
    .select({ k: conversationMembers.lastReadKey })
    .from(conversationMembers)
    .where(and(eq(conversationMembers.conversationId, item.payload.dmId), eq(conversationMembers.userId, item.uid)))
    .limit(1);
  return deferredPushRead(row?.k, key);
}

/**
 * Сообщение отложенного пуша или повтора удалено (у всех или «у меня» получателя) — пуш не шлём (ревью 08.10: повтор
 * «Повторять уведомления» через минуты и часы показывал текст удалённого сообщения; Telegram удалённое из уведомлений
 * убирает). Пуш без `mid` (старый формат очереди) — как раньше.
 */
async function messageGone(item: DeferredPush): Promise<boolean> {
  const mid = item.payload.mid;
  if (!mid) return false;
  const [row] = await db
    .select({ deletedAt: conversationMessages.deletedAt, hiddenFor: conversationMessages.hiddenFor })
    .from(conversationMessages)
    .where(eq(conversationMessages.id, mid))
    .limit(1);
  return !row || row.deletedAt !== null || row.hiddenFor.includes(item.uid);
}

/**
 * Забор созревшего пуша одной командой Redis (ревью Codex 08.10): срок члена ещё ≤ `now` → `ZREM` + `HGET` + `HDEL` вместе,
 * иначе — ничего. Раньше это были три команды подряд, и `scheduleRepeatPush` того же ключа `rep:` между ними ставил новый
 * пуш и срок: старый такт читал НОВЫЙ пуш, стирал его и слал раньше срока, а новый срок в множестве оставался без пуша.
 * Член, перепоставленный на будущее, скрипт не трогает; между двумя тактами (или процессами) пуш получает только один.
 * Возвращает пуш (JSON) или `null` (не созрел, уже забран, пуша в хеше нет).
 */
const CLAIM_LUA = `
local s = redis.call('ZSCORE', KEYS[1], ARGV[1])
if not s or tonumber(s) > tonumber(ARGV[2]) then return false end
redis.call('ZREM', KEYS[1], ARGV[1])
local v = redis.call('HGET', KEYS[2], ARGV[1])
redis.call('HDEL', KEYS[2], ARGV[1])
return v
`;

async function claimDue(id: string, now: number): Promise<string | null> {
  const v = (await redis.eval(CLAIM_LUA, 2, ZKEY, HKEY, id, String(now))) as string | null;
  return typeof v === 'string' ? v : null;
}

/** Один такт: забрать созревшие пуши и послать непрочитанные. Возвращает, сколько ушло и сколько снято прочтением. */
export async function runPushDeferTick(
  send: (item: DeferredPush) => Promise<void>,
  now = Date.now(),
): Promise<{ sent: number; read: number }> {
  const due = await redis.zrangebyscore(ZKEY, 0, now, 'LIMIT', 0, BATCH);
  let sent = 0;
  let read = 0;
  for (const id of due) {
    // Забирает тот, кому скрипт вернул пуш: второй такт (или второй процесс) его уже не пошлёт, перепоставленный — не тронут.
    const raw = await claimDue(id, now);
    if (!raw) continue;
    let item: DeferredPush;
    try {
      item = JSON.parse(raw) as DeferredPush;
    } catch {
      continue;
    }
    try {
      if ((await alreadyRead(item)) || (await messageGone(item))) {
        read++;
        continue;
      }
      await send(item);
      sent++;
    } catch {
      /* best-effort, как и сам пуш */
    }
  }
  return { sent, read };
}

export function startPushDeferWorker(send: (item: DeferredPush) => Promise<void>): void {
  let running = false;
  const timer = setInterval(() => {
    if (running) return;
    running = true;
    void runPushDeferTick(send)
      .then((r) => {
        if (r.sent > 0 || r.read > 0) console.log(`[push] отложенные: ушло ${r.sent}, снято прочтением ${r.read}`);
      })
      .catch((err: unknown) => {
        console.warn(`[push] такт отложенных упал: ${err instanceof Error ? err.message : String(err)}`);
      })
      .finally(() => {
        running = false;
      });
  }, TICK_MS);
  timer.unref();
}
