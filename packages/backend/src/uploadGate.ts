/**
 * Пропуск кусков загрузки в память процесса (ревью безопасности `bigfile1`, H1, 09.10). Тело куска (до 8 МиБ) читается в
 * буфер, поэтому ДО чтения тела ручка (`routes/uploads.ts`, `onRequest`) берёт здесь билет: не больше `PER_USER` кусков
 * одного человека разом и не больше `TOTAL_BYTES` байт кусков на весь процесс. Нет места — отказ сразу, тело не читается:
 * человеку — 429 (своё ограничение), всем — 503 (процесс занят); оба с `Retry-After`, клиент повторяет кусок.
 *
 * Билет держится, пока не закрыт ответ И не завершились отданные ему операции хранилища (`track`): у S3-клиента нет отмены,
 * и после тайм-аута ручки буфер куска ещё держит подвисший запрос к хранилищу — место освобождается, когда тот отпустит
 * (или через `HOLD_CAP_MS`, если хранилище не ответит никогда, — иначе одно зависание закрыло бы приём насовсем).
 *
 * Чистый модуль: без базы, Redis и Fastify — проверяется в Node как есть.
 */

/** Кусков одного человека в пути разом (у клиента 3 на файл; второй файл альбома ждёт с `Retry-After`). */
export const UPLOAD_GATE_PER_USER = 4;
/** Байт кусков в памяти процесса разом (32 куска по 8 МиБ). */
export const UPLOAD_GATE_TOTAL_BYTES = 256 * 1024 * 1024;
/** Дольше этого билет не держится операцией хранилища, которая так и не завершилась. */
export const UPLOAD_GATE_HOLD_CAP_MS = 5 * 60_000;

export interface GateTicket {
  /** Ответ закрыт (отдан или оборван). Повторный вызов — ничего. */
  release(): void;
  /** Держать билет, пока идёт операция `p` (не дольше `HOLD_CAP_MS`); результат — тот же промис. */
  track<T>(p: Promise<T>): Promise<T>;
}

export type GateRefusal = { code: 429 | 503; retryAfter: number; error: string };

export interface UploadGate {
  acquire(userId: string, bytes: number): GateTicket | GateRefusal;
  /** Сейчас в пути: байт всего и кусков человека (для замеров и тестов). */
  usage(userId?: string): { bytes: number; mine: number };
}

export function createUploadGate(perUser = UPLOAD_GATE_PER_USER, totalBytes = UPLOAD_GATE_TOTAL_BYTES, holdCapMs = UPLOAD_GATE_HOLD_CAP_MS): UploadGate {
  let inFlight = 0;
  const perUserCount = new Map<string, number>();
  return {
    acquire(userId, bytes) {
      const mine = perUserCount.get(userId) ?? 0;
      if (mine >= perUser) return { code: 429, retryAfter: 1, error: 'Слишком много кусков разом — повторите чуть позже' };
      if (inFlight + bytes > totalBytes) return { code: 503, retryAfter: 2, error: 'Сервер занят приёмом файлов — повторите чуть позже' };
      inFlight += bytes;
      perUserCount.set(userId, mine + 1);
      // Держатели: ответ (1) + каждая отслеживаемая операция. Ноль — место свободно.
      let holders = 1;
      let freed = false;
      let responded = false;
      const drop = () => {
        if (freed) return;
        holders--;
        if (holders > 0) return;
        freed = true;
        inFlight -= bytes;
        const left = (perUserCount.get(userId) ?? 1) - 1;
        if (left > 0) perUserCount.set(userId, left);
        else perUserCount.delete(userId);
      };
      return {
        release() {
          if (responded) return;
          responded = true;
          drop();
        },
        track<T>(p: Promise<T>): Promise<T> {
          if (freed) return p;
          holders++;
          let once = false;
          const done = () => {
            if (once) return;
            once = true;
            clearTimeout(cap);
            drop();
          };
          const cap = setTimeout(done, holdCapMs);
          cap.unref?.();
          p.then(done, done);
          return p;
        },
      };
    },
    usage(userId) {
      return { bytes: inFlight, mine: userId ? (perUserCount.get(userId) ?? 0) : 0 };
    },
  };
}

/** Пропуск процесса (один на бэкенд). */
export const uploadGate = createUploadGate();
