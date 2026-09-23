/**
 * «Ты сюда ещё не заглядывал» — отметка ПРОСМОТРА настроек, отдельная от отметки «изменено».
 *
 * **Зачем две разные.** Точка «изменено» отвечает на вопрос «что у меня не как у всех» и гаснет,
 * когда значение вернули к заводскому. Она ничего не говорит о том, ЗНАЕТ ли человек, что такая
 * настройка вообще есть. Приложение растёт, новые настройки появляются с каждой версией, и человек
 * узнаёт о них только случайно. Эта отметка — про другое: «вот это новое, ты этого ещё не видел».
 *
 * 🔴 **Считаем по ФАКТУ просмотра, а не по версии сборки.** Сравнивать с «настройками прошлой
 * версии» бессмысленно: человек мог пропустить пять версий подряд или, наоборот, обновиться и
 * ничего не открыть. Правда здесь одна — заглядывал он в эту группу или нет.
 *
 * ⚠️ **Первый запуск засевается как «всё просмотрено».** Иначе человек, который год живёт с этими
 * настройками, после обновления получил бы кружки у ВСЕХ групп разом — то есть шум, который учит
 * не обращать внимания на отметку. С этого момента новым считается только то, что появилось позже.
 */

const KEY = 'gv_settings_seen';

/** Что лежит в хранилище: просмотренные группы и отметка, что засев уже был. */
interface SeenState {
  seeded: boolean;
  ids: string[];
}

function read(): SeenState {
  try {
    const raw = JSON.parse(localStorage.getItem(KEY) || 'null') as Partial<SeenState> | null;
    if (!raw || !Array.isArray(raw.ids)) return { seeded: false, ids: [] };
    return { seeded: raw.seeded === true, ids: raw.ids.filter((x): x is string => typeof x === 'string') };
  } catch {
    return { seeded: false, ids: [] };
  }
}

function write(state: SeenState): void {
  try {
    localStorage.setItem(KEY, JSON.stringify(state));
  } catch {
    /* приватный режим — отметка просто не переживёт перезагрузку, интерфейс от этого не ломается */
  }
}

/**
 * Засеять при первом запуске: всё, что есть сейчас, считается просмотренным.
 *
 * ⚠️ Зовётся ОДИН раз за устройство (по флагу в хранилище), а не «когда список пуст»: пустой список
 * бывает и у того, кто честно ничего не смотрел, и засев стирал бы ему настоящие отметки.
 */
export function seedSeenOnce(allIds: string[]): void {
  const state = read();
  if (state.seeded) return;
  write({ seeded: true, ids: [...new Set([...state.ids, ...allIds])] });
}

/** Просмотренные группы — множеством, чтобы вызывающему было дёшево спрашивать. */
export function seenGroups(): Set<string> {
  return new Set(read().ids);
}

/** Отметить группу просмотренной. Повторный вызов ничего не пишет — это горячий путь прокрутки. */
export function markGroupSeen(id: string): void {
  const state = read();
  if (state.ids.includes(id)) return;
  write({ seeded: state.seeded, ids: [...state.ids, id] });
}

/**
 * Какие ИЗМЕНЕНИЯ человек уже видел: группа → отпечаток её значений на момент, когда точка погасла
 * (`settingsChanged.groupPrints`, 23.09). Отдельный ключ, а не поле в `gv_settings_seen`: у «новой
 * настройки» и «изменённой настройки» разный смысл и разная жизнь — первая гаснет навсегда, вторая
 * загорается снова, когда значение поменяли.
 */
const CHANGED_KEY = 'gv_settings_changed_seen';

export function seenChangedPrints(): Record<string, string> {
  try {
    const raw = JSON.parse(localStorage.getItem(CHANGED_KEY) || 'null') as unknown;
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return {};
    const out: Record<string, string> = {};
    for (const [k, v] of Object.entries(raw as Record<string, unknown>)) if (typeof v === 'string') out[k] = v;
    return out;
  } catch {
    return {};
  }
}

/** Запомнить, что изменения этих групп увидены (в том виде, в каком они сейчас). */
export function markChangedSeen(prints: Record<string, string>): void {
  try {
    localStorage.setItem(CHANGED_KEY, JSON.stringify({ ...seenChangedPrints(), ...prints }));
  } catch {
    /* приватный режим — точка просто загорится снова после перезагрузки */
  }
}

/** Что из известных групп человек ещё не видел. Чистое правило — вся логика отметки сводится к нему. */
export function unseenOf(allIds: string[], seen: ReadonlySet<string>): string[] {
  return allIds.filter((id) => !seen.has(id));
}

/**
 * Есть ли непросмотренное — по этому кружок в рейле зовёт заглянуть в настройки.
 *
 * ⚠️ Спрашивается на КАЖДОЙ отрисовке рейла, поэтому читает хранилище один раз и не строит лишних
 * массивов.
 */
export function hasUnseen(allIds: string[]): boolean {
  const seen = seenGroups();
  return allIds.some((id) => !seen.has(id));
}
