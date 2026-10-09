import { useEffect, useState, type RefObject } from 'react';
import { FORMAT_TOUCH_MENU, selectionHasFormat } from '../fieldFormat';
import { formatField } from '../fieldFormatDom';

/**
 * Форматирование выделенного текста в поле на телефоне (G20, #211). Telegram Android добавляет «Цитировать», «Скрытый»,
 * «Жирный»… «Обычный» в меню выделения поля (02·4.5); в системное меню WebView страница пункты не добавит, поэтому — своя
 * полоса над полем тем же видом, что полоса выделения текста в ленте (`.tsel-bar`, `TextSelection.tsx`). Пока в поле есть
 * выделение и указатель — палец; на ПК то же — подменю «Форматирование» в меню поля (`EditContextMenu`).
 *
 * Нажатие не уводит фокус из поля (`pointerdown` погашен) — выделение остаётся, второе нажатие снимает формат.
 */
export function FieldFormatBar({ fieldRef }: { fieldRef: RefObject<HTMLTextAreaElement | null> }) {
  const [pos, setPos] = useState<{ left: number; bottom: number; hasFormat: boolean } | null>(null);

  useEffect(() => {
    const coarse = window.matchMedia('(pointer: coarse)');
    const update = () => {
      const el = fieldRef.current;
      if (!el || !coarse.matches || document.activeElement !== el) return setPos(null);
      const a = el.selectionStart ?? 0;
      const b = el.selectionEnd ?? 0;
      if (a === b) return setPos(null);
      const r = el.getBoundingClientRect();
      // От левого края экрана: восемь пунктов шире поля, от края поля полоса уехала бы за экран (листается вбок).
      setPos({ left: 8, bottom: window.innerHeight - r.top + 8, hasFormat: selectionHasFormat(el.value, a, b) });
    };
    const el = fieldRef.current;
    document.addEventListener('selectionchange', update);
    el?.addEventListener('selectionchange', update);
    el?.addEventListener('select', update);
    el?.addEventListener('input', update);
    el?.addEventListener('blur', update);
    window.addEventListener('resize', update);
    return () => {
      document.removeEventListener('selectionchange', update);
      el?.removeEventListener('selectionchange', update);
      el?.removeEventListener('select', update);
      el?.removeEventListener('input', update);
      el?.removeEventListener('blur', update);
      window.removeEventListener('resize', update);
    };
  }, [fieldRef]);

  if (!pos) return null;
  return (
    <div
      className="tsel-bar field-fmt"
      role="toolbar"
      aria-label="Форматирование"
      style={{ left: pos.left, bottom: pos.bottom }}
      onPointerDown={(e) => e.preventDefault()}
      onMouseDown={(e) => e.preventDefault()}
    >
      {FORMAT_TOUCH_MENU.map((it) => (
        <button
          key={it.kind}
          type="button"
          className="tsel-btn"
          disabled={it.kind === 'clear' && !pos.hasFormat}
          onClick={() => {
            const el = fieldRef.current;
            if (el) formatField(el, it.kind);
          }}
        >
          {it.label}
        </button>
      ))}
    </div>
  );
}
