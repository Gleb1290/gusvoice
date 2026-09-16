/**
 * In-game voice overlay widget — rendered ONLY in the separate overlay window (main.tsx routes to it
 * on `?window=overlay`). It holds no connection: it listens for `gv-overlay-state` pushes from the main
 * window (see overlay.ts) and renders the roster. Two views (settings-driven):
 *   • list    — avatar + name + mute/deafen icon, speaking gets the green ring
 *   • compact — only who's currently speaking (avatars); an idle pill when nobody speaks
 * The whole card is a `data-tauri-drag-region` so it can be dragged while positioning (Phase 2).
 *
 * Подсказки «кто кого типнул» рисуются ПОВЕРХ ника (в компактном виде — поверх аватарки) и не
 * занимают места: окно ужимается под содержимое, и лишняя строка раздула бы прозрачный прямоугольник
 * поверх игры. Правила отбора — `overlayHints.ts`.
 */
import { useEffect, useRef, useState } from 'react';
import { Avatar } from './Avatar';
import { Icon } from './Icon';
import type { OverlayPayload } from '../overlay';
import { overlayRows } from '../overlayHints';
import { useFirstFrame } from '../firstFrame';

type TauriEvent = {
  listen: (event: string, handler: (e: { payload: unknown }) => void) => Promise<() => void>;
  emit?: (event: string, payload?: unknown) => Promise<void>;
};
function tauriEvent(): TauriEvent | null {
  return (window as unknown as { __TAURI__?: { event?: TauriEvent } }).__TAURI__?.event ?? null;
}
type TauriCore = { invoke: (cmd: string, args?: unknown) => Promise<unknown> };
function tauriCore(): TauriCore | null {
  return (window as unknown as { __TAURI__?: { core?: TauriCore } }).__TAURI__?.core ?? null;
}
/** Native window drag — reliable regardless of which child was grabbed (unlike data-tauri-drag-region,
 *  which only fires on the exact element carrying the attribute). Needs core:window:allow-start-dragging. */
function startDragging(): void {
  const w = (
    window as unknown as {
      __TAURI__?: { window?: { getCurrentWindow?: () => { startDragging?: () => Promise<void> } } };
    }
  ).__TAURI__?.window;
  void w?.getCurrentWindow?.()?.startDragging?.();
}

export function VoiceOverlay() {
  const [state, setState] = useState<OverlayPayload | null>(null);
  const rootRef = useRef<HTMLDivElement>(null);
  const lastSize = useRef('');

  // Shrink the overlay window to fit its content, so the transparent window doesn't cover (and eat
  // clicks over) a big empty rectangle while positioning. Re-runs on content change; the controller
  // re-anchors to the corner on `gv-overlay-resized`.
  useEffect(() => {
    const el = rootRef.current;
    const core = tauriCore();
    if (!el || !core) return;
    const r = el.getBoundingClientRect();
    const w = Math.ceil(r.width);
    const h = Math.ceil(r.height);
    const key = `${w}x${h}`;
    if (w < 1 || h < 1 || key === lastSize.current) return;
    lastSize.current = key;
    void core
      .invoke('gv_overlay_set_size', { w, h })
      .then(() => void tauriEvent()?.emit?.('gv-overlay-resized'))
      .catch(() => {});
  }, [state]);

  useEffect(() => {
    const ev = tauriEvent();
    if (!ev?.listen) return;
    let un: (() => void) | null = null;
    let disposed = false;
    void ev.listen('gv-overlay-state', (e) => setState(e.payload as OverlayPayload)).then((u) => {
      if (disposed) {
        u();
        return;
      }
      un = u;
      // Now that we're listening, ask the main window to (re)push the current state — otherwise its
      // first push (fired the moment this window was created) raced our listener and was lost.
      void ev.emit?.('gv-overlay-ready');
    });
    return () => {
      disposed = true;
      un?.();
    };
  }, []);

  if (!state) return null;
  const empty = state.participants.length === 0;
  // Not in a call and not repositioning → nothing to draw.
  if (empty && !state.positioning) return null;

  const compact = state.content === 'compact';
  const hints = state.hints;
  const rows = overlayRows(state.participants, compact, hints);
  const hintFor = (userId: string) => hints.find((h) => h.toUserId === userId) ?? null;

  // Finish positioning FROM the overlay itself (no round-trip to settings): tell the main window's
  // controller (overlay.ts) to persist the dragged spot + restore click-through.
  const finishPositioning = () => void tauriEvent()?.emit?.('gv-overlay-reposition-done');

  const content =
    state.positioning && empty ? (
      <div className="gv-ov-place">✥ Перетащи меня мышью</div>
    ) : compact && rows.length === 0 ? (
      <div className="gv-ov-idle">GusVoice</div>
    ) : (
      <ul className={`gv-ov-list ${compact ? 'compact' : ''}`}>
        {rows.map((p) => {
          const hint = hintFor(p.id);
          return (
            <li key={p.id} className={`gv-ov-row ${p.speaking ? 'speaking' : ''}`}>
              <span className="gv-ov-ava">
                <OverlayAvatar p={p} size={compact ? 28 : 30} />
                {/* Компактный вид: ников нет, поэтому подсказка садится на аватарку и несёт только
                    сумму — имя отправителя в 28 px не прочитать, а место человека и так задано. */}
                {compact && hint && (
                  <span className="gv-ov-hint compact" key={hint.id}>
                    +{hint.amount}
                  </span>
                )}
              </span>
              {!compact && (
                <span className="gv-ov-nick">
                  <span className="gv-ov-name">{p.name}</span>
                  {/* 🔴 Подсказка ЗАКРЫВАЕТ ник, а не двигает его: окно оверлея ужимается под
                      содержимое, и прибавка ширины раздула бы прозрачный прямоугольник поверх игры
                      и пере-якорила бы его к углу. Ключ по `hint.id` — чтобы повторный пуш того же
                      состояния не перезапускал анимацию с начала. */}
                  {hint && (
                    <span className="gv-ov-hint" key={hint.id}>
                      +{hint.amount} {hint.from}
                    </span>
                  )}
                </span>
              )}
              {!compact && p.deafened && <Icon name="headphones-off" size={14} />}
              {!compact && !p.deafened && p.muted && <Icon name="mic-off" size={14} />}
            </li>
          );
        })}
      </ul>
    );

  return (
    <div ref={rootRef} className={`gv-overlay ${state.positioning ? 'positioning' : ''}`}>
      {/* The card is the drag handle (explicit startDragging on press — works no matter which child was
          grabbed). The «Готово» button sits outside it so it stays clickable. */}
      <div
        className="gv-ov-card"
        data-tauri-drag-region
        style={{ opacity: state.positioning ? 1 : state.opacity }}
        onPointerDown={(e) => {
          if (state.positioning && e.button === 0) startDragging();
        }}
      >
        {content}
      </div>
      {state.positioning && (
        <button type="button" className="gv-ov-done" onClick={finishPositioning}>
          ✓ Готово
        </button>
      )}
    </div>
  );
}

/**
 * Аватар в оверлее: у купившего анимацию показываем ПЕРВЫЙ КАДР гифки, иначе обычную картинку.
 *
 * 🔴 Отдельный компонент, потому что за кадром нужен хук, а строки рисуются в цикле — хук в `map`
 * не вызвать. Кадр снимается один раз на процесс и кэшируется (`firstFrame.ts`).
 * ⚠️ Движения в оверлее по-прежнему НЕТ: он висит поверх чужой игры. Кадр решает другую задачу —
 * чтобы человек не выглядел здесь прежним лицом, ведь обычный и анимированный аватар это разные
 * файлы. Кадр не готов или не снялся — рисуем обычный, как раньше.
 */
function OverlayAvatar({ p, size }: { p: OverlayPayload['participants'][number]; size: number }) {
  const frame = useFirstFrame(p.animatedAvatarUrl);
  return <Avatar url={frame ?? p.avatarUrl ?? undefined} name={p.name} size={size} fallback="icon" />;
}
