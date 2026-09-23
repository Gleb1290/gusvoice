/**
 * Какой якорь подсвечен в рельсе настроек — чистое правило, без DOM.
 *
 * 🔴 **Повод (19.09).** Подсветка «застревала» на середине списка: якорем становилась последняя
 * группа, чей верх ушёл выше кромки, а нижние группы до кромки просто не доходят — прокрутка
 * кончается раньше. Человек листал до самого низа, а рельс показывал «Масштаб интерфейса», то есть
 * врал о том, где он находится.
 *
 * Лечится отдельным случаем «докрутили до дна»: там подсвечивается ПОСЛЕДНЯЯ группа, потому что
 * именно её человек и видит. Без этого правила ни одна нижняя группа не подсветится никогда,
 * сколько бы кромок ни двигать.
 */

/** Насколько ниже кромки группа всё ещё считается «наверху» — запас против дребезга на пиксель. */
export const ANCHOR_SLACK_PX = 12;

const GROUP_LABEL = '.settings-group-label[id^="set-g-"]';

/**
 * Заголовок группы, в которой стоит элемент (наведение на группу справа, 23.09).
 *
 * ⚠️ Контейнера у группы нет: заголовок и её строки идут СОСЕДЯМИ, поэтому группа элемента — ближайший
 * заголовок перед ним на его уровне; не нашёлся — то же для родителя, и так до корня панели.
 */
export function groupLabelAt(target: Element | null, root: Element): HTMLElement | null {
  for (let el = target; el && el !== root; el = el.parentElement) {
    if (el.matches(GROUP_LABEL)) return el as HTMLElement;
    for (let sib = el.previousElementSibling; sib; sib = sib.previousElementSibling) {
      if (sib.matches(GROUP_LABEL)) return sib as HTMLElement;
    }
  }
  return null;
}

export interface AnchorInput {
  /** Группы в порядке показа: `top` — расстояние от верхней кромки области прокрутки. */
  groups: { id: string; top: number }[];
  /** Прокрутка дошла до дна (с небольшим допуском). */
  atBottom: boolean;
}

export function activeAnchor({ groups, atBottom }: AnchorInput): string | null {
  if (groups.length === 0) return null;
  // На дне подсвечиваем последнюю: до кромки она не дойдёт при любой прокрутке.
  if (atBottom) return groups[groups.length - 1]!.id;
  let seen = groups[0]!.id;
  for (const g of groups) {
    if (g.top - ANCHOR_SLACK_PX <= 0) seen = g.id;
  }
  return seen;
}

/** Докрутили ли до дна. Допуск тот же, что у краёв рейла: субпиксельные остатки не считаются. */
export function atBottomOf(box: { scrollTop: number; scrollHeight: number; clientHeight: number }): boolean {
  return box.scrollTop + box.clientHeight >= box.scrollHeight - 2;
}
