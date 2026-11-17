import { useEffect, useMemo, useRef, useState } from 'react';
import {
  PREDICTION_MAX_LIVE,
  PREDICTION_MAX_OPTIONS,
  PREDICTION_MAX_QUESTIONS,
  PREDICTION_MIN_OPTIONS,
  PREDICTION_OPTION_MAX,
  PREDICTION_QUESTION_MAX,
  PREDICTION_TITLE_MAX,
  predictionEstimate,
  type PredictionEventDto,
  type PredictionQuestionDto,
} from '@gusvoice/shared';
import { api } from '../api';
import { GameRules } from './GameRules';
import hostUrl from '../assets/predictions/host.png';
import coinDefaultIcon from '../assets/guscoin.svg';
import { isMockEconomy } from '../benchMock';
import { confirmAction } from '../confirm';
import { gamesView } from '../economy';
import { ensurePredictions } from '../economyClient';
import { usePhoneLayout } from '../phoneLayout';
import {
  cancelReasonText,
  draftBody,
  draftFieldText,
  draftProblem,
  emptyDraft,
  emptyQuestion,
  LOCK_CHOICES,
  myBetOf,
  myEventResult,
  optionShare,
  predictionClock,
  predictionErrorText,
  predictionLeftMs,
  predictionLive,
  type PredictionDraftState,
} from '../predictionRules';
import { useStore, voiceIsHere } from '../store';
import { betPresets, clampBet } from '../wheelRules';
import { BottomSheet } from './BottomSheet';
import { useDuelPeople, useNowTick } from './Duel';
import { Icon } from './Icon';

/**
 * «Ставки на события» (ГусКоины 2, этап 5) — лента событий сервера и редактор. Ленивая сцена «Активностей» (`view: 'events'`),
 * как колесо и дуэль: ПК — модалка, телефон — `BottomSheet page`. Ведущий — голубой попугай с подзорной трубой.
 *
 * Лента: живые события (вопросы, варианты с полосами долей и числом поставивших, моя ставка, отсчёт до закрытия по часам
 * сервера, прикидка «поставишь N — получишь ~M» тем же `predictionEstimate`, которым сервер платит), закрытые — «ждём итога»,
 * итог — верные варианты и мой выигрыш, отменённые — причина. Управление: создатель — «Закрыть приём», «Подвести итог»,
 * «Отменить»; управляющий экономикой/событиями — «Отменить» (закрытие приёма и итог — только создатель). Ставить — только сидя
 * в голосе этого сервера (сервер всё равно проверит: `not_in_voice`).
 */

type Reply = { event: PredictionEventDto; serverNow: string };

/** Ответ POST — тем же путём, что событие шлюза; ленты ещё нет — догрузить снимок. */
function applyReply(serverId: string, r: Reply): void {
  const ok = useStore.getState().applyPredictionEvent({ t: 'prediction.state', serverId, eventId: r.event.id, event: r.event, serverNow: r.serverNow });
  if (!ok) ensurePredictions(serverId, true);
}

function failText(e: unknown): string {
  const er = e as Error & { reason?: string };
  return predictionErrorText(er?.reason ?? er?.message);
}

/** Стенд без сервера: ставка ложится в макет ленты локально (пулы и число поставивших пересчитываются). */
function mockBet(ev: PredictionEventDto, meId: string, questionId: string, optionId: string, amount: number): Reply {
  const questions = ev.questions.map((q) =>
    q.id !== questionId
      ? q
      : {
          ...q,
          pool: q.pool + amount,
          options: q.options.map((o) => (o.id === optionId ? { ...o, pool: o.pool + amount, bettors: o.bettors + 1 } : o)),
          bets: [...q.bets, { userId: meId, optionId, amount, payout: null, refunded: false }],
        },
  );
  return { event: { ...ev, questions }, serverNow: new Date().toISOString() };
}

/** Потолок ставки: максимум сервера (`betMax` ленты), баланс и остаток суточного предела проигрыша. */
function useStakeCap(serverId: string, betMax: number): { balance: number; lossLeft: number | null; cap: number; iconUrl: string | null; feePercent: number } {
  const eco = useStore((s) => s.economy[serverId]);
  const games = eco ? gamesView(eco) : null;
  const balance = eco?.wallet.balance ?? 0;
  const lossLeft = games?.games.effectiveLimit != null ? Math.max(0, games.games.effectiveLimit - games.games.lossToday) : null;
  const cap = Math.max(0, Math.min(betMax, balance, lossLeft ?? Number.MAX_SAFE_INTEGER));
  return { balance, lossLeft, cap, iconUrl: eco?.iconUrl ?? null, feePercent: eco?.settings?.gamesFeePercent ?? 10 };
}

function dateLabel(iso: string | null): string {
  const t = iso ? Date.parse(iso) : NaN;
  if (!Number.isFinite(t)) return '';
  return new Date(t).toLocaleString('ru-RU', { day: 'numeric', month: 'long', hour: '2-digit', minute: '2-digit' });
}

export default function PredictionsScene({
  serverId,
  focusEventId,
  onClose,
  onBack,
}: {
  serverId: string;
  focusEventId?: string;
  onClose: () => void;
  onBack: () => void;
}) {
  const phone = usePhoneLayout();
  const view = useStore((s) => s.predictions[serverId]);
  const [mode, setMode] = useState<'feed' | 'new'>('feed');

  useEffect(() => {
    if (isMockEconomy()) return;
    ensurePredictions(serverId, true);
    const onFocus = () => ensurePredictions(serverId, true);
    window.addEventListener('focus', onFocus);
    return () => window.removeEventListener('focus', onFocus);
  }, [serverId]);

  useEffect(() => {
    if (phone) return; // у листа свой Esc
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return;
      if (mode === 'new') setMode('feed');
      else onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [phone, onClose, mode]);

  useEffect(() => {
    if (!focusEventId || mode !== 'feed') return;
    const id = window.setTimeout(() => document.getElementById(`pr-ev-${focusEventId}`)?.scrollIntoView({ block: 'start', behavior: 'smooth' }), 60);
    return () => window.clearTimeout(id);
  }, [focusEventId, mode, !!view]);

  const title = mode === 'new' ? 'Новое событие' : 'Ставки на события';
  const body =
    mode === 'new' ? (
      <PredictionEditor serverId={serverId} onDone={() => setMode('feed')} />
    ) : (
      <PredictionFeed serverId={serverId} onNew={() => setMode('new')} />
    );

  if (phone) {
    return (
      <BottomSheet page title={title} onClose={onClose} onBack={mode === 'new' ? () => setMode('feed') : onBack}>
        <div className="pr-body"><GameRules game="prediction" />{body}</div>
      </BottomSheet>
    );
  }
  return (
    <div className="modal-overlay" onClick={onClose}>
      <section className="modal eco-welcome act-card game-frame pr-card" role="dialog" aria-modal="true" aria-labelledby="pr-title" onClick={(e) => e.stopPropagation()}>
        <div className="ew-head">
          <button type="button" className="wh-back" onClick={mode === 'new' ? () => setMode('feed') : onBack}>
            <Icon name="chevron-left" size={16} />
            {/* Лента — выбор события (уровень «Активностей»), редактор — уже внутри игры: «Назад» к ленте (владелец 29.10). */}
            {mode === 'new' ? 'Назад' : 'Активности'}
          </button>
          <button type="button" className="icon-close" title="Закрыть" onClick={onClose}>
            <Icon name="close" size={18} />
          </button>
        </div>
        <h2 id="pr-title" className="ew-title">
          {title}
        </h2>
        <GameRules game="prediction" />
        {body}
      </section>
    </div>
  );
}

function PredictionFeed({ serverId, onNew }: { serverId: string; onNew: () => void }) {
  const view = useStore((s) => s.predictions[serverId]);
  const events = view?.events ?? [];
  const ordered = [...events].sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt));
  const recent = ordered.slice(0, 3);
  const older = ordered.slice(3);
  const liveCount = events.filter((e) => predictionLive(e)).length;
  const ticking = events.some((e) => e.state === 'open' && !!e.lockAt);
  const now = useNowTick(1000, ticking);
  const hiddenLiveCount = older.filter((e) => {
    const left = predictionLeftMs(e, now, view?.skewMs ?? 0);
    return e.state === 'open' && (left === null || left > 0);
  }).length;

  if (!view) return <p className="wh-empty">Загружаем события…</p>;
  if (!view.enabled) return <p className="wh-empty">Игры на этом сервере выключены — событий нет.</p>;

  const head = (
    <div className="pr-intro">
      <img src={hostUrl} alt="" className="pr-host" />
      <div className="pr-intro-text">
        <p className="ew-text">
          Ставь на исход вопросов. Банк вопроса делят угадавшие — пропорционально ставкам; комиссия берётся только с проигравших ставок.
        </p>
        {view.canManage && (
          <button type="button" className="ew-btn ew-btn-main pr-new" disabled={liveCount >= PREDICTION_MAX_LIVE} onClick={onNew}>
            <Icon name="plus" size={16} />
            Новое событие
          </button>
        )}
        {view.canManage && liveCount >= PREDICTION_MAX_LIVE && <p className="wh-hint pr-hint-flat">Уже идут {PREDICTION_MAX_LIVE} события — дождись итога одного из них.</p>}
      </div>
    </div>
  );
  return (
    <div className="pr-feed">
      {head}
      {events.length === 0 ? (
        <p className="wh-empty pr-empty">
          {view.canManage ? 'Событий пока нет. Заведи первое: вопрос о матче, споре или стриме — и пусть гуси ставят.' : 'Событий пока нет. Когда их заведут, они появятся здесь.'}
        </p>
      ) : (
        <>
          {recent.map((ev) => <EventCard key={ev.id} serverId={serverId} ev={ev} now={now} />)}
          {older.length > 0 && (
            <details className="pr-history">
              <summary>Ещё события ({older.length}) · Приём открыт: {hiddenLiveCount}</summary>
              {older.map((ev) => <EventCard key={ev.id} serverId={serverId} ev={ev} now={now} />)}
            </details>
          )}
        </>
      )}
    </div>
  );
}

function EventCard({ serverId, ev, now }: { serverId: string; ev: PredictionEventDto; now: number }) {
  const view = useStore((s) => s.predictions[serverId]);
  const meId = useStore((s) => s.user?.id ?? null);
  const inVoice = useStore((s) => !!s.voice && voiceIsHere(s.voice) && s.voice.serverId === serverId);
  const people = useDuelPeople(null);
  const [settling, setSettling] = useState(false);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const isCreator = !!meId && ev.createdBy === meId;
  const canManage = !!view?.canManage;
  const skew = view?.skewMs ?? 0;
  const left = predictionLeftMs(ev, now, skew);

  let status: string;
  let statusCls = '';
  if (ev.state === 'open') {
    status = left !== null ? `Приём ставок · ещё ${predictionClock(left)}` : 'Приём ставок · закроют вручную';
    statusCls = ' live';
  } else if (ev.state === 'locked') status = 'Приём закрыт · ждём итога';
  else if (ev.state === 'settled') status = 'Итог подведён';
  else status = 'Отменено';

  async function act(action: 'close' | 'cancel') {
    if (action === 'cancel') {
      const ok = await confirmAction({
        title: 'Отменить событие?',
        body: 'Все ставки вернутся поставившим, итога не будет. Вернуть событие нельзя.',
        tone: 'danger',
        confirmLabel: 'Отменить событие',
        cancelLabel: 'Не отменять',
      });
      if (!ok) return;
    }
    setBusy(true);
    setErr(null);
    try {
      applyReply(serverId, await api.predictionAction(serverId, ev.id, action));
    } catch (e) {
      const reason = (e as Error & { reason?: string })?.reason;
      setErr(action === 'close' && reason === 'forbidden' ? 'Закрыть приём может только создатель события' : failText(e));
    } finally {
      setBusy(false);
    }
  }

  const mine = myEventResult(ev, meId);
  const creatorName = ev.createdBy ? people(ev.createdBy).name : null;
  return (
    <article id={`pr-ev-${ev.id}`} className={`pr-event pr-${ev.state}`}>
      <header className="pr-event-head">
        <h3 className="pr-event-title">{ev.title}</h3>
        <span className={`act-game-status${statusCls}`}>
          {statusCls && <span className="act-dot inline" aria-hidden="true" />}
          {status}
        </span>
        <span className="pr-event-by">{isCreator ? 'Ведёшь ты' : creatorName ? `Ведёт ${creatorName}` : 'Ведущий удалил аккаунт'}</span>
      </header>

      {ev.state === 'cancelled' && <p className="pr-note">{cancelReasonText(ev.cancelReason)}</p>}

      {settling ? (
        <SettleForm serverId={serverId} ev={ev} onDone={() => setSettling(false)} />
      ) : (
        ev.questions.map((q) => (
          <QuestionBlock key={q.id} serverId={serverId} ev={ev} q={q} meId={meId} canBet={ev.state === 'open' && inVoice && !isCreator} />
        ))
      )}

      {ev.state === 'open' && !settling && (isCreator ? (
        <p className="wh-hint pr-hint-flat">Ты ведёшь это событие — сам не ставишь, итог подводишь ты.</p>
      ) : !inVoice ? (
        <p className="wh-hint pr-hint-flat">Ставить можно, сидя в голосе этого сервера.</p>
      ) : null)}
      {ev.state === 'locked' && !settling && (
        <p className="wh-hint pr-hint-flat">
          {isCreator ? 'Выбери верный вариант на каждый вопрос.' : 'Итог подведёт ведущий.'}
          {ev.autoCancelAt && ` Не будет итога до ${dateLabel(ev.autoCancelAt)} — ставки вернутся.`}
        </p>
      )}
      {ev.state === 'settled' && mine.bets > 0 && (
        <p className={`pr-result${mine.won > 0 ? ' win' : ''}`}>
          {mine.won > 0
            ? `Ты угадал ${mine.hits} из ${mine.bets}: +${mine.won}`
            : mine.refunded >= mine.staked
              ? 'Твои ставки вернулись'
              : `Не угадал — ставки ушли угадавшим`}
        </p>
      )}

      {!settling && (ev.state === 'open' || ev.state === 'locked') && (isCreator || canManage) && (
        <div className="pr-actions">
          {ev.state === 'open' && isCreator && (
            <button type="button" className="ew-btn" disabled={busy} onClick={() => void act('close')}>
              Закрыть приём
            </button>
          )}
          {ev.state === 'locked' && isCreator && (
            <button type="button" className="ew-btn ew-btn-main" disabled={busy} onClick={() => setSettling(true)}>
              Подвести итог
            </button>
          )}
          <button type="button" className="ew-btn pr-cancel" disabled={busy} onClick={() => void act('cancel')}>
            Отменить
          </button>
        </div>
      )}
      {err && (
        <p className="wh-err" role="alert">
          {err}
        </p>
      )}
    </article>
  );
}

function QuestionBlock({
  serverId,
  ev,
  q,
  meId,
  canBet,
}: {
  serverId: string;
  ev: PredictionEventDto;
  q: PredictionQuestionDto;
  meId: string | null;
  canBet: boolean;
}) {
  const betMax = useStore((s) => s.predictions[serverId]?.betMax ?? 0);
  const { balance, lossLeft, cap, iconUrl } = useStakeCap(serverId, betMax);
  const mine = myBetOf(q, meId);
  const [pick, setPick] = useState<string | null>(null);
  const [amountRaw, setAmountRaw] = useState('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const presets = betPresets(cap, cap);
  const amount = clampBet(Number(amountRaw || (presets[0] ?? 0)), betMax, cap);
  const open = canBet && !mine;
  const betting = useRef(false);
  const done = ev.state === 'settled';
  const coin = <img src={iconUrl || coinDefaultIcon} alt="" className="wh-coin" />;

  // Прикидка своей ставки «если сыграет»: пул варианта без неё самой + она (тот же делёж, что у сервера).
  const myEstimate = useMemo(() => {
    if (!mine || mine.refunded || ev.state === 'settled' || ev.state === 'cancelled') return 0;
    const opts = q.options.map((o) => (o.id === mine.optionId ? { ...o, pool: Math.max(0, o.pool - mine.amount) } : o));
    return predictionEstimate(opts, mine.optionId, mine.amount, ev.feePercent);
  }, [mine, q.options, ev.state, ev.feePercent]);
  const estimate = pick && amount > 0 ? predictionEstimate(q.options, pick, amount, ev.feePercent) : 0;

  async function bet() {
    if (betting.current || !open || !pick || amount < 1) return;
    betting.current = true;
    setBusy(true);
    setErr(null);
    try {
      const body = { questionId: q.id, optionId: pick, amount };
      const r = isMockEconomy() && meId ? mockBet(ev, meId, q.id, pick, amount) : await api.betPrediction(serverId, ev.id, body);
      applyReply(serverId, r);
      setPick(null);
      setAmountRaw('');
    } catch (e) {
      setErr(failText(e));
    } finally {
      betting.current = false;
      setBusy(false);
    }
  }

  const pickedLabel = q.options.find((o) => o.id === pick)?.label;
  const mineLabel = mine ? q.options.find((o) => o.id === mine.optionId)?.label : undefined;
  return (
    <section className="pr-q">
      <div className="pr-q-head">
        <span className="pr-q-text">{q.question}</span>
        <span className="pr-q-pool">
          банк {q.pool}
          {coin}
        </span>
      </div>
      <div className="poll-opts" role={open ? 'radiogroup' : undefined} aria-label={open ? q.question : undefined}>
        {q.options.map((o) => {
          const share = optionShare(o.pool, q.pool);
          const isMine = mine?.optionId === o.id;
          const right = done && q.winnerOptionId === o.id;
          const wrong = done && isMine && !q.void && q.winnerOptionId !== o.id;
          const sel = pick === o.id;
          const cls = ['poll-opt', 'pr-opt', isMine ? 'mine' : '', sel ? 'sel' : '', right ? 'right' : '', wrong ? 'wrong' : '', open ? '' : 'closed']
            .filter(Boolean)
            .join(' ');
          return (
            <button
              key={o.id}
              type="button"
              role={open ? 'radio' : undefined}
              aria-checked={open ? sel : undefined}
              className={cls}
              disabled={!open || busy}
              onClick={() => open && !busy && setPick(sel ? null : o.id)}
            >
              <span className="poll-bar" style={{ width: `${share}%` }} aria-hidden />
              <span className="poll-mark">{right || isMine || sel ? <Icon name="check" size={14} /> : null}</span>
              <span className="poll-text pr-opt-text">
                <span className="pr-opt-label">{o.label}</span>
                <span className="pr-opt-meta">
                  {o.bettors > 0 ? `${o.bettors} чел. · ${o.pool}` : 'пока никто'}
                </span>
              </span>
              <span className="poll-pct">{share}%</span>
            </button>
          );
        })}
      </div>

      {q.void && <p className="pr-note">Вопрос не состоялся — ставки по нему вернулись.</p>}
      {mine && (
        <p className={`pr-mine${done && !q.void ? (mine.payout && mine.payout > 0 ? ' win' : ' lose') : ''}`}>
          Твоя ставка {mine.amount}
          {coin} на «{mineLabel ?? '—'}»
          {mine.refunded
            ? ' · вернулась'
            : done && !q.void
              ? mine.payout && mine.payout > 0
                ? ` · угадал: +${mine.payout}`
                : ' · не угадал'
              : myEstimate > 0
                ? ` · если сыграет — ~${myEstimate}`
                : ''}
        </p>
      )}

      {open && (
        <div className="pr-stake">
          <div className="wh-amount">
            {presets.map((v) => (
              <button key={v} type="button" className={`wh-chip${amount === v ? ' sel' : ''}`} disabled={busy || !pick} onClick={() => setAmountRaw(String(v))}>
                {v}
              </button>
            ))}
            <input
              className="wh-amount-input"
              type="number"
              inputMode="numeric"
              min={1}
              max={cap || undefined}
              placeholder="Своя"
              aria-label="Сумма ставки"
              value={amountRaw}
              disabled={busy || !pick}
              onChange={(e) => setAmountRaw(e.target.value)}
            />
          </div>
          <p className="wh-hint pr-hint-flat">
            Ставка окончательная, одна на вопрос. Максимум {betMax}
            {lossLeft !== null && ` · сегодня можно проиграть ещё ${lossLeft}`} · в кошельке {balance}
          </p>
          <p className="duel-pot pr-est">
            {pick && amount > 0 ? <>Поставишь {amount}{coin} — получишь <b>~{estimate}</b>, если сыграет «{pickedLabel}»</> : 'Выбери вариант, чтобы увидеть возможный выигрыш.'}
          </p>
          <button type="button" className="ew-btn ew-btn-main wh-place" disabled={busy || !pick || amount < 1} onClick={() => void bet()}>
            {!pick ? 'Выбери вариант' : amount > 0 ? `Поставить ${amount}` : 'Не хватает монет'}
          </button>
        </div>
      )}
      {err && (
        <p className="wh-err" role="alert">
          {err}
        </p>
      )}
    </section>
  );
}

/** Итог: на каждый вопрос — верный вариант или «не состоялся» (возврат по вопросу). Только создатель, после закрытия приёма. */
function SettleForm({ serverId, ev, onDone }: { serverId: string; ev: PredictionEventDto; onDone: () => void }) {
  const [winners, setWinners] = useState<Record<string, string | null>>({});
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const ready = ev.questions.every((q) => Object.prototype.hasOwnProperty.call(winners, q.id));
  const settling = useRef(false);

  async function settle() {
    if (!ready || settling.current) return;
    settling.current = true;
    setBusy(true);
    setErr(null);
    try {
      applyReply(serverId, await api.settlePrediction(serverId, ev.id, winners));
      onDone();
    } catch (e) {
      setErr(failText(e));
    } finally {
      settling.current = false;
      setBusy(false);
    }
  }

  return (
    <div className="pr-settle">
      {ev.questions.map((q) => (
        <section key={q.id} className="pr-q">
          <span className="pr-q-text">{q.question}</span>
          <div className="wh-amount" role="radiogroup" aria-label={q.question}>
            {q.options.map((o) => (
              <button
                key={o.id}
                type="button"
                role="radio"
                aria-checked={winners[q.id] === o.id}
                disabled={busy}
                className={`wh-chip${winners[q.id] === o.id ? ' sel' : ''}`}
                onClick={() => setWinners((w) => ({ ...w, [q.id]: o.id }))}
              >
                {o.label}
              </button>
            ))}
            <button
              type="button"
              role="radio"
              aria-checked={q.id in winners && winners[q.id] === null}
              disabled={busy}
              className={`wh-chip pr-void${q.id in winners && winners[q.id] === null ? ' sel' : ''}`}
              onClick={() => setWinners((w) => ({ ...w, [q.id]: null }))}
            >
              Не состоялся
            </button>
          </div>
        </section>
      ))}
      <p className="wh-hint pr-hint-flat">«Не состоялся» — ставки по вопросу вернутся. Итог окончательный, деньги разойдутся сразу.</p>
      <div className="pr-actions">
        <button type="button" className="ew-btn" disabled={busy} onClick={onDone}>
          Назад
        </button>
        <button type="button" className="ew-btn ew-btn-main" disabled={busy || !ready} onClick={() => void settle()}>
          Подвести итог
        </button>
      </div>
      {err && (
        <p className="wh-err" role="alert">
          {err}
        </p>
      )}
    </div>
  );
}

/** Редактор события (`canManage`): заголовок, таймер закрытия или вручную, до 10 вопросов × 2..10 вариантов. */
function PredictionEditor({ serverId, onDone }: { serverId: string; onDone: () => void }) {
  const feePercent = useStore((s) => s.economy[serverId]?.settings?.gamesFeePercent ?? 10);
  const [d, setD] = useState<PredictionDraftState>(() => emptyDraft());
  const [field, setField] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  const setQ = (n: number, fn: (q: PredictionDraftState['questions'][number]) => PredictionDraftState['questions'][number]) =>
    setD((x) => ({ ...x, questions: x.questions.map((q, i) => (i === n ? fn(q) : q)) }));
  const bad = (f: string) => (field === f ? ' bad' : '');

  /* Клавиатура телефона (этап 7): APK ужимает WebView на её высоту (`MainActivity.fitAboveKeyboard`), браузер — видимую
     область (`visualViewport`); поле в фокусе после этого может остаться под клавишами. Окно сменило высоту, а поле
     редактора в фокусе вне видимой части — возвращаем его в середину. */
  const box = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const vv = window.visualViewport;
    let raf = 0;
    const keep = () => {
      cancelAnimationFrame(raf);
      raf = requestAnimationFrame(() => {
        const a = document.activeElement as HTMLElement | null;
        if (!a || !box.current?.contains(a) || (a.tagName !== 'INPUT' && a.tagName !== 'TEXTAREA')) return;
        const top = vv ? vv.offsetTop : 0;
        const bottom = vv ? vv.offsetTop + vv.height : window.innerHeight;
        const r = a.getBoundingClientRect();
        if (r.bottom > bottom - 8 || r.top < top) a.scrollIntoView({ block: 'center' });
      });
    };
    window.addEventListener('resize', keep);
    vv?.addEventListener('resize', keep);
    return () => {
      cancelAnimationFrame(raf);
      window.removeEventListener('resize', keep);
      vv?.removeEventListener('resize', keep);
    };
  }, []);

  async function submit() {
    const problem = draftProblem(d);
    setField(problem);
    setErr(null);
    if (problem) return;
    setBusy(true);
    try {
      const r = await api.createPrediction(serverId, draftBody(d));
      applyReply(serverId, r);
      onDone();
    } catch (e) {
      const er = e as Error & { field?: string };
      if (er?.field) setField(er.field);
      else setErr(failText(e));
    } finally {
      setBusy(false);
    }
  }

  const fieldText = draftFieldText(field, d);
  return (
    <div className="pr-editor" ref={box}>
      <label className="wh-h" htmlFor="pr-ed-title">
        Событие
      </label>
      <input
        id="pr-ed-title"
        className={`wh-amount-input pr-input${bad('title')}`}
        maxLength={PREDICTION_TITLE_MAX}
        placeholder="Финал турнира, вечерний стрим…"
        value={d.title}
        onChange={(e) => setD((x) => ({ ...x, title: e.target.value }))}
      />

      <h3 className="wh-h">Приём ставок закроется</h3>
      <div className="wh-amount" role="radiogroup" aria-label="Приём ставок закроется">
        {LOCK_CHOICES.map((c) => (
          <button
            key={c.label}
            type="button"
            role="radio"
            aria-checked={d.lockInSec === c.sec}
            className={`wh-chip${d.lockInSec === c.sec ? ' sel' : ''}`}
            onClick={() => setD((x) => ({ ...x, lockInSec: c.sec }))}
          >
            {c.label}
          </button>
        ))}
      </div>
      <p className="wh-hint">{d.lockInSec === null ? 'Закроешь сам кнопкой «Закрыть приём».' : 'Таймер идёт с момента создания; закрыть раньше можно кнопкой.'}</p>

      {d.questions.map((q, n) => (
        <section key={n} className="pr-ed-q">
          <div className="pr-ed-q-head">
            <h3 className="wh-h">Вопрос {n + 1}</h3>
            {d.questions.length > 1 && (
              <button type="button" className="icon-close" title="Убрать вопрос" onClick={() => setD((x) => ({ ...x, questions: x.questions.filter((_, i) => i !== n) }))}>
                <Icon name="trash" size={14} />
              </button>
            )}
          </div>
          <input
            className={`wh-amount-input pr-input${bad(`q${n}`)}`}
            maxLength={PREDICTION_QUESTION_MAX}
            placeholder="Кто победит?"
            aria-label={`Вопрос ${n + 1}`}
            value={q.question}
            onChange={(e) => setQ(n, (x) => ({ ...x, question: e.target.value }))}
          />
          {q.options.map((o, m) => (
            <div key={m} className="pc-opt">
              <input
                className={`wh-amount-input pr-input${bad(`q${n}.o${m}`)}${bad(`q${n}.options`)}`}
                maxLength={PREDICTION_OPTION_MAX}
                placeholder={`Вариант ${m + 1}`}
                aria-label={`Вопрос ${n + 1}, вариант ${m + 1}`}
                value={o}
                onChange={(e) => setQ(n, (x) => ({ ...x, options: x.options.map((v, j) => (j === m ? e.target.value : v)) }))}
              />
              {q.options.length > PREDICTION_MIN_OPTIONS && (
                <button type="button" className="icon-close" title="Убрать вариант" onClick={() => setQ(n, (x) => ({ ...x, options: x.options.filter((_, j) => j !== m) }))}>
                  <Icon name="close" size={14} />
                </button>
              )}
            </div>
          ))}
          {q.options.length < PREDICTION_MAX_OPTIONS && (
            <button type="button" className="link pc-add" onClick={() => setQ(n, (x) => ({ ...x, options: [...x.options, ''] }))}>
              + Вариант
            </button>
          )}
        </section>
      ))}
      {d.questions.length < PREDICTION_MAX_QUESTIONS && (
        <button type="button" className="ew-btn pr-add-q" onClick={() => setD((x) => ({ ...x, questions: [...x.questions, emptyQuestion()] }))}>
          <Icon name="plus" size={16} />
          Ещё вопрос
        </button>
      )}

      <p className="wh-hint pr-hint-flat">
        Ты ведёшь событие: сам не ставишь, итог подводишь ты. Комиссия {feePercent} % — только с проигравших ставок. Нет итога неделю после
        закрытия — ставки вернутся.
      </p>
      {fieldText && (
        <p className="wh-err" role="alert">
          {fieldText}
        </p>
      )}
      {err && (
        <p className="wh-err" role="alert">
          {err}
        </p>
      )}
      <button type="button" className="ew-btn ew-btn-main wh-place" disabled={busy} onClick={() => void submit()}>
        Начать приём ставок
      </button>
    </div>
  );
}
