import { has, Permission } from '@gusvoice/shared';

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
  | 'bans'
  | 'emoji'
  | 'stickers'
  | 'sounds'
  | 'soundboard'
  | 'economy'
  | 'audit';

export interface TabDef {
  key: ServerSettingsTab;
  label: string;
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
  { key: 'general', label: 'Основное', anyOf: [Permission.MANAGE_SERVER, Permission.MANAGE_CHANNELS] },
  { key: 'bans', label: 'Баны', anyOf: [Permission.BAN_MEMBERS] },
  { key: 'emoji', label: 'Эмодзи', anyOf: [Permission.MANAGE_EMOJIS] },
  { key: 'stickers', label: 'Стикеры', anyOf: [Permission.MANAGE_STICKERS] },
  { key: 'sounds', label: 'Звуки', anyOf: [Permission.MANAGE_SOUNDS] },
  // ⚠️ СВОЯ вкладка, а не блок внутри «Звуков»: право отдельное, и держатель только его иначе не
  // добрался бы до панели вовсе — вкладка «Звуки» ему не показывается.
  { key: 'soundboard', label: 'Саундборд', anyOf: [Permission.MANAGE_SOUNDBOARD] },
  { key: 'economy', label: 'Монеты', anyOf: [Permission.MANAGE_ECONOMY] },
  { key: 'audit', label: 'Журнал', anyOf: [Permission.VIEW_AUDIT_LOG] },
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
