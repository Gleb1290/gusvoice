import {
  CONV_POLL_LIMITS,
  convPollDraft,
  convPollPercents,
  convPollVotersText,
  type ConvMediaInput,
  type ConvPollMedia,
  type ConvPollVotersResponse,
} from '@gusvoice/shared';
import { useEffect, useState } from 'react';
import { createPortal } from 'react-dom';
import { api } from '../api';
import { confirmAction } from '../confirm';
import { useDialogChrome } from '../dialogChrome';
import { usePhoneLayout } from '../phoneLayout';
import { useStore } from '../store';
import { toastError } from '../toast';
import { Avatar } from './Avatar';
import { BottomSheet } from './BottomSheet';
import { MenuItem } from './ContextMenu';
import { Icon } from './Icon';
import { Toggle } from './Toggle';

/**
 * Опрос в ЛС (14.10, признак сервера `convpoll1`; правила — `shared/convPoll.ts`): создание, карточка в ленте, пункты меню
 * сообщения и «Посмотреть голоса». Поведение — Telegram (код не копируется):
 * - создание — Android `PollCreateActivity` (вопрос, варианты с пустым полем в конце, «Анонимное голосование» включено,
 *   «Несколько ответов», «Викторина» с отметкой правильного и «Пояснением»), Desktop `CreatePollBox`; телефон — лист, ПК — окно;
 * - карточка — Android `ChatMessageCell` (опрос), Desktop `history_view_poll.cpp`, Web K `poll.ts`: подпись вида («Анонимный
 *   опрос» / «Викторина» / «Итоги»), до голоса — варианты кружками (один ответ — голос нажатием; несколько — отметки и
 *   «Голосовать»), после — проценты, полосы и отметка своего; викторина — правильный зелёным, неверный выбор красным, пояснение;
 *   внизу — «N голосов» или «Посмотреть голоса» (неанонимный, `PollVotesAlert`);
 * - меню сообщения — «Отменить голос» (`Unvote`, не у викторины) и «Остановить опрос» автору (`StopPoll`, с вопросом).
 */

/** Ответ сервера (сообщение моими глазами) — сразу в ленту; `conv.change` придёт следом с тем же видом. */
function applyPollReply(conversationId: string, msg: Parameters<ReturnType<typeof useStore.getState>['convAfterEdit']>[1]): void {
  useStore.getState().convAfterEdit(conversationId, msg);
}

/** Подпись вида над вариантами (Telegram `AnonymousPoll` / `PublicPoll` / `AnonymousQuizPoll` / `QuizPoll` / `FinalResults`). */
export function convPollKindText(p: Pick<ConvPollMedia, 'anonymous' | 'quiz' | 'closed'>): string {
  if (p.closed) return 'Итоги';
  if (p.quiz) return p.anonymous ? 'Анонимная викторина' : 'Викторина';
  return p.anonymous ? 'Анонимный опрос' : 'Опрос';
}

export function ConvPollCard({ poll, conversationId, messageId, readOnly }: { poll: ConvPollMedia; conversationId: string; messageId: string; readOnly?: boolean }) {
  const [picked, setPicked] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);
  const [votesOpen, setVotesOpen] = useState(false);
  const canVote = !readOnly && !poll.closed && poll.my.length === 0;
  const pct = poll.revealed ? convPollPercents(poll.options) : poll.options.map(() => 0);
  const top = Math.max(1, ...poll.options.map((o) => o.votes));

  // Отменили голос (с другого устройства или из меню) — прежние отметки не возвращаем.
  useEffect(() => {
    if (poll.my.length > 0) setPicked([]);
  }, [poll.my.length]);

  const vote = async (ids: string[]) => {
    if (busy || ids.length === 0) return;
    setBusy(true);
    try {
      applyPollReply(conversationId, await api.convPollVote(conversationId, messageId, ids));
      setPicked([]);
    } catch (e) {
      toastError(e);
    } finally {
      setBusy(false);
    }
  };

  const tap = (id: string) => {
    if (!canVote || busy) return;
    // Один ответ — голос нажатием (Telegram); несколько — отметка, отправка кнопкой «Голосовать».
    if (!poll.multi) return void vote([id]);
    setPicked((p) => (p.includes(id) ? p.filter((x) => x !== id) : [...p, id]));
  };

  return (
    <div className="poll conv-poll" data-closed={poll.closed ? '1' : undefined}>
      <div className="poll-q">{poll.question}</div>
      <div className="conv-poll-kind muted">{convPollKindText(poll)}</div>
      <div className="poll-opts">
        {poll.options.map((o, i) => {
          const mine = poll.my.includes(o.id);
          const sel = picked.includes(o.id);
          const right = poll.quiz && poll.revealed && poll.correct === o.id;
          const wrong = poll.quiz && poll.revealed && mine && poll.correct !== o.id;
          const cls = ['poll-opt', mine ? 'mine' : '', sel ? 'sel' : '', poll.revealed ? 'done' : '', right ? 'right' : '', wrong ? 'wrong' : '']
            .filter(Boolean)
            .join(' ');
          return (
            <button
              key={o.id}
              type="button"
              className={cls}
              // Не `disabled`: общий вид выключенной кнопки бледный, а итоги должны читаться (нажатие и так ничего не делает).
              aria-disabled={!canVote || busy}
              aria-pressed={canVote ? sel : mine}
              onClick={() => tap(o.id)}
            >
              {poll.revealed && <span className="poll-bar" style={{ width: `${Math.round((o.votes / top) * 100)}%` }} aria-hidden />}
              <span className="poll-mark" aria-hidden>
                {poll.revealed ? (
                  right || (mine && !poll.quiz) ? (
                    <Icon name="check" size={13} />
                  ) : wrong ? (
                    <Icon name="close" size={13} />
                  ) : null
                ) : (
                  <span className={`conv-poll-dot${poll.multi ? ' square' : ''}${sel ? ' on' : ''}`} />
                )}
              </span>
              <span className="poll-text">{o.text}</span>
              {poll.revealed && <span className="poll-pct">{pct[i]}%</span>}
            </button>
          );
        })}
      </div>
      {poll.quiz && poll.revealed && poll.solution && (
        <div className="conv-poll-solution">
          <Icon name="bolt" size={14} />
          <span>{poll.solution}</span>
        </div>
      )}
      <div className="poll-foot conv-poll-foot muted">
        {canVote && poll.multi ? (
          <button type="button" className="link" disabled={picked.length === 0 || busy} onClick={() => void vote(picked)}>
            Голосовать
          </button>
        ) : !poll.anonymous && poll.revealed && poll.voters > 0 ? (
          <button type="button" className="link" onClick={() => setVotesOpen(true)}>
            Посмотреть голоса
          </button>
        ) : (
          <span>{convPollVotersText(poll.voters, poll.quiz)}</span>
        )}
      </div>
      {votesOpen && <ConvPollVotes poll={poll} conversationId={conversationId} messageId={messageId} onClose={() => setVotesOpen(false)} />}
    </div>
  );
}

/**
 * Пункты меню сообщения-опроса (Telegram Desktop `HistoryInner::showContextMenu`: «Retract vote», «Stop poll»): «Отменить голос» —
 * проголосовал, опрос открыт, не викторина; «Остановить опрос» — автор, опрос открыт (с вопросом, действие необратимо).
 */
export function ConvPollMenuItems({ poll, conversationId, messageId, mine, onDone }: { poll: ConvPollMedia; conversationId: string; messageId: string; mine: boolean; onDone: () => void }) {
  if (poll.closed) return null;
  const retract = poll.my.length > 0 && !poll.quiz;
  if (!retract && !mine) return null;
  return (
    <>
      {retract && (
        <MenuItem
          icon="undo"
          label="Отменить голос"
          onClick={() => {
            onDone();
            api.convPollVote(conversationId, messageId, []).then((m) => applyPollReply(conversationId, m), toastError);
          }}
        />
      )}
      {mine && (
        <MenuItem
          icon="lock"
          label={poll.quiz ? 'Остановить викторину' : 'Остановить опрос'}
          onClick={() => {
            onDone();
            void confirmAction({
              title: poll.quiz ? 'Остановить викторину?' : 'Остановить опрос?',
              body: 'Если остановить сейчас, голосовать больше никто не сможет. Отменить это нельзя.',
              confirmLabel: 'Остановить',
              tone: 'danger',
            }).then((ok) => {
              if (ok) api.convPollClose(conversationId, messageId).then((m) => applyPollReply(conversationId, m), toastError);
            });
          }}
        />
      )}
    </>
  );
}

/** Окно на ПК / лист на телефоне — общая рамка окон опроса (как `GeoPickDialog`). */
function PollShell({ title, onClose, children }: { title: string; onClose: () => void; children: React.ReactNode }) {
  const phone = usePhoneLayout();
  return phone ? (
    <BottomSheet title={title} onClose={onClose}>
      {children}
    </BottomSheet>
  ) : (
    <PollModal title={title} onClose={onClose}>
      {children}
    </PollModal>
  );
}

function PollModal({ title, onClose, children }: { title: string; onClose: () => void; children: React.ReactNode }) {
  const ref = useDialogChrome<HTMLDivElement>(onClose);
  // Порталом в `body` (приёмка 14.10, D1): внутри ленты `.messages` с `contain: strict` окно `position: fixed` считалось от ленты
  // и уезжало за её верх (top ≈ −scrollTop) — «Кто голосовал» на ПК был невидим, лента прыгала.
  // Портал не отрезает всплытие по дереву React: без стопа нажатие в окне доходит до строки ленты и пузыря под ним (как у `GeoMapFull`).
  const stop = (e: { stopPropagation: () => void }) => e.stopPropagation();
  return createPortal(
    <div
      className="modal-overlay"
      onClick={(e) => {
        e.stopPropagation();
        onClose();
      }}
      onPointerDown={stop}
      onMouseDown={stop}
      onTouchStart={stop}
      onContextMenu={stop}
    >
      <div className="modal poll-composer conv-poll-modal" ref={ref} tabIndex={-1} role="dialog" aria-modal="true" aria-label={title} onClick={(e) => e.stopPropagation()}>
        <div className="admin-head">
          <h2>{title}</h2>
          <button type="button" className="icon-close" title="Закрыть" onClick={onClose}>
            <Icon name="close" size={18} />
          </button>
        </div>
        {children}
      </div>
    </div>,
    document.body,
  );
}

/** «Посмотреть голоса» (Telegram `PollVotesAlert`): по вариантам — процент и кто выбрал, по порядку голосования. */
function ConvPollVotes({ poll, conversationId, messageId, onClose }: { poll: ConvPollMedia; conversationId: string; messageId: string; onClose: () => void }) {
  const [data, setData] = useState<ConvPollVotersResponse | null>(null);
  useEffect(() => {
    let live = true;
    api.convPollVoters(conversationId, messageId).then(
      (r) => live && setData(r),
      (e) => {
        toastError(e);
        onClose();
      },
    );
    return () => {
      live = false;
    };
    // Окно открывается заново на каждый показ — перечитывать по смене итогов не нужно.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [conversationId, messageId]);
  const pct = convPollPercents(poll.options);
  return (
    <PollShell title={poll.quiz ? 'Ответы' : 'Голоса'} onClose={onClose}>
      <div className="conv-poll-votes">
        <div className="poll-q">{poll.question}</div>
        {!data ? (
          <div className="muted">Загрузка…</div>
        ) : (
          poll.options.map((o, i) => {
            const list = data.options.find((x) => x.optionId === o.id)?.voters ?? [];
            if (list.length === 0) return null;
            return (
              <section key={o.id} className="conv-poll-votes-group">
                <div className="conv-poll-votes-head">
                  <span>{o.text}</span>
                  <span className="muted">
                    {pct[i]}% · {convPollVotersText(list.length, poll.quiz)}
                  </span>
                </div>
                {list.map((u) => (
                  <div key={u.id} className="conv-poll-voter">
                    <Avatar url={u.avatarUrl} name={u.displayName || u.username} size={28} />
                    <span>{u.displayName || u.username}</span>
                  </div>
                ))}
              </section>
            );
          })
        )}
      </div>
    </PollShell>
  );
}

/** Создание опроса (Telegram `PollCreateActivity` / `CreatePollBox`): отправка — `onSend` беседы (как геопозиция). */
export function ConvPollCreate({ onSend, onClose }: { onSend: (media: ConvMediaInput) => Promise<void>; onClose: () => void }) {
  const [question, setQuestion] = useState('');
  // Как у Telegram: в конце списка всегда пустое поле, пока не набрано 10.
  const [options, setOptions] = useState<string[]>(['', '']);
  const [anonymous, setAnonymous] = useState(true);
  const [multi, setMulti] = useState(false);
  const [quiz, setQuiz] = useState(false);
  const [correct, setCorrect] = useState<number | null>(null);
  const [solution, setSolution] = useState('');
  const [busy, setBusy] = useState(false);
  const draft = convPollDraft({ kind: 'poll', question, options, anonymous, multi, quiz, correct, solution });
  const filled = options.filter((o) => o.trim()).length;

  const setOpt = (i: number, v: string) =>
    setOptions((prev) => {
      const next = prev.map((o, j) => (j === i ? v : o));
      if (i === next.length - 1 && v.trim() && next.length < CONV_POLL_LIMITS.maxOptions) next.push('');
      return next;
    });
  const removeOpt = (i: number) => {
    setOptions((prev) => (prev.length > CONV_POLL_LIMITS.minOptions ? prev.filter((_, j) => j !== i) : prev.map((o, j) => (j === i ? '' : o))));
    setCorrect((c) => (c === null || c === i ? null : c > i ? c - 1 : c));
  };

  const submit = async () => {
    if (!draft.ok || busy) return;
    setBusy(true);
    try {
      await onSend({ kind: 'poll', question, options, anonymous, multi, quiz, correct, solution: quiz ? solution : null });
      onClose();
    } catch (e) {
      toastError(e);
      setBusy(false);
    }
  };

  // Подсказка под кнопкой — та же фраза, что вернул бы сервер (`convPollDraft`), но только когда человек уже что-то набрал.
  const hint = !draft.ok && (question.trim() || filled > 0) ? draft.error : '';

  return (
    <PollShell title={quiz ? 'Новая викторина' : 'Новый опрос'} onClose={onClose}>
      <div className="conv-poll-create">
        <label className="pc-label" htmlFor="cpc-q">
          Вопрос
        </label>
        <input id="cpc-q" autoFocus maxLength={CONV_POLL_LIMITS.question} value={question} placeholder="Задайте вопрос" onChange={(e) => setQuestion(e.target.value)} />
        {question.length > CONV_POLL_LIMITS.question - 40 && <div className="pc-count">осталось {CONV_POLL_LIMITS.question - question.length}</div>}

        <div className="pc-label">Варианты ответа</div>
        {options.map((o, i) => (
          <div className="pc-opt" key={i}>
            {quiz && (
              <input
                type="radio"
                name="cpc-correct"
                aria-label="Правильный ответ"
                checked={correct === i}
                disabled={!o.trim()}
                onChange={() => setCorrect(i)}
              />
            )}
            <input maxLength={CONV_POLL_LIMITS.option} value={o} placeholder={i === options.length - 1 && i >= 2 ? 'Добавить вариант' : `Вариант ${i + 1}`} onChange={(e) => setOpt(i, e.target.value)} />
            {(o || options.length > CONV_POLL_LIMITS.minOptions) && (
              <button type="button" className="pc-del" title="Убрать вариант" onClick={() => removeOpt(i)}>
                <Icon name="close" size={14} />
              </button>
            )}
          </div>
        ))}
        <div className="muted pc-note">
          {filled >= CONV_POLL_LIMITS.maxOptions ? 'Добавлено максимальное число вариантов.' : `Можно добавить ещё ${CONV_POLL_LIMITS.maxOptions - filled}.`}
          {quiz ? ' Отметьте правильный ответ кружком слева.' : ''}
        </div>

        <div className="pc-label">Настройки</div>
        <div className="settings-row">
          <span id="cpc-anon">Анонимное голосование</span>
          <Toggle checked={anonymous} onChange={setAnonymous} labelledBy="cpc-anon" />
        </div>
        <div className="settings-row">
          <span id="cpc-multi">Несколько ответов</span>
          <Toggle checked={multi && !quiz} disabled={quiz} onChange={setMulti} labelledBy="cpc-multi" />
        </div>
        <div className="settings-row">
          <span id="cpc-quiz">Викторина</span>
          <Toggle checked={quiz} onChange={setQuiz} labelledBy="cpc-quiz" />
        </div>
        <div className="muted pc-note">
          {quiz ? 'У викторины один правильный ответ. Отменить свой ответ нельзя.' : 'Голос можно будет отменить, пока опрос не остановлен.'}
        </div>
        {quiz && (
          <>
            <label className="pc-label" htmlFor="cpc-sol">
              Пояснение
            </label>
            <textarea
              id="cpc-sol"
              rows={2}
              maxLength={CONV_POLL_LIMITS.solution}
              value={solution}
              placeholder="Необязательно"
              onChange={(e) => setSolution(e.target.value)}
            />
            <div className="muted pc-note">Его увидят после ответа — удобно, чтобы объяснить правильный вариант.</div>
          </>
        )}

        {hint && <div className="pc-warn">{hint[0]!.toUpperCase() + hint.slice(1)}</div>}
        <div className="modal-actions">
          <button type="button" className="link" onClick={onClose}>
            Отмена
          </button>
          <button type="button" disabled={!draft.ok || busy} onClick={() => void submit()}>
            {busy ? '…' : 'Создать'}
          </button>
        </div>
      </div>
    </PollShell>
  );
}
