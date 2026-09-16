/**
 * Всплывающая плашка «кто кого типнул» — рисуется ТОЛЬКО в отдельном окне поверх игры
 * (`main.tsx` роутит сюда по `?window=toast`). Своего состояния не держит: слушает `gv-toast-state`
 * от главного окна (см. `tipToast.ts`) и показывает то, что прислали.
 *
 * 🔴 Пусто — значит НИЧЕГО не рисуем: ни карточки, ни рамки, ни точки. В этом вся суть фичи — окно
 * висит всегда, но человек видит его только в момент события. Любой постоянный пиксель превратил бы
 * её в тот самый «постоянный оверлей, который многие не любят».
 *
 * 🔴 Называем ОБОИХ: здесь нет строки участника, которая подсказала бы, кому досталось. Это то же
 * решение, что в плашке над чужим стримом (`StreamTipFeed`), и обратное решению в сайдбаре, где
 * получателя задаёт место.
 */
import { useEffect, useState } from 'react';
import type { ToastPayload } from '../tipToast';
import { shouldStartDrag, type ToastEvent } from '../toastRules';

type TauriEvent = {
  listen: (event: string, handler: (e: { payload: unknown }) => void) => Promise<() => void>;
  emit?: (event: string, payload?: unknown) => Promise<void>;
};
function tauriEvent(): TauriEvent | null {
  return (window as unknown as { __TAURI__?: { event?: TauriEvent } }).__TAURI__?.event ?? null;
}
/** Нативное перетаскивание — надёжнее `data-tauri-drag-region`, который срабатывает только на себе. */
function startDragging(): void {
  const w = (
    window as unknown as {
      __TAURI__?: { window?: { getCurrentWindow?: () => { startDragging?: () => Promise<void> } } };
    }
  ).__TAURI__?.window;
  void w?.getCurrentWindow?.()?.startDragging?.();
}

/** Образец для режима расстановки: настоящих событий в этот момент может не быть вовсе. */
const SAMPLE: ToastEvent = {
  id: 'sample',
  kind: 'tip',
  fromName: 'Маша',
  toName: 'Петя',
  amount: 5,
  atMs: 0,
};

export function TipToast() {
  const [state, setState] = useState<ToastPayload | null>(null);

  useEffect(() => {
    const ev = tauriEvent();
    if (!ev?.listen) return;
    let un: (() => void) | null = null;
    let disposed = false;
    void ev.listen('gv-toast-state', (e) => setState(e.payload as ToastPayload)).then((u) => {
      if (disposed) {
        u();
        return;
      }
      un = u;
      // Слушатель готов — просим главное окно повторить пуш: первый мог прийти до нас.
      void ev.emit?.('gv-toast-ready');
    });
    return () => {
      disposed = true;
      un?.();
    };
  }, []);

  if (!state) return null;
  const positioning = !!state.positioning;
  const events = positioning && state.events.length === 0 ? [SAMPLE] : state.events;
  // 🔴 Ни одного пикселя, когда показывать нечего.
  if (events.length === 0) return null;

  return (
    <div
      className={`gv-toast ${positioning ? 'positioning' : ''}`}
      style={{ fontSize: `${state.scale}em`, opacity: positioning ? 1 : state.opacity }}
      onPointerDown={(e) => {
        // Нажатие на «Готово» перетаскивание НЕ начинает — разбор ловушки в `shouldStartDrag`.
        const onDone = !!(e.target as HTMLElement | null)?.closest?.('.gv-toast-done');
        if (shouldStartDrag({ positioning, button: e.button, onDoneButton: onDone })) startDragging();
      }}
    >
      {events.map((e) => (
        <div className={`gv-toast-row ${e.kind}`} key={e.id}>
          <span className="gv-toast-from">{e.fromName}</span>
          <span className="gv-toast-verb">{e.kind === 'tip' ? 'типнул' : 'ущипнул'}</span>
          <span className="gv-toast-to">{e.toName}</span>
          {/* ⚠️ Плюс только у типа. У щипка платит ОТПРАВИТЕЛЬ, и «−400» рядом с именем ущипнутого
              читалось бы как «с него списали» — прямая неправда. */}
          <span className="gv-toast-amount">{e.kind === 'tip' ? `+${e.amount}` : e.amount}</span>
        </div>
      ))}
      {positioning && (
        <button
          type="button"
          className="gv-toast-done"
          onClick={() => void tauriEvent()?.emit?.('gv-toast-reposition-done')}
        >
          ✓ Готово
        </button>
      )}
    </div>
  );
}
