/**
 * Настройки устройства, привязанные к id ОДНОГО инстанса — чистые правила, без `localStorage` (F0, #139).
 *
 * 🔴 Громкость человека, заглушённые и свёрнутые каналы, отметка «где остановился читать», громкость
 * стримов — всё это хранится по id пользователей и каналов. Эти id принадлежат инстансу: в реестре
 * клиента инстансов может быть несколько, и раньше настройки лежали под ОДНИМ ключом на всех. Ничего
 * не ломалось только потому, что id случайные и не совпадают. С федерацией один и тот же человек
 * будет виден с разных инстансов, и общий ключ начнёт смешивать настройки — фундамент кладём сейчас.
 *
 * Ключ = `<базовый>@<id записи в реестре>`. Прежний общий ключ НЕ удаляется: каждый инстанс при
 * первом чтении получает из него свою копию. Так никто не теряет уже выставленное — ни на первом
 * инстансе, ни на втором, — а мёртвые записи чужих id в копии безвредны.
 *
 * ⚠️ id записи реестра — локальный для устройства (`gv_instances`), а не `instance_id` сервера.
 * Для разделения настроек этого достаточно; сопоставление с настоящей личностью инстанса — F4.
 */

export function scopedStorageKey(base: string, instanceId: string | null): string {
  return instanceId ? `${base}@${instanceId}` : base;
}

/**
 * Прочитать значение этого инстанса. Своего нет — взять прежнее общее и сохранить копию под своим
 * ключом (чтобы дальнейшие записи общий ключ не трогали).
 *
 * ⚠️ Копия пишется ТОЛЬКО когда своего значения нет вовсе (`null`). Пустая строка или `[]` — это уже
 * решение человека на этом инстансе, общий ключ его не перетирает.
 */
export interface ScopedStorageDeps {
  /** id активной записи реестра на момент обращения (может смениться за жизнь вкладки). */
  activeInstanceId(): string | null;
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

export interface ScopedStorage {
  /** Значение этого инстанса; недоступное хранилище — `null`, а не исключение. */
  get(base: string): string | null;
  /** Записать значение этого инстанса. Бросает, как `localStorage.setItem` (переполнено/запрещено). */
  set(base: string, value: string): void;
  /** Под каким ключом это на самом деле лежит — для отладки и переносов. */
  key(base: string): string;
}

/**
 * Пара «прочитать/записать» с привязкой к активному инстансу (#143).
 *
 * Хранилище и реестр приходят зависимостями, поэтому правило переноса со старого общего ключа
 * проверяется тестом целиком, а не по кускам: раньше тестировался только `readScopedValue`, а то,
 * что чтение ловит недоступное хранилище, а запись — нет, держалось на честном слове обёртки.
 */
export function createScopedStorage(deps: ScopedStorageDeps): ScopedStorage {
  return {
    key: (base) => scopedStorageKey(base, deps.activeInstanceId()),
    get(base) {
      try {
        return readScopedValue(base, deps.activeInstanceId(), deps.getItem, deps.setItem);
      } catch {
        // Само обращение к хранилищу может бросить (данные сайта выключены) — это «настройки нет».
        return null;
      }
    },
    set(base, value) {
      deps.setItem(scopedStorageKey(base, deps.activeInstanceId()), value);
    },
  };
}

export function readScopedValue(
  base: string,
  instanceId: string | null,
  getItem: (key: string) => string | null,
  setItem: (key: string, value: string) => void,
): string | null {
  const key = scopedStorageKey(base, instanceId);
  const own = getItem(key);
  if (own !== null || key === base) return own;
  const legacy = getItem(base);
  if (legacy === null) return null;
  try {
    setItem(key, legacy);
  } catch {
    /* хранилище недоступно — вернём значение, копию сделаем в следующий раз */
  }
  return legacy;
}
