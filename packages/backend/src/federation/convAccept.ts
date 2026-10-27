/**
 * ЛС между инстансами, этап Э2 (#141, `docs/dm/FEDERATION.md` §3.2–3.4, §3.8): звонок в дверь и приём копии на доме
 * получателя.
 *
 * Отдающая сторона пишет журнал на связку (`convChanges.recordFedConvChanges`, только записи наших владельцев) и после
 * записи звонит соседу событием `conv.changed {seq}` (`ringDoorbell`, через существующий канал событий). Получатель
 * забирает `GET /fed/v1/conv/changes?since=<курсор>` (`pullConvChanges`) и применяет каждую строку к своей копии:
 * - `msg` — создание (глобальный id, `origin_sort_key` источника, СВОЙ `sort_key` — порядок по приходу, Ф9), правка
 *   (побеждает бо́льшая `edit_version` владельца), надгробие (монотонно; Ф8 — наш человек удалил чужое у обоих в 1:1);
 * - `react` — итог реакций людей соседа на сообщение; `read` — «прочитано до» по id сообщения → свой ключ (✓✓ у автора);
 * - `pin` — закреп «у обоих» сообщения.
 * Новое сообщение будит получателя обычным пушем по своей копии (`fanOutSend`, как местное) — через дом автора ничего.
 *
 * 🔴 Звонок отдаётся ДО фиксации транзакции отдающего (крючок в журнале) — поэтому он отложен и несёт номер, а получатель,
 * не найдя этот номер в журнале, повторяет забор с паузой. Потерянный звонок лечит периодический забор (`startConvPull`:
 * при старте и раз в `PULL_EVERY_MS`) — он же «забор при восстановлении связи».
 * 🔴 Приём пишет журнал местным людям с `{ fed: false }`: чужое не уходит эхом обратно. Своё (записи наших людей) от
 * соседа не принимается никогда, кроме надгробия в 1:1 (Ф8).
 */
import { and, eq, gt, inArray, isNull, lte, ne, sql } from 'drizzle-orm';
import {
  convMediaPreview,
  FED_CONV_CHANGE,
  FED_CONV_CHANGE_E2,
  FED_CONV_CHANGED_EVENT,
  FED_CONV_GROUPS_PATH,
  FED_FEATURES,
  fedConvExportPath,
  isListenable,
  isRoundVideo,
  parseConvListenWire,
  ROUND_ONCE_SPENT_TEXT,
  VOICE_ONCE_SPENT_TEXT,
  parseConvChangedPayload,
  parseConvChangesPage,
  parseConvExportPage,
  parseConvGroupsList,
  parseConvMessageWire,
  parseConvPinWire,
  parseConvPollVotesWire,
  parseConvReactionsWire,
  parseConvReadsWire,
  type Attachment,
  type ConvServiceMark,
  type FedConvAttachmentWire,
  type FedConvMessageWire,
  type FedPersonRef,
  type MessageForwardedFrom,
  type MessageSticker,
} from '@gusvoice/shared';
import { convMediaFromWire, deliver, fedRecordRelay, journal, journalPins, lockConversation, msgEntries, removePins, unarchiveOnMessage, type Delivery } from '../conversations.js';
import { changeAudience, removedByEdit } from '../convRules.js';
import { fanOutSend } from '../convSendFanout.js';
import { db } from '../db/index.js';
import {
  attachments,
  conversationMembers,
  conversationMessageReactions,
  conversationMessages,
  conversationPins,
  conversationVoiceListens,
  conversations,
  convPollVotes,
  fedConvCursor,
  federationLinks,
  userBlocks,
  users,
} from '../db/schema.js';
import { notePeerAnswer, onLinkRestored } from './convLink.js';
import { onFedEvent, sendEventTo } from './eventStream.js';
import { federation } from './instance.js';
import { getSignedFromPeer } from './peerClient.js';

type Tx = Parameters<Parameters<typeof db.transaction>[0]>[0];

/** Периодический забор у всех связок с `dm1` — страховка потерянного звонка и «сосед поднялся». */
const PULL_EVERY_MS = 2 * 60_000;
/** Предел страниц за один заход: сосед с ошибкой может отдавать `more` бесконечно. */
const PULL_MAX_PAGES = 50;
/** Звонок пришёл, а номера в журнале ещё нет (транзакция отдающего не зафиксирована) — повторить через 1, 2, 3 с. */
const PULL_RETRIES = 3;
/** Предел страниц полного прохода по одной беседе (по 100 сообщений): сосед с ошибкой может отдавать `next` бесконечно. */
const EXPORT_MAX_PAGES = 1000;

/**
 * Текст копии сообщения, у которого были только вложения (до Э3 файлы между инстансами не ездят: отправка с файлом в такую
 * беседу отказывает, но сосед новее нас может прислать): пузырь не пустой и честно говорит, что там было.
 */
export const FED_ATTACHMENTS_LATER_TEXT = '📎 Вложение — будет доступно в следующем обновлении';

/**
 * Э3 часть 1 (#141): вложения копий — `federation/convAtt.ts`. Подключает `index.ts` (`configureFedConvAttachments`), а не
 * импорт: этот модуль проверки собирают с явным перечнем зависимостей. Не подключено — копия с файлами пишется, как в Э2
 * (текст + заглушка), и надгробие файлов копий не стирает (их подберёт часовая уборка).
 */
export interface FedConvAttachmentHooks {
  remoteFor(
    tx: Tx,
    input: { conversationId: string; ownerId: string; messageId: string; origin: string; list: readonly FedConvAttachmentWire[] },
  ): Promise<Attachment[]>;
  kick(origin: string): void;
  purge(keys: readonly string[]): void;
}
let attHooks: FedConvAttachmentHooks | null = null;
export function configureFedConvAttachments(hooks: FedConvAttachmentHooks | null): void {
  attHooks = hooks;
}

/**
 * Э6 (#141): копия записи о звонке (`service.kind = call`) — как местная (`calls.record`): пропущенный будит пушем, остальное
 * тихо и сразу «прочитано» получателем. Подключает `index.ts` (`federation/dmCalls.ts`), а не импорт — перечень зависимостей.
 */
export interface FedCallRecordHooks {
  plan(service: { kind?: unknown; reason?: unknown }): { notify: boolean; silent: boolean; markRead: boolean } | null;
  read(conversationId: string, recipientId: string, sortKey: number): Promise<void>;
}
let callRecordHooks: FedCallRecordHooks | null = null;

/**
 * «Кто может мне писать» (13.10, #218, `msgpriv1`): пускает ли наш человек `recipientId` сообщения автора `authorId` (человека
 * соседа). Нет — новое сообщение беседы 1:1 ложится скрытым (`withheld`), как от заблокированного: получатель его не видит, пуша
 * нет, а строка журнала применена (правки и удаления этого сообщения дальше не застревают). Отправитель узнаёт об отказе заранее —
 * присутствием (`dmEphemeral`, `noMessages`). Подключает `index.ts` (`messagePrivacy.messageAllowedFor`) — перечень зависимостей.
 */
let messageGate: ((authorId: string, recipientId: string) => Promise<boolean>) | null = null;
export function configureFedMessagePrivacy(fn: ((authorId: string, recipientId: string) => Promise<boolean>) | null): void {
  messageGate = fn;
}
export function configureFedCallRecord(hooks: FedCallRecordHooks | null): void {
  callRecordHooks = hooks;
}

/**
 * Э7 часть 1 (#141, §3.6): группы со смешанным составом. Строка `conv` группы от её дома (хоста) — завести/обновить группу и
 * состав (`federation/convGroup.applyGroupConv`); подпись дома автора на сообщении — `verify` (цепочка «корневой ключ →
 * `instance_id` автора», без связки с его домом). Подключает `index.ts`, а не импорт — перечень зависимостей модуля.
 */
export interface FedGroupAcceptHooks {
  applyConv(peer: string, self: string, conversationId: string, entity: Record<string, unknown>): Promise<void>;
  verify(w: FedConvMessageWire, entity: Record<string, unknown>): boolean;
}
let groupHooks: FedGroupAcceptHooks | null = null;
export function configureFedGroupAccept(hooks: FedGroupAcceptHooks | null): void {
  groupHooks = hooks;
}

// ─── Звонок в дверь (отдающая сторона) ───────────────────────────────────────────────────────────────────────────────

const pendingRing = new Map<string, number>();
let ringTimer: ReturnType<typeof setTimeout> | null = null;

/** Крючок журнала (`convChanges.configureFedConvDoorbell`): звонок соседу с номером последней строки — пачкой раз в 300 мс. */
export function ringDoorbell(instanceId: string, seq: number): void {
  pendingRing.set(instanceId, Math.max(pendingRing.get(instanceId) ?? 0, seq));
  if (ringTimer) return;
  ringTimer = setTimeout(() => {
    ringTimer = null;
    const list = [...pendingRing];
    pendingRing.clear();
    for (const [id, s] of list) void sendEventTo(id, FED_CONV_CHANGED_EVENT, { seq: s }).catch(() => {});
  }, 300);
}

// ─── Забор (получатель) ──────────────────────────────────────────────────────────────────────────────────────────────

const running = new Set<string>();
const again = new Set<string>();
const wanted = new Map<string, number>();

/**
 * Исправления ревью 12.10, п. 2 (б): строка журнала, которая не применилась (ошибка, беседы у нас ещё нет, вложения без
 * `dm2` в строке связки), держит курсор — страница останавливается на ней, следующий заход повторит. Попыток —
 * `ROW_TRIES`, считаются не чаще раза в `ROW_TRY_SPACING_MS` (повторы звонка через 1–3 с их не сжигают); последняя
 * неудачная — строка пропускается с предупреждением в журнал процесса, чтобы одна битая строка не держала связку вечно.
 */
const ROW_TRIES = 5;
const ROW_TRY_SPACING_MS = 30_000;
const rowTries = new Map<string, { n: number; at: number }>();
/** Связки, чей забор остановился на неприменённой строке: повтор через `ROW_TRY_SPACING_MS` (`pullLoop`). */
const stalled = new Set<string>();
/** п. 1: сосед ответил 429 — забор и полный проход ждут до этого времени (`retry-after`, без заголовка — минута). */
const pausedUntil = new Map<string, number>();
/**
 * п. 1: полный проход не начинается заново после 429 / обрыва: голова журнала на момент НАЧАЛА прохода, пройденные беседы,
 * страница текущей. Курсор после прохода встаёт на эту голову — изменения во время прохода приедут журналом.
 */
const passProgress = new Map<string, { head: number; done: Set<string>; cid: string | null; after: string | null; seen?: SeenMarks | null }>();
/** п. 2 (а): беседы, строку `conv` которых мы отклонили (политика, блокировка): их строки пропускаются без повторов. */
const refusedConvs = new Set<string>();

/**
 * п. 2 (а): строка `conv` (беседа целиком) — завести 1:1 с этим id по правилам `conv.open` (`federation/convOpen.ts`
 * `acceptConvRow`). Подключает `index.ts`, а не импорт: модуль проверки собирают с явным перечнем зависимостей. Ответ:
 * `true` — беседа есть (была или заведена), `false` — отказ (не заводим, строки беседы пропускаются).
 */
let convRowHook: ((peer: string, self: string, conversationId: string, entity: Record<string, unknown>) => Promise<boolean>) | null = null;
export function configureFedConvRow(fn: typeof convRowHook): void {
  convRowHook = fn;
}

/**
 * п. 5, п. 10: принудительно перечитать визитку соседа (`directorySync.refreshCapabilities` с `force`, свой предел раз в
 * минуту на связку) — в строке связки нет `dm1` (пришёл звонок / забор) или `dm2` (пришла копия с вложениями). Подключает
 * `index.ts`. Ответ — признаки после перечитывания.
 */
let capsHook: ((link: { instanceId: string; apiBase: string; features: string[] }) => Promise<string[]>) | null = null;
export function configureFedConvCaps(fn: typeof capsHook): void {
  capsHook = fn;
}

/** Копия с вложениями, а в строке связки нет `dm2`: перечитать визитку и повторить строку позже (п. 5). */
class NeedsFilesFeature extends Error {}

/** Забрать журнал соседа (одиночка на связку): звонок с номером `atLeast`, периодический забор — без номера. */
export function schedulePull(instanceId: string, atLeast = 0): void {
  wanted.set(instanceId, Math.max(wanted.get(instanceId) ?? 0, atLeast));
  if (running.has(instanceId)) {
    again.add(instanceId);
    return;
  }
  running.add(instanceId);
  void pullLoop(instanceId)
    .catch((err) => console.warn(`[fed-dm] забор у ${instanceId} упал: ${err instanceof Error ? err.message : err}`))
    .finally(() => {
      running.delete(instanceId);
      if (again.delete(instanceId)) schedulePull(instanceId);
      else if (stalled.has(instanceId)) {
        // Строка не применилась — повтор через паузу (п. 2 (б)), а не через 2 минуты периодического забора.
        setTimeout(() => schedulePull(instanceId), ROW_TRY_SPACING_MS).unref?.();
      }
    });
}

async function pullLoop(instanceId: string): Promise<void> {
  for (let attempt = 0; attempt <= PULL_RETRIES; attempt += 1) {
    const cursor = await pullConvChanges(instanceId);
    if (cursor === null || stalled.has(instanceId)) return;
    if (cursor >= (wanted.get(instanceId) ?? 0)) {
      wanted.delete(instanceId);
      return;
    }
    await new Promise((r) => setTimeout(r, 1000 * (attempt + 1)));
  }
  wanted.delete(instanceId);
}

function notePause(instanceId: string, retryAfterS: number | undefined): void {
  const s = retryAfterS !== undefined && retryAfterS > 0 ? Math.min(retryAfterS, 3600) : 60;
  pausedUntil.set(instanceId, Date.now() + s * 1000);
  console.warn(`[fed-dm] ${instanceId} ответил 429 на забор журнала — пауза ${s} с`);
}

/** Попытка строки `seq` не удалась: номер попытки (с учётом `ROW_TRY_SPACING_MS`). */
function bumpTry(instanceId: string, seq: number): number {
  const k = `${instanceId}|${seq}`;
  const now = Date.now();
  const cur = rowTries.get(k);
  if (!cur) {
    rowTries.set(k, { n: 1, at: now });
    return 1;
  }
  if (now - cur.at >= ROW_TRY_SPACING_MS) {
    cur.n += 1;
    cur.at = now;
  }
  return cur.n;
}

/** Забыть попытки строк этой связки не дальше `seq` (курсор ушёл вперёд). */
function forgetTries(instanceId: string, seq: number): void {
  for (const k of rowTries.keys()) {
    const [id, s] = k.split('|');
    if (id === instanceId && Number(s) <= seq) rowTries.delete(k);
  }
}

async function saveCursor(instanceId: string, since: number): Promise<void> {
  await db
    .insert(fedConvCursor)
    .values({ instanceId, since })
    .onConflictDoUpdate({ target: fedConvCursor.instanceId, set: { since, updatedAt: new Date() } });
}

/**
 * Один заход забора: страницы журнала соседа от курсора `fed_conv_cursor`, каждая строка применяется своей транзакцией,
 * курсор двигается после страницы — но не дальше первой неприменённой строки (п. 2 (б), `ROW_TRIES`). `null` — сходить не
 * удалось (связки нет, нет `dm1` и после перечитывания визитки, сосед лежит, пауза после 429). `reset` (журнал у соседа
 * обрезан дальше курсора, Ф12) — полный проход по общим беседам (`fullPass`, Э2 часть Б), курсор встаёт на голову журнала
 * из ответа; не удался — курсор на месте, следующий заход продолжит проход с места остановки.
 * Явный отказ связки соседом (`federation.paused` и т. п.) — отметка `convLink.notePeerAnswer` (беседы — только чтение).
 */
export async function pullConvChanges(instanceId: string): Promise<number | null> {
  const self = federation.identity();
  const key = federation.signingKey();
  if (!self || !key) return null;
  stalled.delete(instanceId);
  if ((pausedUntil.get(instanceId) ?? 0) > Date.now()) return null;
  const [link] = await db.select().from(federationLinks).where(eq(federationLinks.instanceId, instanceId)).limit(1);
  if (!link || link.state !== 'active') return null;
  // п. 10: звонок / забор у соседа, который в нашей строке связки без `dm1` (обновился после подтверждения) — перечитать.
  if (!link.features.includes(FED_FEATURES.dm1) && !(capsHook && (await capsHook(link)).includes(FED_FEATURES.dm1))) return null;
  let host: string;
  try {
    host = new URL(link.apiBase).host;
  } catch {
    return null;
  }
  const [cur] = await db.select().from(fedConvCursor).where(eq(fedConvCursor.instanceId, instanceId)).limit(1);
  let since = cur ? Number(cur.since) : 0;
  let passed = false;
  for (let page = 0; page < PULL_MAX_PAGES; page += 1) {
    const res = await getSignedFromPeer({
      apiBase: link.apiBase,
      path: '/api/fed/v1/conv/changes',
      query: { instance_id: self.instanceId, since },
      keyid: key.kid,
      privateKeyDer: key.privateKeyDer,
      allowHosts: new Set([host]),
      now: Date.now(),
    });
    notePeerAnswer(instanceId, res.ok ? res.value.status : null, res.ok ? res.value.body : null);
    if (res.ok && res.value.status === 429) notePause(instanceId, res.value.retryAfter);
    if (!res.ok || res.value.status < 200 || res.value.status >= 300) return page === 0 ? null : since;
    let parsed: ReturnType<typeof parseConvChangesPage>;
    try {
      parsed = parseConvChangesPage(JSON.parse(res.value.body));
    } catch {
      parsed = null;
    }
    if (!parsed || parsed.instanceId !== instanceId) return since;
    if ('reset' in parsed) {
      if (passed || parsed.seq === undefined) {
        console.warn(`[fed-dm] журнал ${instanceId} обрезан дальше ${since}, полный проход невозможен (сосед без головы журнала)`);
        return since;
      }
      passed = true;
      // Начатый раньше проход (оборвался на 429 / сети) продолжается со своей головой и пройденными беседами (п. 1).
      const prog = passProgress.get(instanceId) ?? { head: parsed.seq, done: new Set<string>(), cid: null, after: null };
      passProgress.set(instanceId, prog);
      const head = prog.head;
      if (!(await fullPass(instanceId, self.instanceId, link.apiBase, host, key))) return since;
      since = head;
      await saveCursor(instanceId, since);
      continue;
    }
    // Беседы страницы, которые у нас есть (строка `conv` ниже может завести новую — тогда она добавится сюда).
    const convIds = [...new Set(parsed.items.map((i) => i.conversationId))];
    const present = new Set(
      convIds.length > 0
        ? (await db.select({ id: conversations.id }).from(conversations).where(inArray(conversations.id, convIds))).map((r) => r.id)
        : [],
    );
    let stopAt: number | null = null;
    for (const item of parsed.items) {
      const tries = rowTries.get(`${instanceId}|${item.seq}`)?.n ?? 0;
      let problem: string | null = null;
      // Беседу отказанной строки `conv` с тех пор завёл наш человек сам (встречное «Написать» соседа обогнало ответ на наш `conv.open`):
      // беседа есть — её строки применяются, иначе «прочитано», ответы и реакции этой беседы молча терялись бы до перезапуска.
      if (refusedConvs.has(item.conversationId)) {
        if (!present.has(item.conversationId)) continue;
        refusedConvs.delete(item.conversationId);
      }
      if (item.kind === FED_CONV_CHANGE.conv) {
        if (item.entity && convRowHook) {
          try {
            const was = await groupJoinSnapshot(item.conversationId, item.entity);
            if (await convRowHook(instanceId, self.instanceId, item.conversationId, item.entity)) present.add(item.conversationId);
            else if (!present.has(item.conversationId)) refusedConvs.add(item.conversationId);
            // Э7 часть 3: наш человек вошёл в группу или вернулся в неё — догнать историю, как видит её местная группа.
            await groupCatchUp(instanceId, self.instanceId, link.apiBase, host, key, item.conversationId, was, tries >= ROW_TRIES - 1);
          } catch (err) {
            problem = err instanceof Error ? err.message : String(err);
          }
        }
      } else if (item.entity && !present.has(item.conversationId)) {
        problem = 'беседы у нас нет';
      } else {
        try {
          await applyChange(instanceId, self.instanceId, item.kind, item.conversationId, item.entity, { lastTry: tries >= ROW_TRIES - 1 });
        } catch (err) {
          if (err instanceof NeedsFilesFeature && capsHook) void capsHook(link).catch(() => {});
          problem = err instanceof Error ? err.message : String(err);
        }
      }
      if (problem === null) continue;
      const n = bumpTry(instanceId, item.seq);
      if (n >= ROW_TRIES) {
        console.warn(`[fed-dm] строка ${item.seq} (${item.kind}) от ${instanceId} пропущена после ${n} попыток: ${problem}`);
        continue;
      }
      console.warn(`[fed-dm] строка ${item.seq} (${item.kind}) от ${instanceId} не применилась (${problem}), попытка ${n}, повтор позже`);
      stopAt = item.seq - 1;
      break;
    }
    if (stopAt !== null) {
      if (stopAt > since) {
        since = stopAt;
        await saveCursor(instanceId, since);
      }
      forgetTries(instanceId, since);
      stalled.add(instanceId);
      return since;
    }
    if (parsed.seq > since) {
      since = parsed.seq;
      await saveCursor(instanceId, since);
      forgetTries(instanceId, since);
    }
    if (!parsed.more) break;
  }
  return since;
}

/**
 * Полный проход (Э2 часть Б, §3.3, Ф12): по каждой нашей 1:1 с человеком этого соседа — страницы
 * `GET /fed/v1/conv/:id/export` от начала, строки — тем же `applyChange`, что журнал (всё идемпотентно: создание по id,
 * правка по версии, надгробие монотонно, реакции/«прочитано»/закреп — текущее состояние). Беседы у соседа нет (404) —
 * пропускаем; сеть, 429 или негодный ответ — `false` (курсор не двигается, следующий заход продолжит с той же беседы и
 * страницы — `passProgress`, п. 1 ревью 12.10: раньше проход после первого 429 начинался с нуля и не кончался никогда).
 */
async function fullPass(
  instanceId: string,
  self: string,
  apiBase: string,
  host: string,
  key: { kid: string; privateKeyDer: Buffer },
): Promise<boolean> {
  const res = await db.execute(sql`
    SELECT DISTINCT cm.conversation_id AS cid FROM conversation_members cm JOIN users u ON u.id = cm.user_id
    JOIN conversations c ON c.id = cm.conversation_id
    WHERE c.kind = 'direct' AND u.home_instance_id = ${instanceId}`);
  const convIds = (res.rows as { cid: string }[]).map((r) => r.cid);
  // Э7 часть 3: и группы (только со связкой `dmgroup1`, `fullPassGroups`); 1:1 — прежним отбором выше.
  const groups = await fullPassGroups(instanceId, self, apiBase, host, key);
  if (groups === null) return false;
  for (const g of groups) if (!convIds.includes(g)) convIds.push(g);
  const prog = passProgress.get(instanceId) ?? { head: 0, done: new Set<string>(), cid: null, after: null };
  passProgress.set(instanceId, prog);
  const todo = convIds.filter((c) => !prog.done.has(c));
  console.warn(`[fed-dm] полный проход по ${todo.length} из ${convIds.length} бесед с ${instanceId}`);
  for (const cid of todo) {
    let after: string | null = prog.cid === cid ? prog.after : null;
    // Хвост Э7 (14.10): какие отметки группы пришли выгрузкой и полна ли она (`marksComplete` на каждой странице) — для
    // `dropUnsentGroupMarks` в конце; продолжение прохода после обрыва берёт накопленное (`prog.seen`).
    const seen: SeenMarks = prog.cid === cid && prog.seen ? prog.seen : { react: new Set(), pin: new Set(), listen: new Set(), complete: true };
    let ended = false;
    for (let page = 0; page < EXPORT_MAX_PAGES; page += 1) {
      const r = await getSignedFromPeer({
        apiBase,
        path: `/api${fedConvExportPath(cid)}`,
        query: { instance_id: self, after },
        keyid: key.kid,
        privateKeyDer: key.privateKeyDer,
        allowHosts: new Set([host]),
        now: Date.now(),
      });
      if (!r.ok) return false;
      notePeerAnswer(instanceId, r.value.status, r.value.body);
      if (r.value.status === 404) break;
      if (r.value.status === 429) {
        notePause(instanceId, r.value.retryAfter);
        return false;
      }
      if (r.value.status < 200 || r.value.status >= 300) return false;
      let parsed: ReturnType<typeof parseConvExportPage>;
      try {
        parsed = parseConvExportPage(JSON.parse(r.value.body));
      } catch {
        parsed = null;
      }
      if (!parsed || parsed.instanceId !== instanceId || parsed.conversationId !== cid) return false;
      let gone = false;
      if (!parsed.marksComplete) seen.complete = false;
      for (const item of parsed.items) {
        noteSeenMark(seen, item);
        try {
          await applyChange(instanceId, self, item.kind, cid, item.entity, { lastTry: true });
        } catch (err) {
          console.warn(`[fed-dm] полный проход ${cid}: строка ${item.kind} не применилась: ${err instanceof Error ? err.message : err}`);
        }
        // Э7 часть 3: группу по строке `conv` не завели (нашего человека в ней нет) — сообщения её не нужны.
        if (item.kind === FED_CONV_CHANGE.conv && !(await haveConv(cid))) {
          gone = true;
          break;
        }
      }
      ended = !gone && !parsed.next;
      if (gone || !parsed.next || parsed.next === after) break;
      after = parsed.next;
      prog.cid = cid;
      prog.after = after;
      prog.seen = seen;
    }
    if (ended && seen.complete) {
      try {
        await dropUnsentGroupMarks(instanceId, self, cid, seen);
      } catch (err) {
        console.warn(`[fed-dm] полный проход ${cid}: снятие отметок не удалось: ${err instanceof Error ? err.message : err}`);
      }
    }
    prog.done.add(cid);
    prog.cid = null;
    prog.after = null;
    prog.seen = null;
  }
  passProgress.delete(instanceId);
  return true;
}

// ─── Э7 часть 3: полный проход и догонка истории для групп ───────────────────────────────────────────────────────────

/** Хвост Э7 (14.10): отметки группы, пришедшие выгрузкой (id сообщений по видам), и признак полноты всех её страниц. */
type SeenMarks = { react: Set<string>; pin: Set<string>; listen: Set<string>; complete: boolean; /** Опрос (`dmpoll1`): голоса. */ vote?: Set<string> };

function noteSeenMark(seen: SeenMarks, item: { kind: string; entityId: string | null; entity: Record<string, unknown> | null }): void {
  const id = item.entityId ?? (typeof item.entity?.message_id === 'string' ? item.entity.message_id : null);
  if (!id) return;
  if (item.kind === FED_CONV_CHANGE_E2.react) seen.react.add(id);
  else if (item.kind === FED_CONV_CHANGE.pin) seen.pin.add(id);
  else if (item.kind === FED_CONV_CHANGE_E2.listen) seen.listen.add(id);
  else if (item.kind === FED_CONV_CHANGE_E2.vote) (seen.vote ??= new Set()).add(id);
}

/**
 * Хвост Э7 (14.10): полный проход группы дошёл до последней страницы и ВСЕ страницы несли `marksComplete` — отметки владельцев
 * отдающего дома, которых в выгрузке не было, сняты за время разрыва: снимаем их тем же приёмом, что журнал (пустой список —
 * `applyReactions`/`applyListens`, `pinned: false` — `applyPin`; события людям, мы хост — пересылка остальным домам).
 * Владельцы — как у приёма: от хоста (`origin = peer`) — действующие участники не с нашего инстанса; мы хост — люди дома `peer`.
 * Закреп — только поставленный владельцем (свой местный закреп не снимаем). «Прочитано до» не снимается: указатель монотонный,
 * последняя страница и так несёт его целиком. Как 1:1 (`exportForPeer` — `react` на каждое сообщение), но без раздувания выгрузки.
 */
async function dropUnsentGroupMarks(peer: string, self: string, conversationId: string, seen: SeenMarks): Promise<void> {
  const [c] = await db
    .select({ kind: conversations.kind, origin: conversations.originInstanceId })
    .from(conversations)
    .where(eq(conversations.id, conversationId))
    .limit(1);
  if (!c || c.kind !== 'group') return;
  const fromHost = c.origin === peer;
  if (!fromHost && c.origin !== null) return;
  const live = await db
    .select({ id: users.id, home: users.homeInstanceId })
    .from(conversationMembers)
    .innerJoin(users, eq(users.id, conversationMembers.userId))
    .where(and(eq(conversationMembers.conversationId, conversationId), isNull(conversationMembers.leftAt)));
  const owners = live.filter((m) => (fromHost ? m.home !== null : m.home === peer)).map((m) => m.id);
  const alive = and(eq(conversationMessages.conversationId, conversationId), isNull(conversationMessages.deletedAt), eq(conversationMessages.withheld, false));
  if (owners.length > 0) {
    const reacted = await db
      .selectDistinct({ id: conversationMessageReactions.messageId })
      .from(conversationMessageReactions)
      .innerJoin(conversationMessages, eq(conversationMessages.id, conversationMessageReactions.messageId))
      .where(and(alive, inArray(conversationMessageReactions.userId, owners)));
    for (const r of reacted) if (!seen.react.has(r.id)) await applyReactions(peer, self, conversationId, { message_id: r.id, reactions: [] });
    const heard = await db
      .selectDistinct({ id: conversationVoiceListens.messageId, author: conversationMessages.authorId })
      .from(conversationVoiceListens)
      .innerJoin(conversationMessages, eq(conversationMessages.id, conversationVoiceListens.messageId))
      .where(and(alive, inArray(conversationVoiceListens.userId, owners)));
    const authors = [...new Set(heard.map((h) => h.author))];
    const homeOf = new Map(
      authors.length ? (await db.select({ id: users.id, home: users.homeInstanceId }).from(users).where(inArray(users.id, authors))).map((u) => [u.id, u.home]) : [],
    );
    for (const h of heard) {
      if (seen.listen.has(h.id)) continue;
      // Как выгрузка: хост отдаёт «прослушано» только на наши сообщения, дом участника — только на не свои.
      const home = homeOf.get(h.author);
      if (fromHost ? home !== null : home === peer || home === undefined) continue;
      await applyListens(peer, self, conversationId, { message_id: h.id, listeners: [] });
    }
    // Опрос (`dmpoll1`): голоса владельцев, которых в выгрузке не было, — отменены за разрыв. Только от дома с признаком: без него
    // строк `pollvote` в выгрузке нет вовсе (опросы у него — текст), и снимать по их отсутствию нельзя.
    const [link] = await db.select({ features: federationLinks.features }).from(federationLinks).where(eq(federationLinks.instanceId, peer)).limit(1);
    if (link?.features.includes(FED_FEATURES.dmpoll1)) {
      const voted = await db
        .selectDistinct({ id: convPollVotes.messageId })
        .from(convPollVotes)
        .innerJoin(conversationMessages, eq(conversationMessages.id, convPollVotes.messageId))
        .where(and(alive, inArray(convPollVotes.userId, owners)));
      for (const v of voted) if (!seen.vote?.has(v.id)) await applyPollVotes(peer, self, conversationId, { message_id: v.id, voters: [] });
    }
  }
  // Закреп ушедшего участника выгрузка не обязана нести — по её отсутствию его не снимаем (как реакции: владельцы только
  // действующие, Codex R217, 14.10).
  const former = new Set(
    (
      await db
        .select({ id: conversationMembers.userId })
        .from(conversationMembers)
        .where(and(eq(conversationMembers.conversationId, conversationId), sql`${conversationMembers.leftAt} IS NOT NULL`))
    ).map((f) => f.id),
  );
  const pinned = await db
    .selectDistinct({ id: conversationPins.messageId, by: conversationPins.pinnedBy })
    .from(conversationPins)
    .innerJoin(conversationMessages, eq(conversationMessages.id, conversationPins.messageId))
    .innerJoin(users, eq(users.id, conversationPins.pinnedBy))
    .where(
      and(
        alive,
        eq(conversationPins.conversationId, conversationId),
        eq(conversationPins.forBoth, true),
        fromHost ? sql`${users.homeInstanceId} IS NOT NULL` : eq(users.homeInstanceId, peer),
      ),
    );
  for (const r of pinned) if (!seen.pin.has(r.id) && !former.has(r.by)) await applyPin(peer, self, conversationId, { message_id: r.id, pinned: false });
}

async function haveConv(conversationId: string): Promise<boolean> {
  const [c] = await db.select({ id: conversations.id }).from(conversations).where(eq(conversations.id, conversationId)).limit(1);
  return !!c;
}

/**
 * Группы полного прохода со связкой `dmgroup1` (без признака — пусто: всё как до части 3):
 * - наши группы, где у соседа есть действующие люди: их сообщения у него (журнал соседа обрезан — мы их потеряли бы);
 * - группы соседа (хост — он), где есть наши люди (действующие или бывшие);
 * - его список `GET /fed/v1/conv/groups` — группы, о которых мы не знаем (строка `conv` ушла уборкой). Старый сосед — 404, пусто.
 * `null` — сходить за списком не удалось (сеть, 429, негодный ответ): проход повторится, курсор не двигается.
 */
async function fullPassGroups(
  instanceId: string,
  self: string,
  apiBase: string,
  host: string,
  key: { kid: string; privateKeyDer: Buffer },
): Promise<string[] | null> {
  const [link] = await db.select({ features: federationLinks.features }).from(federationLinks).where(eq(federationLinks.instanceId, instanceId)).limit(1);
  if (!link?.features.includes(FED_FEATURES.dmgroup1)) return [];
  const local = await db.execute(sql`
    SELECT DISTINCT gm.conversation_id AS cid FROM conversation_members gm JOIN users gu ON gu.id = gm.user_id
    JOIN conversations gc ON gc.id = gm.conversation_id
    WHERE gc.kind = 'group' AND (
      (gc.origin_instance_id IS NULL AND gu.home_instance_id = ${instanceId} AND gm.left_at IS NULL)
      OR (gc.origin_instance_id = ${instanceId} AND gu.home_instance_id IS NULL))`);
  const ids = (local.rows as { cid: string }[]).map((r) => r.cid);
  const r = await getSignedFromPeer({
    apiBase,
    path: `/api${FED_CONV_GROUPS_PATH}`,
    query: { instance_id: self },
    keyid: key.kid,
    privateKeyDer: key.privateKeyDer,
    allowHosts: new Set([host]),
    now: Date.now(),
  });
  if (!r.ok) return null;
  notePeerAnswer(instanceId, r.value.status, r.value.body);
  if (r.value.status === 404) return ids;
  if (r.value.status === 429) {
    notePause(instanceId, r.value.retryAfter);
    return null;
  }
  if (r.value.status < 200 || r.value.status >= 300) return null;
  let list: ReturnType<typeof parseConvGroupsList>;
  try {
    list = parseConvGroupsList(JSON.parse(r.value.body));
  } catch {
    list = null;
  }
  if (!list || list.instanceId !== instanceId) return null;
  for (const g of list.groups) if (!ids.includes(g)) ids.push(g);
  return ids;
}

/** Наши люди в группе до строки `conv` и наше последнее сообщение в ней (курсор догонки); не группа / группы не принимаем — `null`. */
type GroupJoinSnapshot = { active: Set<string>; last: string | null };

async function groupJoinSnapshot(conversationId: string, entity: Record<string, unknown>): Promise<GroupJoinSnapshot | null> {
  if (entity.kind !== 'group' || !groupHooks) return null;
  const rows = await db
    .select({ userId: conversationMembers.userId, leftAt: conversationMembers.leftAt })
    .from(conversationMembers)
    .innerJoin(users, eq(users.id, conversationMembers.userId))
    .where(and(eq(conversationMembers.conversationId, conversationId), isNull(users.homeInstanceId)));
  const [last] = await db
    .select({ id: conversationMessages.id })
    .from(conversationMessages)
    .where(eq(conversationMessages.conversationId, conversationId))
    .orderBy(sql`${conversationMessages.sortKey} DESC`)
    .limit(1);
  return { active: new Set(rows.filter((r) => !r.leftAt).map((r) => r.userId)), last: last?.id ?? null };
}

/** Догонка, ждущая повтора строки `conv` (`peer|conversation` → курсор `after`): сеть упала посреди — строка повторится. */
const catchUps = new Map<string, string | null>();

/**
 * Э7 часть 3: строка `conv` хоста ввела нашего человека в группу (новый участник или вернувшийся после `left_at`). В местной
 * группе он видит всю историю — и время своего отсутствия (`addGroupMembers` сбрасывает `hiddenKey`), а наш дом этих сообщений
 * не получал (журнал хоста ушедшему их не отдаёт). Догоняем полным проходом по этой группе (`GET /fed/v1/conv/:id/export`) от
 * нашего последнего сообщения в ней — ДО следующих строк журнала, чтобы пропущенное легло в ленте раньше записи «вернул».
 * Хост без экспорта групп (часть 1) — 404, догонки нет, как раньше. Сеть/429 — ошибка: строка повторится (`ROW_TRIES`).
 */
async function groupCatchUp(
  peer: string,
  self: string,
  apiBase: string,
  host: string,
  key: { kid: string; privateKeyDer: Buffer },
  conversationId: string,
  was: GroupJoinSnapshot | null,
  lastTry: boolean,
): Promise<void> {
  const k = `${peer}|${conversationId}`;
  if (was) {
    const now = await groupJoinSnapshot(conversationId, { kind: 'group' });
    if (now && [...now.active].some((u) => !was.active.has(u))) catchUps.set(k, was.last);
  }
  if (!catchUps.has(k)) return;
  let after = catchUps.get(k) ?? null;
  for (let page = 0; page < EXPORT_MAX_PAGES; page += 1) {
    const r = await getSignedFromPeer({
      apiBase,
      path: `/api${fedConvExportPath(conversationId)}`,
      query: { instance_id: self, after },
      keyid: key.kid,
      privateKeyDer: key.privateKeyDer,
      allowHosts: new Set([host]),
      now: Date.now(),
    });
    if (r.ok) notePeerAnswer(peer, r.value.status, r.value.body);
    if (r.ok && r.value.status === 404 && after !== null && page === 0) {
      // Нашего последнего сообщения у хоста нет (не дошло до него) — с начала группы.
      after = null;
      continue;
    }
    if (r.ok && r.value.status === 404) break;
    if (r.ok && r.value.status === 429) notePause(peer, r.value.retryAfter);
    let parsed: ReturnType<typeof parseConvExportPage> = null;
    if (r.ok && r.value.status >= 200 && r.value.status < 300) {
      try {
        parsed = parseConvExportPage(JSON.parse(r.value.body));
      } catch {
        parsed = null;
      }
    }
    if (!parsed || parsed.instanceId !== peer || parsed.conversationId !== conversationId) {
      if (lastTry) catchUps.delete(k);
      else catchUps.set(k, after);
      throw new Error('догонка истории группы не удалась');
    }
    for (const item of parsed.items) {
      try {
        await applyChange(peer, self, item.kind, conversationId, item.entity, { lastTry: true });
      } catch (err) {
        console.warn(`[fed-dm] догонка группы ${conversationId}: строка ${item.kind} не применилась: ${err instanceof Error ? err.message : err}`);
      }
    }
    if (!parsed.next || parsed.next === after) break;
    after = parsed.next;
  }
  catchUps.delete(k);
}

/**
 * Применить одну строку журнала соседа. Незнакомый вид — молча (сосед новее нас; отдающий шлёт новые виды только соседу с
 * нужным признаком — `convChanges.KIND_FEATURE`). `lastTry` — последняя попытка строки (п. 5): копия с вложениями, а у
 * связки нет `dm2`, ложится с заглушкой, как до Э3; раньше — `NeedsFilesFeature` (курсор держится, визитка перечитывается).
 */
export async function applyChange(
  peer: string,
  self: string,
  kind: string,
  conversationId: string,
  entity: Record<string, unknown> | null,
  opts: { lastTry?: boolean } = {},
): Promise<void> {
  if (!entity) return;
  // Э7 часть 1: журнал отдаёт строки `conv` крючку `configureFedConvRow`; сюда они приходят из полного прохода.
  if (kind === FED_CONV_CHANGE.conv) return groupHooks?.applyConv(peer, self, conversationId, entity);
  if (kind === FED_CONV_CHANGE.msg) return applyMessage(peer, self, conversationId, entity, opts.lastTry ?? true);
  if (kind === FED_CONV_CHANGE_E2.react) return applyReactions(peer, self, conversationId, entity);
  if (kind === FED_CONV_CHANGE.read) return applyReads(peer, self, conversationId, entity);
  if (kind === FED_CONV_CHANGE.pin) return applyPin(peer, self, conversationId, entity);
  if (kind === FED_CONV_CHANGE_E2.listen) return applyListens(peer, self, conversationId, entity);
  if (kind === FED_CONV_CHANGE_E2.vote) return applyPollVotes(peer, self, conversationId, entity);
}

// ─── Беседа под замком ───────────────────────────────────────────────────────────────────────────────────────────────

interface Member {
  id: string;
  home: string | null;
  homeUserId: string | null;
}

/**
 * Оригинал пересланного нашего человека у нас есть (аудит ЛС #236, п.2): его сообщение с тем же временем (до мс) — или
 * пересланное от него с тем же временем оригинала (пересылка пересланного) — и тем же текстом (пустой текст копии —
 * пересылка «без подписи»). Удалённое не считается.
 */
async function ourForwardOriginal(tx: Tx, userId: string, at: Date, content: string): Promise<boolean> {
  if (!Number.isFinite(at.getTime())) return false;
  const iso = at.toISOString();
  const rows = await tx
    .select({ content: conversationMessages.content })
    .from(conversationMessages)
    .where(
      and(
        isNull(conversationMessages.deletedAt),
        sql`((${conversationMessages.authorId} = ${userId} AND ${conversationMessages.forwardedFrom} IS NULL
              AND date_trunc('milliseconds', ${conversationMessages.createdAt}) = ${iso}::timestamptz)
          OR (${conversationMessages.forwardedFrom}->>'userId' = ${userId} AND ${conversationMessages.forwardedFrom}->>'at' = ${iso}))`,
      ),
    )
    .limit(20);
  return rows.some((r) => content === '' || r.content === content);
}

interface LockedConv {
  nextKey: number;
  members: Member[];
  memberIds: string[];
  /** Э7 часть 1: группа со смешанным составом — `host` = мы её дом (пересылаем копии дальше); у 1:1 — `null`. */
  group: { host: boolean } | null;
  /** Глобальная личность → местный участник: наш — по id, человек соседа — теневой с этим домом. */
  byRef(ref: FedPersonRef | null): Member | null;
}

/**
 * Запереть беседу и проверить, что сосед вправе в неё писать: 1:1 (группы — Э7), среди участников есть человек ЭТОГО
 * соседа. Нет беседы (сосед прислал строку беседы, которой у нас нет) — `null`.
 */
async function lockFor(tx: Tx, conversationId: string, peer: string, self: string): Promise<LockedConv | null> {
  const lock = await lockConversation(tx, conversationId);
  if (!lock) return null;
  let group: { host: boolean } | null = null;
  if (lock.kind !== 'direct') {
    // Э7 часть 1 (§3.6): группа — только с `dmgroup1`-приёмом; пишет в неё хост (мы — дом участника) или дом участника (мы — хост).
    if (!groupHooks) return null;
    const [c] = await tx.select({ origin: conversations.originInstanceId }).from(conversations).where(eq(conversations.id, conversationId)).limit(1);
    if (c?.origin && c.origin !== peer) return null;
    group = { host: !c?.origin };
  }
  const rows = await tx
    .select({ id: users.id, home: users.homeInstanceId, homeUserId: users.homeUserId, leftAt: conversationMembers.leftAt })
    .from(conversationMembers)
    .innerJoin(users, eq(users.id, conversationMembers.userId))
    .where(eq(conversationMembers.conversationId, conversationId));
  const members: Member[] = rows.map((m) => ({ id: m.id, home: m.home, homeUserId: m.homeUserId }));
  // Группа: адресаты — действующие участники; автор опоздавшей копии мог уже выйти — он ищется среди всех.
  const live = group ? rows.filter((m) => !m.leftAt) : rows;
  if (group?.host && !live.some((m) => m.home === peer)) return null;
  if (!group && !members.some((m) => m.home === peer)) return null;
  return {
    nextKey: lock.nextKey,
    members: group ? live.map((m) => ({ id: m.id, home: m.home, homeUserId: m.homeUserId })) : members,
    memberIds: live.map((m) => m.id),
    group,
    byRef(ref) {
      if (!ref) return null;
      if (ref.instanceId === self) return members.find((m) => m.home === null && m.id === ref.userId) ?? null;
      // (группа: автор ищется и среди ушедших — опоздавшая копия)
      return members.find((m) => m.home === ref.instanceId && (m.homeUserId ?? m.id) === ref.userId) ?? null;
    },
  };
}

/**
 * G6: служебная запись группы с `users[].ref` (хост, `convChanges.serviceWire`) → те же записи с НАШИМИ id (`byRef`), `ref` не
 * храним. Человека не узнали — запись как пришла (её `id` — id хоста, как до G6). Остальные виды — без изменений.
 */
function localService(raw: Record<string, unknown> | null, c: LockedConv): Record<string, unknown> | null {
  if (!raw || raw.kind !== 'group' || !Array.isArray(raw.users)) return raw;
  return {
    ...raw,
    users: (raw.users as unknown[]).map((u) => {
      if (!u || typeof u !== 'object') return u;
      const { ref, ...rest } = u as { ref?: unknown } & Record<string, unknown>;
      const r = ref as { instanceId?: unknown; userId?: unknown } | undefined;
      if (!r || typeof r.instanceId !== 'string' || typeof r.userId !== 'string') return rest;
      const who = c.byRef({ instanceId: r.instanceId, userId: r.userId });
      return who ? { ...rest, id: who.id } : rest;
    }),
  };
}

/** G6: наши люди (не теневые), которые этой записью перестали быть участниками: «удалил(а)» — из `users`, «покинул(а)» — автор. */
function departedLocals(service: unknown, author: Member, c: LockedConv, self: string): string[] {
  const s = service as { kind?: unknown; type?: unknown; users?: unknown } | null;
  if (!s || s.kind !== 'group') return [];
  const live = new Set(c.memberIds);
  const ids =
    s.type === 'remove' && Array.isArray(s.users)
      ? s.users.flatMap((u) => (u && typeof u === 'object' && typeof (u as { id?: unknown }).id === 'string' ? [(u as { id: string }).id] : []))
      : s.type === 'leave'
        ? [author.id]
        : [];
  // Наш — по `byRef` своей личностью (ищет и среди ушедших: `c.members` у группы — только действующие).
  return [...new Set(ids)].filter((id) => !live.has(id) && (id === author.id ? author.home === null : !!c.byRef({ instanceId: self, userId: id })));
}

// ─── Сообщение ───────────────────────────────────────────────────────────────────────────────────────────────────────

async function applyMessage(peer: string, self: string, conversationId: string, entity: Record<string, unknown>, lastTry: boolean): Promise<void> {
  const w = parseConvMessageWire(entity);
  if (!w || w.conversationId !== conversationId) return;
  // Автор — человек отдающего соседа, либо наш (только надгробие, Ф8); третий инстанс в 1:1 — подделка. Э7: в группе, чей
  // дом — отдающий сосед, автор может быть с любого инстанса — его копию проверяет подпись дома автора (ниже).
  const third = w.author.instanceId !== peer && w.author.instanceId !== self;
  const ours = w.author.instanceId === self;
  const after: (() => Promise<void>)[] = [];

  await db.transaction(async (tx) => {
    const c = await lockFor(tx, conversationId, peer, self);
    if (!c) return;
    if (third && !(c.group && !c.group.host)) return;
    // Э7 часть 1 (§3.6, §4 п. 1): чужое сообщение в группе (не служебное, не надгробие) — только с подписью дома автора;
    // служебные записи и надгробия пишет хост — это его власть. Своё от хоста — только его служебная запись (наш вышел).
    const signedNeeded = !!c.group && !ours && !w.service && !w.deleted;
    if (signedNeeded && (c.group?.host || third) && !groupHooks?.verify(w, entity)) {
      console.warn(`[fed-dm] ${peer}: сообщение ${w.id} в группе без верной подписи дома автора — пропущено`);
      return;
    }
    const originSig = c.group && !ours && entity.sig && typeof entity.sig === 'object' ? (entity.sig as Record<string, unknown>) : null;
    const relay = c.group?.host === true;
    const author = c.byRef(w.author);
    if (!author) return;
    const [row] = await tx.select().from(conversationMessages).where(eq(conversationMessages.id, w.id)).for('update');

    if (row) {
      // Тот же id с другим автором или беседой — отказ (§3.2), молча: чужое не трогаем.
      if (row.conversationId !== conversationId || row.authorId !== author.id) {
        console.warn(`[fed-dm] ${peer}: сообщение ${w.id} не совпадает автором/беседой — пропущено`);
        return;
      }
      if (row.deletedAt) return; // надгробие монотонно: воскресить нельзя
      if (w.deleted) {
        const d = await tombstone(tx, conversationId, row.id, row.withheld, author.id, c.memberIds, relay);
        after.push(() => deliver(d.msg), () => deliver(d.pins));
        // Э3: файлы копии — стереть сразу после фиксации (без файлов — нечего, модуль копий не трогаем).
        const purge = attHooks?.purge;
        if (d.keys.length > 0 && purge) after.push(async () => purge(d.keys));
        return;
      }
      // Э7 часть 3 (#141, `dmgroup2`): «через»-сообщение человека этого дома лежит у нас (хост) с пометкой «ждёт»; дом автора принял его
      // своим и прислал копию с подписью — запоминаем подпись, считаем подтверждённым и только теперь пересылаем остальным домам.
      if (relay && !ours && originSig && row.viaInstanceId === peer && !row.originSig) {
        await tx.update(conversationMessages).set({ originSig, viaState: 'confirmed' }).where(eq(conversationMessages.id, row.id));
        const viaAudience = changeAudience({ action: 'edit', actorId: author.id, memberIds: c.memberIds, withheld: row.withheld, blockedActor: new Set() });
        const viaPts = await journal(tx, msgEntries(viaAudience, conversationId, row.id), { fed: true });
        after.push(() => deliver({ conversationId, messageId: row.id, pts: viaPts }));
        return;
      }
      // Опрос (`dmpoll1`): дом автора остановил опрос — копия закрывается без версии правки (монотонно, как надгробие: обратно не
      // открывается; «изм.» не ставится). Своё сосед не закрывает. Хост группы пересылает закрытие остальным домам.
      if (!ours && w.media?.kind === 'poll' && w.media.closed && row.media?.kind === 'poll' && !row.media.closed) {
        await tx.update(conversationMessages).set({ media: { ...row.media, closed: true } }).where(eq(conversationMessages.id, row.id));
        const closeAudience = changeAudience({ action: 'edit', actorId: author.id, memberIds: c.memberIds, withheld: row.withheld, blockedActor: new Set() });
        const closePts = await journal(tx, msgEntries(closeAudience, conversationId, row.id), { fed: relay });
        after.push(() => deliver({ conversationId, messageId: row.id, pts: closePts }));
        // Правки нет (версия та же) — закрытие и есть вся перемена.
        if (row.editVersion >= w.editVersion) return;
      }
      if (ours || w.editVersion <= row.editVersion) return; // своё сосед не правит; старая версия проигрывает
      // G56 (`dmalbum1`): дом автора убрал элемент альбома — в проводе меньше вложений; убираем их из копии и стираем их файлы.
      // Правка без «изм.» (`edited_at` у автора пуст) не ставит его и здесь.
      const dropped = removedByEdit(row.attachments, w.attachments);
      const droppedIds = dropped.map((a) => a.id as string);
      await tx
        .update(conversationMessages)
        .set({
          content: w.content,
          editedAt: w.editedAt != null ? new Date(w.editedAt) : dropped.length > 0 ? row.editedAt : new Date(),
          editVersion: w.editVersion,
          ...(originSig ? { originSig } : {}),
          ...(dropped.length > 0 ? { attachments: row.attachments.filter((a) => !a.id || !droppedIds.includes(a.id)) } : {}),
        })
        .where(eq(conversationMessages.id, row.id));
      if (droppedIds.length > 0) {
        const dead = await tx
          .update(attachments)
          .set({ state: 'deleted', deletedAt: new Date() })
          .where(and(eq(attachments.messageId, row.id), inArray(attachments.id, droppedIds), inArray(attachments.state, ['attached', 'remote'])))
          .returning({ key: attachments.storageKey });
        const purge = attHooks?.purge;
        const keys = dead.map((d) => d.key);
        if (keys.length > 0 && purge) after.push(async () => purge(keys));
      }
      const audience = changeAudience({ action: 'edit', actorId: author.id, memberIds: c.memberIds, withheld: row.withheld, blockedActor: new Set() });
      // Э7: хост группы пересылает правку остальным домам (журнал на связку, кроме дома автора).
      const pts = await journal(tx, msgEntries(audience, conversationId, row.id), { fed: relay });
      const holders = (await tx
        .select({ userId: conversationPins.userId })
        .from(conversationPins)
        .where(eq(conversationPins.messageId, row.id))).map((r) => r.userId).filter((id) => audience.includes(id));
      const pinD = holders.length > 0 ? await journalPins(tx, conversationId, holders) : null;
      after.push(() => deliver({ conversationId, messageId: row.id, pts }), () => deliver(pinD));
      return;
    }

    // Новое: своё сосед не создаёт (кроме служебной записи хоста группы — «наш вышел»); надгробие незнакомого — показывать нечего.
    if ((ours && !(c.group && !c.group.host && w.service)) || w.deleted) return;
    const recipients = c.members.filter((m) => m.home === null);
    const blocked =
      recipients.length > 0 &&
      (
        await tx
          .select({ id: userBlocks.blockerId })
          .from(userBlocks)
          .where(and(inArray(userBlocks.blockerId, recipients.map((m) => m.id)), eq(userBlocks.blockedId, author.id)))
          .limit(1)
      ).length > 0 ||
      // «Кто может мне писать» (`msgpriv1`): только 1:1 и не служебное (запись о звонке — своё правило «Кто может звонить»).
      (!c.group && recipients.length === 1 && !w.service && messageGate !== null && !(await messageGate(author.id, recipients[0]!.id)));
    let replyToId: string | null = null;
    let parentContent: string | null = null;
    if (w.replyToId) {
      const [parent] = await tx
        .select({ id: conversationMessages.id, content: conversationMessages.content, deletedAt: conversationMessages.deletedAt })
        .from(conversationMessages)
        .where(and(eq(conversationMessages.id, w.replyToId), eq(conversationMessages.conversationId, conversationId)))
        .limit(1);
      replyToId = parent?.id ?? null;
      parentContent = parent && !parent.deletedAt ? parent.content : null;
    }
    // Аудит ЛС #236, п.2: цитата — по нашей копии родителя, не по проводу (`convRules.fedReplyQuote`). Импорт — в теле: перечень
    // статических импортов модуля закрыт проверкой (`activeLoops.test.ts`).
    const { fedCreatedAt, fedReplyQuote } = await import('../convRules.js');
    const replyQuote = fedReplyQuote(parentContent, w.replyQuote);
    const fwd = w.forwardedFrom;
    let forwardedFrom: MessageForwardedFrom | null = null;
    if (fwd) {
      const at = new Date(fwd.at || w.createdAt);
      const who = c.byRef(fwd.author);
      /*
       * Аудит ЛС #236, п.2: «Переслано от» НАШЕГО человека сосед мог приписать любому тексту. Привязка к нашему — только если
       * оригинал у нас есть (`ourForwardOriginal`); нет — имя без привязки и `unverified` (клиент не ведёт в профиль).
       * Человек другого инстанса — как раньше: проверить его оригинал нам нечем.
       */
      const verified = !who || who.home !== null || (await ourForwardOriginal(tx, who.id, at, w.content));
      forwardedFrom = verified
        ? { userId: who?.id ?? '', displayName: fwd.name, at: at.toISOString() }
        : { userId: '', displayName: fwd.name, at: at.toISOString(), unverified: true };
    }
    const sticker: MessageSticker | null = w.sticker
      ? { id: w.sticker.id, emoji: w.sticker.emoji, url: w.sticker.url, format: w.sticker.format as MessageSticker['format'] }
      : null;
    // G6: `users` служебной записи группы — в наши id по `ref` от хоста (`convChanges.serviceWire`); без `ref` — как пришло.
    const service = localService(w.service, c) as unknown as ConvServiceMark | null;
    // Э3 часть 1: сосед с `dm2` отдаёт файлы — вложения копии становятся строками `remote` и копируются к нам
    // (`convAtt.ts`). Сосед без `dm2` (Э2) файлов не отдаёт: текст остаётся, пузырь без текста получает честную заглушку.
    const [peerLink] = await tx
      .select({ features: federationLinks.features })
      .from(federationLinks)
      .where(eq(federationLinks.instanceId, peer))
      .limit(1);
    const files = !!attHooks && !sticker && !service && w.attachments.length > 0 && !!peerLink?.features.includes(FED_FEATURES.dm2);
    // Исправления ревью 12.10, п. 5: сосед прислал файлы (значит, умеет `dm2`), а наша строка связки старая — не вставлять копию
    // с вечной заглушкой: строка держит курсор, визитка перечитывается (`pullConvChanges`). Последняя попытка — как до Э3.
    if (!files && !!attHooks && !sticker && !service && w.attachments.length > 0 && !lastTry) {
      throw new NeedsFilesFeature('вложения, а в строке связки нет dm2');
    }
    const content = w.content || (w.attachments.length > 0 && !sticker && !service && !files ? FED_ATTACHMENTS_LATER_TEXT : '');
    if (!content && !sticker && !service && !files) return;
    // G69 (`dmmedia1`): геопозиция / контакт — контакт сопоставляется с нашими людьми (своя или теневая строка).
    const media = w.media && !w.deleted ? await convMediaFromWire(tx, w.media, self) : null;
    // Аудит ЛС #236, п.3: время копии — в окне [−30 дн, +5 мин] от нашего, иначе сейчас (`convRules.fedCreatedAt`).
    const createdAt = fedCreatedAt(w.createdAt, Date.now());
    const [ins] = await tx
      .insert(conversationMessages)
      .values({
        id: w.id,
        conversationId,
        authorId: author.id,
        clientId: null,
        payloadHash: null,
        sortKey: c.nextKey,
        originSortKey: w.originSortKey,
        createdAt,
        content,
        attachments: [],
        replyToId,
        replyQuote,
        forwardedFrom,
        withheld: blocked,
        silent: w.silent,
        noPreview: w.noPreview,
        captionAbove: false,
        sticker,
        service,
        media,
        editedAt: w.editedAt ? new Date(w.editedAt) : null,
        editVersion: w.editVersion,
        originSig,
      })
      .onConflictDoNothing({ target: conversationMessages.id })
      .returning();
    if (!ins) return;
    const hooks = attHooks;
    const stored = files && hooks
      ? await hooks.remoteFor(tx, { conversationId, ownerId: author.id, messageId: ins.id, origin: peer, list: w.attachments })
      : [];
    if (stored.length > 0 && hooks) {
      await tx.update(conversationMessages).set({ attachments: stored }).where(eq(conversationMessages.id, ins.id));
      ins.attachments = stored;
      after.push(async () => hooks.kick(peer));
    }
    /*
     * Приёмка 15.10 («прочитано» не дошло: собеседник ответил, а у нашего сообщения навсегда одна ✓). Ответ человека соседа в 1:1 —
     * значит, он прочитал всё до него: как у Telegram, где отправка сперва читает беседу целиком (tdesktop `ApiWrap::sendAction` →
     * `histories().readInbox`). Его «прочитано до» встаёт не ниже этой копии (только вперёд, `GREATEST`), наши сообщения до неё
     * получают «прочитано в» — ✓✓ не зависит от того, дошла ли отдельная строка `read` его дома. Сводка с новым `peerReadKey`
     * уходит нашим людям той же строкой `msg` журнала ниже. Придержанное (блокировка) и служебное (звонок) прочтения не означают.
     */
    if (!c.group && !blocked && !service && author.home === peer) {
      const [was] = await tx
        .select({ key: conversationMembers.lastReadKey })
        .from(conversationMembers)
        .where(and(eq(conversationMembers.conversationId, conversationId), eq(conversationMembers.userId, author.id)));
      if (was && Number(was.key) < c.nextKey) {
        await tx
          .update(conversationMembers)
          .set({ lastReadKey: sql`GREATEST(${conversationMembers.lastReadKey}, ${c.nextKey})` })
          .where(and(eq(conversationMembers.conversationId, conversationId), eq(conversationMembers.userId, author.id)));
        await tx
          .update(conversationMessages)
          .set({ readAt: new Date() })
          .where(
            and(
              eq(conversationMessages.conversationId, conversationId),
              gt(conversationMessages.sortKey, Number(was.key)),
              lte(conversationMessages.sortKey, c.nextKey),
              ne(conversationMessages.authorId, author.id),
              isNull(conversationMessages.readAt),
            ),
          );
      }
    }
    await tx
      .update(conversations)
      .set(
        blocked
          ? { lastSortKey: c.nextKey }
          : // Ф9 «по приходу» (Э2 часть Б): опоздавшая копия поднимает беседу моментом приёма, а не отправки.
            { lastSortKey: c.nextKey, lastMessageAt: sql`GREATEST(${conversations.lastMessageAt}, now())` },
      )
      .where(eq(conversations.id, conversationId));
    const audience = changeAudience({ action: 'create', actorId: author.id, memberIds: c.memberIds, withheld: blocked, blockedActor: new Set() });
    await unarchiveOnMessage(tx, conversationId, author.id, audience);
    const pts = await journal(tx, msgEntries(audience, conversationId, ins.id), { fed: relay });
    const delivery: Delivery = { conversationId, messageId: ins.id, pts, created: true };
    // G6 (приёмка 13.10): наш человек, которого эта запись удалила (или вышедший сам), уже не участник — строку «X удалил(а) вас»
    // он получает в ленту бывшей группы, а его сводка пересчитывается («вас исключили», `left_how` видит запись), как у местной
    // группы (`convGroups.insertService` — журнал и ушедшему).
    const departed = c.group ? departedLocals(service, author, c, self) : [];
    if (departed.length > 0) {
      const dPts = await journal(
        tx,
        // Вышедший сам автор уже в обычной аудитории (`changeAudience` берёт автора) — его строку `msg` не дублируем.
        departed.flatMap((userId) => [
          ...(audience.includes(userId) ? [] : [{ userId, conversationId, kind: 'msg' as const, messageId: ins.id }]),
          { userId, conversationId, kind: 'conv' as const, messageId: null },
        ]),
        { fed: false },
      );
      after.push(() => deliver({ conversationId, messageId: ins.id, pts: dPts, created: true }));
    }
    // Э7: в группе пуш — всем нашим действующим участникам, кроме автора (как местная группа, `fanOutGroup`).
    const groupLocal = c.group ? c.members.filter((m) => m.home === null && m.id !== author.id).map((m) => m.id) : null;
    const recipient = recipients[0]?.id ?? null;
    const callPlan = service && callRecordHooks ? callRecordHooks.plan(service as { kind?: unknown; reason?: unknown }) : null;
    // Пуш получателю — его дом по своей копии, как местное (§3.8): окно пачки, заглушки, «без звука».
    after.push(() =>
      fanOutSend({
        me: author.id,
        peerId: recipient,
        conversationId,
        row: ins,
        delivery,
        notifyRecipient: !blocked && recipient !== null && (callPlan?.notify ?? true),
        // Пуш (G69): «Геопозиция» / «Контакт: Имя» вместо запасной фразы со ссылкой.
        content: ins.media ? convMediaPreview(ins.media) : content,
        attachments: stored,
        silent: ins.silent || (callPlan?.silent ?? false),
        sticker: ins.sticker,
        ...(groupLocal ? { groupMemberIds: groupLocal } : {}),
      }),
    );
    if (callPlan?.markRead && recipient !== null && !blocked && ins.sortKey != null && callRecordHooks) {
      const hooksNow = callRecordHooks;
      const key = Number(ins.sortKey);
      after.push(() => hooksNow.read(conversationId, recipient, key));
    }
  });
  for (const f of after) await f();
}

/**
 * Надгробие копии (или нашего сообщения — Ф8): те же следы, что у местного «удалить у обоих» (`conversations.deleteMessageTx`):
 * текст, вложения, реакции, снимок «Переслано от», закрепы. Файлы нашего сообщения — «удалено», их подберёт часовая уборка.
 */
async function tombstone(
  tx: Tx,
  conversationId: string,
  messageId: string,
  withheld: boolean,
  actorId: string,
  memberIds: readonly string[],
  relay = false,
): Promise<{ msg: Delivery; pins: Delivery | null; keys: string[] }> {
  await tx
    .update(conversationMessages)
    .set({ deletedAt: new Date(), content: '', attachments: [], forwardedFrom: null, sticker: null, service: null, media: null })
    .where(eq(conversationMessages.id, messageId));
  await tx.delete(conversationMessageReactions).where(eq(conversationMessageReactions.messageId, messageId));
  const unpinned = (await removePins(tx, [messageId], null)).filter((id) => memberIds.includes(id));
  // Э3: и копии файлов соседа — скопированные (`attached`) и ещё нет (`remote`); файлы стираются после фиксации.
  const gone = await tx
    .update(attachments)
    .set({ state: 'deleted', deletedAt: new Date() })
    .where(and(eq(attachments.messageId, messageId), inArray(attachments.state, ['attached', 'remote'])))
    .returning({ key: attachments.storageKey });
  await tx
    .update(conversations)
    .set({
      lastMessageAt: sql`(SELECT max(created_at) FROM conversation_messages
        WHERE conversation_id = ${conversationId} AND NOT withheld AND deleted_at IS NULL)`,
    })
    .where(eq(conversations.id, conversationId));
  const audience = changeAudience({ action: 'delete-both', actorId, memberIds, withheld, blockedActor: new Set() });
  const pts = await journal(tx, msgEntries(audience, conversationId, messageId), { fed: relay });
  const pins = unpinned.length > 0 ? await journalPins(tx, conversationId, unpinned) : null;
  return { msg: { conversationId, messageId, pts }, pins, keys: gone.map((g) => g.key) };
}

// ─── Реакции ─────────────────────────────────────────────────────────────────────────────────────────────────────────

async function applyReactions(peer: string, self: string, conversationId: string, entity: Record<string, unknown>): Promise<void> {
  const w = parseConvReactionsWire(entity);
  if (!w) return;
  let delivery: Delivery | null = null;
  await db.transaction(async (tx) => {
    const c = await lockFor(tx, conversationId, peer, self);
    if (!c) return;
    const [m] = await tx
      .select({ id: conversationMessages.id, authorId: conversationMessages.authorId, deletedAt: conversationMessages.deletedAt, withheld: conversationMessages.withheld })
      .from(conversationMessages)
      .where(and(eq(conversationMessages.id, w.messageId), eq(conversationMessages.conversationId, conversationId)))
      .limit(1);
    if (!m || m.deletedAt) return;
    // Только люди отдающего соседа: реакции наших людей сосед не правит. Э7 часть 3: хост группы отдаёт ещё людей третьих
    // домов (`fromHost`) — тогда его список заменяет реакции всех действующих участников не с нашего инстанса.
    const fromHost = c.group?.host === false;
    const theirs = c.members.filter((x) => (fromHost ? x.home !== null : x.home === peer)).map((x) => x.id);
    if (theirs.length === 0) return;
    const want = new Set<string>();
    // Аудит ЛС #236, п.4: от соседа — тоже только эмодзи (вид ключа; кастомный — его сервера, проверить нечем) и не больше
    // `REACTIONS_PER_USER_MAX` на человека: лишние сверх первых в списке отбрасываются.
    const { isReactionEmoji, REACTIONS_PER_USER_MAX } = await import('@gusvoice/shared');
    const perUser = new Map<string, number>();
    const take = (id: string, emoji: string) => {
      if (!isReactionEmoji(emoji)) return;
      const key = `${id}\u0000${emoji}`;
      if (want.has(key)) return;
      const n = perUser.get(id) ?? 0;
      if (n >= REACTIONS_PER_USER_MAX) return;
      perUser.set(id, n + 1);
      want.add(key);
    };
    for (const r of w.reactions) {
      if (r.user.instanceId !== peer) continue;
      const who = c.byRef(r.user);
      if (who) take(who.id, r.emoji);
    }
    if (fromHost) {
      const third = new Set(hostedRefs(c, w.reactions.map((r) => r.user), peer, self).map((x) => x.id));
      for (const r of w.reactions) {
        const who = r.user.instanceId === peer ? null : c.byRef(r.user);
        if (who && third.has(who.id)) take(who.id, r.emoji);
      }
    }
    const have = await tx
      .select({ userId: conversationMessageReactions.userId, emoji: conversationMessageReactions.emoji })
      .from(conversationMessageReactions)
      .where(and(eq(conversationMessageReactions.messageId, m.id), inArray(conversationMessageReactions.userId, theirs)));
    const haveSet = new Set(have.map((h) => `${h.userId}\u0000${h.emoji}`));
    const gone = have.filter((h) => !want.has(`${h.userId}\u0000${h.emoji}`));
    const fresh = [...want].filter((k) => !haveSet.has(k)).map((k) => k.split('\u0000') as [string, string]);
    for (const g of gone) {
      await tx
        .delete(conversationMessageReactions)
        .where(
          and(
            eq(conversationMessageReactions.messageId, m.id),
            eq(conversationMessageReactions.userId, g.userId),
            eq(conversationMessageReactions.emoji, g.emoji),
          ),
        );
    }
    if (fresh.length > 0) {
      await tx
        .insert(conversationMessageReactions)
        // Непрочитанная реакция у автора (G24) — как у местной: на своё — сразу увиденная.
        .values(fresh.map(([userId, emoji]) => ({ messageId: m.id, userId, emoji, seenAt: m.authorId === userId ? new Date() : null })))
        .onConflictDoNothing();
    }
    if (gone.length === 0 && fresh.length === 0) return;
    // Блокировка (Э2 часть Б, как местное `reachesPeer`): наш человек, заблокировавший автора реакции, её не получает —
    // ни событием, ни журналом; в истории реакции заблокированного скрыты чтением (`dmReactionsFor`).
    // Э7 часть 3: от хоста группы — блокировка сверяется с теми, чьи реакции изменились, а не со всеми чужими участниками.
    const actors = fromHost ? [...new Set([...gone.map((g) => g.userId), ...fresh.map(([userId]) => userId)])] : theirs;
    const blockedActor = await blockersAmong(tx, c.members.filter((x) => x.home === null).map((x) => x.id), actors);
    const audience = changeAudience({ action: 'react', actorId: theirs[0], memberIds: c.memberIds, withheld: m.withheld, blockedActor });
    const pts = await journal(tx, msgEntries(audience, conversationId, m.id), { fed: false });
    delivery = { conversationId, messageId: m.id, pts };
    // Э7 часть 3: мы хост группы — реакции людей дома участника уходят остальным домам (кроме его).
    if (c.group?.host) await fedRecordRelay(tx, [{ conversationId, kind: FED_CONV_CHANGE_E2.react, entityId: m.id, exceptHome: peer }]);
  });
  await deliver(delivery);
}

// ─── Голоса в опросе (`pollvote`, признак `dmpoll1`) ──────────────────────────────────────────────────────────────────

/**
 * Голоса людей отдающего дома в опросе — по образцу реакций (`applyReactions`): список заменяет голоса тех же людей (от хоста
 * группы — и людей третьих домов, `hostedRefs`), свои голоса наших людей сосед не правит. Вид опроса каждому нашему смотрящему
 * (итоги после своего голоса, правильный ответ викторины — проголосовавшему) считает наша выдача по этому зеркалу
 * (`conversations.messagesForViewer` → `convPollView`): сервер соседа доверенный, как для самих сообщений. Варианты — только этого
 * опроса и один, если «несколько ответов» выключено; закрытие не проверяется (гонка «голос — остановка» решена на доме
 * голосующего, зеркало повторяет его). Событие — `conv.change` всем участникам, как правка (`convPolls.journalPoll`).
 */
async function applyPollVotes(peer: string, self: string, conversationId: string, entity: Record<string, unknown>): Promise<void> {
  const w = parseConvPollVotesWire(entity);
  if (!w) return;
  let delivery: Delivery | null = null;
  await db.transaction(async (tx) => {
    const c = await lockFor(tx, conversationId, peer, self);
    if (!c) return;
    const [m] = await tx
      .select({ id: conversationMessages.id, deletedAt: conversationMessages.deletedAt, withheld: conversationMessages.withheld, media: conversationMessages.media })
      .from(conversationMessages)
      .where(and(eq(conversationMessages.id, w.messageId), eq(conversationMessages.conversationId, conversationId)))
      .limit(1);
    if (!m || m.deletedAt || m.media?.kind !== 'poll') return;
    const poll = m.media;
    const known = new Set(poll.options.map((o) => o.id));
    const fromHost = c.group?.host === false;
    const theirs = c.members.filter((x) => (fromHost ? x.home !== null : x.home === peer)).map((x) => x.id);
    if (theirs.length === 0) return;
    const third = fromHost ? new Set(hostedRefs(c, w.voters.map((v) => v.user), peer, self).map((x) => x.id)) : new Set<string>();
    const want = new Set<string>();
    for (const v of w.voters) {
      const who = c.byRef(v.user);
      if (!who || (v.user.instanceId === peer ? !theirs.includes(who.id) : !third.has(who.id))) continue;
      const opts = v.options.filter((o) => known.has(o));
      for (const o of poll.multi ? opts : opts.slice(0, 1)) want.add(`${who.id}\u0000${o}`);
    }
    const have = await tx
      .select({ userId: convPollVotes.userId, optionId: convPollVotes.optionId })
      .from(convPollVotes)
      .where(and(eq(convPollVotes.messageId, m.id), inArray(convPollVotes.userId, theirs)));
    const haveSet = new Set(have.map((h) => `${h.userId}\u0000${h.optionId}`));
    const gone = have.filter((h) => !want.has(`${h.userId}\u0000${h.optionId}`));
    const fresh = [...want].filter((k) => !haveSet.has(k)).map((k) => k.split('\u0000') as [string, string]);
    for (const g of gone) {
      await tx
        .delete(convPollVotes)
        .where(and(eq(convPollVotes.messageId, m.id), eq(convPollVotes.userId, g.userId), eq(convPollVotes.optionId, g.optionId)));
    }
    if (fresh.length > 0) {
      await tx
        .insert(convPollVotes)
        .values(fresh.map(([userId, optionId]) => ({ messageId: m.id, userId, optionId })))
        .onConflictDoNothing();
    }
    if (gone.length === 0 && fresh.length === 0) return;
    // Голоса заблокированных не прячутся (итог опроса общий, как у местного голоса) — событие всем участникам, как правка.
    const audience = changeAudience({ action: 'edit', actorId: theirs[0], memberIds: c.memberIds, withheld: m.withheld, blockedActor: new Set() });
    const pts = await journal(tx, msgEntries(audience, conversationId, m.id), { fed: false });
    delivery = { conversationId, messageId: m.id, pts };
    // Мы хост группы — голоса людей дома участника уходят остальным домам (кроме его), как реакции.
    if (c.group?.host) await fedRecordRelay(tx, [{ conversationId, kind: FED_CONV_CHANGE_E2.vote, entityId: m.id, exceptHome: peer }]);
  });
  await deliver(delivery);
}

/**
 * Э7 часть 3 (#141, §3.6): люди ТРЕТЬИХ домов из списка хоста группы (`fromHost`) — только действующие участники этой
 * группы, не наши и не самого хоста (его людей разбирает прежний цикл). Подписи дома автора у реакций/«прочитано»/«прослушано»
 * нет: состояние людей третьего дома — со слов хоста (его власть над группой, решение владельца по Э7), но не дальше состава.
 */
function hostedRefs(c: LockedConv, refs: readonly FedPersonRef[], peer: string, self: string): Member[] {
  const out = new Map<string, Member>();
  for (const ref of refs) {
    if (ref.instanceId === peer || ref.instanceId === self) continue;
    const who = c.byRef(ref);
    if (who && who.home !== null && c.memberIds.includes(who.id)) out.set(who.id, who);
  }
  return [...out.values()];
}

// ─── «Прочитано до» ──────────────────────────────────────────────────────────────────────────────────────────────────

async function applyReads(peer: string, self: string, conversationId: string, entity: Record<string, unknown>): Promise<void> {
  const w = parseConvReadsWire(entity);
  if (!w) return;
  let delivery: Delivery | null = null;
  await db.transaction(async (tx) => {
    const c = await lockFor(tx, conversationId, peer, self);
    if (!c) return;
    let moved = false;
    // Э7 часть 3: от хоста группы — ещё «прочитано» людей третьих домов (`hostedRefs`: только действующие участники).
    const hosted = c.group?.host === false ? new Set(hostedRefs(c, w.reads.map((r) => r.user), peer, self).map((x) => x.id)) : new Set<string>();
    for (const r of w.reads) {
      if (r.user.instanceId !== peer && !(hosted.size > 0 && r.user.instanceId !== self)) continue;
      const reader = c.byRef(r.user);
      if (!reader || (r.user.instanceId !== peer && !hosted.has(reader.id))) continue;
      const [m] = await tx
        .select({ sortKey: conversationMessages.sortKey })
        .from(conversationMessages)
        .where(and(eq(conversationMessages.id, r.messageId), eq(conversationMessages.conversationId, conversationId)))
        .limit(1);
      if (!m) continue;
      const [before] = await tx
        .select({ key: conversationMembers.lastReadKey })
        .from(conversationMembers)
        .where(and(eq(conversationMembers.conversationId, conversationId), eq(conversationMembers.userId, reader.id)));
      if (!before || m.sortKey <= Number(before.key)) continue; // только вперёд
      await tx
        .update(conversationMembers)
        .set({ lastReadKey: sql`GREATEST(${conversationMembers.lastReadKey}, ${m.sortKey})` })
        .where(and(eq(conversationMembers.conversationId, conversationId), eq(conversationMembers.userId, reader.id)));
      // «Прочитано в 12:34» (С1) у наших сообщений, которые этот сдвиг накрыл впервые.
      await tx
        .update(conversationMessages)
        .set({ readAt: new Date() })
        .where(
          and(
            eq(conversationMessages.conversationId, conversationId),
            gt(conversationMessages.sortKey, Number(before.key)),
            lte(conversationMessages.sortKey, m.sortKey),
            ne(conversationMessages.authorId, reader.id),
            isNull(conversationMessages.readAt),
          ),
        );
      moved = true;
    }
    if (!moved) return;
    const pts = await journal(
      tx,
      c.memberIds.map((userId) => ({ userId, conversationId, kind: 'read' as const, messageId: null })),
      { fed: false },
    );
    delivery = { conversationId, messageId: null, pts };
    // Э7 часть 3: мы хост группы — «прочитано» людей дома участника уходит остальным домам (кроме его).
    if (c.group?.host) await fedRecordRelay(tx, [{ conversationId, kind: FED_CONV_CHANGE.read, entityId: null, exceptHome: peer }]);
  });
  await deliver(delivery);
}

// ─── «Прослушано» (Э3 часть 3) ───────────────────────────────────────────────────────────────────────────────────────

/**
 * Слушатели-люди соседа нашего голосового или кружка: строки `conversation_voice_listens` людей ЭТОГО соседа заменяются
 * присланным списком (чужое сосед не правит), автору — `conv.change` (у него загорается «прослушано», как в местной ЛС).
 * «Один раз» (`once`), потраченное у слушателя (`spent`: его копия стёрта), — гасится у автора как местный `spendVoiceOnce`: запасная фраза без
 * вложений, `once_spent_at`, файл «удалён» (объект — после фиксации), событие обоим. Блокировка — как у реакций.
 */
/**
 * #226 (`dm2ttl`): одноразовое фото/видео — то же правило, что `isOnceMedia` и фразы `PHOTO_ONCE_SPENT_TEXT` /
 * `VIDEO_ONCE_SPENT_TEXT` в `shared`; повторено здесь, потому что перечень импортов этого модуля закрыт проверкой (R257,
 * `activeLoops.test.ts`).
 */
function onceMediaHere(a: { once?: true; contentType: string; asFile?: true; gif?: true; round?: true }): boolean {
  if (a.once !== true || a.asFile || a.gif || a.round) return false;
  return (a.contentType.startsWith('image/') && a.contentType !== 'image/gif') || a.contentType.startsWith('video/');
}

async function applyListens(peer: string, self: string, conversationId: string, entity: Record<string, unknown>): Promise<void> {
  const w = parseConvListenWire(entity);
  if (!w) return;
  let delivery: Delivery | null = null;
  let purge: string[] = [];
  await db.transaction(async (tx) => {
    const c = await lockFor(tx, conversationId, peer, self);
    if (!c) return;
    const [m] = await tx
      .select({
        id: conversationMessages.id,
        authorId: conversationMessages.authorId,
        deletedAt: conversationMessages.deletedAt,
        withheld: conversationMessages.withheld,
        onceSpentAt: conversationMessages.onceSpentAt,
        attachments: conversationMessages.attachments,
      })
      .from(conversationMessages)
      .where(and(eq(conversationMessages.id, w.messageId), eq(conversationMessages.conversationId, conversationId)))
      .limit(1);
    // Э7 часть 3: мы хост группы, сообщение — человека третьего дома: храним «прослушано» людей дома участника и пересылаем
    // дому автора (у него горит «прослушано», `voiceListenedFor`).
    if (m && !m.deletedAt && c.group?.host && !c.members.some((x) => x.home === null && x.id === m.authorId)) {
      if (m.attachments.some(isListenable)) await relayListens(tx, c, m, w.listeners, peer, conversationId);
      return;
    }
    // Только наше сообщение (автор — местный): «прослушано» на копии сообщения соседа владеет он сам.
    if (!m || m.deletedAt || !c.members.some((x) => x.home === null && x.id === m.authorId)) return;
    if (!m.onceSpentAt && !m.attachments.some(isListenable) && !m.attachments.some(onceMediaHere)) return;
    // Э7 часть 3: от хоста группы — слушатели всех домов, кроме нашего (`hostedRefs`).
    const fromHost = c.group?.host === false;
    const theirs = c.members.filter((x) => (fromHost ? x.home !== null : x.home === peer)).map((x) => x.id);
    if (theirs.length === 0) return;
    const want = new Set<string>();
    for (const u of w.listeners) {
      if (u.instanceId !== peer) continue;
      const who = c.byRef(u);
      if (who && who.id !== m.authorId) want.add(who.id);
    }
    if (fromHost) for (const who of hostedRefs(c, w.listeners, peer, self)) if (who.id !== m.authorId) want.add(who.id);
    const have = await tx
      .select({ userId: conversationVoiceListens.userId })
      .from(conversationVoiceListens)
      .where(and(eq(conversationVoiceListens.messageId, m.id), inArray(conversationVoiceListens.userId, theirs)));
    const haveSet = new Set(have.map((h) => h.userId));
    const gone = have.filter((h) => !want.has(h.userId)).map((h) => h.userId);
    const fresh = [...want].filter((id) => !haveSet.has(id));
    if (gone.length > 0) {
      await tx
        .delete(conversationVoiceListens)
        .where(and(eq(conversationVoiceListens.messageId, m.id), inArray(conversationVoiceListens.userId, gone)));
    }
    if (fresh.length > 0) {
      await tx.insert(conversationVoiceListens).values(fresh.map((userId) => ({ messageId: m.id, userId }))).onConflictDoNothing();
    }
    // #226 (`dm2ttl`): и одноразовое фото/видео — его «потрачено» приходит той же строкой `listen` со `spent`.
    const spend =
      !m.onceSpentAt && w.spent === true && want.size > 0 && m.attachments.some((a) => (a.once === true && isListenable(a)) || onceMediaHere(a));
    if (spend) {
      const media = m.attachments.find(onceMediaHere);
      const spentText = m.attachments.some(isRoundVideo)
        ? ROUND_ONCE_SPENT_TEXT
        : media
          ? media.contentType.startsWith('video/')
            ? 'Видео истекло'
            : 'Фото истекло'
          : VOICE_ONCE_SPENT_TEXT;
      await tx
        .update(conversationMessages)
        .set({ onceSpentAt: new Date(), content: spentText, attachments: [] })
        .where(eq(conversationMessages.id, m.id));
      const dead = await tx
        .update(attachments)
        .set({ state: 'deleted', deletedAt: new Date() })
        .where(and(eq(attachments.messageId, m.id), eq(attachments.state, 'attached')))
        .returning({ key: attachments.storageKey });
      purge = dead.map((d) => d.key);
    } else if (gone.length === 0 && fresh.length === 0) return;
    const blockedActor = spend ? new Set<string>() : await blockersAmong(tx, c.members.filter((x) => x.home === null).map((x) => x.id), fromHost ? [...gone, ...fresh] : theirs);
    const audience = changeAudience({
      action: spend ? 'delete-both' : 'react',
      actorId: theirs[0],
      memberIds: c.memberIds,
      withheld: m.withheld,
      blockedActor,
    });
    const pts = await journal(tx, msgEntries(audience, conversationId, m.id), { fed: false });
    delivery = { conversationId, messageId: m.id, pts };
  });
  if (purge.length > 0) attHooks?.purge(purge);
  await deliver(delivery);
}

/**
 * Э7 часть 3: хост группы — «прослушано» людей дома участника (`peer`) на сообщении человека третьего дома: строки людей
 * `peer` заменяются присланным списком (как в 1:1), дому автора — строка `listen` (`exceptHome`: не обратно). Событий нет:
 * у хоста горит только у автора, а автор — не наш.
 */
async function relayListens(
  tx: Tx,
  c: LockedConv,
  m: { id: string; authorId: string },
  listeners: readonly FedPersonRef[],
  peer: string,
  conversationId: string,
): Promise<void> {
  const theirs = c.members.filter((x) => x.home === peer).map((x) => x.id);
  if (theirs.length === 0) return;
  const want = new Set<string>();
  for (const ref of listeners) {
    const who = ref.instanceId === peer ? c.byRef(ref) : null;
    if (who && who.id !== m.authorId) want.add(who.id);
  }
  const have = await tx
    .select({ userId: conversationVoiceListens.userId })
    .from(conversationVoiceListens)
    .where(and(eq(conversationVoiceListens.messageId, m.id), inArray(conversationVoiceListens.userId, theirs)));
  const gone = have.filter((h) => !want.has(h.userId)).map((h) => h.userId);
  const fresh = [...want].filter((id) => !have.some((h) => h.userId === id));
  if (gone.length > 0) {
    await tx.delete(conversationVoiceListens).where(and(eq(conversationVoiceListens.messageId, m.id), inArray(conversationVoiceListens.userId, gone)));
  }
  if (fresh.length > 0) await tx.insert(conversationVoiceListens).values(fresh.map((userId) => ({ messageId: m.id, userId }))).onConflictDoNothing();
  if (gone.length > 0 || fresh.length > 0) {
    await fedRecordRelay(tx, [{ conversationId, kind: FED_CONV_CHANGE_E2.listen, entityId: m.id, exceptHome: peer }]);
  }
}

// ─── Закреп «у обоих» ────────────────────────────────────────────────────────────────────────────────────────────────

async function applyPin(peer: string, self: string, conversationId: string, entity: Record<string, unknown>): Promise<void> {
  const w = parseConvPinWire(entity);
  if (!w) return;
  let delivery: Delivery | null = null;
  await db.transaction(async (tx) => {
    const c = await lockFor(tx, conversationId, peer, self);
    if (!c) return;
    const [m] = await tx
      .select({ id: conversationMessages.id, deletedAt: conversationMessages.deletedAt })
      .from(conversationMessages)
      .where(and(eq(conversationMessages.id, w.messageId), eq(conversationMessages.conversationId, conversationId)))
      .limit(1);
    if (!m || m.deletedAt) return;
    const rows = await tx
      .select({ userId: conversationPins.userId, forBoth: conversationPins.forBoth })
      .from(conversationPins)
      .where(and(eq(conversationPins.conversationId, conversationId), eq(conversationPins.messageId, m.id)));
    const byUser = new Map(rows.map((r) => [r.userId, r]));
    const changed: string[] = [];
    // Блокировка (Э2 часть Б, как местное `pinAudience`/`unpinTargets`): закреп «у обоих» от заблокированного не ложится
    // нашему человеку, заблокировавшему его, и его снятие не снимает закреп у того.
    // Э7 часть 3: от хоста группы закрепивший может быть человеком третьего дома (`hostedRefs`) — блокировка сверяется с ним.
    const pinner = c.group?.host === false && w.by ? (hostedRefs(c, [w.by], peer, self)[0] ?? null) : null;
    const theirs = pinner ? [pinner.id] : c.members.filter((x) => x.home === peer).map((x) => x.id);
    const blockers = await blockersAmong(tx, c.members.filter((x) => x.home === null).map((x) => x.id), theirs);
    if (w.pinned) {
      const by = pinner ?? (w.by && w.by.instanceId === peer ? c.byRef(w.by) : null) ?? c.members.find((x) => x.home === peer) ?? null;
      if (!by) return;
      for (const u of c.memberIds) {
        if (blockers.has(u)) continue;
        const row = byUser.get(u);
        if (!row) {
          await tx.insert(conversationPins).values({ conversationId, userId: u, messageId: m.id, pinnedBy: by.id, forBoth: true }).onConflictDoNothing();
          changed.push(u);
        } else if (!row.forBoth) {
          await tx
            .update(conversationPins)
            .set({ forBoth: true })
            .where(and(eq(conversationPins.conversationId, conversationId), eq(conversationPins.messageId, m.id), eq(conversationPins.userId, u)));
          changed.push(u);
        }
      }
    } else {
      const drop = rows.filter((r) => r.forBoth && !blockers.has(r.userId)).map((r) => r.userId);
      if (drop.length > 0) {
        await tx
          .delete(conversationPins)
          .where(and(eq(conversationPins.conversationId, conversationId), eq(conversationPins.messageId, m.id), inArray(conversationPins.userId, drop)));
        changed.push(...drop);
      }
    }
    if (changed.length > 0) delivery = await journalPins(tx, conversationId, changed);
    // Э7 часть 3: мы хост группы — закреп «для всех» с дома участника уходит остальным домам (кроме его).
    if (changed.length > 0 && c.group?.host) await fedRecordRelay(tx, [{ conversationId, kind: FED_CONV_CHANGE.pin, entityId: m.id, exceptHome: peer }]);
  });
  await deliver(delivery);
}

/** Кто из `locals` заблокировал кого-то из `actors` — читается в транзакции под замком беседы (как `blockersOf`). */
async function blockersAmong(tx: Tx, locals: readonly string[], actors: readonly string[]): Promise<Set<string>> {
  if (locals.length === 0 || actors.length === 0) return new Set();
  const rows = await tx
    .select({ id: userBlocks.blockerId })
    .from(userBlocks)
    .where(and(inArray(userBlocks.blockerId, [...locals]), inArray(userBlocks.blockedId, [...actors])));
  return new Set(rows.map((r) => r.id));
}

// ─── Подключение ─────────────────────────────────────────────────────────────────────────────────────────────────────

let timer: ReturnType<typeof setInterval> | null = null;

async function pullAll(): Promise<void> {
  const links = await db.select({ instanceId: federationLinks.instanceId, features: federationLinks.features }).from(federationLinks).where(eq(federationLinks.state, 'active'));
  for (const l of links) if (l.features.includes(FED_FEATURES.dm1)) schedulePull(l.instanceId);
}

/**
 * Включить приём (зовёт `index.ts` при `FEDERATION_DM_ENABLED`): обработчик звонка, забор при старте (сосед мог писать,
 * пока мы лежали) и раз в `PULL_EVERY_MS`.
 */
/** `active` (#224): ЛС между инстансами включены прямо сейчас — выключили тумблером в админке, такты и приём пустые. */
export function startConvPull(active: () => boolean = () => true): void {
  onFedEvent(FED_CONV_CHANGED_EVENT, async ({ instanceId, event }) => {
    if (!active()) return;
    schedulePull(instanceId, parseConvChangedPayload(event.payload)?.seq ?? 0);
  });
  // Э2 часть Б: связка снова рабочая — забрать пропущенное и позвонить соседу (он заберёт у нас и снимет свою отметку).
  onLinkRestored((instanceId) => {
    if (!active()) return;
    schedulePull(instanceId);
    ringDoorbell(instanceId, 0);
  });
  if (timer) return;
  const pass = () => {
    if (active()) void pullAll().catch(() => {});
  };
  setTimeout(pass, 5_000).unref?.();
  timer = setInterval(pass, PULL_EVERY_MS);
  timer.unref?.();
}
