/**
 * Правила своего списка выбора (#153, дизайн round 9) — чистые, без React и DOM.
 *
 * 🔴 **Повод.** 14 мест звали нативный `<select>`. Он рисуется виджетом системы: чужой шрифт,
 * прямые углы, белый список в тёмном приложении — и это ещё полбеды. Настоящая поломка в
 * `UserSettingsModal`: перерисовка родителя схлопывала раскрытый список прямо посреди выбора, и
 * ради этого индикатор уровня микрофона пришлось гонять мимо React через ref. Свой список
 * перерисовки не боится.
 *
 * ⚠️ Вид здесь не решается — он в `Select.tsx` и `styles.css` по макету
 * `docs/design/design-step9/Dropdown.dc.html`. Здесь только то, что от облика не зависит.
 */

export interface SelectOption {
  value: string;
  label: string;
  /** Вторая строка под именем: подсказка устройства («по умолчанию системы»), @ник участника. */
  hint?: string;
  /** Цвет кружка слева — роль или статус. */
  dot?: string;
  /** Правая колонка моноширинным: счётчик участников роли. */
  meta?: string;
  /** Заголовок группы, под которым идёт строка («МИКРОФОНЫ», «Роли»). */
  group?: string;
  disabled?: boolean;
}

/**
 * С какого числа строк показывать поиск.
 *
 * ⚠️ Порог не косметический: список устройств на живой машине — это десяток имён вида «Микрофон (2- High
 * Definition Audio Device)», где различие в двух символах посередине. Глазами там не ищут.
 */
export const SEARCH_FROM = 8;

export function shouldSearch(count: number): boolean {
  return count >= SEARCH_FROM;
}

/**
 * Приведение строки к виду для сравнения.
 *
 * `ё` → `е` намеренно: люди набирают «еще», а в списке стоит «ещё» — и поиск молча отвечает
 * «ничего не найдено», хотя нужное на экране.
 */
function norm(s: string): string {
  return s.trim().toLowerCase().replace(/ё/g, 'е');
}

/** Подходит ли строка запросу. Ищем и по второй строке: имя устройства часто одинаковое, различает подпись. */
export function matchOption(o: SelectOption, query: string): boolean {
  const q = norm(query);
  if (!q) return true;
  return norm(o.label).includes(q) || (o.hint != null && norm(o.hint).includes(q));
}

export function filterOptions(options: SelectOption[], query: string): SelectOption[] {
  if (!norm(query)) return options;
  return options.filter((o) => matchOption(o, query));
}

/**
 * Разложить по группам, сохраняя порядок исходного списка.
 *
 * Строки без группы идут первой безымянной пачкой — так «— без категории —» остаётся наверху, а не
 * уезжает под заголовок.
 */
export function groupOptions(options: SelectOption[]): { group?: string; items: SelectOption[] }[] {
  const out: { group?: string; items: SelectOption[] }[] = [];
  for (const o of options) {
    const last = out[out.length - 1];
    if (last && last.group === o.group) last.items.push(o);
    else out.push({ group: o.group, items: [o] });
  }
  return out;
}

/**
 * Куда переехать подсветке с клавиатуры.
 *
 * Недоступные строки пропускаем: подсветка, стоящая на том, что нельзя выбрать, — обещание, которого
 * список не держит. Заворачиваем по кругу и возвращаем прежнее место, если выбирать вообще нечего.
 */
export function moveHighlight(options: SelectOption[], current: number, dir: 1 | -1): number {
  const n = options.length;
  if (n === 0) return -1;
  let i = current;
  for (let step = 0; step < n; step++) {
    i = (i + dir + n) % n;
    if (!options[i].disabled) return i;
  }
  return current;
}

/** С какой строки начинать, когда список открыли: с выбранной, иначе с первой доступной. */
export function initialHighlight(options: SelectOption[], value: string): number {
  const i = options.findIndex((o) => o.value === value && !o.disabled);
  if (i >= 0) return i;
  return options.findIndex((o) => !o.disabled);
}

/**
 * Что написать в триггере.
 *
 * Пустое значение показывает placeholder — на нём держатся два разных случая: «ещё не выбрано» и
 * список-действие («+ добавить участника в роль»), который после выбора возвращается в пустое.
 */
export function triggerTextOf(options: SelectOption[], value: string, placeholder: string): string {
  const found = options.find((o) => o.value === value);
  return found ? found.label : placeholder;
}

/** Выбрана ли сейчас хоть какая-то строка (для приглушённого вида placeholder'а). */
export function hasValue(options: SelectOption[], value: string): boolean {
  return options.some((o) => o.value === value);
}
