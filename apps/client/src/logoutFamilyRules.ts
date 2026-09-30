/**
 * Выход «всей семьёй» и завершение гостевых сессий на хостах — без `localStorage`, `fetch` и
 * `import.meta.env` на импорте (аудит F-23, #184).
 *
 * Вынесено из `config.ts` по просьбе Codex (2026-09-26): тот модуль выполняет миграцию реестра прямо
 * на импорте и в Node не грузится, поэтому самое дорогое здесь — порядок «сначала хостам „завершить
 * сессию“, потом стереть токены» — проверить было нечем. Чтение и запись реестра остались в
 * `config.ts`; здесь только решение, что стирать, и сам запрос хосту с сетью, переданной снаружи.
 */
import type { Instance } from './configRules';

/** Сетевой вызов для запроса хосту — `fetch` или подмена в тесте. */
export type GuestSessionFetch = (url: string, init: RequestInit) => Promise<unknown>;

/**
 * Чистое по импорту: попросить хосты завершить гостевые сессии, сеть — только через `fetchFn`.
 *
 * `POST /fed/guest-session/end` поднимает поколение теневой строки на хосте — то же, что «выйти
 * везде» дома, — и угнанный токен больше не переживает нажатие «Выйти». Без ожидания и с
 * `keepalive`: за выходом следует перезагрузка, и запрос обязан её пережить; хост лежит — выход всё
 * равно происходит, его сессия умрёт по сроку. Записи без токена или адреса пропускаются.
 */
export function endGuestSessions(guests: readonly Instance[], fetchFn: GuestSessionFetch): void {
  for (const inst of guests) {
    if (!inst.token || !inst.apiUrl) continue;
    try {
      void fetchFn(`${inst.apiUrl}/api/fed/guest-session/end`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${inst.token}` },
        keepalive: true,
      }).catch(() => {
        /* хост недоступен — сессия умрёт по сроку */
      });
    } catch {
      /* fetch недоступен (тесты без окна) — не повод ломать выход */
    }
  }
}

/**
 * Чистое ядро `logoutFamily`: новый реестр со стёртыми токенами семьи записи `id`; `null` — записи нет.
 *
 * `null` значит «писать в реестр нечего» — прежний `logoutFamily` в этом случае не трогал хранилище.
 * 🔴 `endSession` зовётся с гостевыми записями семьи ДО того, как ядро вернёт новый список, и получает
 * их нетронутыми — с токенами на руках (F-23). Запись реестра делает вызывающий уже после возврата,
 * поэтому запрос хосту всегда уходит раньше, чем токен исчезает.
 * ⚠️ Семья — это дом и ЕГО гости, а не весь реестр: у человека может быть несколько своих аккаунтов
 * на разных инстансах, и выход из одного не должен выбрасывать из остальных. Выход, начатый с
 * гостевой записи, ведёт к её дому — и стирает ту же семью.
 */
export function logoutFamilyCore(
  list: Instance[],
  id: string | null,
  endSession: (guests: Instance[]) => void,
): Instance[] | null {
  const me = list.find((i) => i.id === id);
  if (!me) return null;
  const homeId = me.guestOf ?? me.id;
  const family = new Set([homeId, ...list.filter((i) => i.guestOf === homeId).map((i) => i.id)]);
  // Хостам — «завершить сессию», пока токены ещё на руках (F-23), и только потом стираем.
  endSession(list.filter((i) => i.guestOf === homeId));
  return list.map((i) => (family.has(i.id) ? { ...i, token: null } : i));
}
