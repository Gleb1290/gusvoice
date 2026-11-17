import { useState } from 'react';
import type { WheelBetDto } from '@gusvoice/shared';
import { betsByUser } from '../wheelRules';

export interface WheelBetsProps {
  roundId: string | null;
  bets: readonly WheelBetDto[];
  nameOf: (id: string) => string;
  avatarOf: (id: string) => string | null;
  meId: string | null;
  emptyText?: string;
  title?: string;
}

const amountFormat = new Intl.NumberFormat('ru-RU');
const compactFormat = new Intl.NumberFormat('ru-RU', { notation: 'compact', maximumFractionDigits: 1 });
function amountLabel(value: number): string {
  if (!Number.isFinite(value)) return '—';
  return (Math.abs(value) >= 1_000_000 ? compactFormat : amountFormat).format(value);
}

/** Смена раунда сразу создаёт новую страницу, без кадра со старым состоянием. */
export function WheelBets(props: WheelBetsProps) {
  return <WheelBetsPage key={props.roundId ?? 'no-round'} {...props} />;
}

function WheelBetsPage({ roundId, bets, nameOf, avatarOf, meId, emptyText = 'Пока никто не поставил', title = 'Ставки раунда' }: WheelBetsProps) {
  const groups = betsByUser(roundId === null ? [] : bets);
  const pages = Math.max(1, Math.ceil(groups.length / 4));
  const [requestedPage, setPage] = useState(0);
  const page = Math.min(requestedPage, pages - 1);
  // Ограничиваем сразу: исчезнувшая страница не возвращается при новых ставках.
  if (requestedPage !== page) setPage(page);
  const visible = groups.slice(page * 4, page * 4 + 4);

  return <section className="wh-live-bets" aria-label={title}>
    <header className="wh-live-bets-head">
      <h3 className="wh-live-bets-heading" title={title}>{title} · {groups.length}</h3>
      <div className="wh-live-bets-pager" role="group" aria-label="Страницы ставок">
        <button type="button" aria-label="Предыдущая страница ставок" disabled={page === 0}
          onClick={() => setPage(page - 1)}>‹</button>
        <span className="wh-live-bets-page" aria-live="polite" aria-atomic="true">{page + 1}/{pages}</span>
        <button type="button" aria-label="Следующая страница ставок" disabled={page === pages - 1}
          onClick={() => setPage(page + 1)}>›</button>
      </div>
    </header>
    <div className="wh-live-bets-body">
      <ul className="wh-live-bets-list" aria-label="Участники раунда">
        {Array.from({ length: 4 }, (_, slot) => {
          const group = visible[slot];
          if (!group) return <li key={`empty-${slot}`} className="wh-live-bet wh-live-bets-placeholder" aria-hidden="true" />;
          const name = nameOf(group.userId);
          const avatar = avatarOf(group.userId);
          const picks = group.bets.map(bet => `На ${bet.pick}: ${amountLabel(bet.amount)}`).join(' · ');
          return <li key={group.userId} className={`wh-live-bet${group.userId === meId ? ' me' : ''}`}>
            <div className="wh-live-bets-person">
              {avatar && <img className="wh-live-bets-avatar" src={avatar} alt="" width={16} height={16} />}
              <span className="wh-live-bets-name" title={name}>{name}</span>
              <strong className="wh-live-bets-amount" title={`Сумма ставок: ${Number.isFinite(group.total) ? amountFormat.format(group.total) : '—'}`}>
                {amountLabel(group.total)}
              </strong>
            </div>
            <span className="wh-live-bets-picks" title={picks}>{picks}</span>
          </li>;
        })}
      </ul>
      {groups.length === 0 && <p className="wh-live-bets-empty">{emptyText}</p>}
    </div>
  </section>;
}
