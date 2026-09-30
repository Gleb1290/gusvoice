/**
 * Точки остановки внутри транзакций ЛС — только для тестов гонок (просьба Codex 28.09, #212).
 *
 * Гонка «удалить у обоих» против одновременной отправки держится на замке строки беседы (`FOR UPDATE` в
 * `routes/dm.ts`) и на `GREATEST` при отправке. На одном соединении PGlite две транзакции вперемешку не пустить,
 * поэтому тест останавливает одну в заданной точке и решает, что случится до её фиксации.
 *
 * В бою обе точки пустые: вызов — одна проверка на `undefined`, ни ожидания, ни побочных эффектов.
 */
export interface DmWriteBarrier {
  /** Удаление «у обоих»: строка беседы уже под замком, сообщение ещё не удалено. */
  afterDeleteLock?: () => Promise<void>;
  /** Отправка: сообщение вставлено, время беседы ещё не сдвинуто. */
  afterSendInsert?: () => Promise<void>;
}

export const dmWriteBarrier: DmWriteBarrier = {};

/** Поставить точки на время теста; `{}` — снять обе. */
export function setDmWriteBarrierForTests(b: DmWriteBarrier): void {
  dmWriteBarrier.afterDeleteLock = b.afterDeleteLock;
  dmWriteBarrier.afterSendInsert = b.afterSendInsert;
}
