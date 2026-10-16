import { useRef, useState, type PointerEvent, type ReactNode, type TouchEvent } from 'react';
import { clampPinIndex, PIN_BAR_LONG_PRESS_MS, pinSegments, pinTitle } from '../pinBarRules';
import { Icon } from './Icon';

export interface PinnedBarProps {
  /** Сколько сообщений закреплено. Нет закреплённых — полоса не рисуется. */
  count: number;
  /** Какое показано: 0 — самое старое; при открытии беседы — новое (`count - 1`). Вне границ прижимается к ним. */
  index: number;
  /**
   * Текст одной строкой — по правилу цитат раунда 10: текст / подпись фото / «Фото» / «Голосовое сообщение · 0:42» /
   * «Файл: имя» / «Стикер». Длинное обрежется многоточием.
   */
  text: string;
  /** Миниатюра фото или стикера — квадрат 34 px слева от текста. */
  thumb?: string;
  /** Фото под спойлером (`media2`): миниатюра размыта. */
  thumbSpoiler?: boolean;
  /**
   * Нажата вся полоса. Переход к сообщению (с вспышкой) и сдвиг на предыдущее закреплённое — `index − 1`, по кругу, — дело
   * вызывающего: полоса только показывает то, что ей дали.
   */
  onOpen: () => void;
  /** Закреплено одно: кнопка справа — «Открепить» (крестик). Не передан — кнопки нет. */
  onUnpin?: () => void;
  /** Закреплено несколько: кнопка справа — «Все закреплённые» (список). Не передан — кнопки нет. */
  onList?: () => void;
  /**
   * Правый щелчок мышью по полосе (Telegram Desktop `HistoryWidget::barRightClicks`): перейти к СЛЕДУЮЩЕМУ закреплённому — к
   * более новому, от самого нового по кругу к самому старому. Решает зовущий; не передан — правый щелчок ничего не делает.
   */
  onNext?: () => void;
  /**
   * Долгое нажатие пальцем (контекстное меню касанием): открыть список всех закреплённых (у Telegram Android — и список, и
   * переход; решение G27 — список). Не передан — долгое нажатие ничего не делает. Правый щелчок мыши сюда не попадает.
   */
  onLongPress?: () => void;
  /** Список открыт — у кнопки `aria-expanded`, и рисуются `children`. */
  listOpen?: boolean;
  /**
   * Список всех закреплённых — существующий поповер `.pins-pop` (позиционируется от правого края полосы). Рисуется,
   * только пока `listOpen` и закреплённых несколько: полоса сама ничего не знает ни о сообщениях, ни о сети.
   */
  children?: ReactNode;
}

/**
 * Полоса закрепа под шапкой беседы (раунд 12, `docs/design/design-step12/HANDOFF.md` §2.3). Слева деления по числу
 * закреплённых (до четырёх, `pinBarRules.pinSegments`) — горит текущее; дальше миниатюра (если есть), «Закреплённое
 * сообщение» (при нескольких — «#N» / «Предыдущее сообщение», `pinBarRules.pinTitle`) и текст одной строкой. Вся полоса — кнопка «к сообщению»; справа отдельная кнопка:
 * при одном «Открепить», при нескольких «Все закреплённые» (`aria-expanded`, список — `children`).
 *
 * Деталь без стора: что закреплено, куда переходить и что в списке, решает вызывающий. Стили — блок «Раунд 12», §7.
 */
export function PinnedBar({ count, index, text, thumb, thumbSpoiler, onOpen, onUnpin, onList, onNext, onLongPress, listOpen = false, children }: PinnedBarProps) {
  // Каким был последний указатель над полосой: контекстное событие от пальца — долгое нажатие, от мыши — правый щелчок.
  const lastPointer = useRef<string>('mouse');
  // Э3 (#141): миниатюру даёт сервер ссылкой; вложение с соседнего инстанса может ещё копироваться (503) — без «битой» картинки.
  const [badThumb, setBadThumb] = useState<string | null>(null);
  // Долгое нажатие пальцем — своим таймером (как у пузырей ленты): системное контекстное событие WebView есть не везде, а когда
  // есть — приходит следом; `longFired` не даёт списку открыться и тут же закрыться, а нажатие после удержания — открыть сообщение.
  const longTimer = useRef<number | null>(null);
  const longFrom = useRef<{ x: number; y: number } | null>(null);
  const longFired = useRef(false);
  const clearLong = () => {
    if (longTimer.current !== null) window.clearTimeout(longTimer.current);
    longTimer.current = null;
  };
  if (!(count >= 1)) return null;
  const many = count > 1;
  const at = clampPinIndex(count, index);
  const side = many ? onList : onUnpin;
  const sideLabel = many ? 'Все закреплённые' : 'Открепить';
  return (
    <div className="pin-bar">
      <button
        type="button"
        className="pin-bar-main"
        onClick={() => {
          if (longFired.current) {
            longFired.current = false;
            return;
          }
          onOpen();
        }}
        onPointerDown={(e: PointerEvent<HTMLElement>) => {
          lastPointer.current = e.pointerType || 'mouse';
        }}
        onTouchStart={(e: TouchEvent<HTMLElement>) => {
          longFired.current = false;
          clearLong();
          if (!onLongPress) return;
          const t = e.touches[0];
          longFrom.current = { x: t.clientX, y: t.clientY };
          longTimer.current = window.setTimeout(() => {
            longTimer.current = null;
            longFired.current = true;
            onLongPress();
          }, PIN_BAR_LONG_PRESS_MS);
        }}
        onTouchMove={(e: TouchEvent<HTMLElement>) => {
          const from = longFrom.current;
          const t = e.touches[0];
          if (from && t && Math.hypot(t.clientX - from.x, t.clientY - from.y) > 10) clearLong();
        }}
        onTouchEnd={clearLong}
        onTouchCancel={clearLong}
        onContextMenu={(e) => {
          e.preventDefault();
          if (lastPointer.current === 'touch' || lastPointer.current === 'pen') {
            if (!longFired.current) {
              longFired.current = true;
              clearLong();
              onLongPress?.();
            }
          } else onNext?.();
        }}
        aria-label={`К закреплённому сообщению${many ? ` ${at + 1} из ${count}` : ''}`}
      >
        <span className="pin-bar-ind" aria-hidden="true">
          {pinSegments(count, at).map((on, i) => (
            <i className={on ? 'on' : undefined} key={i} />
          ))}
        </span>
        {thumb && thumb !== badThumb && (
          <img className={thumbSpoiler ? 'pin-bar-thumb spoiled-thumb' : 'pin-bar-thumb'} src={thumb} alt="" onError={() => setBadThumb(thumb)} />
        )}
        <span className="pin-bar-text">
          <span className="pin-bar-title">
            {pinTitle(count, at)}
          </span>
          <span className="pin-bar-msg">{text}</span>
        </span>
      </button>
      {side && (
        <button
          type="button"
          className="topbar-btn pin-bar-btn"
          aria-label={sideLabel}
          title={sideLabel}
          aria-expanded={many ? listOpen : undefined}
          onClick={side}
        >
          <Icon name={many ? 'list' : 'close'} size={18} />
        </button>
      )}
      {many && listOpen && children}
    </div>
  );
}
