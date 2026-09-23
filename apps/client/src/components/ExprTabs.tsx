import type { ReactNode } from 'react';

/**
 * Нижняя полоса вкладок «Эмодзи | Стикеры» в пикере строки ввода (#159, как в Telegram).
 *
 * Стикеры раньше открывались своей кнопкой рядом с эмодзи, а на телефоне — пунктом шторки «+»:
 * две двери к одному и тому же «чем ответить без слов». Теперь дверь одна — кнопка эмодзи, а
 * стикеры — соседняя вкладка. Сами пикеры остаются раздельными (см. `StickerPicker`), общая у них
 * только эта полоса.
 */
export type ExprTab = 'emoji' | 'stickers';

const KEY = 'gv_expr_tab';

/** Какую вкладку открыть: ту, что была последней. Удобство одного человека — хранится в браузере. */
export function getExprTab(): ExprTab {
  try {
    return localStorage.getItem(KEY) === 'stickers' ? 'stickers' : 'emoji';
  } catch {
    return 'emoji';
  }
}

export function setExprTab(t: ExprTab): void {
  try {
    localStorage.setItem(KEY, t);
  } catch {
    /* приватный режим — вкладка просто не запомнится */
  }
}

/**
 * Ставить ли фокус в поиск при открытии. На сенсорном экране с вкладками — нет: фокус в поле
 * поднимает клавиатуру, и каждое переключение вкладки выталкивало бы её снова поверх сетки.
 * Без вкладок (реакции, статус) и с мышью поведение прежнее.
 */
export function exprAutoFocus(footer: ReactNode | undefined): boolean {
  if (!footer) return true;
  try {
    return !window.matchMedia('(pointer: coarse)').matches;
  } catch {
    return true;
  }
}

export function ExprTabs({ tab, onTab }: { tab: ExprTab; onTab: (t: ExprTab) => void }) {
  const item = (t: ExprTab, label: string) => (
    <button
      type="button"
      role="tab"
      aria-selected={tab === t}
      className={tab === t ? 'active' : ''}
      onClick={() => {
        if (t === tab) return;
        setExprTab(t);
        onTab(t);
      }}
    >
      {label}
    </button>
  );
  return (
    <div className="expr-tabs" role="tablist" aria-label="Что отправить">
      {item('emoji', 'Эмодзи')}
      {item('stickers', 'Стикеры')}
    </div>
  );
}
