import { useEffect, useRef, useState } from 'react';

import { useConfirmDialog } from '../confirm';
import { useFocusTrap } from '../focusTrap';
import { canConfirm, confirmLabelOf, enterHintOf, hasCancel, submitsOnEnter } from '../confirmRules';
import { Icon } from './Icon';

/**
 * Единственное окно подтверждения на всё приложение — замена нативных `confirm`/`alert`
 * (макет round 9, `docs/design/design-step9/Confirm Dialogs.dc.html`).
 *
 * 🔴 Висит рядом с корнем (`App`), а НЕ внутри `MainLayout`, в отличие от тостов: подтверждать
 * приходится и там, где главный экран ещё не собран, — на выборе инстанса, в мастере, на экране
 * «инстанс не отвечает». Тосты в этих местах не видны, и повторять их ошибку незачем.
 *
 * 🔴 Главное отличие от нативного — окно НЕ замораживает вкладку. Нативный `confirm` останавливает
 * страницу целиком: приложение перестаёт отвечать, пока его не закроют, и на стенде 19.09 это
 * выглядело как «админка повисла».
 */
export function ConfirmHost() {
  const pending = useConfirmDialog((s) => s.pending);
  const answer = useConfirmDialog((s) => s.answer);
  const [typed, setTyped] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  /** Галочка окна (`ConfirmSpec.option`) — своя у каждого вопроса. */
  const [option, setOption] = useState(false);
  const okRef = useRef<HTMLButtonElement>(null);
  const cancelRef = useRef<HTMLButtonElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  /** Само окно — по нему ходит ловушка фокуса (`focusTrap.ts`). */
  const boxRef = useRef<HTMLDivElement>(null);

  // Новое окно — чистое поле и чистая ошибка: набранное имя или отказ от прошлого вопроса здесь
  // значили бы разблокированную кнопку и чужую красную плашку у следующего.
  useEffect(() => {
    setTyped('');
    setBusy(false);
    setError(null);
    setOption(pending?.option?.checked ?? false);
    // eslint-disable-next-line react-hooks/exhaustive-deps -- новый вопрос = новый id
  }, [pending?.id]);

  /**
   * Фокус уводим В ОКНО: иначе Enter и пробел продолжают уходить на кнопку под ним, а с клавиатуры
   * до диалога не добраться вовсе. В окне с набором имени фокус — в поле: человеку сразу писать.
   *
   * 🔴 У ОПАСНОГО окна фокус идёт на «Отмену», а не на кнопку действия. Поймал на себе 19.09:
   * правило «Enter не подтверждает опасное» соблюдалось, а сообщение всё равно удалилось — потому
   * что сфокусированную кнопку браузер жмёт по Enter САМ, мимо наших обработчиков. Правило,
   * которое обходится фокусом, — это не правило; и подпись «здесь не подтверждает» под ним была
   * бы прямой ложью.
   */
  useEffect(() => {
    if (!pending) return;
    const t = setTimeout(() => {
      if (pending.requireText) inputRef.current?.focus();
      else if (pending.tone === 'danger' && cancelRef.current) cancelRef.current.focus();
      else okRef.current?.focus();
    }, 0);
    return () => clearTimeout(t);
  }, [pending]);

  /** Подтвердить: если действие доверено окну — выполнить его здесь же, показав ход и отказ. */
  async function accept() {
    if (!pending || busy) return;
    if (!pending.run) {
      answer(true);
      return;
    }
    setBusy(true);
    setError(null);
    try {
      await pending.run();
      answer(true);
    } catch (e) {
      // Окно НЕ закрываем: человек должен увидеть отказ там, где нажимал, и решить — повторить
      // или отменить. Закрытое окно с тостом в углу этот выбор у него отбирает.
      setError(e instanceof Error ? e.message : 'Не получилось. Попробуйте ещё раз.');
      setBusy(false);
    }
  }

  useEffect(() => {
    if (!pending) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.preventDefault();
        if (!busy) answer(false);
        return;
      }
      if (e.key === 'Enter') {
        // ⚠️ Гасим ВСЕГДА, а не только когда подтверждаем: иначе Enter дойдёт до кнопки под
        // фокусом и сделает ровно то, что правило запрещает.
        e.preventDefault();
        if (submitsOnEnter(pending, typed)) void accept();
      }
    };
    /**
     * 🔴 ЗАХВАТ (`capture: true`), а не всплытие: иначе клавиша сперва достаётся кнопке под фокусом
     * и та срабатывает нативно — наш `preventDefault` приходит уже после. Именно так после первой
     * починки Enter в опасном окне жал «Отмену»: действие не выполнялось (уже хорошо), но окно
     * закрывалось молча, хотя подсказка обещает только `Esc`.
     */
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pending, typed, busy, answer]);

  // Пока окно открыто, Tab ходит только по нему; закрылось — фокус вернулся на кнопку-источник.
  useFocusTrap(boxRef, !!pending);

  if (!pending) return null;
  const ok = canConfirm(pending, typed);
  const danger = pending.tone === 'danger';
  const guardOk = !!pending.requireText && ok;

  return (
    <div className="modal-overlay confirm-overlay" onClick={() => !busy && answer(false)}>
      <div
        ref={boxRef}
        className={`modal confirm${danger ? ' danger' : ''}`}
        role="alertdialog"
        aria-modal="true"
        aria-labelledby="confirm-title"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="confirm-top">
          <span className={`confirm-ic${danger ? ' danger' : ''}`}>
            <Icon name={danger ? 'trash' : 'signal'} size={20} />
          </span>
          <div className="confirm-text">
            <h2 id="confirm-title">{pending.title}</h2>
            {pending.body && <p className="confirm-body">{pending.body}</p>}

            {/* Список внутри окна: когда текст перечисляет объекты («выйти со всех серверов»),
                человеку важно видеть, что именно он теряет, а не считать их в предложении. */}
            {pending.items && pending.items.length > 0 && (
              <ul className="confirm-items">
                {pending.items.map((it) => (
                  <li key={it}>
                    <span className="confirm-item-mono">{it.slice(0, 1).toUpperCase()}</span>
                    <span className="confirm-item-name">{it}</span>
                  </li>
                ))}
              </ul>
            )}

            {pending.requireText && (
              <div className="confirm-guard">
                <div className="confirm-guard-label">ВВЕДИТЕ «{pending.requireText}» ДЛЯ ПОДТВЕРЖДЕНИЯ</div>
                <div className={`confirm-guard-box${guardOk ? ' ok' : ''}`}>
                  <input
                    ref={inputRef}
                    value={typed}
                    onChange={(e) => setTyped(e.target.value)}
                    spellCheck={false}
                    disabled={busy}
                    aria-label={`Наберите ${pending.requireText}`}
                  />
                  {guardOk && <Icon name="check" size={17} />}
                </div>
              </div>
            )}

            {pending.option && (
              <label className="confirm-option">
                <input
                  type="checkbox"
                  checked={option}
                  disabled={busy}
                  onChange={(e) => {
                    setOption(e.target.checked);
                    pending.onOption?.(e.target.checked);
                  }}
                />
                <span>{pending.option.label}</span>
              </label>
            )}

            {error && (
              <div className="confirm-error" role="alert">
                <Icon name="close" size={16} />
                <span>{error}</span>
              </div>
            )}
          </div>
        </div>

        <div className="confirm-actions">
          {hasCancel(pending) && (
            <button ref={cancelRef} type="button" className="ghost" disabled={busy} onClick={() => answer(false)}>
              {pending.cancelLabel ?? 'Отмена'}
            </button>
          )}
          <button
            ref={okRef}
            type="button"
            className={`confirm-primary${danger ? ' danger' : ''}`}
            disabled={!ok || busy}
            onClick={() => void accept()}
          >
            {busy && <span className="confirm-spin" aria-hidden="true" />}
            {/* После отказа глагол меняется на «Повторить»: прежний («Удалить») предлагал бы
                сделать то, что только что не получилось, будто ничего не произошло. */}
            {error ? 'Повторить' : confirmLabelOf(pending)}
          </button>
        </div>

        <div className="confirm-keys">
          <span>
            <kbd>Esc</kbd> отмена
          </span>
          <span className={submitsOnEnter(pending, typed) ? undefined : 'off'}>
            <kbd>Enter</kbd> {enterHintOf(pending, typed)}
          </span>
        </div>
      </div>
    </div>
  );
}
