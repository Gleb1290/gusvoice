import { useCallback, useEffect, useMemo, useRef, useState, type KeyboardEvent, type ReactNode } from 'react';
import { useDialogChrome } from '../dialogChrome';
import { usePhoneLayout } from '../phoneLayout';
import {
  SCHED_PAST_TEXT,
  SCHED_WEEKDAYS,
  canGoNext,
  canGoPrev,
  initialPick,
  monthGrid,
  monthOf,
  monthTitle,
  parseTimeField,
  pickAt,
  quickOptions,
  quotedText,
  schedShift,
  schedShiftText,
  schedStatus,
  sendLabel,
  settledTimeField,
  shiftMonth,
  stepTimeField,
  typedTimeField,
  type MonthRef,
  type SchedCell,
} from '../schedRules';
import { BottomSheet } from './BottomSheet';
import { Icon } from './Icon';

export interface SchedPickProps {
  /** Текст сообщения — в кавычках под заголовком; длинный обрежется многоточием, пустой — строки нет. */
  text: string;
  /**
   * Время выбрано (быстрый вариант или главная кнопка) — момент отправки, местный. Вызывается не больше одного раза за жизнь
   * окна, следом окно закрывается (`onClose`). В отложенные кладёт и ошибки ловит зовущий: окно ничего не знает о сети и
   * `onPick` не ждёт.
   */
  onPick: (at: Date, silent?: boolean) => void;
  /**
   * Колокольчик «без звука» в окне (07.10, #211, G47; Telegram Desktop `history_view_schedule_box.cpp`: кнопка-колокольчик
   * `lng_schedule_notify_on` / `lng_schedule_notify_off`, а Ctrl при отправке — тоже тихо: «Pro tip: Hold Ctrl key to send a
   * silent scheduled message!»). Нет — колокольчика нет (сервер без `conv8` «без звука» не знает), `onPick` зовётся без
   * второго аргумента. Есть — второй аргумент `true`, если колокольчик выключен («тихо») или нажат Ctrl.
   */
  silentToggle?: boolean;
  /** Закрыть окно: крестик, «Отмена», щелчок мимо, Esc, «назад» на телефоне и сразу после выбора. */
  onClose: () => void;
  /**
   * С какого момента начать выбор — перенос времени у уже отложенного. Время позади или дальше года вперёд — как без него:
   * завтра в 9:00.
   */
  initial?: Date;
  /** «Сейчас» вместо часов — для примеров выгрузки и проверок: время тогда не идёт. Обычно не передают. */
  now?: Date;
  /** Вид принудительно: `true` — лист снизу, `false` — окно по центру. По умолчанию — по ширине окна (`usePhoneLayout`). */
  phone?: boolean;
}

const TITLE = 'Отправить позже';
const TITLE_ID = 'sched-pick-title';
const PAST_ID = 'sched-pick-past';
const SHIFT_ID = 'sched-pick-shift';
const HOURS_MAX = 23;
const MINUTES_MAX = 59;
/** Часы идут раз в полминуты: «Через час» не врёт, а «время прошло» появляется само, если человек задумался. */
const CLOCK_MS = 30_000;

const two = (n: number): string => String(n).padStart(2, '0');
const dayClass = (c: SchedCell): string => `sched-day${c.today ? ' today' : ''}${c.on ? ' on' : ''}${c.out ? ' out' : ''}`;

/** Одно из полей времени (часы и минуты здесь, дни/часы/минуты в «Свой срок…» — `MuteCustomHost`): цифры, не больше двух, ↑ / ↓ листают по кругу, вход выделяет всё, уход добивает до «09». */
export function TimeField({
  label,
  value,
  max,
  invalid = false,
  onChange,
}: {
  label: string;
  value: string;
  max: number;
  invalid?: boolean;
  onChange: (v: string) => void;
}) {
  return (
    <input
      value={value}
      inputMode="numeric"
      maxLength={2}
      autoComplete="off"
      aria-label={label}
      aria-invalid={invalid || undefined}
      aria-describedby={invalid ? PAST_ID : undefined}
      onChange={(e) => {
        const next = typedTimeField(e.target.value, max);
        // Одни не-цифры (буква поверх выделенного «09») — не ввод: поле остаётся как было, а не очищается.
        if (next === '' && e.target.value !== '') return;
        onChange(next);
      }}
      onFocus={(e) => e.currentTarget.select()}
      onBlur={() => onChange(settledTimeField(value, max))}
      onKeyDown={(e) => {
        if (e.key !== 'ArrowUp' && e.key !== 'ArrowDown') return;
        e.preventDefault();
        onChange(stepTimeField(value, e.key === 'ArrowUp' ? 1 : -1, max));
      }}
    />
  );
}

/**
 * ПК — окно по центру, как остальные окна ПК (`.modal-overlay` > `.modal.create-channel`, 420 px): заголовок с крестиком,
 * строка с текстом, выбор. `useDialogChrome`: Esc и возврат фокуса на кнопку, с которой открыли.
 */
export function SchedDialog({
  title,
  what = '',
  onClose,
  onKeyDown,
  children,
}: {
  title: string;
  what?: string;
  onClose: () => void;
  onKeyDown: (e: KeyboardEvent<HTMLDivElement>) => void;
  children: ReactNode;
}) {
  const dialogRef = useDialogChrome<HTMLDivElement>(onClose);
  return (
    <div className="modal-overlay" onClick={onClose}>
      <div
        className="modal create-channel"
        ref={dialogRef}
        tabIndex={-1}
        role="dialog"
        aria-modal="true"
        aria-labelledby={TITLE_ID}
        onClick={(e) => e.stopPropagation()}
        // Окно само берёт фокус при открытии: Enter тогда отправляет выбранное по умолчанию. Из полей внутри Enter
        // обрабатывает `.sched-pick`; сюда он всплывёт уже обработанным.
        onKeyDown={(e) => {
          if (e.target === e.currentTarget) onKeyDown(e);
        }}
      >
        <div className="admin-head">
          <h2 id={TITLE_ID}>{title}</h2>
          <button type="button" className="icon-close" aria-label="Закрыть" title="Закрыть" onClick={onClose}>
            <Icon name="close" size={18} />
          </button>
        </div>
        {what && <p className="modal-what">{what}</p>}
        {children}
      </div>
    </div>
  );
}

/**
 * «Отправить позже» — выбор даты и времени для отложенного сообщения (раунд 12,
 * `docs/design/design-step12/HANDOFF.md` §8.2, макет `SchedPick`). Три быстрых варианта («Через час» — сейчас + 60 минут,
 * вверх до 5; «Завтра утром» 9:00; «Завтра вечером» 19:00) — одно касание, и выбор сделан. Точный — месяц сеткой с
 * понедельника (прошедшие дни недоступны, сегодня обведено, выбранный — мёдом) и два поля времени (16 px — WebView не
 * увеличивает страницу при фокусе). Главная кнопка называет, что будет: «Отправить завтра в 9:00»; время позади — кнопка
 * неактивна, а под полями «Это время уже прошло». Правила — `schedRules.ts` (чистое, «сейчас» параметром).
 *
 * Перевод часов (05.10): момент из полей — по абсолютному времени (`pickAt`: нетронутый перенос — точно `initial`, в
 * повторяющемся осеннем часе — будущий проход). Весной набранного часа может не быть (02:30) — под полями «Часы переводятся:
 * 2:30 нет, будет 3:30», кнопка называет настоящее время, а когда курсор ушёл из полей или выбран день — в полях встаёт оно же
 * (решение владельца: показанное = то, что уйдёт на сервер).
 *
 * Телефон (`usePhoneLayout`, граница 760 px, как у соседних окон; не `isMobile()`) — `BottomSheet` с заголовком и
 * подзаголовком и кнопкой `.sched-go` во всю ширину; ПК — окно по центру с «Отмена» ссылкой. Enter в полях (и в самом окне)
 * отправляет выбранное. Выбор не ждёт ответа сети: `onPick`, затем `onClose`.
 */
export function SchedPick({ text, onPick, onClose, initial, now: fixedNow, phone: forcePhone, silentToggle = false }: SchedPickProps) {
  const autoPhone = usePhoneLayout();
  const phone = forcePhone ?? autoPhone;

  const [clock, setClock] = useState(() => new Date());
  const fixedAt = fixedNow?.getTime();
  useEffect(() => {
    if (fixedAt !== undefined) return;
    const t = setInterval(() => setClock(new Date()), CLOCK_MS);
    return () => clearInterval(t);
  }, [fixedAt]);
  const now = fixedNow ?? clock;

  // Начало выбора считается один раз: дальше человек ведёт сам, и «сейчас» его выбор не двигает.
  const [start] = useState(() => initialPick(now, initial));
  const [view, setView] = useState<MonthRef>(() => monthOf(start.day));
  const [day, setDay] = useState(start.day);
  const [hh, setHh] = useState(() => two(start.h));
  const [mm, setMm] = useState(() => two(start.m));
  /** Колокольчик выключен — «без звука» (по умолчанию звук есть, как у Telegram). */
  const [silent, setSilent] = useState(false);

  // Обработчики зовущего читаем через ref: у `close` один адрес на весь срок окна (лист и `useDialogChrome` не
  // переподписываются на каждую перерисовку).
  const onPickRef = useRef(onPick);
  const onCloseRef = useRef(onClose);
  onPickRef.current = onPick;
  onCloseRef.current = onClose;
  const close = useCallback(() => onCloseRef.current(), []);
  // Второе нажатие, пока окно ещё не исчезло, второй раз не отложит: `finally` — окно закрывается, даже если обработчик
  // зовущего упал (само исключение никуда не девается).
  const done = useRef(false);
  const commit = (at: Date, ctrl = false) => {
    if (done.current) return;
    const fresh = fixedNow ?? new Date();
    if (schedStatus(at, fresh) !== 'ok') {
      // Пока человек думал, выбранная минута ушла: показать это, а не отправить «в прошлое».
      setClock(fresh);
      return;
    }
    done.current = true;
    try {
      if (silentToggle) onPickRef.current(at, silent || ctrl);
      else onPickRef.current(at);
    } finally {
      onCloseRef.current();
    }
  };

  const quick = useMemo(() => quickOptions(now), [now]);
  const cells = useMemo(() => monthGrid(view, day, now), [view, day, now]);
  const h = parseTimeField(hh, HOURS_MAX);
  const m = parseTimeField(mm, MINUTES_MAX);
  // По абсолютному времени (`pickAt`): начало выбора, пока его не трогали, — точно оно; повторяющийся час — будущий проход.
  const at = pickAt(day, h, m, now, start);
  const status = schedStatus(at, now);
  const past = status === 'past';
  const label = sendLabel(at, now);
  const what = quotedText(text);
  /* Перевод часов вперёд (решение владельца 05.10): набранного часа в этот день нет — уйдёт на час позже. Пока поля в
     работе, подсказка говорит это сразу; когда курсор ушёл из полей (или сменился день), в полях встаёт настоящее время,
     а подсказка остаётся — откуда оно взялось. Набор следующего поля или другой день подсказку снимают. */
  const liveShift = at && h !== null && m !== null ? schedShift(day, h, m, at) : null;
  const [shiftNote, setShiftNote] = useState<{ from: string; to: string } | null>(null);
  const shown = liveShift ?? shiftNote;
  /** Поставить в поля то, что уйдёт на самом деле, если набранного в день `d` нет (`hText` / `mText` — уже добитые). */
  const fitTime = (d: Date, hText: string, mText: string) => {
    const hv = parseTimeField(hText, HOURS_MAX);
    const mv = parseTimeField(mText, MINUTES_MAX);
    const real = pickAt(d, hv, mv, fixedNow ?? new Date(), start);
    const shift = real && hv !== null && mv !== null ? schedShift(d, hv, mv, real) : null;
    if (!real || !shift) return;
    setHh(two(real.getHours()));
    setMm(two(real.getMinutes()));
    setShiftNote(shift);
  };
  // Подсказку снимает только другое ЧИСЛО в поле: уход курсора добивает «3» до «03» — это не новый набор.
  const setHour = (v: string) => {
    if (parseTimeField(v, HOURS_MAX) !== h) setShiftNote(null);
    setHh(v);
  };
  const setMinute = (v: string) => {
    if (parseTimeField(v, MINUTES_MAX) !== m) setShiftNote(null);
    setMm(v);
  };

  const submit = (ctrl = false) => {
    if (at && status === 'ok') commit(at, ctrl);
  };
  // Enter в поле времени (и в самом окне) отправляет выбранное; на кнопке и ссылке он нажимает их сам.
  const onEnter = (e: KeyboardEvent<HTMLElement>) => {
    if (e.key !== 'Enter' || e.nativeEvent.isComposing || e.defaultPrevented) return;
    if ((e.target as HTMLElement).closest('button')) return;
    e.preventDefault();
    submit(e.ctrlKey || e.metaKey);
  };
  const pickDay = (c: SchedCell) => {
    setDay(c.date);
    // День соседнего месяца: календарь переходит в его месяц, чтобы выбранный день был виден мёдом на своём месте.
    if (c.out) setView(monthOf(c.date));
    // В новый день набранного часа может не быть (ночь перевода вперёд) — в поля сразу настоящее время и подсказка.
    setShiftNote(null);
    fitTime(c.date, hh, mm);
  };

  // Колокольчик «без звука» (G47): нажат — тихо. Слева от кнопок, как у Telegram Desktop.
  const bell = silentToggle ? (
    <button
      type="button"
      className={silent ? 'sched-bell on' : 'sched-bell'}
      aria-pressed={silent}
      aria-label="Без звука"
      title={silent ? 'Получатель получит тихое уведомление' : 'Получатель получит обычное уведомление'}
      onClick={() => setSilent((v) => !v)}
    >
      <Icon name={silent ? 'bell-off' : 'bell'} size={18} />
    </button>
  ) : null;

  const pick = (
    <div className="sched-pick" onKeyDown={onEnter}>
      <div className="sched-quick">
        {quick.map((q) => (
          <button type="button" className="sched-q" key={q.id} onClick={(e) => commit(q.at, e.ctrlKey || e.metaKey)}>
            <span className="sched-q-label">{q.label}</span>
            <span className="sched-q-time">{q.time}</span>
          </button>
        ))}
      </div>
      <div className="sched-label">Дата и время</div>
      <div className="sched-cal">
        <div className="sched-cal-head">
          <button
            type="button"
            className="sched-cal-nav"
            aria-label="Предыдущий месяц"
            disabled={!canGoPrev(view, now)}
            onClick={() => setView(shiftMonth(view, -1))}
          >
            <Icon name="chevron-left" size={18} />
          </button>
          <strong aria-live="polite">{monthTitle(view)}</strong>
          <button
            type="button"
            className="sched-cal-nav"
            aria-label="Следующий месяц"
            disabled={!canGoNext(view, now)}
            onClick={() => setView(shiftMonth(view, 1))}
          >
            <Icon name="chevron-right" size={18} />
          </button>
        </div>
        <div className="sched-grid">
          {SCHED_WEEKDAYS.map((w) => (
            <span className="sched-wd" key={w} aria-hidden="true">
              {w}
            </span>
          ))}
          {cells.map((c) => (
            <button
              type="button"
              className={dayClass(c)}
              key={c.key}
              disabled={c.disabled}
              aria-pressed={c.on}
              aria-label={c.aria}
              onClick={() => pickDay(c)}
            >
              {c.n}
            </button>
          ))}
        </div>
      </div>
      <div className="sched-time">
        <span>Время</span>
        <span
          className="sched-hm"
          role="group"
          aria-label="Время"
          onBlur={(e) => {
            // Курсор ушёл из обоих полей (а не из часов в минуты) — набранного часа нет: в поля настоящее время. Ушёл на
            // другой день календаря — сверит уже с ним `pickDay` (в тот день набранный час может быть).
            const next = e.relatedTarget instanceof Element ? e.relatedTarget : null;
            if (next && (e.currentTarget.contains(next) || next.closest('.sched-day'))) return;
            fitTime(day, settledTimeField(hh, HOURS_MAX), settledTimeField(mm, MINUTES_MAX));
          }}
        >
          <TimeField label="Часы" value={hh} max={HOURS_MAX} invalid={past} onChange={setHour} />:
          <TimeField label="Минуты" value={mm} max={MINUTES_MAX} invalid={past} onChange={setMinute} />
        </span>
      </div>
      {past && (
        <div className="field-msg error" id={PAST_ID} role="alert">
          {SCHED_PAST_TEXT}
        </div>
      )}
      {!past && shown && (
        <div className="field-msg muted" id={SHIFT_ID} role="status">
          {schedShiftText(shown)}
        </div>
      )}
      {silentToggle && silent && (
        <div className="field-msg muted" role="status">
          Получатель получит тихое уведомление.
        </div>
      )}
      {phone ? (
        <div className="sched-foot">
          {bell}
          <button type="button" className="sched-go" disabled={status !== 'ok'} onClick={(e) => submit(e.ctrlKey || e.metaKey)}>
            {label}
          </button>
        </div>
      ) : (
        <div className="modal-actions">
          {bell}
          <button type="button" className="link" onClick={close}>
            Отмена
          </button>
          <button type="button" disabled={status !== 'ok'} onClick={(e) => submit(e.ctrlKey || e.metaKey)}>
            {label}
          </button>
        </div>
      )}
    </div>
  );

  return phone ? (
    <BottomSheet title={TITLE} subtitle={what ? <div className="modal-what">{what}</div> : undefined} onClose={close}>
      {pick}
    </BottomSheet>
  ) : (
    <SchedDialog title={TITLE} what={what} onClose={close} onKeyDown={onEnter}>
      {pick}
    </SchedDialog>
  );
}
