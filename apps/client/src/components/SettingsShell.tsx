import type {
  ButtonHTMLAttributes,
  HTMLAttributes,
  InputHTMLAttributes,
  KeyboardEventHandler,
  ReactNode,
  Ref,
} from 'react';
import { usePhoneLayout } from '../phoneLayout';
import { Icon, type IconName } from './Icon';

/**
 * Оболочка большого окна с разделами — «рельс» (#153, round 9). С 23.09 на ней все четыре окна настроек: пользователя,
 * сервера, канала и админ-панель. Детали дизайн-системы: из них же собраны эти окна в приложении.
 *
 * Слева рельс: заголовок окна, у настроек пользователя — поиск, список разделов (значок + название) с точками
 * «изменено» и «не просмотрено», под открытым разделом — якоря его групп. Справа шапка раздела: заголовок, строка
 * «что здесь лежит», крестик; под ней — содержимое раздела. На телефоне (до 760 px) это два экрана: список разделов,
 * тап — раздел (класс `picked`), «назад» в шапке — снова список.
 *
 * 🔴 До 03.10 эта разметка была скопирована в четыре окна, а в дизайн-системе её не было вовсе: дизайн-чат не знал, что
 * рельс — общая оболочка любого большого окна, и нарисовал бы третью раскладку. Окна переведены на эти детали без
 * единого изменения разметки (сверено на стенде побайтно, ПК и телефон).
 *
 * ⚠️ Чистые компоненты: без стора и сети. Что открыто, что изменено и что увидено — считает окно и передаёт пропсами.
 * Стили — блок «Настройки: рельс разделов» в `styles.css`.
 */

/** Какое окно. От него размер на ПК и прежние классы семейства, на которые опираются стили содержимого. */
export type SettingsWindowVariant = 'user' | 'server' | 'channel' | 'admin';

// 🔴 Классы — ровно прежние: `admin` и `channel-settings` несут стили содержимого (таблицы админки, формы канала),
// размер задаёт последний класс.
const WINDOW_CLASS: Record<SettingsWindowVariant, string> = {
  user: 'modal admin rail-modal settings-modal', // 980 × 660 — личные настройки
  server: 'modal admin rail-modal server-rail', // 1180 × 720 — «Роли»: список ролей и права в две колонки
  channel: 'modal channel-settings rail-modal channel-rail', // 860 × 640 — формы и один список прав
  admin: 'modal admin rail-modal admin-rail', // 1500 × 720 — таблица пользователей с почтой и тумблерами
};

export interface SettingsWindowProps
  extends Omit<HTMLAttributes<HTMLDivElement>, 'className' | 'role' | 'title' | 'children'> {
  variant: SettingsWindowVariant;
  /** Телефон: открыт раздел (второй экран), а не список разделов. На ПК видны оба сразу. */
  picked?: boolean;
  /** Клик мимо окна и оба крестика. */
  onClose: () => void;
  /** `id` заголовка раздела (`SettingsHead.titleId`) — им окно подписано для читалок. */
  titleId: string;
  /** Окно целиком — ловушке фокуса и возврату фокуса. */
  dialogRef?: Ref<HTMLDivElement>;
  /** Левая колонка — `SettingsRail`. */
  rail: ReactNode;
  /** Правая колонка: `SettingsHead`, под ней содержимое раздела. */
  children: ReactNode;
  /** Окна поверх этого (обрезка картинки, права категории): в той же подложке, после окна. */
  outside?: ReactNode;
}

export function SettingsWindow({
  variant,
  picked = false,
  onClose,
  titleId,
  dialogRef,
  rail,
  children,
  outside,
  ...dialog
}: SettingsWindowProps) {
  return (
    <div className="modal-overlay" onClick={onClose}>
      <div
        className={`${WINDOW_CLASS[variant]}${picked ? ' picked' : ''}`}
        {...dialog}
        onClick={(e) => e.stopPropagation()}
        ref={dialogRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        tabIndex={-1}
      >
        {rail}
        <div className="set-main">{children}</div>
      </div>
      {outside}
    </div>
  );
}

export interface SettingsRailProps {
  /** Заголовок окна: «Настройки», «Админ-панель · Гусятня», имя сервера или канала. */
  title: string;
  /** Имя, которое дал человек (сервер, канал): длинное режется многоточием, целиком — во всплывающей подсказке. */
  named?: boolean;
  /** Значок перед именем — у канала его глиф (`ChannelGlyph`). Имя при этом режется, как у `named`. */
  glyph?: ReactNode;
  /**
   * Поле поиска (`SettingsSearch`). С поиском рельс на ПК начинается прямо с него, а строка «заголовок + крестик»
   * видна только на телефоне: там список разделов — отдельный экран, и без неё окно с него нечем закрыть (системная
   * «назад» выбрасывает из приложения целиком — проверено на устройстве). Без поиска заголовок окна виден всегда:
   * иначе «что это за окно» читается только по выделенной строке.
   */
  search?: ReactNode;
  /** Подпись списка разделов для читалок: «Разделы настроек сервера». */
  label: string;
  onClose: () => void;
  /** Стрелки по разделам с клавиатуры. */
  onListKeyDown?: KeyboardEventHandler<HTMLDivElement>;
  /** Разделы — `RailItem`; у окна с якорями каждый раздел вместе со своими `RailAnchors` — в обёртке `<div>`. */
  children: ReactNode;
}

export function SettingsRail({ title, named, glyph, search, label, onClose, onListKeyDown, children }: SettingsRailProps) {
  /* Телефон (#218): список разделов — отдельный экран, и закрывает его не «✕» справа, а стрелка «←» слева от названия, как в
     настройках Telegram (`ActionBar` с `BACK`, `TA/ui/SettingsActivity`). Та же кнопка, тот же `onClose`; на ПК — по-прежнему «✕». */
  const phone = usePhoneLayout();
  return (
    <div className="set-rail">
      <div className={`${search ? 'set-rail-head' : 'set-rail-title'}${phone ? ' back-left' : ''}`}>
        {phone && (
          <button type="button" className="icon-close icon-back" title="Закрыть" aria-label="Закрыть" onClick={onClose}>
            <Icon name="chevron-left" size={24} />
          </button>
        )}
        {glyph ? (
          <span className="ch-settings-title" title={title}>
            {glyph}
            <span className="rail-title-text">{title}</span>
          </span>
        ) : named ? (
          <span className="rail-title-text" title={title}>
            {title}
          </span>
        ) : (
          <span>{title}</span>
        )}
        {!phone && (
          <button type="button" className="icon-close" title="Закрыть" aria-label="Закрыть" onClick={onClose}>
            <Icon name="close" size={18} />
          </button>
        )}
      </div>
      {search}
      <div className="set-rail-list" role="tablist" aria-label={label} aria-orientation="vertical" onKeyDown={onListKeyDown}>
        {children}
      </div>
    </div>
  );
}

export interface RailItemProps
  extends Omit<ButtonHTMLAttributes<HTMLButtonElement>, 'children' | 'type' | 'role' | 'className'> {
  icon: IconName;
  label: ReactNode;
  /** Открытый раздел. */
  active?: boolean;
  /**
   * Залитая точка «здесь не как с завода». Считается отличие от ЗАВОДСКОГО значения, а не «сюда заходили»: вернул
   * как было — точка гаснет. Акцентная, без красного: изменённая настройка — не ошибка, человек так захотел.
   */
  changed?: boolean;
  /** Точка-кольцо «здесь есть то, чего ты ещё не видел» — контурная, чтобы не путалась с «изменено». */
  unseen?: boolean;
}

export function RailItem({
  icon,
  label,
  active = false,
  changed,
  unseen,
  id,
  'aria-controls': controls,
  tabIndex,
  ...rest
}: RailItemProps) {
  return (
    <button
      type="button"
      role="tab"
      id={id}
      aria-selected={active}
      aria-controls={controls}
      tabIndex={tabIndex}
      className={`set-rail-item${active ? ' active' : ''}`}
      {...rest}
    >
      <Icon name={icon} size={16} />
      <span>{label}</span>
      {changed && <span className="set-dot" role="img" aria-label="есть изменения" />}
      {unseen && <span className="set-dot new" role="img" aria-label="есть непросмотренное" />}
    </button>
  );
}

/** Якоря групп открытого раздела — оглавление экрана, а не второй уровень меню. */
export function RailAnchors({ children }: { children: ReactNode }) {
  return <div className="set-rail-anchors">{children}</div>;
}

export interface RailAnchorProps extends Omit<ButtonHTMLAttributes<HTMLButtonElement>, 'type' | 'className'> {
  /** Группа, до которой сейчас докручено: полоска слева и жирный шрифт. */
  on?: boolean;
  changed?: boolean;
  unseen?: boolean;
  children: ReactNode;
}

export function RailAnchor({ on = false, changed, unseen, children, ...rest }: RailAnchorProps) {
  return (
    <button type="button" className={`set-rail-anchor${on ? ' on' : ''}`} {...rest}>
      {children}
      {changed && <span className="set-dot" role="img" aria-label="есть изменения" />}
      {unseen && <span className="set-dot new" role="img" aria-label="не просмотрено" />}
    </button>
  );
}

export interface SettingsSearchProps extends Omit<InputHTMLAttributes<HTMLInputElement>, 'type'> {
  inputRef?: Ref<HTMLInputElement>;
  /** Клавиши, которые ставят курсор в поиск. */
  shortcut?: string;
}

/** Поиск по настройкам — первая строка рельса. Находки показывает окно (`set-results` под шапкой раздела). */
export function SettingsSearch({
  inputRef,
  shortcut = 'Ctrl K',
  value,
  placeholder = 'Поиск',
  'aria-label': ariaLabel = 'Поиск по настройкам',
  ...input
}: SettingsSearchProps) {
  return (
    <div className="set-search">
      <Icon name="search" size={15} />
      <input ref={inputRef} value={value} placeholder={placeholder} aria-label={ariaLabel} {...input} />
      <kbd>{shortcut}</kbd>
    </div>
  );
}

export interface SettingsHeadProps {
  title: ReactNode;
  /** `id` заголовка — его же получает `SettingsWindow.titleId`. */
  titleId: string;
  /** Строка «что здесь лежит». Не передана — строки нет. */
  sub?: ReactNode;
  /**
   * «изменено 2 из 14» — после строки, медовым. Это КНОПКА: человек хочет увидеть, ЧТО изменено, и клик ведёт к
   * первой изменённой группе. Живёт вместе с точками: всё изменённое увидено — счётчика нет.
   */
  changed?: ReactNode;
  onShowChanged?: () => void;
  /** Действия раздела между заголовком и крестиком: «⟳ обновить» в админке — только там, где есть что обновлять. */
  actions?: ReactNode;
  /** Телефон: «назад» к списку разделов (на ПК кнопки нет). */
  onBack: () => void;
  onClose: () => void;
}

export function SettingsHead({ title, titleId, sub, changed, onShowChanged, actions, onBack, onClose }: SettingsHeadProps) {
  return (
    <div className="set-head">
      <button type="button" className="set-back" onClick={onBack} aria-label="К разделам">
        <Icon name="chevron-left" size={18} />
      </button>
      <div className="set-head-text">
        <h2 id={titleId}>{title}</h2>
        {sub !== undefined || changed ? (
          <div className="set-head-sub">
            {sub}
            {changed ? (
              <button type="button" className="set-head-mark" onClick={onShowChanged}>
                · {changed}
              </button>
            ) : null}
          </div>
        ) : null}
      </div>
      {actions}
      <button type="button" className="icon-close" title="Закрыть" aria-label="Закрыть" onClick={onClose}>
        <Icon name="close" size={18} />
      </button>
    </div>
  );
}
