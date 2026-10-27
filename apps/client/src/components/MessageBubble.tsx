import { useState, type HTMLAttributes, type MouseEvent, type ReactNode } from 'react';
import type { BubbleKind, ReplyKind } from '../bubbleRules';
import { Icon, type IconName } from './Icon';

/**
 * Пузыри личных сообщений «как в Telegram» (Р13) — детали дизайн-системы, из них же собрана лента ЛС
 * (`MessagePane.MessageRow` с пропом `bubbles` — все ЛС с 09.10).
 *
 * Свои — справа, собеседника — слева; в беседе вдвоём ни аватара, ни имени: кто есть кто, видно по стороне.
 * Подряд идущие сообщения склеиваются в группу (углы со стороны автора почти острые), у последнего в группе —
 * «хвостик». Время внутри пузыря. Какой вид у сообщения (обычный, фото во всю ширину, крупные эмодзи, стикер) —
 * решает `bubbleLook` из `bubbleRules.ts`, здесь только разметка. Стили — блок «ЛС как в Telegram» в `styles.css`,
 * цвета — токены `--bubble-in` / `--bubble-out`.
 *
 * Раунд 12 (04.10) добавил две детали к пузырю, обе без новых пропсов у `MessageBubble`: `SelectCheck` — кружок
 * выделения, кладётся в слот `actions`; `ForwardedFrom` — первая строка пересланного, кладётся первым ребёнком пузыря
 * (рисовать ли её, решает `bubbleRules.showsForwardedFrom`). Стили обеих — блок «Раунд 12» в `styles.css`.
 *
 * ⚠️ Чистые компоненты: без стора и сети. Всё живое (меню, касания, переход по цитате) приходит пропсами.
 */

/** Сторона: `out` — свои сообщения (справа), `in` — собеседника (слева). */
export type BubbleSide = 'out' | 'in';

export interface MessageBubbleProps extends Omit<HTMLAttributes<HTMLDivElement>, 'children'> {
  side: BubbleSide;
  /** Не первое в группе подряд идущих: верхний угол со стороны автора почти острый, отступ сверху меньше. */
  grouped?: boolean;
  /** Последнее в группе: «хвостик» к автору. */
  tail?: boolean;
  /** Вид пузыря (`bubbleLook`): `text` — с полями, `media` — фото во всю ширину, `emoji` и `sticker` — без пузыря. */
  kind?: BubbleKind;
  /** Сколько крупных эмодзи (1…3) у вида `emoji` — от этого их размер. */
  jumbo?: number;
  /** Ширина пузыря с фото, px: пузырь ровно по картинке, подпись переносится по её ширине. */
  mediaWidth?: number | null;
  /** Время поверх фото — когда под фото ничего нет (ни подписи, ни реакций): углы фото = углы пузыря, без хвостика. */
  mediaEnd?: boolean;
  /** С сообщением работают (его меню, пикер реакций, правка) — обводка пузыря. */
  active?: boolean;
  /**
   * Место под аватар слева от пузыря — только в широкой ленте «все слева» (как Telegram Desktop: там аватар у всех,
   * и у своих, иначе свои фото и крупные эмодзи без пузыря не отличить от чужих). `null` — пустое место той же
   * ширины (не последнее в группе: аватар один на группу, у последнего); `undefined` — места нет вовсе.
   */
  avatar?: ReactNode;
  /**
   * Действия наведения рядом с пузырём, со стороны середины ленты (ответить, реакция, изменить, удалить). В режиме
   * выделения (раунд 12) на их месте — `SelectCheck`, а сама строка получает `className="picked"`, `role="checkbox"`,
   * `aria-checked` и `onClick`: это сквозные атрибуты строки, новых пропсов для выделения нет.
   */
  actions?: ReactNode;
  /**
   * Кнопки под пузырём (сообщение бота, #230 — `MessageKeyboard`). Есть — пузырь и кнопки встают колонкой `.bub-stack` (ширина
   * кнопок = ширине пузыря, как у Telegram); нет — разметка строки прежняя.
   */
  kb?: ReactNode;
  children: ReactNode;
}

/**
 * Строка ленты с пузырём. Остальные пропсы (`data-mid`, касания, правый клик, `aria-*`) уходят на саму строку.
 * `className` добавляется к классам строки (например, `outgoing sending` у сообщения в пути).
 */
export function MessageBubble({
  side,
  grouped = false,
  tail = true,
  kind = 'text',
  jumbo = 0,
  mediaWidth = null,
  mediaEnd = false,
  active = false,
  avatar,
  actions,
  kb,
  children,
  className,
  ...row
}: MessageBubbleProps) {
  const rowClass =
    `message bub ${side === 'out' ? 'mine' : 'theirs'}` +
    `${grouped ? ' grouped' : ''}${tail ? ' tail' : ''}${active ? ' active' : ''}${className ? ` ${className}` : ''}`;
  const bubbleClass =
    `message-main bubble${kind === 'text' ? '' : ` ${kind}`}` +
    `${kind === 'emoji' && jumbo > 0 ? ` jumbo-${Math.min(jumbo, 3)}` : ''}${kind === 'media' && mediaEnd ? ' media-end' : ''}`;
  return (
    <div {...row} className={rowClass}>
      {avatar !== undefined && <span className="bub-ava">{avatar}</span>}
      {kb ? (
        <div className="bub-stack">
          <div className={bubbleClass} style={kind === 'media' && mediaWidth ? { width: mediaWidth } : undefined}>
            {children}
          </div>
          {kb}
        </div>
      ) : (
        <div className={bubbleClass} style={kind === 'media' && mediaWidth ? { width: mediaWidth } : undefined}>
          {children}
        </div>
      )}
      {actions}
    </div>
  );
}

/**
 * Отметка у своего сообщения (раунд 10): `sending` — часы (только если сервер молчит дольше секунды), `sent` — ✓,
 * `read` — ✓✓ (собеседник прочитал; с раунда 11 — цветом времени, «прочитано» отличает вторая галочка, а не мёд),
 * `failed` — красный кружок «не отправлено».
 */
export type BubbleStatus = 'sending' | 'sent' | 'read' | 'failed';

const STATUS_ICON: Record<BubbleStatus, { icon: IconName; title: string }> = {
  sending: { icon: 'clock', title: 'Отправляется' },
  sent: { icon: 'check', title: 'Отправлено' },
  read: { icon: 'checks', title: 'Прочитано' },
  failed: { icon: 'alert-circle', title: 'Не отправлено' },
};

/**
 * Время в пузыре — тихое (раунд 11): Manrope 500, 10.5 px, цифры не выше строчных текста, база — на базовой линии
 * текста; цвет в тон пузырю (`--bubble-in-meta` / `--bubble-out-meta`, 4.6:1). `edited` — пометка «изм.» перед временем.
 * `over` — поверх фото: тёмная полупрозрачная пилюля со светлым текстом, читается на любой картинке.
 * Без пузыря (крупные эмодзи, стикер) время само становится маленькой пилюлей — это делают стили.
 * `status` — отметка после времени, только у своих (`side="out"`); 14 px, обводка 1.5, цветом времени; работает во всех
 * четырёх местах времени.
 */
export function BubbleMeta({
  time,
  edited = false,
  over = false,
  status,
  title,
}: {
  time: string;
  edited?: boolean;
  over?: boolean;
  status?: BubbleStatus;
  /** Подсказка по наведению на время — полная дата (`messagePaneRules.timeTooltip`); пусто — без подсказки. */
  title?: string;
}) {
  const st = status ? STATUS_ICON[status] : null;
  return (
    <span className={over ? 'bub-meta over' : 'bub-meta'} title={title || undefined}>
      {edited ? 'изм. ' : ''}
      {time}
      {/* `key` — новая отметка (часы → ✓ → ✓✓) монтируется заново и проигрывает появление. */}
      {st ? (
        <span key={status} className={`bub-st ${status}`}>
          <Icon name={st.icon} size={16} title={st.title} />
        </span>
      ) : null}
    </span>
  );
}

/**
 * Дневная метка в ленте: без неё, чтобы понять, где кончился вчерашний разговор, приходится читать время у каждого
 * сообщения. `pill` — пилюлей посередине, как у Telegram (лента пузырей); без него — чертой через всю ленту
 * (каналы).
 */
export function DayDivider({ label, pill = false }: { label: string; pill?: boolean }) {
  return (
    <div className={pill ? 'day-divider pill' : 'day-divider'} role="separator">
      <span>{label}</span>
    </div>
  );
}

/**
 * Цитата сообщения, на которое отвечают, — кнопка перехода к нему. В канале это строка над текстом; в пузыре —
 * блок с медовой чертой слева: имя автора, под ним начало текста (так у Telegram). На вложение — с миниатюрой слева;
 * удалённое — не кнопка: ни автора, ни перехода, только «Сообщение удалено».
 */
export function ReplyQuote({
  author,
  text,
  onClick,
  kind = 'text',
  thumb,
  spoiler,
  quote = false,
}: {
  author: string;
  text: string;
  onClick?: () => void;
  kind?: ReplyKind;
  thumb?: string;
  /** Миниатюра под спойлером (`media2`) — размыта, как у Telegram. */
  spoiler?: boolean;
  /**
   * Цитата фрагмента (08.10, G55, `quote1`): в `text` — выбранный кусок, а не начало сообщения. Курсив и кавычка в правом
   * верхнем углу — как у Telegram (`history_view_reply.cpp`: значок цитаты у плашки с `quote`).
   */
  quote?: boolean;
}) {
  // Э3 (#141): миниатюру даёт сервер ссылкой, а вложение с соседнего инстанса может ещё копироваться (503) — вместо «битой» картинки значок.
  const [badThumb, setBadThumb] = useState<string | null>(null);
  if (kind === 'deleted') {
    return (
      <div className="reply-quote deleted">
        <span className="rq-text">{text}</span>
      </div>
    );
  }
  const preview =
    kind === 'photo' || kind === 'sticker' ? (
      thumb && thumb !== badThumb ? (
        <span className={kind === 'sticker' ? 'rq-thumb sticker' : 'rq-thumb'}>
          <img src={thumb} alt="" className={spoiler && kind === 'photo' ? 'spoiled-thumb' : undefined} onError={() => setBadThumb(thumb)} />
        </span>
      ) : (
        // Картинки ещё нет (закрытый файл ЛС ждёт ссылку) — значок того же размера, цитата не прыгает.
        <span className="rq-thumb icon">
          <Icon name={kind === 'sticker' ? 'sticker' : 'photo'} size={18} />
        </span>
      )
    ) : kind === 'voice' || kind === 'file' || kind === 'video' ? (
      // Видео (06.10) — камера, а не листок файла: кадра у цитаты нет (миниатюры видео сервер не хранит).
      <span className="rq-thumb icon">
        <Icon name={kind === 'voice' ? 'mic' : kind === 'video' ? 'camera' : 'file'} size={18} />
      </span>
    ) : null;
  return (
    <button
      type="button"
      className={`reply-quote${preview ? ' has-thumb' : ''}${quote ? ' quoted' : ''}`}
      title="Перейти к сообщению"
      onClick={onClick}
    >
      <Icon name="reply" size={13} />
      {preview}
      <span className="rq-author">{author}</span>
      <span className="rq-text">{text}</span>
    </button>
  );
}

export interface SelectCheckProps {
  /** Сообщение выбрано: кружок залит мёдом, внутри галочка; нет — пустое кольцо. */
  checked: boolean;
}

/**
 * Кружок режима выделения (раунд 12, HANDOFF §2.2) — слева от строки сообщения. Кладётся в слот `actions` у
 * `MessageBubble`: действия наведения живут там же, а в режиме выделения их нет. Сама строка — флажок целиком:
 * `className="picked"` у выбранной, `role="checkbox"`, `aria-checked`, `onClick` — переключить; кружок только рисует,
 * поэтому для вспомогательных технологий скрыт.
 *
 * Слот `.bub-slot.start` — абсолютный, на высоту пузыря (без верхнего отступа строки), кружок 22 px; пузыри уезжают
 * вправо, освобождая колонку, сдвигом `.messages.sel-mode` (`--sel-col`), а не отступом. Появление — `selIn`.
 */
export function SelectCheck({ checked }: SelectCheckProps) {
  return (
    <span className="bub-slot start" aria-hidden="true">
      <span className={checked ? 'sel-check on' : 'sel-check'}>
        <Icon name="check" size={14} stroke={3} />
      </span>
    </span>
  );
}

export interface ForwardedFromProps {
  /** Имя автора оригинала — в именительном падеже, как пришло от сервера (`forwardedFrom.displayName`). */
  name: string;
  /**
   * Открыть профиль автора оригинала. Нет — имя не кнопка, а просто текст: так у удалённого автора, открывать нечего
   * (сервер подставляет ему обезличенное имя). Событие нажатия — чтобы карточка профиля встала у точки нажатия, как у
   * аватара в ленте (порция 5).
   */
  onOpen?: (e: MouseEvent<HTMLButtonElement>) => void;
}

/**
 * «Переслано от <имя>» (раунд 12, HANDOFF §2.4) — первая строка пузыря, раньше цитаты: «Переслано от» тихо, цветом
 * времени своего пузыря, имя — медовым 700. У вида `media` стоит над снимком (поля и отступ дают правила
 * `.bubble.media`). Нажатие на имя всплывает до строки, как любое другое: в режиме выделения `onOpen` не передают —
 * имя тогда просто текст, и нажатие переключает строку. Рисовать ли строку у очередного сообщения серии —
 * `bubbleRules.showsForwardedFrom`.
 */
export function ForwardedFrom({ name, onOpen }: ForwardedFromProps) {
  return (
    <div className="bub-fwd">
      {'Переслано от '}
      {onOpen ? (
        <button type="button" className="bub-fwd-name" onClick={onOpen}>
          {name}
        </button>
      ) : (
        <span className="bub-fwd-name">{name}</span>
      )}
    </div>
  );
}
