import type { db } from './db/index.js';

/**
 * Точки остановки внутри транзакций ЛС — только для тестов гонок (просьбы Codex 28.09, #212, и 04.10, `conv5`).
 *
 * Гонка «удалить у обоих» против одновременной отправки держится на замке строки беседы (`FOR UPDATE` в
 * `conversations.ts`) и на `GREATEST` при отправке. На одном соединении PGlite две транзакции вперемешку не пустить,
 * поэтому тест останавливает одну в заданной точке и решает, что случится до её фиксации.
 *
 * Точкам с `tx` дана сама транзакция: PGlite выполняет запросы по очереди (и запрос мимо транзакции ждёт её конца),
 * поэтому «чужую» запись между двумя шагами там можно вклинить только ИЗНУТРИ этой транзакции. На настоящем Postgres с
 * независимыми соединениями та же точка — место, где тест отпускает вторую транзакцию.
 *
 * В бою все точки пустые: вызов — одна проверка на `undefined`, ни ожидания, ни побочных эффектов.
 */
export type BarrierTx = Parameters<Parameters<typeof db.transaction>[0]>[0];

export interface DmWriteBarrier {
  /** Удаление «у обоих»: строка беседы уже под замком, сообщение ещё не удалено. */
  afterDeleteLock?: () => Promise<void>;
  /** Отправка: сообщение вставлено, время беседы ещё не сдвинуто. */
  afterSendInsert?: () => Promise<void>;
  /**
   * Загрузка вложения (`attachments.createPending`): незавершённые владельца выбраны, кого вытеснить — решено
   * (`evict`), UPDATE вытеснения ещё не было. Здесь тест привязывает вытесняемую строку к сообщению (`pending` →
   * `attached`, как параллельная отправка или пересылка) и проверяет, что вытеснение её не пометит удалённой.
   */
  beforePendingEvict?: (p: { tx: BarrierTx; evict: readonly string[] }) => Promise<void>;
  /**
   * Пересылка (`conversations.forwardMessages`): беседа-получатель под замком, повтор, источник и копии проверены,
   * пачки ещё нет. Тот же id отправки, вставленный здесь в другой беседе, — гонка: вставка пропустит конфликт
   * (`ON CONFLICT DO NOTHING`), пачка откатится, ответ — 409, а не 500.
   */
  beforeForwardInsert?: (p: { tx: BarrierTx }) => Promise<void>;
  /**
   * Пересылка: пачка вставлена, но не зафиксирована. Независимая транзакция с тем же id отправки в другой беседе ждёт
   * здесь на уникальном ключе `(автор, client_id)` и после фиксации этой получает 409.
   */
  afterForwardInsert?: () => Promise<void>;
}

export const dmWriteBarrier: DmWriteBarrier = {};

/** Поставить точки на время теста; `{}` — снять все. */
export function setDmWriteBarrierForTests(b: DmWriteBarrier): void {
  dmWriteBarrier.afterDeleteLock = b.afterDeleteLock;
  dmWriteBarrier.afterSendInsert = b.afterSendInsert;
  dmWriteBarrier.beforePendingEvict = b.beforePendingEvict;
  dmWriteBarrier.beforeForwardInsert = b.beforeForwardInsert;
  dmWriteBarrier.afterForwardInsert = b.afterForwardInsert;
}
