import {
  POLL_MAX_OPTIONS,
  POLL_MAX_OPTION_TEXT,
  POLL_MAX_QUESTION,
  POLL_MIN_OPTIONS,
  checkPollDraft,
} from '@gusvoice/shared';
import { useState } from 'react';
import { api } from '../api';
import { useStore } from '../store';
import { toastError } from '../toast';
import { useDialogChrome } from '../dialogChrome';
import { Icon } from './Icon';

/**
 * Форма создания опроса (#17).
 *
 * Ограничения НЕ повторяются здесь руками: и лимиты, и «что считается годным черновиком» берутся
 * из `shared/pollDraft.ts` — тот же код проверяет запрос на сервере. Раньше это были две копии
 * одного правила, и разъезд означал бы, что кнопка активна, а сервер отказывает.
 * Проверяет всё равно сервер; здесь — только чтобы не дать нажать заведомо отказное.
 */
const DURATIONS: { label: string; hours: number }[] = [
  { label: 'Без срока', hours: 0 },
  { label: '1 час', hours: 1 },
  { label: '6 часов', hours: 6 },
  { label: 'Сутки', hours: 24 },
  { label: 'Неделя', hours: 24 * 7 },
];

export function PollComposer({ channelId, onClose }: { channelId: string; onClose: () => void }) {
  const ref = useDialogChrome<HTMLDivElement>(onClose);
  const [question, setQuestion] = useState('');
  const [options, setOptions] = useState(['', '']);
  const [multi, setMulti] = useState(false);
  const [anonymous, setAnonymous] = useState(true);
  const [hours, setHours] = useState(0);
  const [busy, setBusy] = useState(false);

  const draft = checkPollDraft(question, options);
  const ready = draft.ok;
  // Про повтор предупреждаем словами: человек иначе смотрит на серую кнопку и не понимает, чего ей
  // не хватает — а набранное терять обидно.
  const dupes = !draft.ok && draft.error === 'варианты повторяются';

  function setOpt(i: number, v: string) {
    setOptions((p) => p.map((o, j) => (j === i ? v : o)));
  }

  async function submit() {
    if (!draft.ok || busy) return;
    setBusy(true);
    try {
      // Своё сообщение кладём из ответа, не дожидаясь `message.create` по сокету: если гейтвей в
      // этот момент переподключался, кадр терялся и опрос «не создавался» на глазах у автора.
      // Дубля не будет — `appendMessage` отсекает по id.
      const msg = await api.createPoll(channelId, {
        question: draft.question,
        options: draft.options,
        multi,
        anonymous,
        hours,
      });
      useStore.getState().appendMessage(channelId, msg);
      onClose();
    } catch (e) {
      toastError(e);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="modal-overlay" onClick={onClose}>
      <div
        className="modal poll-composer"
        ref={ref}
        tabIndex={-1}
        role="dialog"
        aria-modal="true"
        aria-labelledby="pc-title"
        onClick={(e) => e.stopPropagation()}
      >
        <h2 id="pc-title">Новый опрос</h2>

        <label className="pc-label" htmlFor="pc-q">
          Вопрос
        </label>
        <input
          id="pc-q"
          autoFocus
          maxLength={POLL_MAX_QUESTION}
          value={question}
          placeholder="Заказываем пиццу?"
          onChange={(e) => setQuestion(e.target.value)}
        />

        <div className="pc-label">Варианты</div>
        {options.map((o, i) => (
          <div className="pc-opt" key={i}>
            <input
              maxLength={POLL_MAX_OPTION_TEXT}
              value={o}
              placeholder={`Вариант ${i + 1}`}
              onChange={(e) => setOpt(i, e.target.value)}
              onKeyDown={(e) => {
                // Enter на последнем поле добавляет следующее — так список набирается не отрываясь
                // от клавиатуры.
                if (e.key === 'Enter' && i === options.length - 1 && options.length < POLL_MAX_OPTIONS) {
                  e.preventDefault();
                  setOptions((p) => [...p, '']);
                }
              }}
            />
            {options.length > POLL_MIN_OPTIONS && (
              <button type="button" className="pc-del" title="Убрать вариант" onClick={() => setOptions((p) => p.filter((_, j) => j !== i))}>
                <Icon name="close" size={14} />
              </button>
            )}
          </div>
        ))}
        {options.length < POLL_MAX_OPTIONS && (
          <button type="button" className="link pc-add" onClick={() => setOptions((p) => [...p, ''])}>
            + Добавить вариант
          </button>
        )}

        <label className="pc-check">
          <input type="checkbox" checked={multi} onChange={(e) => setMulti(e.target.checked)} />
          <span>Можно выбрать несколько</span>
        </label>

        <div className="pc-label">Кто как ответил</div>
        {/* Значение по умолчанию — анонимный: у раскрытия нет обратной дороги, и если человек
            не задумался над выбором, безопаснее не показать лишнего. */}
        <div className="pc-radio" role="radiogroup" aria-label="Видимость голосов">
          <label className="pc-check">
            <input type="radio" name="pc-anon" checked={anonymous} onChange={() => setAnonymous(true)} />
            <span>Анонимный — видно только итог</span>
          </label>
          <label className="pc-check">
            <input type="radio" name="pc-anon" checked={!anonymous} onChange={() => setAnonymous(false)} />
            <span>Публичный — по клику видно, кто что выбрал</span>
          </label>
        </div>

        <div className="muted pc-note">
          Результаты в любом случае скрыты до собственного голоса, а переголосовать нельзя.
        </div>

        <label className="pc-label" htmlFor="pc-dur">
          Срок
        </label>
        <select id="pc-dur" value={hours} onChange={(e) => setHours(Number(e.target.value))}>
          {DURATIONS.map((d) => (
            <option key={d.hours} value={d.hours}>
              {d.label}
            </option>
          ))}
        </select>

        {dupes && <div className="pc-warn">Варианты повторяются</div>}

        <div className="modal-actions">
          <button type="button" className="link" onClick={onClose}>
            Отмена
          </button>
          <button type="button" disabled={!ready || busy} onClick={() => void submit()}>
            {busy ? '…' : 'Создать'}
          </button>
        </div>
      </div>
    </div>
  );
}
