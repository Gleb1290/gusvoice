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
const inFlight = new Map<string, Promise<void>>();

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
  if (inFlight.has(serverId)) return;

  const p = api
    .getEconomy(serverId)
    .then((view) => {
      useStore.getState().setEconomy(serverId, view);
    })
    .catch(() => {
      // Экономика — украшение поверх основного: молча ничего не показываем, а не рушим шапку.
    })
    .finally(() => {
      inFlight.delete(serverId);
    });
  inFlight.set(serverId, p);
}
