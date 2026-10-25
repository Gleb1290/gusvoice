import { has, Permission } from '@gusvoice/shared';
import type { IconName } from './components/Icon';

/**
 * Какие вкладки настроек сервера доступны при таких правах — ЕДИНЫЙ источник правды.
 *
 * 🔴 Зачем отдельный модуль. Раньше список вкладок жил внутри `ServerSettingsModal`, а кнопка,
 * которая его открывает, стояла в `ChannelSidebar` под своим условием `MANAGE_SERVER ||
 * VIEW_AUDIT_LOG`. Каждая новая вкладка добавлялась в модалку и НЕ добавлялась в условие кнопки —
 * в итоге участник с правом на эмодзи (а также на стикеры, звуки и баны) видел вкладку, до которой
 * не мог добраться: пункта «Настройки сервера» у него просто не было.
 *
 * Теперь и дверь, и содержимое считаются здесь. Добавляя вкладку, правишь одно место, и забыть
 * про вход физически нельзя.
 *
 * Модуль чистый: ни стора, ни React — чтобы это правило проверялось тестом.
 */

export type ServerSettingsTab =
  | 'general'
  | 'roles'
  | 'members'
  | 'bans'
  | 'emoji'
  | 'stickers'
  | 'sounds'
  | 'soundboard'
  | 'integrations'
  | 'economy'
  | 'audit';

export interface TabDef {
  key: ServerSettingsTab;
  label: string;
  /** Одна строка под заголовком раздела: что здесь вообще лежит (рельс, как у настроек и админки). */
  sub: string;
  icon: IconName;
  /** Права, ЛЮБОЕ из которых открывает вкладку. */
  anyOf: bigint[];
}

/**
 * Порядок важен: первая доступная вкладка становится стартовой.
 *
 * ⚠️ У «Основного» ДВА права, и это не небрежность: вкладка содержит и переименование сервера
 * (`MANAGE_SERVER`), и управление категориями — а роуты категорий требуют `MANAGE_CHANNELS`.
 * Пока право было одно, выходило сразу две беды: с `MANAGE_SERVER` человек видел редактор
 * категорий и получал 403 на каждое действие, а с `MANAGE_CHANNELS` не мог войти вообще, хотя
 * право у него ровно на это. Внутри вкладки блоки разделены по своим правам.
 */
const TABS: TabDef[] = [
  {
    key: 'general',
    label: 'Основное',
    sub: 'Название, иконка и категории',
    icon: 'settings',
    anyOf: [Permission.MANAGE_SERVER, Permission.MANAGE_CHANNELS],
  },
  // «Роли» и «Участники» — бывшее отдельное окно под кнопкой 👥 (23.09, решение владельца: всё
  // управление сервером в одном месте, как в Discord). Кнопка 👥 осталась и открывает это окно
  // сразу на своём разделе.
  { key: 'roles', label: 'Роли', sub: 'Права ролей и их старшинство', icon: 'shield', anyOf: [Permission.MANAGE_ROLES] },
  // ⚠️ Два права, как было у кнопки 👥: кикающему без права на роли нужен список людей ради кика,
  // а выдача ролей внутри раздела заперта отдельно, по MANAGE_ROLES.
  {
    key: 'members',
    label: 'Участники',
    sub: 'Кто на сервере: выдать роль или кикнуть',
    icon: 'users',
    anyOf: [Permission.MANAGE_ROLES, Permission.KICK_MEMBERS],
  },
  { key: 'bans', label: 'Баны', sub: 'Кому закрыт вход и снятие запрета', icon: 'ban', anyOf: [Permission.BAN_MEMBERS] },
  { key: 'emoji', label: 'Эмодзи', sub: 'Свои эмодзи сервера', icon: 'reaction', anyOf: [Permission.MANAGE_EMOJIS] },
  {
    key: 'stickers',
    label: 'Стикеры',
    sub: 'Свои стикеры и наборы из Telegram',
    icon: 'sticker',
    anyOf: [Permission.MANAGE_STICKERS],
  },
  {
    key: 'sounds',
    label: 'Звуки',
    sub: 'Звуки событий в голосовых каналах',
    icon: 'bell',
    anyOf: [Permission.MANAGE_SOUNDS],
  },
  // ⚠️ СВОЯ вкладка, а не блок внутри «Звуков»: право отдельное, и держатель только его иначе не
  // добрался бы до панели вовсе — вкладка «Звуки» ему не показывается.
  {
    key: 'soundboard',
    label: 'Саундборд',
    sub: 'Сэмплы, которые включают в голосовом канале',
    icon: 'music',
    anyOf: [Permission.MANAGE_SOUNDBOARD],
  },
  // Все вебхуки сервера (#24, «Интеграции» у Discord). Право серверное; права каналов сервер учитывает сам при выдаче
  // списка (`/servers/:id/webhooks`), так что запертые каналы в разделе не видны.
  {
    key: 'integrations',
    label: 'Интеграции',
    sub: 'Вебхуки: внешние программы пишут в каналы',
    icon: 'link',
    anyOf: [Permission.MANAGE_WEBHOOKS],
  },
  {
    key: 'economy',
    label: 'Монеты',
    sub: 'Валюта сервера, начисление и магазин',
    icon: 'star',
    anyOf: [Permission.MANAGE_ECONOMY],
  },
  { key: 'audit', label: 'Журнал', sub: 'Кто и что менял на сервере', icon: 'activity', anyOf: [Permission.VIEW_AUDIT_LOG] },
];

/**
 * Что включено на ИНСТАНСЕ — не на сервере и не у человека.
 *
 * Право и включённость — разные вещи: у человека может быть `MANAGE_ECONOMY`, а экономики на
 * инстансе нет вовсе (`ECONOMY_ENABLED=false`), и тогда вкладки нет ни у кого, включая владельца.
 */
export interface ServerSettingsFeatures {
  economy: boolean;
}

/**
 * ⚠️ Умолчание «всё включено» — чтобы тесты этого модуля проверяли ПРАВА, а не флаги инстанса.
 * Оба живых вызова (модалка настроек и пункт меню в сайдбаре) флаги передают явно.
 */
const ALL_FEATURES: ServerSettingsFeatures = { economy: true };

function available(features: ServerSettingsFeatures): TabDef[] {
  return TABS.filter((t) => t.key !== 'economy' || features.economy);
}

export function serverSettingsTabs(perms: bigint, features: ServerSettingsFeatures = ALL_FEATURES): TabDef[] {
  return available(features).filter((t) => t.anyOf.some((p) => has(perms, p)));
}

/**
 * Показывать ли вообще пункт «Настройки сервера».
 *
 * Ровно «есть хотя бы одна вкладка» — иначе открылось бы пустое окно, а это выглядит как поломка.
 */
export function canOpenServerSettings(perms: bigint, features: ServerSettingsFeatures = ALL_FEATURES): boolean {
  return serverSettingsTabs(perms, features).length > 0;
}

/**
 * Доступен ли конкретный раздел. Нужен второй двери — кнопке 👥 «Роли и участники», которая открывает
 * то же окно сразу на своём разделе: её условие тоже считается здесь, а не своим `has()` в сайдбаре.
 */
export function serverSettingsHas(
  perms: bigint,
  key: ServerSettingsTab,
  features: ServerSettingsFeatures = ALL_FEATURES,
): boolean {
  return serverSettingsTabs(perms, features).some((t) => t.key === key);
}
