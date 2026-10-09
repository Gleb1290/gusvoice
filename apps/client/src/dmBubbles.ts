/**
 * ЛС как в Telegram (Р13, решение владельца 02.10, `docs/dm/PLAN.md`): свои сообщения справа на медовом пузыре,
 * собеседника — слева; в беседе вдвоём без аватаров и имён; время внутри пузыря; подряд идущие склеиваются, у последнего
 * в группе — «хвостик». Только лента ЛС: каналы остаются прежними.
 *
 * С 05.10 (решение владельца после приёмки) — у всех по умолчанию. Переключатель устройства остаётся запасным:
 * `gv_dm_bubbles = '0'` (или ссылка `?bubbles=0`) возвращает старую ленту, `'1'` — новую.
 */
export const DM_BUBBLES_DEFAULT = true;
const KEY = 'gv_dm_bubbles';

export function dmBubblesSwitch(): boolean {
  try {
    const v = localStorage.getItem(KEY);
    if (v === '1') return true;
    if (v === '0') return false;
  } catch {
    /* нет хранилища — умолчание сборки */
  }
  return DM_BUBBLES_DEFAULT;
}

export function setDmBubblesSwitch(on: boolean): void {
  try {
    localStorage.setItem(KEY, on ? '1' : '0');
  } catch {
    /* нет хранилища — переключить нельзя */
  }
}

// Ссылка-включатель `https://<инстанс>/?bubbles=1` (выключить — `bubbles=0`): строка переключателя в настройках видна
// только супер-админу, а проверить пузыри нужно и тестовым аккаунтам. Применяется на старте клиента (`main.tsx`) ДО
// первой отрисовки — `MessagePane`/`DmChatView` читают переключатель один раз, при монтировании. Параметр после
// применения убирается из адреса: иначе старая ссылка из закладки при каждом открытии перебивала бы выбор, сделанный
// потом в настройках. Прочие параметры, путь и хеш остаются как были.

const PARAM = 'bubbles';

/** Итог разбора строки запроса — чистые данные, без DOM и хранилища (для тестов и для `applyBubblesFromUrl`). */
export interface BubblesUrlPlan {
  /** `true` — в адресе `bubbles=1`, `false` — `bubbles=0`; `null` — переключатель не трогать (нет параметра или иное значение). */
  set: boolean | null;
  /** Строка запроса БЕЗ `bubbles` (`?a=b` или `''`); `null` — параметра в адресе не было, адрес менять не нужно. */
  search: string | null;
}

/**
 * Разобрать `location.search`. Значением считается ровно `1` или `0`; любое другое (`yes`, пусто, `true`) — не команда,
 * но параметр всё равно подлежит удалению. При повторах (`?bubbles=1&bubbles=0`) значение берётся у первого, как у
 * `URLSearchParams.get`, а убираются все. Остальные параметры возвращаются дословно, как были записаны в адресе
 * (без перекодирования), — `?invite=…` и прочие читаются после этого ровно так же, как до него.
 */
export function planBubblesFromSearch(search: string): BubblesUrlPlan {
  const query = search.startsWith('?') ? search.slice(1) : search;
  const rest: string[] = [];
  let found = false;
  let value: string | null = null;
  for (const pair of query.split('&')) {
    if (!pair) continue;
    // `&` впереди: иначе конструктор откусил бы ведущий `?` у куска, который сам начинается с него.
    const parsed = new URLSearchParams(`&${pair}`);
    if (!parsed.has(PARAM)) {
      rest.push(pair);
      continue;
    }
    if (!found) value = parsed.get(PARAM);
    found = true;
  }
  if (!found) return { set: null, search: null };
  return { set: value === '1' ? true : value === '0' ? false : null, search: rest.length ? `?${rest.join('&')}` : '' };
}

/**
 * Применить `?bubbles=1|0` из адреса: записать переключатель устройства и убрать параметр из адресной строки
 * (`history.replaceState` — запись в истории не добавляется). Параметра нет — ничего не трогает.
 *
 * Звать как `applyBubblesFromUrl(location, history)`. Не бросает: сбой хранилища глотает `setDmBubblesSwitch`, отказ
 * `replaceState` (песочница, `file://`) глотается здесь — стартовать клиент это не должно мешать.
 */
export function applyBubblesFromUrl(
  loc: Pick<Location, 'pathname' | 'search' | 'hash'>,
  hist: Pick<History, 'replaceState'> & { state?: unknown },
): void {
  const plan = planBubblesFromSearch(loc.search);
  if (plan.search === null) return;
  if (plan.set !== null) setDmBubblesSwitch(plan.set);
  try {
    hist.replaceState(hist.state, '', loc.pathname + plan.search + loc.hash);
  } catch {
    /* адрес не переписать — переключатель уже записан, остальное не страшно */
  }
}
