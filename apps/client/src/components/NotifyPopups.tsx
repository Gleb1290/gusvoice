/**
 * Окно своих всплывающих уведомлений на ПК (G38, ND-07; `main.tsx` `?window=notify`, окно `overlay::NOTIFY`). Повторяет
 * «свои» уведомления Telegram Desktop (`window/notifications_manager_default.cpp`): карточка 320 px с аватаром 62 px, имя
 * чата и строка текста, крестик; стопка в углу рабочей области, новая — ближе к углу; лишние ждут в очереди; «Скрыть все»
 * при двух и больше; угасание после ввода человека, пауза на наведении; правый клик закрывает, клик открывает беседу;
 * «Ответить» на наведении — поверх правой части текста, текст под ней гаснет градиентом (`notifyFadeRight`); поле ответа —
 * прямо в карточке. Правила — `notifyPopupRules.ts`, данные — `notifyPopupHost.ts`, текст превью — `popupPreview` в `notifications.ts`.
 * Своего соединения окно не держит: рисует то, что прислало главное окно.
 */
import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { Avatar } from './Avatar';
import type { PopupMessage } from '../notifyPopupHost';
import {
  EMPTY_STACK,
  POPUP_CORNER_DEFAULT,
  POPUP_COUNT_DEFAULT,
  POPUP_FADE_MS,
  POPUP_FAST_MS,
  POPUP_HIDE_AFTER_MS,
  POPUP_INPUT_POLL_MS,
  POPUP_PHOTO,
  POPUP_WIDTH,
  popupCorner,
  popupCount,
  popupDropGroup,
  popupFill,
  popupInputSeen,
  popupLineParts,
  popupOrder,
  popupPush,
  popupRemove,
  popupShowsHideAll,
  type PopupCorner,
  type PopupNotice,
  type PopupStack,
} from '../notifyPopupRules';

type TauriCore = { invoke: (cmd: string, args?: unknown) => Promise<unknown> };
type TauriEvent = { listen: (event: string, handler: (e: { payload: unknown }) => void) => Promise<() => void> };
function tauri(): { core?: TauriCore; event?: TauriEvent } | null {
  return (window as unknown as { __TAURI__?: { core?: TauriCore; event?: TauriEvent } }).__TAURI__ ?? null;
}
function invoke(cmd: string, args?: unknown): Promise<unknown> {
  const c = tauri()?.core;
  return c ? c.invoke(cmd, args) : Promise.resolve(null);
}

/** Жизнь карточки: ждёт ввода → таймер → угасает. `hold` — мышь на окне или идёт ответ. */
type Phase = { kind: 'wait'; at: number } | { kind: 'timer'; until: number } | { kind: 'fade'; at: number } | { kind: 'hold' };

export function NotifyPopups() {
  const [stack, setStack] = useState<PopupStack>(EMPTY_STACK);
  const [corner, setCorner] = useState<PopupCorner>(POPUP_CORNER_DEFAULT);
  const [max, setMax] = useState(POPUP_COUNT_DEFAULT);
  const [monitor, setMonitor] = useState('');
  const [phases, setPhases] = useState<Record<string, Phase>>({});
  const [hover, setHover] = useState(false);
  const [replying, setReplying] = useState<string | null>(null);
  const [replyText, setReplyText] = useState('');
  // Сменился масштаб интерфейса (`gv_ui_scale` → CSS `zoom` у `<html>`, его применяет `main.tsx` и в этом окне) или тема —
  // перемерить стопку: CSS-размер тот же, а экранный другой.
  const [restyle, setRestyle] = useState(0);
  const rootRef = useRef<HTMLDivElement>(null);
  const maxRef = useRef(max);
  maxRef.current = max;

  const remove = useCallback((id: string) => {
    setStack((s) => popupRemove(s, id, maxRef.current));
    setReplying((r) => (r === id ? null : r));
  }, []);

  // Сообщения главного окна. `__gvNotifyPopup` — тот же вход для проверки вёрстки без десктопа (headless-браузер).
  useEffect(() => {
    const apply = (raw: unknown) => {
      const m = raw as PopupMessage | null;
      if (!m || typeof m !== 'object') return;
      if (m.kind === 'show') {
        const lim = popupCount(m.max);
        setCorner(popupCorner(m.corner));
        setMax(lim);
        setMonitor(typeof m.monitor === 'string' ? m.monitor : '');
        setStack((s) => popupPush(s, m.notice, lim));
      } else if (m.kind === 'clear') {
        setStack((s) => popupDropGroup(s, m.group, maxRef.current));
      } else if (m.kind === 'prefs') {
        const lim = popupCount(m.max);
        setCorner(popupCorner(m.corner));
        setMax(lim);
        setMonitor(typeof m.monitor === 'string' ? m.monitor : '');
        setStack((s) => (m.native ? EMPTY_STACK : popupFill(s, lim)));
      }
    };
    (window as unknown as { __gvNotifyPopup?: (m: unknown) => void }).__gvNotifyPopup = apply;
    let off: (() => void) | null = null;
    let dead = false;
    void tauri()
      ?.event?.listen('gv-notify-popup', (e) => apply(e.payload))
      .then((u) => {
        if (dead) u();
        else off = u;
      });
    return () => {
      dead = true;
      off?.();
    };
  }, []);

  // Новые карточки на экране — ждут ввода человека (Telegram `checkLastInput`); ушедшие — без фазы.
  const holdRef = useRef(false);
  holdRef.current = hover || replying !== null;
  useEffect(() => {
    setPhases((prev) => {
      const next: Record<string, Phase> = {};
      const now = Date.now();
      for (const n of stack.shown) next[n.id] = prev[n.id] ?? (holdRef.current ? { kind: 'hold' } : { kind: 'wait', at: now });
      return next;
    });
  }, [stack.shown]);

  // Наведение — все снова непрозрачны и ждут (`stopAllHiding`); ушла мышь — все сразу угасают (`startAllHiding`), если
  // никто не отвечает.
  useEffect(() => {
    const now = Date.now();
    setPhases((prev) => {
      const next: Record<string, Phase> = {};
      for (const id of Object.keys(prev)) next[id] = hover || replying ? { kind: 'hold' } : prev[id].kind === 'hold' ? { kind: 'fade', at: now } : prev[id];
      return next;
    });
  }, [hover, replying]);

  // Часы: раз в 300 мс — ввод замечен? таймер вышел? угасла?
  useEffect(() => {
    if (!stack.shown.length) return;
    const t = setInterval(() => {
      void (async () => {
        const waiting = Object.values(phases).some((p) => p.kind === 'wait');
        let idle: number | null = null;
        if (waiting) {
          const v = await invoke('gv_os_idle_ms').catch(() => null);
          idle = typeof v === 'number' ? v : null;
        }
        const now = Date.now();
        const gone: string[] = [];
        setPhases((prev) => {
          let changed = false;
          const next: Record<string, Phase> = { ...prev };
          for (const [id, p] of Object.entries(prev)) {
            if (p.kind === 'wait' && popupInputSeen(p.at, now, idle)) {
              next[id] = { kind: 'timer', until: now + POPUP_HIDE_AFTER_MS };
              changed = true;
            } else if (p.kind === 'timer' && now >= p.until) {
              next[id] = { kind: 'fade', at: now };
              changed = true;
            } else if (p.kind === 'fade' && now - p.at >= POPUP_FADE_MS) {
              gone.push(id);
            }
          }
          return changed ? next : prev;
        });
        for (const id of gone) remove(id);
      })();
    }, POPUP_INPUT_POLL_MS);
    return () => clearInterval(t);
  }, [stack.shown.length, phases, remove]);

  useEffect(() => {
    const bump = () => setRestyle((n) => n + 1);
    window.addEventListener('storage', bump);
    return () => window.removeEventListener('storage', bump);
  }, []);

  // Размер стопки → окно (угол рабочей области, `notify_popup.rs`); пусто — окно прячется. Размер — ЭКРАННЫЙ, с масштабом
  // интерфейса (`getBoundingClientRect` учитывает `zoom`): при «Крупном» карточка шире 320 и окно обязано быть шире, иначе
  // правый край карточки (крестик, «Ответить», конец текста) обрезается краем окна — так и было в пробном 0.8.99.
  useLayoutEffect(() => {
    const el = rootRef.current;
    const send = () => {
      const r = stack.shown.length && el ? el.getBoundingClientRect() : null;
      const h = r ? Math.ceil(r.height) : 0;
      const w = r ? Math.ceil(r.width) || POPUP_WIDTH : POPUP_WIDTH;
      void invoke('gv_notify_popup_layout', { w, h, corner, monitor: monitor || null }).catch(() => {});
    };
    send();
    if (!el || typeof ResizeObserver === 'undefined') return;
    const ro = new ResizeObserver(send);
    ro.observe(el);
    return () => ro.disconnect();
  }, [stack.shown.length, corner, monitor, restyle]);

  const open = (n: PopupNotice) => {
    void invoke('gv_notify_popup_action', { action: 'open', tag: n.tag, group: n.conv ?? null, text: null }).catch(() => {});
    setStack((s) => (n.group ? popupDropGroup(s, n.group, maxRef.current) : popupRemove(s, n.id, maxRef.current)));
  };

  const sendReply = (n: PopupNotice) => {
    const text = replyText.trim();
    if (!text || !n.conv) return;
    void invoke('gv_notify_popup_action', { action: 'reply', tag: n.tag, group: n.conv, text }).catch(() => {});
    setReplyText('');
    remove(n.id);
  };

  const order = popupOrder(stack.shown, corner);
  const hideAll = popupShowsHideAll(stack) ? (
    <button type="button" className="nfp-hide-all" onClick={() => setStack(EMPTY_STACK)}>
      Скрыть все
    </button>
  ) : null;
  const top = corner.startsWith('t');

  return (
    <div
      ref={rootRef}
      className={`nfp-root ${top ? 'top' : 'bottom'}`}
      onMouseEnter={() => setHover(true)}
      onMouseLeave={() => setHover(false)}
    >
      {!top && hideAll}
      {order.map((n) => {
        const p = phases[n.id];
        const fading = p?.kind === 'fade';
        const isReply = replying === n.id;
        const line = popupLineParts(n);
        return (
          <div
            key={n.id}
            className="nfp-card"
            role="button"
            tabIndex={0}
            style={{
              opacity: fading ? 0 : 1,
              transition: `opacity ${fading ? POPUP_FADE_MS : POPUP_FAST_MS}ms ${fading ? 'ease-in' : 'linear'}`,
            }}
            onClick={() => {
              if (!isReply) open(n);
            }}
            onContextMenu={(e) => {
              e.preventDefault();
              remove(n.id);
            }}
          >
            <div className="nfp-main">
              <Avatar url={n.avatar} name={n.title} size={POPUP_PHOTO} />
              <div className="nfp-text">
                <div className="nfp-title">{n.title}</div>
                <div className="nfp-body">
                  {line.from && <span className="nfp-from">{line.from}</span>}
                  {line.kind && <span className="nfp-kind">{line.kind}</span>}
                  {line.text}
                </div>
              </div>
              <button
                type="button"
                className="nfp-close"
                aria-label="Закрыть"
                onClick={(e) => {
                  e.stopPropagation();
                  remove(n.id);
                }}
              >
                ×
              </button>
              {n.conv && !isReply && (
                // Telegram `prepareActionsCache`: под кнопкой — полоса фона карточки от низа имени до низа карточки, слева
                // от неё градиент `notifyFadeRight`; появляется на наведении (`toggleActionButtons`, 200 мс).
                <div className="nfp-actions">
                  <button
                    type="button"
                    className="nfp-reply-btn"
                    onClick={(e) => {
                      e.stopPropagation();
                      setReplyText('');
                      setReplying(n.id);
                    }}
                  >
                    Ответить
                  </button>
                </div>
              )}
            </div>
            {isReply && (
              <div className="nfp-reply" onClick={(e) => e.stopPropagation()}>
                <textarea
                  className="nfp-reply-input"
                  autoFocus
                  rows={1}
                  placeholder="Сообщение"
                  value={replyText}
                  onChange={(e) => setReplyText(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter' && !e.shiftKey) {
                      e.preventDefault();
                      sendReply(n);
                    } else if (e.key === 'Escape') {
                      setReplying(null);
                    }
                  }}
                />
                <button type="button" className="nfp-send" aria-label="Отправить" disabled={!replyText.trim()} onClick={() => sendReply(n)}>
                  <svg viewBox="0 0 24 24" width="20" height="20" fill="currentColor" aria-hidden="true">
                    <path d="M3.4 20.4 21 12 3.4 3.6 3.4 10l12.6 2-12.6 2z" />
                  </svg>
                </button>
              </div>
            )}
          </div>
        );
      })}
      {top && hideAll}
    </div>
  );
}
