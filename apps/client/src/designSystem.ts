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
/**
 * Меню. Раунд 12 (04.10): у `ContextMenu` четыре необязательных пропса — `reactions` (полоса над карточкой), `anchor`
 * вместо `pos` (меню у пузыря; на телефоне не лист), `align`, `spotlight` (подложка, кроме строки); подвал «когда
 * отправлено» — разметкой `.ctx-foot`. `ReactionBar` — полоса быстрых реакций, по умолчанию наш набор 👍 🔥 😂 ❤️ 🦆
 * (`QUICK_REACTIONS` в `ContextMenu.tsx`; сюда не вынесен: страж выгрузки считает деталью всё с заглавной буквы).
 */
export {
  ContextMenu,
  MenuItem,
  MenuSection,
  MenuHeader,
  ReactionBar,
  type ContextMenuProps,
  type MenuAlign,
  type MenuPos,
  type MenuSpotlight,
  type ReactionBarProps,
} from './components/ContextMenu';
/**
 * Лента ЛС «как в Telegram» (Р13): пузырь, время в нём, дневная пилюля, цитата. Ими же собрана лента в приложении.
 * Раунд 10 (03.10): отметка у своих (`BubbleMeta status`) и цитата на вложение или удалённое (`ReplyQuote kind`/`thumb`).
 * Раунд 12 (04.10): `SelectCheck` — кружок выделения (кладётся в слот `actions` у `MessageBubble`), `ForwardedFrom` —
 * первая строка пересланного («Переслано от <имя>»); новых пропсов у `MessageBubble` нет.
 * 08.10 (G55): `ReplyQuote quote` — цитата фрагмента (курсив, кавычка в углу).
 */
export {
  MessageBubble,
  BubbleMeta,
  DayDivider,
  ReplyQuote,
  SelectCheck,
  ForwardedFrom,
  type BubbleSide,
  type BubbleStatus,
  type SelectCheckProps,
  type ForwardedFromProps,
} from './components/MessageBubble';
/**
 * Раунд 12 (05.10, порция 3б): две детали без стора и без сети — их содержимое и действия отдаёт зовущий. `PinnedBar` —
 * полоса закрепа под шапкой беседы (деления, «2 из 3», текст одной строкой, справа «Открепить» или «Все закреплённые»;
 * список закреплённых — `children`, пока `listOpen`). `SchedPick` — «Отправить позже»: окно по центру на ПК и лист снизу на
 * телефоне (по ширине окна, или принудительно пропсом `phone`), быстрые варианты, месяц сеткой, время; `now` подменяет
 * «сейчас» (примеры выгрузки не зависят от даты). Их правила — `pinBarRules.ts` и `schedRules.ts` (чистое).
 */
export { PinnedBar, type PinnedBarProps } from './components/PinnedBar';
export { SchedPick, type SchedPickProps } from './components/SchedPick';
/**
 * Большое окно с разделами — «рельс» (03.10): на нём все четыре окна настроек (пользователя, сервера, канала, админка).
 * До выноса разметка была скопирована в каждое окно, и в выгрузке её не было вовсе.
 */
export {
  SettingsWindow,
  SettingsRail,
  RailItem,
  RailAnchors,
  RailAnchor,
  SettingsSearch,
  SettingsHead,
  type SettingsWindowVariant,
} from './components/SettingsShell';

// ——— Как этим пользуются из кода ————————————————————————————————————————————
/** Свои окна вместо `window.confirm`/`alert`: нативные ЗАМОРАЖИВАЮТ вкладку целиком. */
export { confirmAction, confirmWithOption, alertDialog, useConfirmDialog } from './confirm';

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
/**
 * Какой пузырь у сообщения: обычный, фото во всю ширину, альбом из 2–10 фото и видео (раунд 10; 09.10: 2–4 по макету, 5–10 плитками «как
 * Telegram», раскладка `albumGrid` / `albumStyleOf` в `bubbleRules.ts`), крупные эмодзи (до трёх) или
 * стикер без пузыря. И что цитирует ответ (раунд 10): текст, фото, голосовое, файл, стикер или удалённое. Раунд 12:
 * `showsForwardedFrom` — у какого из пересланных подряд рисовать строку «Переслано от» (у первого от каждого автора
 * оригинала). 05.10: `replyQuoteLook` без цитируемого в ленте берёт вид вложения из полей сервера в самой цитате
 * (`ReplyQuoteSource`); видео — «Видео» (06.10: значок камеры — `replyQuoteVideo` + `ReplyKind` `video` у `ReplyQuote`, был значок
 * файла). 06.10: `bubbleLook` — видео рисуется кадром, как фото: одно
 * видео с размером — `media`, в альбоме из 2–4 — ячейка наравне с фото (кадр с ▶ и длительностью — `VideoAttachment`).
 */
export {
  ALBUM_MAX,
  JUMBO_MAX,
  MEDIA_MIN_W,
  TEXT_BUBBLE,
  type BubbleKind,
  type BubbleLook,
  type ForwardedSource,
  type ReplyKind,
  type ReplyQuoteLook,
  type ReplyQuoteSource,
  bubbleLook,
  emojiOnlyCount,
  replyQuoteLook,
  replyQuoteVideo,
  showsForwardedFrom,
} from './bubbleRules';
/**
 * Арифметика всплывающих слоёв: и меню, и список выбора считают место одним кодом. Раунд 12: `placeStackByPoint` —
 * меню с полосой реакций по точке клика, `placeByHalf` — меню у пузыря «по половине экрана». 09.10: `viewportSafe` — окно
 * без строки состояния и панели навигации (`--gv-sat` / `--gv-sab`); его передают все слои у якоря и точки.
 */
export {
  type CardBox,
  placeByAnchor,
  placeByHalf,
  placeByPoint,
  placeDropdown,
  placeStackByPoint,
  toLayoutPoint,
  toLayoutRect,
  viewport,
  viewportSafe,
} from './popover';
