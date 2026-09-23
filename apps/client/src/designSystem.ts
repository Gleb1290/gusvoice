/**
 * Ядро дизайн-системы GusVoice — ОДНА точка входа (#153).
 *
 * **Зачем файл существует.** Дизайн-чат (claude.ai/design) не читает этот репозиторий: он знает
 * только то, что ему рассказали в переписке. Из-за этого раунд 8 начался с того, что дизайн рисовал
 * СВОЕГО гуся, не зная, что маскот с конца августа — восемь готовых PNG. Лечится это не длинными
 * брифами, а выгрузкой настоящей системы: собранные отсюда компоненты становятся деталями, из
 * которых дизайн собирает экраны, а `docs/design/SYSTEM.md` и `docs/design/STATE.md` — его памятью
 * о том, что у нас уже есть и что поменялось.
 *
 * **Что сюда попадает.** Только то, чем пользуется ЛЮБОЙ экран и что живёт без сети и стора:
 * иконки, маскот, тумблер, список выбора, окно подтверждения, лист снизу, правила и токены. Всё,
 * что тянет `api`/`store`/LiveKit, — не деталь системы, а часть приложения, и здесь ему не место.
 *
 * ⚠️ Файл ничего не реализует и ни на что не влияет в бою — он перечисляет. Добавили в ядро
 * компонент — допишите строку сюда и абзац в `docs/design/STATE.md`, иначе выгрузка о нём не узнает.
 */

// ——— Разметка и поведение ———————————————————————————————————————————————————
export { Icon, ChannelGlyph, isCustomIcon, type IconName } from './components/Icon';
export { Goose, type GoosePose } from './components/Goose';
export { Toggle } from './components/Toggle';
export { Avatar } from './components/Avatar';
export { StatusDot } from './components/StatusDot';
export { BottomSheet, SheetRow } from './components/BottomSheet';
export { Select, type SelectOption } from './components/Select';
export { ConfirmHost } from './components/ConfirmHost';
export { ContextMenu, MenuItem, MenuSection, MenuHeader, type MenuPos } from './components/ContextMenu';

// ——— Как этим пользуются из кода ————————————————————————————————————————————
/** Свои окна вместо `window.confirm`/`alert`: нативные ЗАМОРАЖИВАЮТ вкладку целиком. */
export { confirmAction, alertDialog, useConfirmDialog } from './confirm';

// ——— Чистые правила (их же проверяет Codex тестами) —————————————————————————
export {
  type ConfirmSpec,
  type ConfirmTone,
  canConfirm,
  confirmLabelOf,
  enterHintOf,
  hasCancel,
  submitsOnEnter,
} from './confirmRules';
export {
  SEARCH_FROM,
  filterOptions,
  groupOptions,
  hasValue,
  initialHighlight,
  matchOption,
  moveHighlight,
  shouldSearch,
  triggerTextOf,
} from './selectRules';
export {
  SECTIONS,
  SEARCH_MIN,
  type SectionKey,
  type SettingsEntry,
  type SettingsGroup,
  type SettingsSection,
  searchSettings,
  sectionOf,
  visibleSections,
} from './settingsNav';
/** Арифметика всплывающих слоёв: и меню, и список выбора считают место одним кодом. */
export { placeByAnchor, placeByPoint, placeDropdown, toLayoutPoint, toLayoutRect, viewport } from './popover';
