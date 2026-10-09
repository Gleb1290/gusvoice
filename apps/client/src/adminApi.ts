import { api, apiFor, type Api } from './api';
import { useStore } from './store';

/**
 * Клиент API для админ-панели (01.10, федерация без перехода).
 *
 * Админку СВОЕГО инстанса человек открывает и тогда, когда стоит гостем у соседа (`configRules.adminTarget`). Раньше
 * клик сперва переводил его домой (`switchInstance`) — с обрывом голоса у соседа и экраном загрузки. Теперь админка
 * открывается поверх текущего экрана, а её запросы идут в API дома токеном дома (`apiFor`): `store.adminInstanceId`
 * — запись дома, `null` — активный инстанс (обычный случай и мастер установки, который делит с админкой формы).
 *
 * 🔴 Все компоненты админки зовут `adminApi()`, а не `api`: пропущенный вызов ушёл бы к соседу гостевым токеном.
 */
export function adminApi(): Api {
  const id = useStore.getState().adminInstanceId;
  return id ? apiFor(id) : api;
}
