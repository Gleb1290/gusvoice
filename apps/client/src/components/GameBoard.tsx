import { useEffect, useState } from 'react';
import type { GameLeaderboardDto, GameTitleDto, GameTitleKey, GameTitlesDto } from '@gusvoice/shared';
import { api } from '../api';
import { isMockEconomy, mockGameLeaderboard } from '../benchMock';
import { ensureGameTitles, ensureRecaps } from '../gameBoardClient';
import { boardRowDetails, partialFromLabel, signedCoins, titleValueText } from '../gameBoardRules';
import { usePhoneLayout } from '../phoneLayout';
import { useStore } from '../store';
import { BottomSheet } from './BottomSheet';
import { GameTitleChip, GameTitleMark } from './GameTitleChip';
import { Icon } from './Icon';

/**
 * Лидерборд игр и звания месяца (ГусКоины 2, этап 6).
 *
 * `GameBoardSection` — таблица с переключателем «Этот месяц · Прошлый · Сезон» (кошелёк, вкладка «Игры»; сцена «Активностей»).
 * Строки — чистый результат по всем играм, своя подсвечена; отрицательные стоят в хвосте (так сортирует сервер) и НЕ красятся:
 * таблица — витрина, а не доска позора. Под именем — разбивка (колесо/дуэли/прогнозы, срывы джекпота, победы дуэлей по
 * видам), у имени — значки званий прошлого месяца. `GameTitlesList` — 27 званий с носителями. `GameBoardScene` — сцена
 * «Таблица и звания» в «Активностях»: ПК — модалка, телефон — `BottomSheet page`.
 */

type Period = 'month' | 'prev' | 'season';

export function GameBoardTable({ board, meId, currency }: { board: GameLeaderboardDto; meId: string | undefined; currency: string }) {
  if (board.people.length === 0) return <div className="muted wallet-empty">В этом периоде ещё никто не играл</div>;
  return (
    <div className="board-list gb-list">
      {board.people.map((p) => {
        const details = boardRowDetails(p);
        return (
          <div className={`board-row gb-row${p.userId === meId ? ' board-row-me' : ''}`} key={p.userId}>
            <span className="board-place">{p.place}</span>
            <span className="gb-who">
              <span className="board-name gb-name">
                <span className="gb-name-text">{p.displayName}</span>
                {p.titles.slice(0, 2).map((k) => (
                  <GameTitleChip key={k} titleKey={k} name={board.titleNames[k]} compact />
                ))}
                {p.titles.length > 2 && <small className="gb-more">+{p.titles.length - 2}</small>}
              </span>
              {details.length > 0 && <small className="gb-details">{details.join(' · ')}</small>}
            </span>
            <span className="board-earned gb-net">
              {signedCoins(p.net)} {currency}
            </span>
          </div>
        );
      })}
    </div>
  );
}

export function GameBoardSection({ serverId, currency, heading = true }: { serverId: string; currency: string; heading?: boolean }) {
  const me = useStore((s) => s.user);
  const titles = useStore((s) => s.gameTitles[serverId]);
  const [period, setPeriod] = useState<Period>('month');
  const [board, setBoard] = useState<GameLeaderboardDto | null>(null);
  const [failed, setFailed] = useState(false);
  const prevMonth = titles?.month ?? null;

  useEffect(() => ensureGameTitles(serverId), [serverId]);
  useEffect(() => {
    let alive = true;
    setFailed(false);
    setBoard(null);
    const p = period === 'season' ? 'season' : 'month';
    api
      .getGameLeaderboard(serverId, p, period === 'prev' ? prevMonth?.id : undefined)
      .then((b) => alive && setBoard(b))
      .catch(() => {
        if (!alive) return;
        // Стенд с макетом экономики: маршрута нет — синтетика тем же компонентом.
        if (isMockEconomy()) setBoard(mockGameLeaderboard(me?.id ?? 'me', me?.displayName ?? 'Я', p));
        else setFailed(true);
      });
    return () => {
      alive = false;
    };
  }, [serverId, period, prevMonth?.id, me?.id, me?.displayName]);

  if (board && !board.enabled) return null;
  const partial = period === 'prev' && prevMonth?.partialFrom ? partialFromLabel(prevMonth.partialFrom) : '';
  return (
    <div className="gb-section">
      <div className="gb-head">
        {heading && <h3>{board?.period?.name ?? 'Таблица игр'}</h3>}
        {partial && <small className="gb-partial">{partial}</small>}
      </div>
      <div className="seg gb-seg" role="group" aria-label="Период">
        <button type="button" className={period === 'month' ? 'on' : ''} onClick={() => setPeriod('month')}>
          Этот месяц
        </button>
        {prevMonth && (
          <button type="button" className={period === 'prev' ? 'on' : ''} onClick={() => setPeriod('prev')}>
            {prevMonth.name.split(' ')[0]}
          </button>
        )}
        <button type="button" className={period === 'season' ? 'on' : ''} onClick={() => setPeriod('season')}>
          Сезон
        </button>
      </div>
      {failed ? (
        <div className="muted wallet-empty">Таблица не загрузилась — попробуй позже</div>
      ) : board ? (
        <GameBoardTable board={board} meId={me?.id} currency={currency} />
      ) : (
        <div className="muted wallet-empty">Загружаем…</div>
      )}
      <p className="gb-foot">Чистый результат: выигрыши и возвраты минус ставки. В сезон экономики не идёт.</p>
    </div>
  );
}

/** Мои звания прошлого месяца — строка чипов (кошелёк). Нет — ничего. */
export function MyGameTitles({ serverId }: { serverId: string }) {
  const meId = useStore((s) => s.user?.id);
  const titles = useStore((s) => s.gameTitles[serverId]);
  useEffect(() => ensureGameTitles(serverId), [serverId]);
  const mine = titles?.titles.filter((t) => t.holders.some((h) => h.userId === meId)) ?? [];
  if (!titles?.month || mine.length === 0) return null;
  return (
    <div className="gb-mine">
      <span className="muted">Твои звания · {titles.month.name}</span>
      {mine.map((t) => (
        <GameTitleChip key={t.key} titleKey={t.key} name={t.name} />
      ))}
    </div>
  );
}

/** Звания человека за прошлый месяц (карточка профиля) — ключи и названия. */
export function titlesOf(dto: GameTitlesDto | undefined, userId: string): { key: GameTitleKey; name: string }[] {
  return dto?.titles.filter((t) => t.holders.some((h) => h.userId === userId)).map((t) => ({ key: t.key, name: t.name })) ?? [];
}

function TitleRow({ t, meId, currency }: { t: GameTitleDto; meId: string | undefined; currency: string }) {
  return (
    <div className={`gt-row${t.holders.some((h) => h.userId === meId) ? ' gt-row-me' : ''}`}>
      <GameTitleMark titleKey={t.key} name={t.name} size={36} />
      <span className="gt-row-body">
        <span className="gt-row-name">{t.name}</span>
        <small className="gt-row-about">{t.about}</small>
        <span className="gt-row-holders">
          {t.holders.map((h) => h.displayName).join(', ')}
          {t.holders[0] && <small> · {titleValueText(t.unit, t.holders[0].value, currency)}</small>}
        </span>
      </span>
    </div>
  );
}

export function GameTitlesList({ dto, currency }: { dto: GameTitlesDto; currency: string }) {
  const meId = useStore((s) => s.user?.id);
  if (!dto.month) {
    return <div className="muted wallet-empty">Звания выдаются по итогам месяца — первые появятся 1-го числа.</div>;
  }
  const given = dto.titles.filter((t) => t.holders.length > 0);
  const rest = dto.titles.filter((t) => t.holders.length === 0);
  return (
    <div className="gt-list">
      <div className="gb-head">
        <h3>Звания · {dto.month.name}</h3>
        {dto.month.partialFrom && <small className="gb-partial">{partialFromLabel(dto.month.partialFrom)}</small>}
      </div>
      {given.length === 0 && <div className="muted wallet-empty">В прошлом месяце звания никому не достались.</div>}
      {given.map((t) => (
        <TitleRow key={t.key} t={t} meId={meId} currency={currency} />
      ))}
      {rest.length > 0 && (
        <details className="gt-rest">
          <summary>Не достались никому · {rest.length}</summary>
          {rest.map((t) => (
            <TitleRow key={t.key} t={t} meId={meId} currency={currency} />
          ))}
        </details>
      )}
    </div>
  );
}

/** Сцена «Таблица и звания» в «Активностях» (`view: 'board'`). */
export function GameBoardScene({ serverId, onClose, onBack }: { serverId: string; onClose: () => void; onBack: () => void }) {
  const phone = usePhoneLayout();
  const currency = useStore((s) => s.economy[serverId]?.currencyName || 'монет');
  const titles = useStore((s) => s.gameTitles[serverId]);
  const recaps = useStore((s) => s.recaps[serverId]);
  const openRecap = useStore((s) => s.openRecap);
  const [tab, setTab] = useState<'board' | 'titles'>('board');

  useEffect(() => {
    ensureGameTitles(serverId);
    ensureRecaps(serverId);
  }, [serverId]);
  useEffect(() => {
    if (phone) return; // у листа свой Esc
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [phone, onClose]);

  const recapKinds = (['games', 'economy'] as const).filter((k) => recaps?.[k]);
  const body = (
    <>
      <div className="seg gb-tabs" role="tablist" aria-label="Что показать">
        <button type="button" role="tab" aria-selected={tab === 'board'} className={tab === 'board' ? 'on' : ''} onClick={() => setTab('board')}>
          Таблица
        </button>
        <button type="button" role="tab" aria-selected={tab === 'titles'} className={tab === 'titles' ? 'on' : ''} onClick={() => setTab('titles')}>
          Звания
        </button>
      </div>
      {tab === 'board' ? (
        <GameBoardSection serverId={serverId} currency={currency} />
      ) : titles ? (
        <GameTitlesList dto={titles} currency={currency} />
      ) : (
        <div className="muted wallet-empty">Загружаем…</div>
      )}
      {recapKinds.length > 0 && (
        <div className="gb-recaps">
          {recapKinds.map((k) => (
            <button key={k} type="button" className="wallet-how gb-recap-btn" onClick={() => openRecap({ serverId, kind: k })}>
              <Icon name="star" size={14} />
              {k === 'games' ? `Итоги · ${recaps?.games?.name}` : `Итоги сезона · ${recaps?.economy?.name}`}
            </button>
          ))}
        </div>
      )}
    </>
  );

  if (phone) {
    return (
      <BottomSheet page title="Таблица и звания" onClose={onClose} onBack={onBack}>
        <div className="pr-body gb-body">{body}</div>
      </BottomSheet>
    );
  }
  return (
    <div className="modal-overlay" onClick={onClose}>
      <section className="modal eco-welcome act-card game-frame gb-card" role="dialog" aria-modal="true" aria-labelledby="gb-title" onClick={(e) => e.stopPropagation()}>
        <div className="ew-head">
          <button type="button" className="wh-back" onClick={onBack}>
            <Icon name="chevron-left" size={16} />
            Активности
          </button>
          <button type="button" className="icon-close" title="Закрыть" onClick={onClose}>
            <Icon name="close" size={18} />
          </button>
        </div>
        <h2 id="gb-title" className="ew-title">
          Таблица и звания
        </h2>
        {body}
      </section>
    </div>
  );
}
