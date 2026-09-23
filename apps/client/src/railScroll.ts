/**
 * Прокрутка списка серверов в рейле — чистые правила, без DOM и без React.
 *
 * **Повод.** Серверов у человека становится больше, чем влезает по высоте, и список начинал давить
 * на нижние кнопки (настройки, админка, профиль): они уезжали за край или наезжали друг на друга.
 * Решение — прокручиваемая полоса серверов, а чтобы граница читалась, содержимое у краёв ТАЕТ:
 * серверы уплывают под кнопки, а не обрываются линейкой.
 *
 * 🔴 Затухание включается ТОЛЬКО с той стороны, где действительно что-то скрыто. Постоянная маска
 * съедала бы край первой и последней иконки даже у человека с тремя серверами — то есть у
 * большинства, кто про прокрутку никогда не узнает.
 */

/** Сколько пикселей у края считаем «уже докрутили» — чтобы затухание не мигало на субпиксельных сдвигах. */
export const RAIL_EDGE_SLACK = 2;

/** Сколько миллисекунд полоска прокрутки остаётся видимой после последнего движения. */
export const RAIL_SCROLLBAR_LINGER_MS = 900;

export interface RailEdges {
  /** Есть что-то выше текущего положения — значит верхний край должен таять. */
  top: boolean;
  /** Есть что-то ниже — тает нижний край. */
  bottom: boolean;
}

/** Какие края прокручиваемой полосы сейчас должны таять. */
export function railEdges(box: { scrollTop: number; scrollHeight: number; clientHeight: number }): RailEdges {
  // Прокручивать нечего — обе стороны видны целиком, маска не нужна вовсе.
  if (box.scrollHeight <= box.clientHeight + RAIL_EDGE_SLACK) return { top: false, bottom: false };
  return {
    top: box.scrollTop > RAIL_EDGE_SLACK,
    bottom: box.scrollTop + box.clientHeight < box.scrollHeight - RAIL_EDGE_SLACK,
  };
}

/** Класс полосы по состоянию краёв и прокрутки — одна строка, чтобы компонент не собирал её руками. */
export function railScrollClass(edges: RailEdges, scrolling: boolean): string {
  return [
    'rail-scroll',
    edges.top ? 'fade-top' : '',
    edges.bottom ? 'fade-bottom' : '',
    scrolling ? 'scrolling' : '',
  ]
    .filter(Boolean)
    .join(' ');
}
