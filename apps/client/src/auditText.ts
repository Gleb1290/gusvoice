import type { AuditLogEntry } from '@gusvoice/shared';

/**
 * Человеческое описание одной записи журнала действий.
 *
 * 🔴 Вынесено из `AuditLogView.tsx` под тесты 06.09 вместе с починкой самой беды: разбор был
 * `switch` с веткой «не знаю такого действия — напечатать код», и в неё молча провалились
 * ПЯТНАДЦАТЬ действий из сорока одного. Люди видели в журнале `soundboard.price` и
 * `channel.general.set` — то есть журнал не отвечал на свой единственный вопрос «кто что сделал».
 *
 * 🔴 Ветка `default` теперь стоит на страже, а не заметает мусор: `const _: never = e.action`
 * перестаёт сходиться, стоит появиться новому действию без строки, и сборка падает раньше, чем
 * это увидит человек. Возврат сырого кода там остаётся ТОЛЬКО ради старых записей в базе —
 * действие могло быть написано версией, которая про наш союз ничего не знала.
 */
export function describeAudit(e: AuditLogEntry): string {
  const d = e.data as Record<string, unknown>;
  const s = (k: string) => (typeof d[k] === 'string' ? (d[k] as string) : '');
  const n = (k: string) => (typeof d[k] === 'number' ? (d[k] as number) : null);
  /** Название в кавычках или подстановка, когда его в записи нет. */
  const q = (k: string, fallback: string) => (s(k) ? `«${s(k)}»` : fallback);
  /**
   * Над кем действие. Порядок источников не случаен: `data` хранит имя НА МОМЕНТ события (кикнутого
   * участника в базе уже нет, и join его не найдёт), а join — актуальное имя для всех остальных,
   * включая сотни уже накопленных голосовых записей, где в `data` имени нет вовсе.
   */
  const whom = s('displayName') || s('username') || e.target?.displayName || e.target?.username || '';

  switch (e.action) {
    case 'role.create':
      return `создал роль «${s('name')}»`;
    case 'role.update':
      return `изменил роль «${s('name')}»`;
    case 'role.delete':
      return `удалил роль «${s('name')}»`;
    case 'role.assign':
      return `выдал ${whom ? `${whom} ` : ''}роль «${s('roleName')}»`;
    case 'role.unassign':
      return `снял ${whom ? `с ${whom} ` : ''}роль «${s('roleName')}»`;
    case 'role.reorder':
      return 'изменил порядок ролей';

    case 'channel.create':
      return `создал канал «${s('name')}»`;
    case 'channel.update':
      return `изменил канал «${s('name')}»`;
    case 'channel.delete':
      return `удалил канал «${s('name')}»`;
    case 'channel.reorder':
      // `reparented` = каналы, у которых сменилась категория. Это важнее самого порядка: перенос
      // канала в другую категорию меняет, кто его вообще видит.
      return d.reparented ? 'переставил каналы и перенёс их между категориями' : 'изменил порядок каналов';
    case 'channel.overwrite.update':
      return 'изменил права канала';
    case 'channel.overwrite.delete':
      return 'сбросил права канала';
    case 'channel.general.set':
      // ⚠️ Имени тут нет: запись целится в КАНАЛ, а не в участника, и `data` держит только `userId`.
      // Врать выдуманным именем нельзя, поэтому пишем без него.
      return 'назначил генерала канала';
    case 'channel.general.clear':
      return 'снял генерала канала';
    case 'channel.sound.set':
      return `заменил в канале звук «${soundEventName(s('event'))}»`;
    case 'channel.sound.clear':
      return `вернул в канале обычный звук «${soundEventName(s('event'))}»`;

    case 'category.create':
      return `создал категорию «${s('name')}»`;
    case 'category.update':
      return `переименовал категорию в «${s('name')}»`;
    case 'category.reorder':
      return 'изменил порядок категорий';
    case 'category.delete':
      return `удалил категорию «${s('name')}»`;
    case 'category.overwrite.update':
      return 'изменил права категории';
    case 'category.overwrite.delete':
      return 'сбросил права категории';

    case 'server.update':
      return `изменил настройки сервера${changedTail(d.changed)}`;
    case 'server.transfer':
      return `передал владение ${whom || 'участнику'}`;

    case 'sound.set':
      return `заменил звук сервера «${soundEventName(s('event'))}»`;
    case 'sound.clear':
      return `вернул обычный звук сервера «${soundEventName(s('event'))}»`;

    case 'soundboard.add':
      return `добавил в саундборд звук ${q('name', 'без названия')}`;
    case 'soundboard.remove':
      return `убрал из саундборда звук ${q('name', 'без названия')}`;
    case 'soundboard.price':
      return `назначил звуку ${q('name', 'без названия')} цену ${n('priceCoins') ?? '—'}`;

    case 'economy.settings':
      return `изменил настройки экономики${compensatedTail(n('compensated'), n('people'))}`;
    case 'economy.shop':
      // Имя награды кладёт сервер (`shopRules.ts`) в момент события — единый источник, без
      // словаря-двойника на клиенте. У старых записей его нет, тогда остаётся ключ.
      return `изменил в лавке ${q('label', s('item') ? `«${s('item')}»` : 'награду')}`;
    case 'economy.retro':
      return `доначислил за прошлое ${n('granted') ?? 0} монет${peopleTail(n('paid'))}`;
    case 'economy.icon':
      return 'сменил значок валюты';

    case 'member.kick':
      return `кикнул ${whom || 'участника'}`;
    case 'member.ban':
      return `забанил ${whom || 'участника'}${s('reason') ? ` (${s('reason')})` : ''}`;
    case 'member.unban':
      return `разбанил ${whom || 'участника'}`;
    case 'member.leave':
      // Единственное действие, где человек сам себе актор — «вышел», а не «выгнал кого-то».
      return 'вышел с сервера';

    case 'voice.mute':
      return `замьютил ${whom || 'участника'}`;
    case 'voice.unmute':
      return `размьютил ${whom || 'участника'}`;
    case 'voice.disconnect':
      return `отключил из войса ${whom || 'участника'}`;
    case 'voice.move':
      return `переместил ${whom ? `${whom} ` : ''}в «${s('toChannelName')}»`;

    default: {
      // 🔴 Здесь ловится НОВОЕ действие, которому забыли написать строку: союз перестаёт
      // сходиться в `never`, и падает типизация, а не журнал у человека.
      const unreachable: never = e.action;
      return String(unreachable);
    }
  }
}

/** Название звукового события так, как его зовут в настройках, а не ключом из кода. */
function soundEventName(event: string): string {
  const names: Record<string, string> = {
    join: 'вход в канал',
    leave: 'выход из канала',
    mute: 'выключение микрофона',
    unmute: 'включение микрофона',
    deafen: 'выключение звука',
    undeafen: 'включение звука',
    dm: 'личное сообщение',
    mention: 'упоминание',
    stream: 'начало показа',
    streamStop: 'конец показа',
    move: 'перемещение',
    tip: 'тип',
    coins: 'начисление монет',
  };
  return names[event] ?? event;
}

/** Какие именно настройки сервера тронули. Пустой хвост, когда запись их не сохранила. */
function changedTail(changed: unknown): string {
  if (!Array.isArray(changed) || changed.length === 0) return '';
  const names: Record<string, string> = {
    name: 'название',
    iconUrl: 'значок',
    description: 'описание',
    inviteOnly: 'вход по приглашению',
    currencyName: 'название валюты',
  };
  return `: ${changed.map((k) => names[String(k)] ?? String(k)).join(', ')}`;
}

/** «и доначислил N монет M людям» — доначисление не должно теряться в общей строке про настройки. */
function compensatedTail(compensated: number | null, people: number | null): string {
  if (!compensated) return '';
  return `, доначислив ${compensated} монет${peopleTail(people)}`;
}

function peopleTail(people: number | null): string {
  return people ? ` (${people} чел.)` : '';
}
