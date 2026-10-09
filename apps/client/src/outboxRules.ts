import type { Attachment } from '@gusvoice/shared';
import type { OutgoingMessage } from './outgoingRules';

/**
 * ЛС, этап 2 (шаг 2в): исходящие бесед — чистые правила очереди (`docs/dm/STAGE2.md`, «Отправка»).
 *
 * Раньше строка «в пути» жила в состоянии ленты (`MessagePane`) и пропадала при смене беседы, входе в голос и
 * перезагрузке, а повтор был только ручным. Теперь очередь — в сторе по беседе и в записи кеша на диске:
 * - отправка строго по порядку внутри беседы: следующая ждёт, пока предыдущая либо ушла, либо окончательно не ушла;
 * - сбой сети, 5xx, 429 — автоповтор с растущей паузой ТЕМ ЖЕ id отправки (сервер вернёт 200 и то же сообщение, если
 *   первая попытка на самом деле дошла); отказ по существу (4xx) — сразу «не отправлено» с «Повторить»/«Удалить»;
 * - без связи (нет сети у устройства, шлюз оборван) или запрос не дошёл дважды подряд — «не отправлено» сразу, без
 *   минуты ожидания, а когда связь вернётся — уходит само тем же id (05.10, `afterFailure` / `afterReconnect`);
 * - после перезапуска строка с уже загруженными файлами (или без файлов) уходит сама, а с незагруженным файлом — «не
 *   отправлено»: самих файлов на диске нет (Р7 откладывает вложения в черновике).
 */

/** Загруженное вложение строки — ровно то, что уйдёт в `attachments` отправки. */
export type OutboxRef = Pick<Attachment, 'width' | 'height' | 'waveform' | 'durationMs' | 'asFile' | 'spoiler'> & { id: string };

export interface OutboxItem extends OutgoingMessage<File> {
  convId: string;
  createdAt: number;
  attempts: number;
  /** Загруженные файлы по индексу — повтор их не перезаливает (иначе другой хеш и 409 вместо 200). */
  uploaded: (OutboxRef | undefined)[];
  /** Имена файлов — для подписи строки, в том числе после перезапуска, когда самих файлов уже нет. */
  fileNames: string[];
  /** Ждёт автоповтора до этого момента (мс); `0` — можно слать сейчас. */
  retryAt: number;
  /**
   * «Отправить без звука» (С3, раунд 12 порция 8): уйдёт с `silent: true`. Поле только у таких; на диск пишется вместе со
   * строкой (повтор после перезапуска — тоже без звука). В отпечаток повтора сервер флаг не берёт — повтор тем же id
   * отдаст сообщение как есть.
   */
  silent?: true;
  /**
   * «Отправить как файлы» (G48, `linkprev1`): вложения-картинки и видео уйдут подсказкой `asFile` (карточкой файла). Поле
   * только у таких; на диск пишется со строкой, как `silent`.
   */
  asFile?: true;
  /** «Без превью ссылки» (G19, `linkprev1`): уйдёт с `noPreview: true`. Поле только у таких; на диск — как `silent`. */
  noPreview?: true;
  /**
   * Спойлер (G48, `media2`): индексы файлов строки, чьи вложения уйдут с `spoiler: true`. Поле только у таких; на диск пишется
   * со строкой, как `silent`.
   */
  spoilers?: number[];
  /** «Подпись над медиа» (G48, `media2`): уйдёт с `captionAbove: true`. Поле только у таких; на диск — как `silent`. */
  captionAbove?: true;
  /** Цитата фрагмента (G55, `quote1`): уйдёт `replyQuote` вместе с `replyToId`. Поле только у таких; на диск — как `silent`. */
  replyQuote?: { text: string; offset: number };
  /**
   * «Не отправлено» из-за связи (`afterFailure` без связи или запрос не дошёл): связь вернётся — уйдёт само
   * (`afterReconnect`), как очередь без сети у Telegram. Поле только у таких; на диск пишется вместе со строкой.
   */
  netFail?: true;
}

/** То, что пишется на диск: без самих файлов. */
export type PersistedOutboxItem = Omit<OutboxItem, 'files'>;

export const OUTBOX_MAX_ATTEMPTS = 6;
const RETRY_STEPS_MS = [1_000, 2_000, 5_000, 10_000, 30_000, 60_000];

/** Пауза перед повтором после `attempts` неудач. */
export function retryDelay(attempts: number): number {
  return RETRY_STEPS_MS[Math.min(Math.max(attempts - 1, 0), RETRY_STEPS_MS.length - 1)];
}

/**
 * Повторять ли самим. Нет ответа (сеть), 5xx, 408, 429 — временное: повторяем. Остальные 4xx — ответ по существу
 * (пусто, слишком длинно, нет доступа, заблокирован, 409 конфликт id) — повтор ничего не изменит.
 */
export function isTransient(status: number | undefined): boolean {
  if (status === undefined || status === 0) return true;
  return status >= 500 || status === 408 || status === 429;
}

export function newOutboxItem(
  convId: string,
  input: {
    key: string;
    content: string;
    files: File[];
    replyToId: string | null;
    silent?: boolean;
    asFile?: boolean;
    noPreview?: boolean;
    spoilers?: number[];
    captionAbove?: boolean;
    replyQuote?: { text: string; offset: number } | null;
  },
  now: number,
): OutboxItem {
  return {
    ...(input.replyQuote && input.replyToId ? { replyQuote: { text: input.replyQuote.text, offset: input.replyQuote.offset } } : {}),
    ...(input.silent ? { silent: true as const } : {}),
    ...(input.asFile ? { asFile: true as const } : {}),
    ...(input.noPreview ? { noPreview: true as const } : {}),
    ...(input.spoilers?.length ? { spoilers: input.spoilers } : {}),
    ...(input.captionAbove ? { captionAbove: true as const } : {}),
    key: input.key,
    convId,
    content: input.content,
    files: input.files,
    fileNames: input.files.map((f) => f.name),
    replyToId: input.replyToId,
    status: 'sending',
    error: null,
    createdAt: now,
    attempts: 0,
    uploaded: [],
    retryAt: 0,
  };
}

/**
 * Какую строку беседы слать сейчас. Порядок строгий: первая «в пути» строка — голова; ждёт паузы повтора — ничего не
 * шлём (следующая не обгоняет её). Окончательно не ушедшие («не отправлено») очередь не держат.
 */
export function nextToSend(list: readonly OutboxItem[], now: number): { item: OutboxItem | null; waitMs: number } {
  const head = list.find((x) => x.status === 'sending');
  if (!head) return { item: null, waitMs: 0 };
  if (head.retryAt > now) return { item: null, waitMs: head.retryAt - now };
  return { item: head, waitMs: 0 };
}

/**
 * Сколько раз подряд запрос может не дойти (нет ответа: сеть, таймаут), пока связь на вид есть, — дальше «не отправлено».
 * 🔴 Раньше и без сети строка ждала все шесть попыток с паузами 1→2→5→10→30 с: «Не отправлено» появлялось через 48 с
 * (замечание владельца 05.10, стенд: и в вебе, и в виде телефона), а у зависшего запроса — ещё позже.
 */
export const OUTBOX_NET_ATTEMPTS = 2;
/** Причина у не ушедшего из-за связи — словами, а не сырым «Failed to fetch» браузера. */
export const NO_CONNECTION_ERROR = 'нет связи с сервером';

/**
 * Неудача попытки: временная — ждать повтора (до предела попыток), по существу — «не отправлено». Без связи (`offline`: у
 * устройства нет сети или шлюз оборван) временная неудача — «не отправлено» сразу, а запрос, не дошедший
 * `OUTBOX_NET_ATTEMPTS` раз подряд, — после стольких попыток; такая строка помечена `netFail` и уйдёт сама, когда связь
 * вернётся (`afterReconnect`).
 */
export function afterFailure(
  item: OutboxItem,
  status: number | undefined,
  error: string,
  now: number,
  offline = false,
): OutboxItem {
  const attempts = item.attempts + 1;
  if (isTransient(status)) {
    const unreached = status === undefined || status === 0;
    if (offline || (unreached && attempts >= OUTBOX_NET_ATTEMPTS)) {
      return { ...item, attempts, status: 'failed', error: NO_CONNECTION_ERROR, retryAt: 0, netFail: true };
    }
    if (attempts < OUTBOX_MAX_ATTEMPTS) return { ...item, attempts, retryAt: now + retryDelay(attempts), error };
  }
  return { ...item, attempts, status: 'failed', error, retryAt: 0 };
}

/** «Повторить» вручную — с нуля попыток и без паузы. */
export function manualRetry(item: OutboxItem): OutboxItem {
  const { netFail: _netFail, ...rest } = item;
  return { ...rest, status: 'sending', error: null, attempts: 0, retryAt: 0 };
}

/**
 * Связь вернулась (`online` окна, `ready` шлюза): не ушедшее из-за связи (`netFail`) уходит само, как по «Повторить», в
 * прежнем порядке. Отказы по существу остаются. Возвращать нечего — тот же список (стор не перерисовывается).
 */
export function afterReconnect(list: readonly OutboxItem[]): readonly OutboxItem[] {
  if (!list.some((x) => x.netFail && x.status === 'failed')) return list;
  return list.map((x) => (x.netFail && x.status === 'failed' ? manualRetry(x) : x));
}

export function toPersisted(item: OutboxItem): PersistedOutboxItem {
  const { files: _files, ...rest } = item;
  return rest;
}

/**
 * Строка с диска после перезапуска. Все файлы были загружены (или файлов нет) — уходит сама тем же id отправки.
 * Какой-то файл загрузиться не успел — самого файла уже нет: «не отправлено», выбрать заново.
 */
export function restoreItem(p: PersistedOutboxItem): OutboxItem {
  const lost = p.fileNames.some((_, i) => !p.uploaded[i]);
  const base: OutboxItem = { ...p, files: [], retryAt: 0 };
  if (lost) return { ...base, status: 'failed', error: 'файл не загрузился — прикрепите его снова' };
  return p.status === 'sending' ? { ...base, attempts: 0 } : base;
}
