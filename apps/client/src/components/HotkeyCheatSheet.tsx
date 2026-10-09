import { useEffect } from 'react';
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
 *  не одно или не из настроек (`Ctrl`, `↑` / `↓`). */
function Row({ label, combo = '', keys }: { label: string; combo?: string; keys?: string[] }) {
  return (
    <div className="cheat-row">
      <span className="cheat-label">{label}</span>
      <span className="cheat-keys">
        {(keys ?? capsules(combo)).map((k, i) => (
          <kbd key={i} className={`cheat-key ${k === '—' ? 'unset' : ''}`}>
            {k}
          </kbd>
        ))}
      </span>
    </div>
  );
}

/**
 * Keyboard-shortcut cheat sheet (round-7 P8), opened with `?`. Voice bindings come from the
 * user's own hotkey config (so they read "Не задано" until set); navigation shortcuts are the
 * ones MainLayout actually handles. Only truthful, working shortcuts are listed.
 */
export function HotkeyCheatSheet({ onClose }: { onClose: () => void }) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  const hk = getHotkeys();
  const audio = getAudioSettings();

  const voice = [
    { label: 'Выключить микрофон', combo: hk.mute },
    { label: 'Заглушить звук (деафен)', combo: hk.deafen },
    { label: 'Демонстрация экрана', combo: hk.screenShare },
    { label: 'Рация (Push-to-Talk)', combo: audio.pushToTalk ? audio.pttKey : '' },
  ];
  const nav: { label: string; combo?: string; keys?: string[] }[] = [
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
    { label: 'Эта шпаргалка', keys: ['?'] },
  ];
  /* Клавиши беседы (07.10, G36 и G15; как в Telegram Desktop): ответ на соседнее, правка последнего, лента из поля,
     отправка по выбранному режиму, выделение и Esc по слоям. Только то, что реально работает (`chatKeysRules.ts`). */
  const ctrlSend = getSendMode() === 'ctrl-enter';
  const chat: { label: string; combo?: string; keys?: string[] }[] = [
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

  return (
    <div className="modal-overlay" onClick={onClose}>
      {/* `aria-modal`: пока шпаргалка открыта, Esc и клавиши беседы — её (G15: Esc закрывает её, а не слой беседы под ней). */}
      <div className="modal cheatsheet" role="dialog" aria-modal="true" aria-label="Горячие клавиши" onClick={(e) => e.stopPropagation()}>
        <div className="cheat-head">
          <Icon name="keyboard" size={20} className="cheat-head-icon" />
          <span className="cheat-title">Горячие клавиши</span>
          <div style={{ flex: 1 }} />
          <span className="cheat-hint">нажмите ? в любой момент</span>
          <button type="button" className="icon-close" title="Закрыть" onClick={onClose}>
            <Icon name="close" size={18} />
          </button>
        </div>
        <div className="cheat-grid">
          <div className="cheat-col">
            <div className="cheat-col-title">Голос</div>
            {voice.map((k) => (
              <Row key={k.label} label={k.label} combo={k.combo} />
            ))}
            {/* Две колонки, а не три строки: с «Сообщениями» шпаргалка иначе выше окна 800 px. Слева голос и навигация, справа
                сообщения — по высоте поровну. */}
            <div className="cheat-col-title next">Навигация</div>
            {nav.map((k) => (
              <Row key={k.label} label={k.label} combo={k.combo} keys={k.keys} />
            ))}
          </div>
          <div className="cheat-col">
            <div className="cheat-col-title">Сообщения</div>
            {chat.map((k) => (
              <Row key={k.label} label={k.label} keys={k.keys} />
            ))}
          </div>
        </div>
      </div>
    </div>
  );
}
