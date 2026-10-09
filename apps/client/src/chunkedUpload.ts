import type { Attachment } from '@gusvoice/shared';

/**
 * Загрузка файла ЛС кусками (`bigfile1`, 09.10; решение владельца: файл до 500 МБ+, у Telegram 2 ГБ). Сервер — S3 multipart
 * через бэкенд (`packages/backend/src/routes/uploads.ts`): начать → куски `PUT …/parts/:n` (по 3 разом) → собрать.
 *
 * - Обрыв куска (сеть, 5xx, 429, тишина дольше `STALL_MS`) — повтор этого куска с паузой (`RETRY_MS`), не всего файла.
 * - Исчерпали повторы — ошибка «нет связи» (`TypeError`, как у `fetch`): очередь ЛС повторит отправку позже, и ЭТОТ ЖЕ
 *   файл продолжится с недостающих кусков (`sessions`, сервер говорит, какие уже лежат), а не заново.
 * - Сервер занят (429/503 с `Retry-After`: пропуск памяти кусков, ревью H1) — ждём сколько сказано, до `BUSY_RETRIES` раз,
 *   не тратя повторы на обрыв.
 * - Сборка уже идёт (202 `{ assembling }`: повтор после 504 прокси на долгой сборке) — спрашиваем снова раз в `ASSEMBLY_POLL_MS`.
 * - Сервер не знает загрузку после обрыва (404 статуса) — сначала один раз «собрать»: она могла собраться, а ответ потеряться
 *   (тогда вложение уже есть и квота списана); только потом — заново.
 * - Отмена (`signal`) — текущие куски обрываются, загрузка на сервере бросается (`DELETE`).
 * - Прогресс — байты всех кусков (готовых + идущих) от размера файла.
 *
 * Модуль без DOM-зависимостей в логике: транспорт и таймеры — снаружи (`ChunkDeps`), чтобы прогнать в Node.
 */

/** С какого размера файл идёт кусками (меньше — прежним одним запросом). Равен куску сервера. */
export const CHUNK_FROM_BYTES = 8 * 1024 * 1024;
/** Сколько кусков одного файла в пути разом. */
export const CHUNK_PARALLEL = 3;
/** Паузы перед повторами куска; длина — число повторов. */
export const RETRY_MS = [1000, 2000, 4000, 8000, 15000] as const;
/** Кусок без единого байта прогресса дольше этого — считаем оборванным и повторяем (смена сети на телефоне «висит», а не падает). */
export const STALL_MS = 45_000;
/** Сколько раз кусок ждёт «сервер занят» (429/503 с `Retry-After`) сверх обычных повторов. */
export const BUSY_RETRIES = 60;
/** Пауза между вопросами «собралось?», пока сервер собирает файл (202 `assembling`), и сколько раз спросить (≈ 15 мин). */
export const ASSEMBLY_POLL_MS = 3000;
export const ASSEMBLY_POLLS = 300;

export interface ChunkOpts {
  onProgress?: (loaded: number, total: number) => void;
  signal?: AbortSignal;
}

export interface ChunkDeps {
  /** JSON-запрос к API (`/api` + путь); ошибка — `Error` с `status`. */
  req<T>(method: string, path: string, body?: unknown): Promise<T>;
  /** Сырые байты куска (`PUT`, `application/octet-stream`) с прогрессом и отменой; ответ — как у `fetch`. */
  putPart(path: string, body: Blob, opts: ChunkOpts): Promise<Response>;
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
}

interface StartReply {
  uploadId: string;
  partSize: number;
  parts: number;
}
interface StatusReply extends StartReply {
  size: number;
  done: number[];
}

/** Незаконченные загрузки этой страницы: файл → загрузка на сервере (повтор отправки продолжает её). */
const sessions = new WeakMap<Blob, { convId: string; uploadId: string }>();

function aborted(): Error & { aborted: true } {
  return Object.assign(new Error('загрузка отменена'), { name: 'AbortError', aborted: true as const });
}

function offline(): TypeError {
  return new TypeError('Failed to fetch');
}

/** Можно ли повторить кусок после этой ошибки: сеть, тишина, 5xx, 429, 408. Остальные 4xx — нет. */
export function retryablePartError(e: unknown): boolean {
  if (e instanceof TypeError) return true;
  const status = (e as { status?: number } | null)?.status;
  if ((e as { stalled?: boolean } | null)?.stalled) return true;
  return status === undefined || status === 408 || status === 429 || status >= 500;
}

/** Номера кусков, которые ещё надо залить (по порядку). */
export function partsToSend(parts: number, done: readonly number[]): number[] {
  const have = new Set(done);
  const out: number[] = [];
  for (let n = 1; n <= parts; n++) if (!have.has(n)) out.push(n);
  return out;
}

/** Границы куска `n` (с 1) в файле. */
export function partRange(size: number, partSize: number, n: number): { start: number; end: number } {
  const start = (n - 1) * partSize;
  return { start, end: Math.min(size, start + partSize) };
}

async function errorOf(res: Response): Promise<Error & { status: number; retryAfter?: number }> {
  const data = (await res.json().catch(() => ({}))) as { error?: string };
  const retryAfter = Number(res.headers?.get?.('Retry-After')) || 0;
  return Object.assign(new Error(data.error || `HTTP ${res.status}`), { status: res.status }, retryAfter > 0 ? { retryAfter } : {});
}

/** Ответ сборки «ещё собирается» (202): сервер уже собирает этот файл по прошлому запросу. */
function isAssembling(r: unknown): boolean {
  return (r as { assembling?: unknown } | null)?.assembling === true;
}

/** Загрузить файл кусками в беседу `convId`. Ответ — DTO вложения, как у одиночной загрузки. */
export async function uploadInChunks(deps: ChunkDeps, convId: string, file: File, opts: ChunkOpts = {}): Promise<Attachment> {
  const sleep = deps.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const signal = opts.signal;
  if (signal?.aborted) throw aborted();
  const base = `/conv/${encodeURIComponent(convId)}/uploads`;

  /** Собрать: ответ сборки, пока сервер говорит «собирается», — ждать и спрашивать снова. */
  const assemble = async (path: string): Promise<Attachment> => {
    for (let poll = 0; ; poll++) {
      if (signal?.aborted) throw aborted();
      const r = await deps.req<Attachment>('POST', `${path}/complete`);
      if (!isAssembling(r)) return r;
      if (poll >= ASSEMBLY_POLLS) throw offline();
      await sleep(ASSEMBLY_POLL_MS);
    }
  };

  // Продолжение после обрыва: спросить сервер, какие куски уже лежат. Нет загрузки — она могла собраться, а ответ
  // потеряться: один раз «собрать» (вернёт готовое вложение); и тут нет (истекла, отменена) — заново.
  let st: StatusReply | null = null;
  const prev = sessions.get(file);
  if (prev && prev.convId === convId) {
    const prevPath = `${base}/${prev.uploadId}`;
    st = await deps.req<StatusReply>('GET', prevPath).catch((e: { status?: number }) => {
      if (e?.status === 404) return null;
      throw e;
    });
    if (!st) {
      const att = await assemble(prevPath).catch((e: { status?: number }) => {
        if (e?.status === 404) return null;
        throw e;
      });
      sessions.delete(file);
      if (att) {
        opts.onProgress?.(file.size, file.size);
        return att;
      }
    }
  }
  if (!st) {
    const r = await deps.req<StartReply>('POST', base, { name: file.name || 'file', size: file.size, type: file.type || undefined });
    st = { ...r, size: file.size, done: [] };
    sessions.set(file, { convId, uploadId: r.uploadId });
  }
  const { uploadId, partSize } = st;
  const path = `${base}/${uploadId}`;

  const cancelOnServer = () => {
    sessions.delete(file);
    void deps.req('DELETE', path).catch(() => {});
  };

  // Прогресс: готовые куски целиком + текущие байты идущих.
  let doneBytes = st.done.reduce((sum, n) => sum + (partRange(file.size, partSize, n).end - partRange(file.size, partSize, n).start), 0);
  const inflight = new Map<number, number>();
  // Показанное не убывает: оборванный кусок уходит из `inflight`, и сумма падает — полоса не должна ползти назад
  // (находка Codex R127); повтор куска догонит показанное своими байтами.
  let shown = 0;
  const report = () => {
    let sum = doneBytes;
    for (const v of inflight.values()) sum += v;
    shown = Math.max(shown, Math.min(sum, file.size));
    opts.onProgress?.(shown, file.size);
  };
  report();

  const sendPart = async (n: number): Promise<void> => {
    const { start, end } = partRange(file.size, partSize, n);
    const blob = file.slice(start, end);
    let busyWaits = 0;
    for (let attempt = 0; ; attempt++) {
      if (signal?.aborted) throw aborted();
      // Своя отмена на попытку: тишина дольше `STALL_MS` рвёт только её, отмена человека — всё.
      const ctrl = new AbortController();
      const stopAll = () => ctrl.abort();
      signal?.addEventListener('abort', stopAll, { once: true });
      let stalled = false;
      let timer: ReturnType<typeof setTimeout> | undefined;
      const arm = () => {
        if (timer) clearTimeout(timer);
        timer = setTimeout(() => {
          stalled = true;
          ctrl.abort();
        }, STALL_MS);
      };
      arm();
      try {
        const res = await deps.putPart(`${path}/parts/${n}`, blob, {
          signal: ctrl.signal,
          onProgress: (loaded) => {
            arm();
            inflight.set(n, loaded);
            report();
          },
        });
        if (!res.ok) throw await errorOf(res);
        inflight.delete(n);
        doneBytes += end - start;
        report();
        return;
      } catch (e) {
        inflight.delete(n);
        report();
        if (signal?.aborted) throw aborted();
        const err = stalled ? Object.assign(new Error('кусок завис'), { stalled: true }) : e;
        if (!retryablePartError(err)) throw err;
        const retryAfter = Number((err as { retryAfter?: number }).retryAfter) || 0;
        const status = (err as { status?: number }).status;
        // «Сервер занят» с указанной паузой — не обрыв: ждём сказанное, повторы на обрыв не тратим.
        if ((status === 429 || status === 503) && retryAfter > 0 && busyWaits < BUSY_RETRIES) {
          busyWaits++;
          attempt--;
          await sleep(retryAfter * 1000);
          continue;
        }
        if (attempt >= RETRY_MS.length) throw offline();
        await sleep(Math.max(RETRY_MS[attempt], retryAfter * 1000));
      } finally {
        if (timer) clearTimeout(timer);
        signal?.removeEventListener('abort', stopAll);
      }
    }
  };

  const runParts = async (list: number[]): Promise<void> => {
    const queue = [...list];
    let failure: unknown = null;
    const worker = async () => {
      while (queue.length > 0 && failure === null) {
        const n = queue.shift()!;
        try {
          await sendPart(n);
        } catch (e) {
          failure ??= e;
        }
      }
    };
    await Promise.all(Array.from({ length: Math.min(CHUNK_PARALLEL, list.length) }, worker));
    if (failure !== null) throw failure;
  };

  try {
    await runParts(partsToSend(st.parts, st.done));
    // Сборка; 409 — сервер не досчитался кусков (ответ потерялся) — спросить, каких нет, долить и собрать ещё раз.
    for (let round = 0; ; round++) {
      if (signal?.aborted) throw aborted();
      try {
        const att = await assemble(path);
        sessions.delete(file);
        opts.onProgress?.(file.size, file.size);
        return att;
      } catch (e) {
        const missing =
          (e as { status?: number }).status === 409 && round < 2
            ? await deps.req<StatusReply>('GET', path).then((s) => partsToSend(s.parts, s.done))
            : null;
        if (missing && missing.length > 0) {
          for (const n of missing) doneBytes -= partRange(file.size, partSize, n).end - partRange(file.size, partSize, n).start;
          await runParts(missing);
          continue;
        }
        if (retryablePartError(e) && round < 2) {
          await sleep(RETRY_MS[round]);
          continue;
        }
        throw e;
      }
    }
  } catch (e) {
    if ((e as { aborted?: boolean } | null)?.aborted || signal?.aborted) {
      cancelOnServer();
      throw aborted();
    }
    // Не повторяемая ошибка (413, 404 загрузки, 400) — загрузка бесполезна, бросить её на сервере.
    if (!retryablePartError(e)) cancelOnServer();
    throw e;
  }
}
