import { api } from './api';
import { config } from './config';
import { useStore } from './store';
import { economyVisible } from './economyVisible';

/**
 * Загрузка снимка экономики в стор — ЕДИНСТВЕННОЕ место, откуда клиент за ним ходит (#117).
 *
 * 🔴 Зачем отдельным модулем. Раньше чип в шапке и оверлей типа опрашивали сервер каждый сам, раз в
 * минуту, и держали свои копии: после типа оверлей перечитывал себя, а чип — нет, и в одном окне
 * висели два разных баланса. Теперь данные живут в сторе в одном экземпляре, а обновляются пушем
 * `economy.wallet`, а не опросом.
 *
 * ⚠️ Опрос остался только как СТРАХОВКА (возврат фокуса, смена сервера): пропущенное событие не
 * должно оставлять число протухшим навсегда.
 */

/** Запросы в полёте по серверам — чтобы два компонента на одном экране не сходили дважды. */
const inFlight = new Map<string, { dirty: boolean }>();

/**
 * Забыть запросы в полёте после перехода в другой инстанс (§5.7): id серверов там свои, и застрявшая
 * запись помешала бы загрузить экономику сервера с ТАКИМ ЖЕ id у соседа.
 */
export function clearEconomyInFlight(): void {
  inFlight.clear();
  wheelInFlight.clear();
  duelInFlight.clear();
  predictionsInFlight.clear();
}

/**
 * Убедиться, что снимок экономики этого сервера есть в сторе.
 *
 * Ничего не делает, если экономика на инстансе выключена или снимок уже загружен.
 * `force` — перезапросить принудительно (возврат фокуса).
 */
export function ensureEconomy(serverId: string, force = false): void {
  if (!serverId) return;
  // 🔴 Экономика включена на инстансе И этому человеку видна — одно решение, и принимает его
  // бэкенд, кладя ответ в `economyPreview` профиля (#117). Здесь мы лишь не мозолим глаза
  // остальным и не шлём заведомо пустых запросов.
  // ⚠️ Флаг инстанса из сохранённого реестра — только запасной вариант: он не обновляется с
  // момента добавления сервера, разбор — в `economyVisible.ts`.
  if (!economyVisible(useStore.getState().user?.economyPreview, config.economyEnabled === true)) return;
  if (!force && useStore.getState().economy[serverId]) return;
  const active = inFlight.get(serverId);
  if (active) {
    // Событие пришло после начала GET: его ответ уже не доказывает актуальность снимка.
    if (force) active.dirty = true;
    return;
  }
  const request = { dirty: false };
  const gamesAtStart = useStore.getState().economy[serverId]?.wallet?.games;
  inFlight.set(serverId, request);
  void api
    .getEconomy(serverId)
    .then((view) => {
      // clear при смене инстанса отменяет и применение ответа, и его отложенный повтор.
      if (inFlight.get(serverId) !== request) return;
      const state = useStore.getState();
      // Личный предел мог измениться отдельным PATCH, пока GET был в полёте.
      if (state.economy[serverId]?.wallet?.games !== gamesAtStart) request.dirty = true;
      if (!request.dirty) state.setEconomy(serverId, view);
    })
    .catch(() => {
      // Экономика — украшение поверх основного: молча ничего не показываем, а не рушим шапку.
    })
    .finally(() => {
      if (inFlight.get(serverId) !== request) return;
      inFlight.delete(serverId);
      // Один повтор на накопленные события; без событий нет ни таймера, ни опроса.
      if (request.dirty) ensureEconomy(serverId, true);
    });
}

/**
 * Загрузка снимка колеса гусей-пиратов в стор (`store.wheel[serverId]`) — единственное место, откуда клиент за ним ходит
 * (рядом с `ensureEconomy` и по тем же причинам; здесь, а не отдельным модулем — у `sockets.ts` закрытая граница импортов).
 *
 * Когда: кнопка «Активности» стала видна (сервер включил игры), сцена открылась (`force`), сокет переподключился
 * (`sockets.ts` `ready`, `force`) и событие пришло раньше снимка. 🔴 Живое состояние едет событиями `wheel.state`/
 * `wheel.result`, но событие одним пушем теряется (сон ноутбука, обрыв) — без перечитки снимка точка «идёт раунд» висела бы
 * до перезапуска.
 *
 * 🔴 Включены ли игры (`gamesView`), решает ВЫЗЫВАЮЩИЙ: кнопка «Активности» зовёт только при включённых, сокет — только где снимок
 * уже был. Здесь проверки нет намеренно — у `economyClient` закрытая граница импортов в тестах сокета.
 */
const wheelInFlight = new Set<string>();

export function ensureWheel(serverId: string | null | undefined, force = false): void {
  if (!serverId) return;
  if (!force && useStore.getState().wheel?.[serverId]) return;
  if (wheelInFlight.has(serverId)) return;
  wheelInFlight.add(serverId);
  api
    .getWheel(serverId)
    .then((snap) => useStore.getState().setWheel(serverId, snap))
    .catch(() => {
      // Колесо — украшение поверх голоса: молча без него, кнопка просто без точки.
    })
    .finally(() => wheelInFlight.delete(serverId));
}

/**
 * Снимок гусиной дуэли голосового канала (ГусКоины 2, этап 3) — `store.duels[channelId]` и входящий мне вызов
 * (`store.duelInvite`). Здесь, а не отдельным модулем — по той же причине, что `ensureWheel` (граница импортов `sockets.ts`).
 *
 * Когда: вошёл в голосовой канал с включёнными играми (`ActivitiesHost`), сокет переподключился (`ready`, если канал уже
 * был загружен), открылась сцена (`force`). Живое состояние — события `duel.state`; одно потерянное событие оставило бы
 * висеть чужой вызов или «идёт игра» до перезапуска. Включены ли игры — решает вызывающий (как у колеса).
 */
const duelInFlight = new Set<string>();

export function ensureDuel(serverId: string | null | undefined, channelId: string | null | undefined, force = false): void {
  if (!serverId || !channelId) return;
  if (!force && useStore.getState().duels?.[channelId] !== undefined) return;
  if (duelInFlight.has(channelId)) return;
  duelInFlight.add(channelId);
  api
    .getDuel(serverId, channelId)
    .then((snap) => useStore.getState().setDuelSnapshot(serverId, channelId, snap))
    .catch(() => {
      // Дуэль — украшение поверх голоса: молча без неё.
    })
    .finally(() => duelInFlight.delete(channelId));
}

/**
 * Лента ставок на события сервера (ГусКоины 2, этап 5) — `store.predictions[serverId]`. Здесь, а не отдельным модулем —
 * по той же причине, что `ensureWheel` (граница импортов `sockets.ts`).
 *
 * Когда: кнопка «Активности» стала видна (точка «идёт событие»), открылась лента (`force`), сокет переподключился (`ready`,
 * где снимок уже был), событие `prediction.state` пришло раньше снимка. Одно потерянное событие оставило бы висеть «приём
 * ставок» или чужой итог до перезапуска. Включены ли игры — решает вызывающий (как у колеса).
 */
const predictionsInFlight = new Set<string>();

export function ensurePredictions(serverId: string | null | undefined, force = false): void {
  if (!serverId) return;
  if (!force && useStore.getState().predictions?.[serverId]) return;
  if (predictionsInFlight.has(serverId)) return;
  predictionsInFlight.add(serverId);
  api
    .getPredictions(serverId)
    .then((snap) => useStore.getState().setPredictions(serverId, snap))
    .catch(() => {
      // События — украшение поверх голоса: молча без них, кнопка просто без точки.
    })
    .finally(() => predictionsInFlight.delete(serverId));
}
