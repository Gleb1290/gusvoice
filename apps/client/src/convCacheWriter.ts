import type { ConvMessage } from '@gusvoice/shared';
import { writeConvCache } from './convCache';
import { buildRecord } from './convCacheRules';
import { toPersisted } from './outboxRules';
import { useStore } from './store';

/**
 * ЛС, этап 2 (шаг 2б): запись кеша бесед по изменениям стора (`docs/dm/STAGE2.md`).
 *
 * Не чаще раза в секунду (и не реже раза в пять, пока изменения идут подряд), а при уходе вкладки в фон — сразу: на
 * телефоне и в свёрнутом десктопе фон часто и есть конец жизни страницы. Пишется только в режиме бесед и только
 * когда список уже загружен (есть номер журнала).
 */

const DEBOUNCE_MS = 1000;
const MAX_WAIT_MS = 5000;

let started = false;
/** Срочная запись незаписанного (фон, выгрузка, переход в другой инстанс); `null` — писатель не запущен. */
let urgent: (() => void) | null = null;
const beforeUrgent = new Set<() => void>();
const afterUrgent = new Set<() => void>();

/**
 * Отложенное, что обязано успеть в срочную запись: черновик ленты ждёт 300 мс (`createDraftSaver`) и без этого
 * пропадал бы вместе со сбросом бесед. Возвращает отписку.
 */
export function onConvCacheUrgent(fn: () => void): () => void {
  beforeUrgent.add(fn);
  return () => {
    beforeUrgent.delete(fn);
  };
}

/**
 * То, что идёт ПОСЛЕ срочной записи — когда отложенное уже в сторе: черновики на сервер (Р7, `convFlushDrafts`), иначе
 * последние буквы перед закрытием окна до других устройств не доехали бы. Возвращает отписку.
 */
export function onConvCacheFlushed(fn: () => void): () => void {
  afterUrgent.add(fn);
  return () => {
    afterUrgent.delete(fn);
  };
}

/**
 * Записать кеш бесед СЕЙЧАС — ключом ещё активного инстанса. 🔴 Переход в другой инстанс (`instanceSwitch`) сразу
 * следом сбрасывает беседы (`convReset`): черновик и неотправленное последней секунды до диска не доходили — запись
 * откладывается на секунду, — и при возврате их не было.
 */
export function flushConvCacheNow(): void {
  for (const fn of [...beforeUrgent]) fn();
  urgent?.();
  for (const fn of [...afterUrgent]) fn();
}

export function startConvCacheWriter(): void {
  if (started) return;
  started = true;
  let timer: ReturnType<typeof setTimeout> | null = null;
  let firstDirty = 0;

  const flush = () => {
    if (timer) clearTimeout(timer);
    timer = null;
    firstDirty = 0;
    const s = useStore.getState();
    if (!s.convActive || !s.convCacheKey) return;
    const outbox = Object.values(s.outbox).flat().map(toPersisted);
    const rec = buildRecord(
      s.conv,
      s.dmMessages as Record<string, ConvMessage[]>,
      Date.now(),
      outbox,
      s.drafts,
      s.places,
      s.draftDirty,
    );
    if (rec) void writeConvCache(s.convCacheKey, rec);
  };

  const schedule = () => {
    const now = Date.now();
    if (!firstDirty) firstDirty = now;
    if (timer) clearTimeout(timer);
    const wait = Math.min(DEBOUNCE_MS, Math.max(0, firstDirty + MAX_WAIT_MS - now));
    timer = setTimeout(flush, wait);
  };

  useStore.subscribe((s, prev) => {
    if (!s.convActive) return;
    if (
      s.conv !== prev.conv ||
      s.dmMessages !== prev.dmMessages ||
      s.outbox !== prev.outbox ||
      s.drafts !== prev.drafts ||
      s.places !== prev.places ||
      s.draftDirty !== prev.draftDirty
    )
      schedule();
  });

  // Изменений после прошлой записи нет — на диске уже то же самое.
  urgent = () => {
    if (timer) flush();
  };

  try {
    document.addEventListener('visibilitychange', () => {
      if (document.visibilityState === 'hidden') flushConvCacheNow();
    });
    window.addEventListener('pagehide', () => flushConvCacheNow());
  } catch {
    /* без окна — только по таймеру */
  }
}
