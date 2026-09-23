/**
 * «Где я был в прошлый раз» — последний открытый сервер и канал, чтобы перезагрузка не выкидывала
 * человека на пустой экран «Выбери сервер».
 *
 * 🔴 **Повод (19.09).** Место в приложении не переживало обычную перезагрузку вообще: ни persist у
 * стора, ни ключа в хранилище — после F5 человек каждый раз начинал с выбора сервера, хотя минуту
 * назад читал канал. Конкретные случаи восстановления были (ссылка-приглашение, переход между
 * инстансами, возврат в голосовой после падения), но самого частого — «я просто обновил страницу» —
 * не было.
 *
 * ⚠️ **Место запоминается ПО ИНСТАНСУ.** Человек живёт на своём инстансе и ходит гостем на чужие;
 * один общий ключ означал бы, что возвращение домой открывает чужой сервер, которого в этом списке
 * нет. Ключ инстанса — часть записи, и чужая запись просто не подходит.
 *
 * ⚠️ **Это подсказка, а не приказ.** Сервер могли закрыть, канал — удалить, права — отобрать. Всё,
 * что отсюда прочитано, обязано проверяться существованием в загруженном списке, иначе восстановление
 * превратится в ошибку на старте.
 */

const KEY = 'gv_last_place';

export interface LastPlace {
  /** Инстанс, к которому относится запись: у каждого своё место. */
  instanceId: string;
  serverId?: string;
  channelId?: string;
  /** Личные сообщения — отдельная ветка: там нет сервера, но место тоже хочется помнить. */
  dmId?: string;
}

export function rememberPlace(place: LastPlace): void {
  try {
    localStorage.setItem(KEY, JSON.stringify(place));
  } catch {
    /* приватный режим — место просто не переживёт перезагрузку, приложение от этого не ломается */
  }
}

/** Последнее место ЭТОГО инстанса. Чужая запись не подходит и считается отсутствующей. */
export function lastPlace(instanceId: string | null): LastPlace | null {
  if (!instanceId) return null;
  try {
    const raw = JSON.parse(localStorage.getItem(KEY) || 'null') as Partial<LastPlace> | null;
    if (!raw || raw.instanceId !== instanceId) return null;
    return {
      instanceId,
      serverId: typeof raw.serverId === 'string' ? raw.serverId : undefined,
      channelId: typeof raw.channelId === 'string' ? raw.channelId : undefined,
      dmId: typeof raw.dmId === 'string' ? raw.dmId : undefined,
    };
  } catch {
    return null;
  }
}

/** Забыть место — например, когда сервер закрыли и возвращаться уже некуда. */
export function forgetPlace(): void {
  try {
    localStorage.removeItem(KEY);
  } catch {
    /* см. выше */
  }
}
