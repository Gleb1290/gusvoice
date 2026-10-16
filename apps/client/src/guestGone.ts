import type { GuestPlacesView } from '@gusvoice/shared';
import { clearBgUnread, onBgGuestLinks, syncBgGateways } from './bgGateways';
import { activeInstanceId, instances, removeInstance, updateInstance, type Instance } from './config';
import { homeEntry } from './configRules';
import { switchInstance } from './instanceSwitch';
import { endGuestSessions } from './logoutFamilyRules';
import { goneGuestEntries, placeOfEntry, type RailPlace } from './railRules';
import { useStore } from './store';
import { toast } from './toast';

/**
 * Гостевые записи, которые уходят с устройства БЕЗ ответа хоста (15.10).
 *
 * Повод: сосед по федерации удалён навсегда, держатель нажал «Разорвать», а у людей в рейле осталась группа соседа — и
 * выйти из неё было нельзя: и «Выйти со всех серверов», и «Завершить сессию» ждут ответа хоста, а он мёртв. Как в
 * Discord/Telegram — удалённый сервер просто исчезает у участников.
 *
 *  - **Автоматически** (`dropGoneGuests`): дом в «Где я гость» (`GET /fed/my-guest`, `linkState` у каждого места) говорит,
 *    что связки с инстансом больше нет (`railRules.linkGone`: `blocked`/`unknown`) — запись и её кеш стираются, тост
 *    «Связь с «X» разорвана — его серверы убраны». Перечитывают места рейл (`RailGroups`: запуск, возврат на экран,
 *    событие `federation.guest_links`) и `sweepOtherHomes` — для гостей ДРУГИХ своих домов (мультиаккаунт).
 *  - **Руками** (`dismissGuestGroup`): «Убрать из списка» на заголовке группы соседа и в «Где я гость», когда хост молчит.
 *
 * 🔴 Хост не ждём НИКОГДА: просьба завершить сессию — «выстрелил и забыл» с таймаутом (`endGuestSessions`, F-23); не дошла
 * — сессия там умрёт по сроку. Пауза и потеря доверия — не разрыв: такие группы остаются серыми (`railRules`).
 */

const listeners = new Set<() => void>();

/** Записи реестра убраны отсюда — рейлу перерисоваться (он читает реестр на отрисовке). */
export function onGuestEntriesChanged(fn: () => void): () => void {
  listeners.add(fn);
  return () => {
    listeners.delete(fn);
  };
}

function changed(): void {
  for (const fn of listeners) {
    try {
      fn();
    } catch {
      /* подписчик не вправе сорвать уборку */
    }
  }
}

/** Сколько ждать мёртвый хост или дом: дольше — уже не «выстрелил и забыл», а висящее соединение. */
const HOST_TIMEOUT_MS = 8_000;

function timeoutSignal(): { signal?: AbortSignal } {
  return typeof AbortSignal !== 'undefined' && typeof AbortSignal.timeout === 'function'
    ? { signal: AbortSignal.timeout(HOST_TIMEOUT_MS) }
    : {};
}

/**
 * Хост НЕ ОТВЕТИЛ (а не отказал): сеть, таймаут или 5xx прокси перед лежащим бэкендом. Отказ словами (`federation.*`,
 * 401/403) — ответ, и выход по нему идёт обычным путём.
 */
export function hostSilent(e: unknown): boolean {
  if (e instanceof TypeError) return true;
  const name = (e as { name?: unknown } | null)?.name;
  if (name === 'TimeoutError' || name === 'AbortError') return true;
  const code = (e as { code?: unknown } | null)?.code;
  return typeof code === 'string' && /^HTTP 5\d\d$/.test(code);
}

/** Ключи настроек этой записи (`instanceScopeRules.scopedStorageKey`: `<ключ>@<id записи>`). */
function wipeScopedKeys(entryId: string): void {
  try {
    const suffix = `@${entryId}`;
    const keys: string[] = [];
    for (let i = 0; i < localStorage.length; i++) {
      const k = localStorage.key(i);
      if (k && k.endsWith(suffix)) keys.push(k);
    }
    for (const k of keys) localStorage.removeItem(k);
  } catch {
    /* хранилище недоступно — записи реестра уже нет, остатки ни к чему не привязаны */
  }
}

/**
 * Убрать гостевую запись с устройства, не дожидаясь хоста: голос на ней — долой, хосту — просьба завершить сессию без
 * ожидания, запись реестра и её кеш бесед (`removeInstance` → `cacheWipeOnRemove`), её настройки, фоновый шлюз и счётчики.
 * ⚠️ Активную запись сюда не отдавать: сначала переход домой (`dismissGuestGroup`).
 */
export function forgetGuestEntry(entry: Instance): void {
  const store = useStore.getState();
  if (store.voice?.instanceId === entry.id) store.leaveVoice();
  endGuestSessions([entry], (url, init) => fetch(url, { ...init, ...timeoutSignal() }));
  removeInstance(entry.id);
  wipeScopedKeys(entry.id);
  clearBgUnread(entry.id);
  syncBgGateways(activeInstanceId());
}

/**
 * Места от дома `homeId` пришли: гостевые записи этого дома, чья связка разорвана, — с устройства, с тостом. Сколько убрано.
 * Повторный вызов с тем же ответом ничего не делает (записей уже нет) — тост один.
 */
export function dropGoneGuests(homeId: string, places: readonly RailPlace[]): number {
  const gone = goneGuestEntries(instances(), homeId, activeInstanceId(), places);
  if (gone.length === 0) return 0;
  const titles = new Set<string>();
  for (const { entry, title } of gone) {
    forgetGuestEntry(entry);
    titles.add(title);
  }
  for (const title of titles) toast('info', `Связь с «${title}» разорвана — его серверы убраны`);
  changed();
  return gone.length;
}

/** Когда в последний раз спрашивали дом (не активный) про его гостевые места: не чаще раза в 10 минут без повода. */
const lastSweep = new Map<string, number>();
const SWEEP_EVERY_MS = 10 * 60_000;

/**
 * Свериться с ДРУГИМИ своими домами (мультиаккаунт) и с домом, когда стоим гостем: их гостевые группы тоже в рейле, а
 * `RailGroups` спрашивает только дом, в котором стоит. Токеном дома, мимо общего `api` (он говорит с активным).
 * `force` — id дома, чьё событие `federation.guest_links` пришло фоновым шлюзом: его — без паузы.
 */
export async function sweepOtherHomes(force: string | null = null): Promise<void> {
  const list = instances();
  const active = activeInstanceId();
  const atHomeId = list.find((i) => i.id === active && !i.guestOf)?.id ?? null;
  for (const home of list) {
    if (home.guestOf || !home.token || home.id === atHomeId) continue;
    if (!list.some((g) => g.guestOf === home.id)) continue;
    const now = Date.now();
    if (force !== home.id && now - (lastSweep.get(home.id) ?? 0) < SWEEP_EVERY_MS) continue;
    lastSweep.set(home.id, now);
    try {
      const res = await fetch(`${home.apiUrl}/api/fed/my-guest`, {
        headers: { Authorization: `Bearer ${home.token}` },
        ...timeoutSignal(),
      });
      if (!res.ok) continue;
      const view = (await res.json()) as GuestPlacesView;
      if (Array.isArray(view?.places)) dropGoneGuests(home.id, view.places);
    } catch {
      /* дом не ответил — ничего не убираем: молчание дома не разрыв связки */
    }
  }
}

onBgGuestLinks((homeId) => void sweepOtherHomes(homeId));

/**
 * «Убрать из списка» (15.10): группа соседа уходит с ЭТОГО устройства без ответа хоста — запись реестра (если есть) и
 * пометка у дома «место скрыто» (`Instance.hiddenGuests`), иначе рейл тут же вернул бы группу по членствам от дома.
 * Стоим в этой записи — сначала домой (`switchInstance`: прежняя запись ещё активна, её кеш пишется её ключом).
 */
export async function dismissGuestGroup(target: { instanceId: string | null; place: RailPlace | null }): Promise<void> {
  const list = instances();
  const active = activeInstanceId();
  const entry = target.instanceId ? (list.find((i) => i.id === target.instanceId) ?? null) : null;
  const homeId = entry?.guestOf ?? homeEntry(list, active)?.id ?? null;
  const place = target.place;
  const entries = list.filter(
    (i) => !!i.guestOf && i.guestOf === homeId && (i.id === entry?.id || (!!place && placeOfEntry(i, [place]) === place)),
  );
  const fedId = place?.instanceId ?? entry?.federationInstanceId ?? null;
  const home = homeId ? list.find((i) => i.id === homeId && !i.guestOf) : undefined;
  if (home && fedId) {
    const servers = place ? place.servers.map((s) => s.serverId) : (entry?.servers ?? []).map((s) => s.id);
    updateInstance(home.id, { hiddenGuests: { ...(home.hiddenGuests ?? {}), [fedId]: servers } });
  }
  if (home && entries.some((e) => e.id === active)) await switchInstance(home.id);
  for (const e of entries) forgetGuestEntry(e);
  changed();
}
