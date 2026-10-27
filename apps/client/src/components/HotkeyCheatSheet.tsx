import { useEffect, useRef } from 'react';
import { getAudioSettings } from '../audioSettings';
import { formatCombo, getHotkeys, isDesktop, isTauri } from '../hotkeys';
import { getSendMode } from '../sendMode';
import { Icon } from './Icon';

/** Split a normalized combo into display capsules; empty (unbound) → a single dim dash. */
function capsules(combo: string): string[] {
  if (!combo) return ['—'];
  return formatCombo(combo).split(' + ');
}

/** Строка шпаргалки: `combo` — сочетание в виде настроек голоса (`Ctrl+KeyF`); `keys` — готовые клавиши, когда сочетание
 *  не одно или не из настроек (`Ctrl`, `↑` / `↓`); `alt` — второе сочетание того же действия, через «или». */
function Row({ label, combo = '', keys, alt }: { label: string; combo?: string; keys?: string[]; alt?: string[] }) {
  const caps = (list: string[]) =>
    list.map((k, i) => (
      <kbd key={i} className={`cheat-key ${k === '—' ? 'unset' : ''}`}>
        {k}
      </kbd>
    ));
  return (
    <div className="cheat-row">
      <span className="cheat-label">{label}</span>
      <span className="cheat-keys">
        {caps(keys ?? capsules(combo))}
        {alt && (
          <>
            <span className="cheat-or">или</span>
            {caps(alt)}
          </>
        )}
      </span>
    </div>
  );
}

type Line = { label: string; combo?: string; keys?: string[]; alt?: string[] };

/**
 * Keyboard-shortcut cheat sheet (round-7 P8), opened with `?` or Ctrl+/ (как Keyboard Shortcuts в Discord). Voice bindings
 * come from the user's own hotkey config (so they read "Не задано" until set); navigation shortcuts are the ones MainLayout
 * actually handles. Only truthful, working shortcuts are listed.
 *
 * 20.10 — окно «как в Discord»: шапка закреплена, тело листается, высота не больше экрана под полосой окна десктопа (#219;
 * раньше шапку срезало сверху, а низ уходил за край без прокрутки). Группы — секции с заголовком, раскладка — колонками CSS
 * (`.cheat-body`): строки перетекают из колонки в колонку, поэтому колонки ровные и без пустоты внизу справа.
 */
export function HotkeyCheatSheet({ onClose }: { onClose: () => void }) {
  const boxRef = useRef<HTMLDivElement | null>(null);
  const closeRef = useRef(onClose);
  closeRef.current = onClose;
  useEffect(() => {
    const opener = document.activeElement as HTMLElement | null;
    boxRef.current?.focus();
    // Фаза ПЕРЕХВАТА и `preventDefault`: шпаргалку открывают и поверх настроек (кнопка в группе «Горячие клавиши»), а их
    // Esc (`useDialogChrome`) молчит при `defaultPrevented` — один Esc закрывает одно окно, верхнее.
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape' || e.defaultPrevented) return;
      e.preventDefault();
      closeRef.current();
    };
    window.addEventListener('keydown', onKey, true);
    return () => {
      window.removeEventListener('keydown', onKey, true);
      opener?.focus?.();
    };
  }, []);

  const hk = getHotkeys();
  const audio = getAudioSettings();

  const voice = [
    { label: 'Выключить микрофон', combo: hk.mute },
    { label: 'Заглушить звук (деафен)', combo: hk.deafen },
    { label: 'Демонстрация экрана', combo: hk.screenShare },
    ...(isDesktop() ? [{ label: 'Показывать окно в фокусе (во время показа)', combo: hk.focusShare ?? '' }] : []),
    { label: 'Рация (Push-to-Talk)', combo: audio.pushToTalk ? audio.pttKey : '' },
  ];
  const nav: Line[] = [
    // Ctrl+F — поиск сервера; в ЛС его нет, там Ctrl+F остаётся браузеру (поиск по странице).
    { label: 'Поиск сообщений (сервер)', combo: 'Ctrl+KeyF' },
    { label: 'Поиск бесед (ЛС)', combo: 'Ctrl+KeyK' },
    { label: 'Следующий канал или беседа', combo: 'Alt+ArrowDown' },
    { label: 'Предыдущий канал или беседа', combo: 'Alt+ArrowUp' },
    { label: 'Первый канал или беседа', combo: 'Ctrl+Alt+Home' },
    { label: 'Последний канал или беседа', combo: 'Ctrl+Alt+End' },
    // Папки ЛС (G40; Telegram Desktop `core/shortcuts.cpp`): вкладка по номеру, соседняя, архив.
    { label: 'Папка ЛС по номеру · архив', keys: ['Ctrl', '1…8 / 9'] },
    { label: 'Соседняя папка ЛС', keys: ['Ctrl', 'Shift', '↑ / ↓'] },
    // Ctrl+0 — только десктоп (в браузере это сброс масштаба), как Ctrl+R (Р-4).
    ...(isTauri() ? [{ label: 'Избранное', keys: ['Ctrl', '0'] }] : []),
    // Окно и беседы десктопа (G63/G65; Telegram Desktop `core/shortcuts.cpp`): в браузере эти клавиши принадлежат вкладке.
    ...(isDesktop()
      ? [
          { label: 'Недавние беседы (удерживая Ctrl)', keys: ['Ctrl', 'Tab / Shift+Tab'] },
          { label: 'Меню беседы', keys: ['Ctrl', '\\'] },
          { label: 'Спрятать в трей', keys: ['Ctrl', 'W / F4'] },
          { label: 'Выйти из приложения', keys: ['Ctrl', 'Q'] },
        ]
      : []),
    { label: 'Эта шпаргалка', keys: ['?'], alt: ['Ctrl', '/'] },
  ];
  /* Клавиши беседы (07.10, G36 и G15; как в Telegram Desktop): ответ на соседнее, правка последнего, лента из поля,
     отправка по выбранному режиму, выделение и Esc по слоям. Только то, что реально работает (`chatKeysRules.ts`). */
  const ctrlSend = getSendMode() === 'ctrl-enter';
  const chat: Line[] = [
    { label: 'Отправить', keys: ctrlSend ? ['Ctrl', 'Enter'] : ['Enter'] },
    { label: 'Новая строка', keys: ctrlSend ? ['Enter'] : ['Shift', 'Enter'] },
    { label: 'Ответить на предыдущее / следующее', keys: ['Ctrl', '↑ / ↓'] },
    { label: 'Изменить последнее своё (пустое поле)', keys: ['↑'] },
    { label: 'Листать ленту из поля', keys: ['PgUp / PgDn'] },
    { label: 'Прикрепить файл', keys: ['Ctrl', 'O'] },
    { label: 'Расширить выделение', keys: ['Shift', '↑ / ↓'] },
    { label: 'Копировать выделенные', keys: ['Ctrl', 'C'] },
    { label: 'Удалить выделенные', keys: ['Delete'] },
    { label: 'Назад: меню, выделение, ответ, беседа', keys: ['Esc'] },
  ];

  const sections: { title: string; rows: Line[] }[] = [
    { title: 'Голос', rows: voice },
    { title: 'Навигация', rows: nav },
    { title: 'Сообщения', rows: chat },
  ];

  return (
    <div className="modal-overlay" onClick={onClose}>
      {/* `aria-modal`: пока шпаргалка открыта, Esc и клавиши беседы — её (G15: Esc закрывает её, а не слой беседы под ней). */}
      <div
        ref={boxRef}
        className="modal cheatsheet"
        role="dialog"
        aria-modal="true"
        aria-labelledby="cheat-title"
        tabIndex={-1}
        onClick={(e) => e.stopPropagation()}
      >
        <div className="cheat-head">
          <Icon name="keyboard" size={20} className="cheat-head-icon" />
          <h2 className="cheat-title" id="cheat-title">
            Горячие клавиши
          </h2>
          <span className="cheat-hint">
            <kbd className="cheat-key">?</kbd>
            <span className="cheat-or">или</span>
            <kbd className="cheat-key">Ctrl</kbd>
            <kbd className="cheat-key">/</kbd>
          </span>
          <button type="button" className="icon-close" title="Закрыть" aria-label="Закрыть" onClick={onClose}>
            <Icon name="close" size={18} />
          </button>
        </div>
        <div className="cheat-body">
          {sections.map((sec) => (
            <section key={sec.title} className="cheat-sec" aria-label={sec.title}>
              <h3 className="cheat-sec-title">{sec.title}</h3>
              {sec.rows.map((k) => (
                <Row key={k.label} label={k.label} combo={k.combo} keys={k.keys} alt={k.alt} />
              ))}
            </section>
          ))}
        </div>
      </div>
    </div>
  );
}
