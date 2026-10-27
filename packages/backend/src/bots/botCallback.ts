/**
 * Нажатие кнопки под сообщением бота (#230, этап 2) — Redis: запрос нажатия, ответ бота, счётчики висящих.
 *
 * Модель — долгий HTTP человека (`routes/botPress.ts`): запрос нажатия живёт в Redis `bot:cbq:<id>` `CALLBACK_QUERY_TTL_S`,
 * бот отвечает `answerCallbackQuery` ОДИН раз (DEL возвращает 1 только первому) → ответ в `bot:cbqa:<id>`, его забирает
 * ожидающий запрос человека опросом (`CALLBACK_POLL_MS`). Проще pub/sub и без гонок подписки (`botStore.ts` будильник);
 * опрос ограничен пределами нажатий. Нажатие в базе не хранится.
 */
import { randomBytes } from 'node:crypto';
import { redisPub } from '../realtime.js';
import { CALLBACK_PENDING_TTL_S, CALLBACK_POLL_MS, CALLBACK_QUERY_TTL_S } from './botRules.js';

export interface CallbackQueryRecord {
  botId: string;
  userId: string;
  /** Беседа 1:1 (этап 2) — пустая строка у нажатия в канале. */
  conversationId: string;
  messageId: string;
  /** Нажатие в канале сервера (#231): ответ принимается, только пока бот на этом сервере. */
  channelId?: string;
  serverId?: string;
}
export interface CallbackAnswer {
  text?: string;
  alert?: true;
}

const queryKey = (id: string) => `bot:cbq:${id}`;
const answerKey = (id: string) => `bot:cbqa:${id}`;

/** Новый запрос нажатия: `cbq_` + 16 случайных байт base64url (22 знака). */
export async function createCallbackQuery(rec: CallbackQueryRecord): Promise<string> {
  const id = `cbq_${randomBytes(16).toString('base64url')}`;
  await redisPub.set(queryKey(id), JSON.stringify(rec), 'EX', CALLBACK_QUERY_TTL_S);
  return id;
}

/**
 * Ответ бота. `false` — нет такого запроса, он чужого бота, просрочен или уже отвечен (провод отвечает «query is too old…»).
 * Сверка владельца ДО удаления: чужой бот не может «съесть» запрос другого.
 */
export async function answerCallbackQuery(botId: string, id: string, answer: CallbackAnswer): Promise<boolean> {
  const raw = await redisPub.get(queryKey(id));
  if (!raw) return false;
  let rec: CallbackQueryRecord;
  try {
    rec = JSON.parse(raw) as CallbackQueryRecord;
  } catch {
    return false;
  }
  if (rec.botId !== botId) return false;
  // Канал (#231): бота сняли с сервера — висящее нажатие «too old» (решение владельца: снятие чистит подписки).
  if (rec.serverId && !(await stillOnServer(rec.serverId, botId))) return false;
  // Один ответ: DEL отдаёт 1 только первому из параллельных.
  if ((await redisPub.del(queryKey(id))) !== 1) return false;
  await redisPub.set(answerKey(id), JSON.stringify(answer), 'EX', CALLBACK_QUERY_TTL_S);
  return true;
}

/** Бот ещё на сервере (#231) — лениво, у модуля узкий перечень импортов. */
async function stillOnServer(serverId: string, botId: string): Promise<boolean> {
  const { botOnServer } = await import('./botChannel.js');
  return botOnServer(botId, serverId);
}

/** Ждать ответ бота до `ms` (или обрыва запроса человека). `null` — не ответил. */
export async function waitCallbackAnswer(id: string, ms: number, signal?: AbortSignal): Promise<CallbackAnswer | null> {
  const deadline = Date.now() + ms;
  for (;;) {
    const raw = await redisPub.get(answerKey(id));
    if (raw) {
      await redisPub.del(answerKey(id)).catch(() => 0);
      try {
        const a = JSON.parse(raw) as CallbackAnswer;
        return { ...(typeof a.text === 'string' && a.text ? { text: a.text } : {}), ...(a.alert === true ? { alert: true as const } : {}) };
      } catch {
        return {};
      }
    }
    const left = deadline - Date.now();
    if (left <= 0 || signal?.aborted) return null;
    await new Promise((res) => setTimeout(res, Math.min(CALLBACK_POLL_MS, left)));
  }
}

/**
 * Занять место висящего нажатия (`key` — человек или бот): больше `max` одновременно — отказ (`false`, место не занято).
 * Счётчик живёт с запасом на TTL запроса — сбой процесса посреди ожидания не держит место вечно.
 */
export async function acquirePending(key: string, max: number): Promise<boolean> {
  const k = `bot:cbqn:${key}`;
  const n = await redisPub.incr(k);
  await redisPub.expire(k, CALLBACK_PENDING_TTL_S);
  if (n > max) {
    await redisPub.decr(k).catch(() => 0);
    return false;
  }
  return true;
}

export async function releasePending(key: string): Promise<void> {
  await redisPub.decr(`bot:cbqn:${key}`).catch(() => 0);
}
