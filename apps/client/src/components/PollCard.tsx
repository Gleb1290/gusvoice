import type { Poll, PollVoters } from '@gusvoice/shared';
import { useEffect, useState } from 'react';
import { api } from '../api';
import { useNameResolver } from '../memberName';
import { pollTimeLeft } from '../pollTime';
import { useStore } from '../store';
import { toastError } from '../toast';
import { Avatar } from './Avatar';
import { Icon } from './Icon';

/**
 * Опрос внутри сообщения (#17).
 *
 * Три правила, и все три держатся на сервере, а не на рисовании:
 *  1. **Результаты скрыты до своего голоса.** Иначе первые голоса тянут за собой остальные.
 *     Пока скрыты, сервер шлёт нули — прятать числа в клиенте бессмысленно.
 *  2. **Переголосовать нельзя.** Поэтому при множественном выборе человек отмечает всё сразу и
 *     жмёт «Проголосовать» один раз: иначе «выбери несколько» и «нельзя передумать» противоречат.
 *  3. **Анонимный или публичный** — задаётся при создании. У публичного по клику на вариант видно,
 *     кто его выбрал; у анонимного этого нет никогда.
 */
export function PollCard({ poll, channelId, messageId }: { poll: Poll; channelId: string; messageId: string }) {
  const nameOf = useNameResolver();
  const [picked, setPicked] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);
  const [voters, setVoters] = useState<PollVoters[] | null>(null);
  const [openOpt, setOpenOpt] = useState<string | null>(null);
  // Пересчёт «осталось» раз в минуту — иначе карточка врёт до перерисовки по другой причине.
  const [, tickNow] = useState(0);
  useEffect(() => {
    if (!poll.closesAt || poll.closed) return;
    const t = setInterval(() => tickNow((n) => n + 1), 60_000);
    return () => clearInterval(t);
  }, [poll.closesAt, poll.closed]);

  const voted = poll.myVotes.length > 0;
  const canVote = !voted && !poll.closed;
  const total = poll.options.reduce((s, o) => s + o.votes, 0);
  const left = poll.closesAt && !poll.closed ? pollTimeLeft(poll.closesAt) : null;

  function toggle(id: string) {
    if (!canVote) return;
    setPicked((p) => (poll.multi ? (p.includes(id) ? p.filter((x) => x !== id) : [...p, id]) : [id]));
  }

  async function submit() {
    if (!canVote || picked.length === 0 || busy) return;
    setBusy(true);
    try {
      // Ответ ОБЯЗАТЕЛЬНО применяем: только он несёт `myVotes` и `revealed`. WS-события их не
      // содержат намеренно (см. `applyPoll` в сторе), так что выброшенный ответ = мёртвая карточка.
      const fresh = await api.votePoll(channelId, messageId, picked);
      useStore.getState().applyPoll(channelId, messageId, fresh);
    } catch (e) {
      toastError(e);
    } finally {
      setBusy(false);
    }
  }

  async function showVoters(optionId: string) {
    if (poll.anonymous || !poll.revealed) return;
    setOpenOpt((cur) => (cur === optionId ? null : optionId));
    if (voters) return;
    try {
      setVoters(await api.pollVoters(channelId, messageId));
    } catch (e) {
      toastError(e);
    }
  }

  return (
    <div className="poll">
      <div className="poll-q">{poll.question}</div>
      <div className="poll-opts">
        {poll.options.map((o) => {
          const mine = poll.myVotes.includes(o.id);
          const sel = picked.includes(o.id);
          const pct = !poll.revealed || total === 0 ? 0 : Math.round((o.votes / total) * 100);
          const list = voters?.find((v) => v.optionId === o.id)?.users ?? [];
          return (
            <div key={o.id}>
              <button
                type="button"
                className={`poll-opt${mine ? ' mine' : ''}${sel ? ' sel' : ''}${poll.revealed ? ' done' : ''}`}
                onClick={() => (canVote ? toggle(o.id) : showVoters(o.id))}
                title={
                  canVote
                    ? poll.multi
                      ? 'Отметить'
                      : 'Выбрать'
                    : poll.anonymous
                      ? 'Опрос анонимный'
                      : poll.revealed
                        ? 'Показать, кто выбрал'
                        : ''
                }
              >
                {poll.revealed && <span className="poll-bar" style={{ width: `${pct}%` }} aria-hidden />}
                <span className="poll-mark">
                  {mine || sel ? <Icon name="check" size={13} /> : null}
                </span>
                <span className="poll-text">{o.text}</span>
                {poll.revealed && <span className="poll-pct">{pct}%</span>}
              </button>
              {openOpt === o.id && !poll.anonymous && poll.revealed && (
                <div className="poll-voters">
                  {list.length === 0 ? (
                    <span className="muted">Никто не выбрал</span>
                  ) : (
                    list.map((u) => (
                      <span className="poll-voter" key={u.id}>
                        <Avatar url={u.avatarUrl} name={nameOf(u.id, u.displayName)} size={18} />
                        {nameOf(u.id, u.displayName)}
                      </span>
                    ))
                  )}
                </div>
              )}
            </div>
          );
        })}
      </div>

      {canVote && (
        <div className="poll-actions">
          <button type="button" disabled={picked.length === 0 || busy} onClick={() => void submit()}>
            {busy ? '…' : 'Проголосовать'}
          </button>
          {/* Предупреждаем ДО нажатия — узнать про «нельзя передумать» после клика обидно. */}
          <span className="muted poll-warn">Переголосовать будет нельзя</span>
        </div>
      )}

      <div className="poll-foot muted">
        {poll.voters === 0 ? 'Ещё никто не голосовал' : `Проголосовало: ${poll.voters}`}
        {poll.multi ? ' · можно выбрать несколько' : ''}
        {poll.anonymous ? ' · анонимный' : ' · видно, кто как ответил'}
        {poll.closed ? ' · опрос закрыт' : left ? ` · ${left}` : ''}
        {!poll.revealed && !poll.closed ? ' · результаты после вашего голоса' : ''}
      </div>
    </div>
  );
}
