/**
 * Правила перетаскивания каналов — чистые, БЕЗ React и стора.
 *
 * Вынуто из `ChannelSidebar.tsx` по просьбе Codex (2026-07-27): считалось внутри компонента, то есть
 * проверялось только мышью. Ошибка тут даёт конфликтующие позиции — а порядок каналов сразу уходит
 * на сервер и виден всем на сервере, не только тому, кто тащил.
 */

/** Куда встанет канал при броске: в категорию `cat`, перед каналом `before` (`null` = в конец). */
export interface DropHint {
  cat: string | null;
  before: string | null;
}

/**
 * Решение по строке, УЖЕ найденной под указателем: куда встанет канал, либо `null` — «цели нет,
 * подсказку погасить». Геометрия (какая строка под курсором и верхняя это половина или нижняя)
 * остаётся в компоненте, сюда приходит уже посчитанной.
 *
 * 🔴 `null` над собственной строкой — это #94, а не мелочь: раньше компонент на этом месте просто
 * выходил из расчёта, НЕ трогая подсказку, и она оставалась от предыдущей строки. Из-за этого
 * «вернуть канал туда, где взял, и отпустить» — единственный способ отменить начатое перетаскивание —
 * применяло прошлую цель и уносило канал в другое место.
 */
export function dropHintForRow(p: {
  draggedId: string;
  targetId: string;
  targetCat: string | null;
  /** Указатель в нижней половине строки → встаём ПОСЛЕ неё. */
  after: boolean;
  /** id каналов целевой категории по порядку — включая перетаскиваемый, если он из неё же. */
  orderedIds: string[];
}): DropHint | null {
  if (p.targetId === p.draggedId) return null;
  if (!p.after) return { cat: p.targetCat, before: p.targetId };
  const idx = p.orderedIds.indexOf(p.targetId);
  // idx < 0 быть не должно (строка взята из этого же списка), но тогда `orderedIds[0]` вместо
  // «в конец» молча увёл бы канал в начало — считаем это концом группы.
  if (idx < 0) return { cat: p.targetCat, before: null };
  // 🔴 Следующего соседа ищем, ПРОПУСКАЯ сам перетаскиваемый канал (нашёл Codex). Иначе при `A,B,C`
  // бросок `B` на нижнюю половину `A` — то есть «поставить B сразу за A», ровно туда, где он и
  // стоит, — давал `before: 'B'`. А `computeReorder` исключает перетаскиваемый из списка ДО вставки,
  // не находит там `beforeId` и уводит канал В КОНЕЦ: вместо «ничего не поменялось» получалось
  // `C→1, B→2`. Ошибка тихая: подсказка выглядит осмысленной, а промах виден только по результату.
  const before = p.orderedIds.slice(idx + 1).find((id) => id !== p.draggedId) ?? null;
  return { cat: p.targetCat, before };
}

/** Минимум полей канала, нужный для перестановки (полный `Channel` из shared им удовлетворяет). */
export interface OrderableChannel {
  id: string;
  categoryId?: string | null;
  position: number;
}

export interface ChannelOrder {
  id: string;
  categoryId: string | null;
  position: number;
}

/**
 * Пересчитать позиции после броска канала `dragId` в категорию `targetCat` ПЕРЕД каналом `beforeId`
 * (`null` = в конец). Возвращает ТОЛЬКО реально изменившиеся строки — их и шлём на сервер.
 *
 * ⚠️ Позиции раздаются плотно (0,1,2…) в целевой категории; при переносе МЕЖДУ категориями исходная
 * тоже уплотняется, иначе после нескольких переносов в ней остаются дыры и следующая вставка
 * «перед соседом» встаёт не туда.
 * ⚠️ Перетаскиваемый канал исключается из списка ДО вставки (`c.id !== dragId`) — иначе он посчитался
 * бы дважды и сместил индекс вставки на единицу.
 */
export function computeReorder(
  all: OrderableChannel[],
  dragId: string,
  targetCat: string | null,
  beforeId: string | null,
): ChannelOrder[] {
  const dragged = all.find((c) => c.id === dragId);
  if (!dragged) return [];
  const srcCat = dragged.categoryId ?? null;
  const inCat = (cat: string | null) =>
    all.filter((c) => (c.categoryId ?? null) === cat && c.id !== dragId).sort((a, b) => a.position - b.position);

  const target = inCat(targetCat);
  const at = beforeId ? target.findIndex((c) => c.id === beforeId) : -1;
  target.splice(at < 0 ? target.length : at, 0, dragged);

  const updates: ChannelOrder[] = target.map((c, i) => ({ id: c.id, categoryId: targetCat, position: i }));
  if (srcCat !== targetCat) {
    inCat(srcCat).forEach((c, i) => updates.push({ id: c.id, categoryId: srcCat, position: i }));
  }
  return updates.filter((u) => {
    const orig = all.find((c) => c.id === u.id)!;
    return (orig.categoryId ?? null) !== u.categoryId || orig.position !== u.position;
  });
}

/**
 * Открывает ли ЛКМ по строке участника его карточку.
 *
 * На этой строке уже живёт четыре жеста: наведение (превью), Alt+клик (типнуть), протяжка
 * (перенести участника, у модераторов) и ПКМ (меню). Клик — пятый, и он обязан уступать двум из них.
 *
 * 🔴 `afterDrag` — не перестраховка, а ЗАМЕРЕННОЕ поведение: строка на `pointerdown` берёт
 * `setPointerCapture`, и после перетаскивания браузер всё равно шлёт ей `click` — палец отпущен в
 * другом месте, а целью осталась она. Проверено на стенде: `pointerup, dragging=true` и следом
 * `click`. Без этого условия карточка открывалась бы КАЖДЫЙ раз, когда модератор перетаскивает
 * человека в другой канал.
 *
 * ⚠️ `altKey` — потому что Alt+клик по нику это «типнуть», и открывать поверх него карточку значит
 * швырять её в лицо на каждый тип.
 */
export function rowClickOpensCard(p: { altKey: boolean; afterDrag: boolean }): boolean {
  return !p.altKey && !p.afterDrag;
}
