import { useEffect, useRef, useState, type ReactNode } from 'react';
import {
  DUEL_MOVE_MS,
  DUEL_REMATCH_PAUSE_MS,
  DUEL_ROLL_ANIM_MS,
  DUEL_ROLL_TURN_MS,
  GREEDY_MAX_TIMEOUTS,
  GREEDY_TARGET,
  RPS_WINS,
  type DuelDto,
  type DuelGame,
  type RpsHand,
} from '@gusvoice/shared';
import { api } from '../api';
import { isMockEconomy } from '../benchMock';
import coinDefaultIcon from '../assets/guscoin.svg';
import judgeUrl from '../assets/duel/judge.png';
import {
  duelChallengeErrorText,
  duelGameKnown,
  duelGameTitle,
  duelLeftMs,
  duelPot,
  duelReasonText,
  duelSideOf,
  duelTimeoutNote,
  greedyProgress,
  hasRolled,
  rematchLeftMs,
  RPS_HAND_INFO,
  rpsLastRound,
  shownMyHand,
  verifyDuel,
  verifyGreedy,
  verifyTwentyOne,
  type DuelSide,
  type DuelVerdict,
  type DuelView,
  type GreedyVerdict,
} from '../duelRules';
import {
  PRACTICE_CAPTAIN_ID,
  practiceMove,
  practiceNextAt,
  practiceResultText,
  practiceShownDuel,
  practiceStart,
  practiceTick,
} from '../duelPractice';
import { ensureDuel } from '../economyClient';
import { usePhoneLayout } from '../phoneLayout';
import { playSound } from '../sounds';
import { useStore } from '../store';
import { clockLabel } from '../wheelRules';
import { Die, Duelist } from './DuelArt';
import { BottomSheet } from './BottomSheet';
import { applyDuelReply, CountRing, duelFailText, useDuelPeople, useNowTick } from './Duel';
import { Icon } from './Icon';
import { GameRules } from './GameRules';
import { TwentyOneBoard } from './TwentyOneBoard';
import { DiceBoard } from './DiceBoard';

/**
 * Сцена «Гусиная дуэль» (ГусКоины 2, этап 3 — кубики; этап 4 — «Камень-ножницы-бумага» `RpsBoard` и «Жадный гусь»
 * `GreedyBoard`, ходы — `POST …/move` с `seq`) — грузится лениво (`Activities.tsx`), вместе с ней и судья
 * (зелёный попугай `assets/duel/judge.png`, арт R323/R324 P2).
 *
 * ПК — `.modal-overlay > .modal.duel-scene`, телефон (≤ 760) — `BottomSheet page`; разметка одна.
 * Кубики — CSS 3D: куб из шести граней с точками (`PIP_CELLS`), к зрителю — грань `DIE_FACE_ROT[v]`. Свежий бросок
 * (кости стороны только что раскрылись) кувыркается `DUEL_ROLL_ANIM_MS` обёрткой `.dc-tumble` (целые обороты — конец
 * анимации совпадает с покоем), `prefers-reduced-motion` — без кувырка, сразу грань. Кости, раскрытые до открытия сцены,
 * стоят молча.
 */

/**
 * Дуэлянт — гусь-пират с саблей (`assets/duel/duelist.png`, 380×384, смотрит вправо, красный кушак), арт ГусКоинов 2.
 * Вызвавший — слева как нарисован; соперник — справа, отражён (`scaleX(-1)`) и с кушаком другого цвета: поверх лежит
 * слой «только кушак» (`assets/duel/duelist-sash.png`, вырезан из арта по цвету) с `hue-rotate` — крылья, клюв и лапы не перекрашиваются. Аватар игрока —
 * значок в рамке у нижнего внешнего угла. Победитель подпрыгивает, проигравший поникает (`prefers-reduced-motion` —
 * статично). Картинка — динамическим `import()` один раз на модуль: граница импортов сцены в проверках закрыта,
 * а нарисованного места (`aspect-ratio`) хватает, чтобы вёрстка не прыгнула, когда картинка придёт.
 */
/**
 * «Тренировка с капитаном» (`practice` — игра): партия с ботом без ставки целиком на клиенте (`duelPractice.ts`). Сцена
 * та же — доски рисуют `PracticeState.duel`, ходы идут в локальный движок вместо `POST`, капитан и сроки — по таймеру
 * `practiceNextAt`. Ни стора дуэлей, ни снимков сервера, ни денег. Закрыл сцену — тренировка кончилась.
 */
function usePractice(game: DuelGame | undefined, meId: string | null) {
  const [session, setSession] = useState(() => ({
    trainer: game ? practiceStart(game, meId ?? 'me', Date.now()) : null,
    round: 1,
    played: false,
    nextIn: 4,
    score: { me: 0, captain: 0, draws: 0 },
  }));
  const { trainer, round, played, nextIn, score } = session;
  const [paused, setPaused] = useState(false);
  const [hidden, setHidden] = useState(() => document.hidden);
  useEffect(() => {
    if (!game) return;
    const changed = () => setHidden(document.hidden);
    document.addEventListener('visibilitychange', changed);
    return () => document.removeEventListener('visibilitychange', changed);
  }, [game]);
  useEffect(() => {
    if (!trainer) return;
    const at = practiceNextAt(trainer);
    if (at === null) return;
    const wake = window.setTimeout(() => setSession((cur) => {
      if (!cur.trainer) return cur;
      const next = practiceTick(cur.trainer, Date.now());
      const ended = cur.trainer.duel.state !== 'settled' && next.duel.state === 'settled';
      const win = next.duel.winnerId;
      return { ...cur, trainer: next, score: ended ? {
        me: cur.score.me + Number(win === next.duel.challengerId),
        captain: cur.score.captain + Number(win === PRACTICE_CAPTAIN_ID),
        draws: cur.score.draws + Number(!win),
      } : cur.score };
    }), Math.max(0, at - Date.now()) + 20);
    return () => window.clearTimeout(wake);
  }, [trainer]);
  const again = () => game && setSession((cur) => ({
    ...cur, trainer: practiceStart(game, meId ?? 'me', Date.now()), round: cur.round + 1, played: false, nextIn: 4,
  }));
  useEffect(() => {
    // Только между партиями: скрытая вкладка и отсутствие ходов не запускают бесконечную игру капитана с судьёй.
    if (!game || trainer?.duel.state !== 'settled' || !played || paused || hidden) return;
    const wake = window.setTimeout(() => {
      if (document.hidden) return;
      if (nextIn <= 1) again();
      else setSession((cur) => ({ ...cur, nextIn: cur.nextIn - 1 }));
    }, 1000);
    return () => window.clearTimeout(wake);
  }, [game, trainer, played, paused, hidden, nextIn]);
  return {
    trainer, round, played, nextIn, paused, score,
    togglePause: () => setPaused((value) => !value),
    pause: () => setPaused(true),
    move: (m: RpsHand | 'roll' | 'stop') => setSession((cur) => {
      const next = cur.trainer && practiceMove(cur.trainer, m, Date.now());
      return next ? { ...cur, trainer: next, played: true } : cur;
    }),
    again,
  };
}

/** Готовность принадлежит открытой сцене, а не фоновому сокету или аккаунту целиком. */
function useDuelSeries(serverId: string, channelId: string, duel: DuelDto | null, enabled: boolean) {
  const [paused, setPaused] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [leaving, setLeaving] = useState(false);
  const clientId = useRef<string | null>(null);
  const current = useRef(duel);
  current.current = duel;
  const seriesId = duel?.series?.id;
  const active = !!seriesId && duel?.series?.status !== 'offered' && duel?.series?.status !== 'stopped';
  useEffect(() => { setPaused(false); setError(null); setLeaving(false); }, [seriesId]);
  const apply = (reply: { duel: DuelDto | null; serverNow: string }, requested: DuelDto) => {
    if (!reply.duel) return;
    const latest = useStore.getState().duels[channelId]?.duel;
    // Ответ heartbeat не должен возвращать руки/счёт к снимку, прочитанному до параллельного хода.
    if (latest && latest !== requested && (reply.duel.series?.round ?? 0) <= (latest.series?.round ?? 0)) return;
    applyDuelReply(serverId, { ...reply, duel: reply.duel });
  };
  useEffect(() => {
    if (!active || !enabled || paused || leaving) return;
    clientId.current ??= crypto.randomUUID();
    let alive = true, sending = false;
    let timer: number | undefined;
    const pulse = async () => {
      if (!alive || sending) return;
      const requested = current.current;
      if (!requested || requested.series?.id !== seriesId || requested.series.status === 'stopped') return;
      if (timer !== undefined) window.clearTimeout(timer);
      if (document.hidden) return;
      sending = true;
      try {
        const reply = await api.duelSeriesPulse(serverId, requested.id, {
          clientId: clientId.current!, roundId: requested.id, visible: true, ready: true,
        });
        if (alive) { apply(reply, requested); setError(null); }
      } catch {
        // Ошибка не доказывает готовность. Серверная аренда истечёт; снимок восстановит текущую партию.
        if (alive) { setError('Связь с серией прервалась. Следующая партия ждёт подтверждения связи обоих игроков.'); ensureDuel(serverId, channelId, true); }
      } finally {
        sending = false;
        if (alive) timer = window.setTimeout(() => void pulse(), 2000);
      }
    };
    const pauseOnServer = () => {
      const d = current.current;
      if (d?.series?.id === seriesId) void api.duelSeriesControl(serverId, d.id, 'pause').catch(() => {});
    };
    const visibility = () => {
      if (document.hidden) pauseOnServer();
      else void pulse();
    };
    document.addEventListener('visibilitychange', visibility);
    void pulse();
    return () => {
      alive = false;
      if (timer !== undefined) window.clearTimeout(timer);
      document.removeEventListener('visibilitychange', visibility);
      pauseOnServer();
    };
  }, [serverId, channelId, seriesId, active, enabled, paused, leaving]);
  async function control(action: 'pause' | 'stop') {
    const requested = current.current;
    if (!requested?.series) return true;
    if (action === 'pause') setPaused(true);
    else setLeaving(true);
    try {
      const reply = await api.duelSeriesControl(serverId, requested.id, action);
      if (reply.duel) applyDuelReply(serverId, { ...reply, duel: reply.duel });
      setError(null);
      return true;
    } catch {
      setError('Не удалось подтвердить остановку. Повтори выход — продолжение приостановлено.');
      return false;
    }
  }
  return { paused, leaving, error, active, control, resume: () => { setPaused(false); setLeaving(false); } };
}

export default function DuelScene({
  serverId,
  channelId,
  practice,
  onClose,
  onBack,
  onModeChange,
}: {
  serverId: string;
  channelId: string;
  /** Тренировка с капитаном в этой игре (без ставки, на клиенте); нет — настоящая партия канала. */
  practice?: DuelGame;
  onClose: () => void;
  onBack: () => void;
  onModeChange?: (practice: boolean) => void;
}) {
  const phone = usePhoneLayout();
  const storeView = useStore((s) => s.duels[channelId]);
  const meId = useStore((s) => s.user?.id ?? null);
  const iconUrl = useStore((s) => s.economy[serverId]?.iconUrl ?? null);
  const inChannel = useStore((s) => s.voice?.channelId === channelId);
  const channelPeople = useDuelPeople(channelId);
  const now = useNowTick(250);
  const training = usePractice(practice, meId);
  const trainer = training.trainer;
  const view: DuelView | null | undefined = trainer ? { duel: practiceShownDuel(trainer), skewMs: 0, myHand: trainer.myHand } : storeView;
  const people: People = trainer
    ? (id) => (id === PRACTICE_CAPTAIN_ID ? { name: 'Капитан', avatar: null } : channelPeople(id))
    : channelPeople;

  // Снимок заново при открытии и возврате фокуса: событие одним пушем могло потеряться.
  useEffect(() => {
    if (practice || isMockEconomy()) return;
    ensureDuel(serverId, channelId, true);
    const onFocus = () => ensureDuel(serverId, channelId, true);
    window.addEventListener('focus', onFocus);
    return () => window.removeEventListener('focus', onFocus);
  }, [serverId, channelId]);

  const d: DuelDto | null = view?.duel ?? null;
  const skew = view?.skewMs ?? 0;
  const mySide = d ? duelSideOf(d, meId) : null;
  const series = useDuelSeries(serverId, channelId, trainer ? null : d, !!mySide && inChannel);
  async function leave(next: () => void) {
    if (mySide && d?.series && d.series.status !== 'stopped' && !(await series.control('stop'))) return;
    next();
  }
  useEffect(() => {
    if (phone) return; // у листа свой Esc
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') void leave(onClose);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [phone, onClose, series.active, mySide, d?.series?.id]);

  // ——— Итог: победа — победителю, поражение — проигравшему (30.10), при открытой сцене (закрытая — `sockets.ts`). ———
  const settledSeen = useRef<string | null>(d?.state === 'settled' ? d.id : null);
  useEffect(() => {
    if (!d || d.state !== 'settled' || settledSeen.current === d.id) return;
    settledSeen.current = d.id;
    if (d.winnerId && d.winnerId === meId && !useStore.getState().selfDeafened) playSound('duelWin');
    else if (d.winnerId && meId && (d.challengerId === meId || d.targetId === meId) && !useStore.getState().selfDeafened) playSound('duelLose');
  }, [d, meId]);

  const [busy, setBusy] = useState(false);
  const requestInFlight = useRef(false);
  const [err, setErr] = useState<string | null>(null);
  async function act(action: 'roll' | 'withdraw') {
    if (!d || requestInFlight.current) return;
    if (trainer) {
      if (action === 'roll') training.move('roll');
      return;
    }
    requestInFlight.current = true;
    setBusy(true);
    setErr(null);
    try {
      applyDuelReply(serverId, await api.duelAction(serverId, d.id, action, action === 'roll' ? d.rollNo : undefined));
    } catch (e) {
      setErr(duelFailText(e));
      ensureDuel(serverId, channelId, true);
    } finally {
      requestInFlight.current = false;
      setBusy(false);
    }
  }
  /** Ход игры с выбором (этап 4): `seq` текущего раунда/действия; ответ несёт свою руку КНБ (`myHand`). */
  async function move(m: RpsHand | 'roll' | 'stop') {
    if (!d || requestInFlight.current) return;
    if (trainer) {
      training.move(m);
      return;
    }
    const seq = d.game === 'rps' ? d.rps?.seq : d.game === 'twentyone' ? d.twentyOne?.seq : d.greedy?.seq;
    if (seq === undefined) return;
    requestInFlight.current = true;
    setBusy(true);
    setErr(null);
    try {
      applyDuelReply(serverId, await api.duelMove(serverId, d.id, seq, m));
    } catch (e) {
      setErr(duelFailText(e));
      ensureDuel(serverId, channelId, true);
    } finally {
      requestInFlight.current = false;
      setBusy(false);
    }
  }
  async function rematch() {
    if (!d || !mySide || requestInFlight.current) return;
    requestInFlight.current = true;
    setBusy(true);
    setErr(null);
    try {
      const rival = mySide === 'challenger' ? d.targetId : d.challengerId;
      applyDuelReply(serverId, await api.challengeDuel(serverId, { channelId, targetId: rival, game: d.game, amount: d.amount }));
    } catch (e) {
      const er = e as Error & { reason?: string };
      setErr(duelChallengeErrorText(er?.reason ?? er?.message, d.game));
    } finally {
      requestInFlight.current = false;
      setBusy(false);
    }
  }

  const coin = <img src={iconUrl || coinDefaultIcon} alt="" className="wh-coin" />;

  // ——— Подпись состояния ———
  let status: { big: string; small: string; live?: boolean } = { big: '…', small: 'Судья раскладывает кубики' };
  if (view === null) status = { big: 'Тихо', small: 'Сейчас в канале дуэли нет' };
  else if (d?.state === 'invited') {
    const left = duelLeftMs(d.inviteUntil, skew, now);
    status = { big: clockLabel(left), small: mySide === 'challenger' ? 'ждём ответа…' : 'вызов ждёт ответа', live: true };
  } else if (d?.state === 'playing' && !duelGameKnown(d.game)) {
    status = { big: 'Идёт', small: 'эту игру твоя версия не показывает — обнови приложение', live: true };
  } else if (d?.state === 'playing' && d.game === 'rps') {
    const left = duelLeftMs(d.moveUntil ?? null, skew, now);
    status = {
      big: d.moveUntil ? clockLabel(left) : 'Раз, два, три!',
      small: `Партия до ${RPS_WINS} побед в раундах`,
      live: true,
    };
  } else if (d?.state === 'playing' && d.game === 'twentyone') {
    const left = duelLeftMs(d.moveUntil ?? null, skew, now);
    status = { big: d.moveUntil ? clockLabel(left) : 'Сравниваем',
      small: d.twentyOne?.finished ? 'обе попытки завершены — судья сравнивает очки' : d.twentyOne?.turn === mySide
        ? 'твой ход — ещё кубик или «Стоп»' : 'соперник решает', live: true };
  } else if (d?.state === 'playing' && d.game === 'greedy') {
    const left = duelLeftMs(d.moveUntil ?? null, skew, now);
    const turn = d.greedy?.turn;
    const turnId = turn === 'target' ? d.targetId : d.challengerId;
    status = {
      big: d.moveUntil ? clockLabel(left) : 'Хватит!',
      small: turn && turn === mySide ? 'твой ход — бросай или «Стоп»' : `ходит ${people(turnId).name}`,
      live: true,
    };
  } else if (d?.state === 'playing') {
    const left = duelLeftMs(d.turnUntil, skew, now);
    const both = hasRolled(d, 'challenger') && hasRolled(d, 'target');
    const none = !hasRolled(d, 'challenger') && !hasRolled(d, 'target');
    status = both
      ? { big: 'Бросок!', small: 'судья считает точки', live: true }
      : d.rollNo > 0 && none
        ? { big: clockLabel(left), small: `Бросок ${d.rollNo + 1} · до ${d.diceTarget ?? 1} побед`, live: true }
        : { big: clockLabel(left), small: 'на бросок — не успел, бросит судья', live: true };
  } else if (d?.state === 'settled' && trainer) {
    const loserId = d.winnerId ? (d.winnerId === d.challengerId ? d.targetId : d.challengerId) : null;
    status = d.winnerId
      ? { big: 'Итог', small: (loserId && duelTimeoutNote(d, people(loserId).name)) || 'судья поднял флажок' }
      : { big: 'Ничья', small: d.reason === 'draw-limit' ? 'победителя нет — сыграйте ещё раз' : 'судья развёл руками' };
  } else if (d?.state === 'settled') {
    const loserId = d.winnerId ? (d.winnerId === d.challengerId ? d.targetId : d.challengerId) : null;
    status = d.winnerId
      ? { big: 'Итог', small: (loserId && duelTimeoutNote(d, people(loserId).name)) || 'судья поднял флажок' }
      : { big: 'Ничья', small: duelReasonText(d.reason, d.game) };
  } else if (d?.state === 'cancelled') status = { big: 'Отбой', small: duelReasonText(d.reason, d.game) };

  const winnerName = d?.winnerId ? people(d.winnerId).name : null;
  const rematchLeft = d ? rematchLeftMs(d, skew, now, DUEL_REMATCH_PAUSE_MS) : 0;
  const pot = d ? duelPot(d.amount, d.feePercent) : null;

  const body = (
    <div className="dc-body">
      <div className="dc-toolbar">
        <span className="dc-mode-label">{trainer ? 'Тренировка · без ставки' : d ? `Ставка ${d.amount} с каждого` : 'Гусиная дуэль'}</span>
        {d && duelGameKnown(d.game) && <GameRules game={d.game} onOpen={() => trainer ? training.pause() : series.active && void series.control('pause')}>
      {d && pot && !trainer && (
        <p className="wh-hint">
          Ставка {d.amount} с каждого · банк {pot.pot} · комиссия {d.feePercent} % сгорает · победитель получит {pot.payout}
        </p>
      )}

      {d && d.game !== 'rps' && !trainer && (
        <p className="wh-commit" title={d.commit}>
          Замок партии: <code>{d.commit.length > 16 ? `${d.commit.slice(0, 8)}…${d.commit.slice(-8)}` : d.commit}</code> —{' '}
          {d.game === 'greedy' ? 'кто ходит первым и все броски загаданы' : 'кости загаданы'} до принятия вызова
        </p>
      )}
      {d?.game === 'rps' && !trainer && (
        <p className="wh-commit">
          Здесь нет случая — проверять нечего: руки тайные, пока не сходят оба, и открываются разом. Свою руку видишь только ты.
        </p>
      )}
      {d?.state === 'settled' && d.seed && d.game === 'dice' && <DuelFairCheck key={d.id} duel={d} />}
      {d?.state === 'settled' && d.seed && d.game === 'greedy' && d.greedy && <GreedyFairCheck key={d.id} duel={d} />}
      {d?.state === 'settled' && d.seed && d.game === 'twentyone' && d.twentyOne && <GreedyFairCheck key={d.id} duel={d} />}
{d?.game === 'dice' && <ol className="dice-history" aria-label="История бросков">{d.rolls.map((r, i) => {
        if (!r.challenger || !r.target) return null;
        const a = r.challenger[0] + r.challenger[1], b = r.target[0] + r.target[1];
        return <li key={i}>Бросок {i + 1}: {a} : {b} — {a === b ? 'ничья' : `победил ${people(a > b ? d.challengerId : d.targetId).name}`}</li>;
      })}</ol>}
{d?.rps && d.rps.rounds.length > 0 && <ol className="rps-rounds" aria-label="Раунды">{d.rps.rounds.map((r, i) => <li key={i}><span>#{i + 1}</span>{RPS_HAND_INFO[r.challenger].emoji}<span>:</span>{RPS_HAND_INFO[r.target].emoji}<span>{!r.winner ? 'ничья' : people(r.winner === 'challenger' ? d.challengerId : d.targetId).name}</span></li>)}</ol>}
        </GameRules>}
      </div>
      <div className="dc-sessionbar">
        <span className="duel-round-label">{trainer ? `${d?.game === 'rps' || d?.game === 'dice' ? 'Партия' : 'Раунд'} ${training.round}${d?.state === 'settled' ? d.game === 'rps' || d.game === 'dice' ? ' завершена' : ' завершён' : ''}` : d?.series ? `Серия · партия ${d.series.round}` : 'Партия'}</span>
        {(trainer || d?.series) && <div className="duel-session-score" aria-label={trainer ? 'Счёт тренировки' : 'Счёт серии'}>
          <span title={d ? people(d.challengerId).name : ''}>{trainer ? 'Ты' : d ? people(d.challengerId).name : ''} <b>{trainer ? training.score.me : d?.series?.score.challenger}</b></span>
          <span className="wh-hint">Ничьи: {trainer ? training.score.draws : d?.series?.score.draws}</span>
          <span title={d ? people(d.targetId).name : ''}><b>{trainer ? training.score.captain : d?.series?.score.target}</b> {trainer ? 'Капитан' : d ? people(d.targetId).name : ''}</span>
        </div>}
      </div>
      <div className="dc-playfield">
      {d?.game !== 'dice' && <div className={`wh-timer${status.live ? ' live' : ''}`} aria-live="polite">
        <span className="wh-timer-big">{status.big}</span>
        <span className="wh-timer-small">{status.small}</span>
      </div>}

      {d && d.game === 'rps' && d.rps && (
        <RpsBoard view={view!} mySide={mySide} people={people} now={now} busy={busy} phone={phone} coin={coin} onMove={(m) => void move(m)} />
      )}
      {d && d.game === 'greedy' && d.greedy && (
        <GreedyBoard
          duel={d}
          skew={skew}
          mySide={mySide}
          people={people}
          now={now}
          busy={busy}
          phone={phone}
          coin={coin}
          autoBy={trainer ? 'судья' : 'капитан'}
          onMove={(m) => void move(m)}
        />
      )}
      {d?.game === 'twentyone' && d.twentyOne && (
        <TwentyOneBoard duel={d} mySide={mySide} people={people} phone={phone} busy={busy} onMove={(m) => void move(m)} />
      )}
      {d?.game === 'dice' && <DiceBoard duel={d} mySide={mySide} people={people} phone={phone} busy={busy} now={now} skew={skew} stateNote={status.small} onRoll={() => void act('roll')} />}
      </div>
      <div className="dc-summary">
      {d?.state === 'settled' && winnerName && d.payout !== null && (
        <p className="wh-result">
          <span className="wh-result-head">
            <b>{d.winnerId === meId ? 'Ты' : winnerName}</b> {d.winnerId === meId ? 'забираешь' : 'забирает'} {d.payout}
            {coin}
          </span>
        </p>
      )}
      {trainer && d?.state === 'settled' && (
        <p className="wh-result duel-practice-result">
          <span className="wh-result-head">
            <b>{practiceResultText(d)}</b>
          </span>
        </p>
      )}
      {d?.series && d.series.status !== 'offered' && (
        <p className="wh-hint duel-series-status" role="status">
          {d.series.status === 'stopped' ? d.series.stopReason === 'idle'
            ? 'Серия завершена после пропуска · счёт сохранён.' : 'Серия завершена. Счёт сохранён.'
            : series.paused || d.series.status === 'paused' ? 'Пауза · ждём готовности обоих игроков.'
              : d.state === 'settled' && d.series.nextAt ? `Следующая партия через ${Math.ceil(duelLeftMs(d.series.nextAt, skew, now) / 1000)} с`
                : d.state === 'settled' ? 'Ждём готовности обоих игроков к следующей партии.' : 'Серия · следующая партия после итога.'}
        </p>
      )}

      {trainer && d?.state === 'settled' && (
        <p className="wh-hint duel-next-round" role="status">
          {!training.played ? 'Ты не ходил — продолжим, когда будешь готов.' : training.paused
            ? 'Пауза между раундами.' : `Следующий раунд через ${training.nextIn} с`}
        </p>
      )}
      {err && (
        <p className="wh-err" role="alert">
          {err}
        </p>
      )}
      {series.error && <p className="wh-err" role="alert">{series.error}</p>}

      </div>
      {/* Постоянный выход и действия между раундами прижаты к низу рамки. */}
      <div className="game-actions">
        {d?.state === 'invited' && mySide === 'challenger' && (
          <button type="button" className="ew-btn" disabled={busy} onClick={() => void act('withdraw')}>
            Отозвать вызов
          </button>
        )}
        {(
          <button type="button" className="ew-btn game-actions-back" onClick={() => void leave(onBack)}>
            К выбору игр
          </button>
        )}
        {trainer && (
          <button type="button" className="ew-btn ew-btn-main game-actions-main" disabled={d?.state !== 'settled'} onClick={() => training.again()}>
            Следующий раунд
          </button>
        )}
        {trainer && (
          <button type="button" className={`ew-btn dc-pause-button${training.paused ? ' paused' : ''}`} aria-label={training.paused ? 'Продолжить' : 'Пауза'} title={training.paused ? 'Продолжить' : 'Пауза'} aria-pressed={training.paused} onClick={training.togglePause}>
            <span className="dc-pause-copy">{training.paused ? 'Продолжить' : 'Пауза'}</span>
          </button>
        )}
        {series.active && mySide && inChannel && (
          <button type="button" className="ew-btn" aria-pressed={series.paused} onClick={() => series.paused ? series.resume() : void series.control('pause')}>
            {series.paused ? 'Продолжить серию' : 'Пауза серии'}
          </button>
        )}
        {!trainer && !series.active && mySide && inChannel && (
          <button type="button" className="ew-btn ew-btn-main game-actions-main" disabled={busy || (d?.state !== 'settled' && d?.state !== 'cancelled') || rematchLeft > 0} onClick={() => void rematch()}>
            {(d?.state === 'settled' || d?.state === 'cancelled') && rematchLeft > 0 ? `Реванш через ${Math.ceil(rematchLeft / 1000)} с` : 'Реванш'}
          </button>
        )}
      </div>
    </div>
  );

  if (phone) {
    return (
      <BottomSheet page title={`${duelGameTitle(d?.game ?? 'dice')} · ${trainer ? 'С капитаном' : 'Гусиная дуэль'}`} onClose={() => void leave(onClose)} onBack={() => void leave(onBack)}>
        {body}
      </BottomSheet>
    );
  }
  return (
    <div className="modal-overlay" onClick={() => void leave(onClose)}>
      <section className="modal eco-welcome game-frame duel-scene" role="dialog" aria-modal="true" aria-labelledby="dc-title" onClick={(e) => e.stopPropagation()}>
        <div className="ew-head dc-header">
          <h2 id="dc-title" className="ew-title">{duelGameTitle(d?.game ?? 'dice')}<small>{trainer ? 'Тренировка с капитаном' : 'Гусиная дуэль'}</small></h2>
          <button type="button" className="icon-close" title="Закрыть" onClick={() => void leave(onClose)}><Icon name="close" size={18} /></button>
        </div>
        {body}
      </section>
    </div>
  );
}

/** «Проверить честность»: зерно открыто после итога — пересчитываем замок и кости каждого броска у себя. */
function DuelFairCheck({ duel }: { duel: DuelDto }) {
  const [verdict, setVerdict] = useState<DuelVerdict | null>(null);
  const [busy, setBusy] = useState(false);
  return (
    <details className="wh-fair">
      <summary>Проверить честность</summary>
      <p className="wh-fair-text">
        Зерно партии загадано до принятия вызова, а его замок (хеш) виден с самого начала. После итога зерно открыто — из него
        считаются и замок, и все кости по порядку бросков. Проверка идёт прямо здесь, у тебя.
      </p>
      <dl className="wh-fair-kv">
        <dt>Замок</dt>
        <dd>
          <code>{duel.commit}</code>
        </dd>
        <dt>Зерно</dt>
        <dd>
          <code>{duel.seed}</code>
        </dd>
        <dt>Броски</dt>
        <dd>
          {duel.rolls
            .map((r) => `${r.challenger ? r.challenger.join('+') : '?'} : ${r.target ? r.target.join('+') : '?'}`)
            .join(' · ')}
        </dd>
      </dl>
      <div className="wh-fair-row">
        <button
          type="button"
          className="ew-btn"
          disabled={busy}
          onClick={() => {
            setBusy(true);
            void verifyDuel(duel)
              .then(setVerdict)
              .catch(() => setVerdict({ ok: false, why: 'unavailable' }))
              .finally(() => setBusy(false));
          }}
        >
          Проверить
        </button>
        {verdict && (
          <span className={`wh-verdict${verdict.ok ? ' ok' : ' bad'}`} role="status">
            {verdict.ok
              ? '✓ Совпадает: зерно открывает замок, и кости те самые'
              : verdict.why === 'unavailable'
                ? 'Браузер здесь не умеет считать хеш (нужно защищённое соединение)'
                : verdict.why === 'commit'
                  ? '✗ Зерно не открывает замок партии'
                  : verdict.why === 'no-seed'
                    ? 'Зерно ещё не открыто'
                    : `✗ В броске №${(verdict.at ?? 0) + 1} по зерну выходит ${verdict.got?.slice(0, 2).join('+')} : ${verdict.got?.slice(2).join('+')}`}
          </span>
        )}
      </div>
    </details>
  );
}

type People = (id: string) => { name: string; avatar: string | null };

/**
 * Свежее событие партии (новый раунд КНБ / новый бросок гуся): номер держится `ms`, открытое до сцены — не свежее.
 * `onFresh` может вернуть уборку — она снимается вместе с таймером (закрыли сцену или пришло следующее событие).
 */
function useFresh(key: string, count: number, ms: number, onFresh: () => void | (() => void)): number | null {
  const seen = useRef<{ key: string; n: number } | null>(null);
  const [fresh, setFresh] = useState<number | null>(null);
  const cb = useRef(onFresh);
  cb.current = onFresh;
  useEffect(() => {
    if (!seen.current || seen.current.key !== key) {
      seen.current = { key, n: count };
      setFresh(null);
      return;
    }
    if (count <= seen.current.n) return;
    seen.current.n = count;
    setFresh(count);
    const undo = cb.current();
    const t = window.setTimeout(() => setFresh((f) => (f === count ? null : f)), ms);
    if (undo) {
      return () => {
        window.clearTimeout(t);
        undo();
      };
    }
    return () => window.clearTimeout(t);
  }, [key, count, ms]);
  return fresh;
}

/** Сколько держится раскрытие рук КНБ ярко (потом прошлый раунд тускнеет, как старые кости). */
const RPS_REVEAL_MS = 2_500;

/**
 * «Камень-ножницы-бумага» (этап 4): два игрока, счёт до `RPS_WINS` между ними, руки последнего раунда. Ход скрыт:
 * у соперника до раскрытия — только «готов», своя рука — из личного ответа (`myHand`). Новый раунд в `rps.rounds` —
 * обе руки открываются разом (`.rps-hand.reveal`, без движения при `prefers-reduced-motion`) и звук `rpsReveal`.
 */
function RpsBoard({
  view,
  mySide,
  people,
  now,
  busy,
  phone,
  coin,
  onMove,
}: {
  view: DuelView;
  mySide: DuelSide | null;
  people: People;
  now: number;
  busy: boolean;
  phone: boolean;
  coin: ReactNode;
  onMove: (m: RpsHand) => void;
}) {
  const d = view.duel;
  const rps = d.rps!;
  const playing = d.state === 'playing';
  const last = rpsLastRound(d);
  const myHand = shownMyHand(view);
  const fresh = useFresh(d.id, rps.rounds.length, RPS_REVEAL_MS, () => {
    if (!useStore.getState().selfDeafened) playSound('rpsReveal');
  });
  const revealing = fresh !== null;
  const left = duelLeftMs(d.moveUntil ?? null, view.skewMs, now);

  const player = (side: DuelSide) => {
    const id = side === 'challenger' ? d.challengerId : d.targetId;
    const who = people(id);
    const mine = side === mySide;
    const ready = playing && rps.ready[side];
    const won = d.state === 'settled' && d.winnerId === id;
    const lost = d.state === 'settled' && !!d.winnerId && d.winnerId !== id;
    // На столе: своя выбранная рука текущего раунда, иначе рука последнего раскрытого (в идущей партии после раскрытия —
    // тускло), иначе «?» (соперник сходил — «✓»).
    let hand: RpsHand | null = null;
    let look: 'picked' | 'reveal' | 'stale' | '' = '';
    if (mine && ready && myHand && !revealing) {
      hand = myHand;
      look = 'picked';
    } else if (last && !(ready && !revealing)) {
      hand = last[side];
      look = revealing ? 'reveal' : playing ? 'stale' : '';
    }
    const roundWon = revealing && last?.winner === side;
    return (
      <div className={`dc-player rps-player${mine ? ' me' : ''}${won ? ' won' : ''}${lost ? ' lost' : ''}`}>
        <Duelist side={side} who={who} phone={phone} mine={mine} won={won} lost={lost} />
        <span className="dc-name" title={who.name}>{mine ? `${who.name} (ты)` : who.name}</span>
        <span className="rps-wins" aria-label={`побед: ${rps.wins[side]} из ${RPS_WINS}`}>
          {Array.from({ length: RPS_WINS }, (_, i) => (
            <i key={i} className={i < rps.wins[side] ? 'on' : ''} />
          ))}
        </span>
        <span
          key={look === 'reveal' ? `r${rps.rounds.length}` : 'h'}
          className={`rps-hand${hand ? '' : ' unknown'}${look ? ` ${look}` : ''}${roundWon ? ' round-won' : ''}`}
          aria-hidden="true"
        >
          {hand ? RPS_HAND_INFO[hand].emoji : ready ? '✓' : '?'}
        </span>
        <span className="rps-hand-label">{hand && look !== 'stale' ? RPS_HAND_INFO[hand].label : ' '}</span>
        <span className="dc-wait rps-ready">{playing && !revealing ? ready ? mine ? 'ход сделан' : 'соперник готов' : !mine ? 'думает…' : ' ' : ' '}</span>
      </div>
    );
  };

  const canPick = playing && !revealing && !!mySide && !rps.ready[mySide] && !!d.moveUntil;
  const roundResult = last?.winner
    ? last.winner === mySide ? 'Ты выиграл раунд' : `${people(last.winner === 'challenger' ? d.challengerId : d.targetId).name} выигрывает раунд`
    : 'Ничья — очки не меняются';
  return (
    <div className="dc-board rps-board">
      <div className={`rps-phase${revealing || !playing ? ' result' : ''}`} role="status">
        <b>{revealing ? `Раунд ${rps.rounds.length} завершён` : playing ? `Раунд ${rps.rounds.length + 1}` : 'Партия завершена'}</b>
        <span>{revealing ? `${roundResult}. Счёт партии ${rps.wins.challenger}:${rps.wins.target}.` : !playing
          ? `Итог партии ${rps.wins.challenger}:${rps.wins.target}` : !mySide ? 'Игроки выбирают руки'
            : rps.ready[mySide] ? 'Ход принят. Ждём соперника — руки откроются одновременно.' : 'Выбери руку. Один выбор на раунд.'}</span>
      </div>
      <div className="dc-arena">
        {player('challenger')}
        <div className="dc-judge">
          <img src={judgeUrl} alt="Судья — зелёный попугай" draggable={false} />
          <span className="rps-score" aria-label="Счёт партии">
            {rps.wins.challenger} : {rps.wins.target}
          </span>
          <span className="dc-vs">
            {revealing ? (last?.winner ? 'раунд взят' : 'ничья — ещё раз!') : playing ? `раунд ${rps.rounds.length + 1}` : `до ${RPS_WINS} побед`}
          </span>
        </div>
        {player('target')}
      </div>
      <div className="dc-turn-controls"><p className="dc-move-status" role="status">{revealing ? "Раунд завершён · следующий начнётся после раскрытия" : !playing ? "Партия завершена" : mySide && rps.ready[mySide] ? "Ход принят · ждём соперника" : "Выбери руку"}</p>
        <div className="rps-picks" role="group" aria-label="Твой ход">
          <CountRing leftMs={left} totalMs={DUEL_MOVE_MS} size={28} />
          {RPS_PICK_ORDER.map((h) => (
            <button key={h} type="button" className={`rps-pick${myHand === h && !!mySide && rps.ready[mySide] ? ' selected' : ''}`} aria-pressed={myHand === h && !!mySide && rps.ready[mySide]} disabled={busy || !canPick} onClick={() => onMove(h)}>
              <span className="rps-pick-emoji" aria-hidden="true">
                {RPS_HAND_INFO[h].emoji}
              </span>
              {RPS_HAND_INFO[h].label}
            </button>
          ))}
        </div>
      </div>
    </div>
  );
}

/** Кнопки хода КНБ — в привычном порядке названия игры. */
const RPS_PICK_ORDER: readonly RpsHand[] = ['rock', 'scissors', 'paper'];

/**
 * «Жадный гусь» (этап 4): счёт обоих к `GREEDY_TARGET` полосой (копилка хода — светлым продолжением у ходящего), чей ход
 * подсвечен, кубик последнего броска (кувырок `.dc-tumble` при свежем, стук `diceRoll`), «Сгорело N!» на единице,
 * «Бросить ещё / Стоп» с кольцом срока `moveUntil` в свой ход. Просрочки (`timeouts`) — «за тебя сходил капитан».
 */
function GreedyBoard({
  duel: d,
  skew,
  mySide,
  people,
  now,
  busy,
  phone,
  coin,
  autoBy = 'капитан',
  onMove,
}: {
  duel: DuelDto;
  skew: number;
  mySide: DuelSide | null;
  people: People;
  now: number;
  busy: boolean;
  phone: boolean;
  coin: ReactNode;
  /** Кто ходит за просрочившего (в тренировке капитан — соперник, за игрока ходит судья). */
  autoBy?: string;
  onMove: (m: 'roll' | 'stop') => void;
}) {
  const g = d.greedy!;
  const playing = d.state === 'playing';
  const fresh = useFresh(d.id, g.rolls.length, DUEL_ROLL_ANIM_MS, () => {
    if (!useStore.getState().selfDeafened) playSound('diceRoll');
    // Выпала «1» — копилка сгорает, когда кубик докатился (этап 7): звук в тот же миг, что и надпись о сгорании.
    // Таймер снимается уборкой `useFresh`: сцену закрыли раньше — звука после размонтирования нет.
    if (g.lastRoll?.die === 1) {
      const burn = window.setTimeout(() => {
        if (!useStore.getState().selfDeafened) playSound('greedyBurn');
      }, DUEL_ROLL_ANIM_MS);
      return () => window.clearTimeout(burn);
    }
    return undefined;
  });
  const rolling = fresh !== null;
  const left = duelLeftMs(d.moveUntil ?? null, skew, now);
  const die = g.lastRoll?.die ?? null;
  const burnedNow = g.lastRoll?.die === 1;
  const burnBy = g.lastRoll ? people(g.lastRoll.by === 'challenger' ? d.challengerId : d.targetId).name : '';
  // Счёт соперника скрыт до конца партии (29.10): маска `greedyHide` с сервера (в тренировке — `practiceShownDuel`).
  // Сторона, скрытая хоть раз в этой партии, после раскрытия получает `.gr-reveal` — полоса доезжает до счёта разово.
  const secret = (side: DuelSide) => g.hidden?.[side] === true;
  const wasHidden = useRef({ id: d.id, challenger: false, target: false });
  if (wasHidden.current.id !== d.id) wasHidden.current = { id: d.id, challenger: false, target: false };
  if (g.hidden?.challenger) wasHidden.current.challenger = true;
  if (g.hidden?.target) wasHidden.current.target = true;
  // «Забрал»: действие без броска сменило ход — это «Стоп» (свой, чужой или судьи). Сумму не показываем: у соперника её нет.
  const lastAct = useRef<{ id: string; seq: number; rolls: number; turn: DuelSide } | null>(null);
  const [stopped, setStopped] = useState<{ seq: number; by: DuelSide } | null>(null);
  useEffect(() => {
    const p = lastAct.current;
    lastAct.current = { id: d.id, seq: g.seq, rolls: g.rolls.length, turn: g.turn };
    if (p && p.id === d.id && g.seq === p.seq + 1 && g.rolls.length === p.rolls && g.turn !== p.turn) setStopped({ seq: g.seq, by: p.turn });
  }, [d.id, g.seq, g.rolls.length, g.turn]);
  const stopNow = playing && !burnedNow && stopped !== null && stopped.seq === g.seq;
  const stopName = stopped ? people(stopped.by === 'challenger' ? d.challengerId : d.targetId).name : '';

  const player = (side: DuelSide) => {
    const id = side === 'challenger' ? d.challengerId : d.targetId;
    const who = people(id);
    const mine = side === mySide;
    const turn = playing && g.turn === side;
    const won = d.state === 'settled' && d.winnerId === id;
    const lost = d.state === 'settled' && !!d.winnerId && d.winnerId !== id;
    const hide = secret(side);
    const revealed = !hide && wasHidden.current[side];
    const score = hide ? 0 : g.scores[side];
    const bank = turn && !hide ? g.turnPoints : 0;
    const auto = g.timeouts[side];
    const p0 = greedyProgress(score, GREEDY_TARGET);
    const p1 = greedyProgress(score + bank, GREEDY_TARGET);
    return (
      <div
        className={`dc-player gr-player${mine ? ' me' : ''}${turn ? ' turn' : ''}${won ? ' won' : ''}${lost ? ' lost' : ''}${hide ? ' secret' : ''}${revealed ? ' gr-reveal' : ''}`}
      >
        <Duelist side={side} who={who} phone={phone} mine={mine} won={won} lost={lost} />
        <span className="dc-name" title={who.name}>{mine ? `${who.name} (ты)` : who.name}</span>
        {hide ? (
          <span className="gr-score" title="Счёт скрыт до конца партии">
            ?<small>скрыт до конца</small>
          </span>
        ) : (
          <span className="gr-score">
            {score}
            {bank > 0 && <span className="gr-score-bank">+{bank}</span>}
            <small>очков · цель {GREEDY_TARGET}+</small>
          </span>
        )}
        <span className={`gr-bar${hide ? ' secret' : ''}`} aria-hidden="true">
          <i className="gr-bar-fill" style={{ width: `${p0 * 100}%` }} />
          {bank > 0 && <i className="gr-bar-bank" style={{ left: `${p0 * 100}%`, width: `${(p1 - p0) * 100}%` }} />}
        </span>
        {turn && <span className="dc-wait gr-turn">{mine ? 'твой ход' : 'ходит'}</span>}
        {playing && auto > 0 && (
          <span className="gr-auto" title={`Пропусков подряд: ${auto} из ${GREEDY_MAX_TIMEOUTS}`}>
            {mine ? `за тебя сходил ${autoBy}` : `за него сходил ${autoBy}`} · {auto}/{GREEDY_MAX_TIMEOUTS}
          </span>
        )}
      </div>
    );
  };

  const myTurn = playing && !!mySide && g.turn === mySide && !!d.moveUntil;
  const turnName = people(g.turn === 'challenger' ? d.challengerId : d.targetId).name;
  return (
    <div className="dc-board greedy-board">
      <div className="rps-phase"><b>{playing ? myTurn ? 'Твой ход' : 'Ход соперника' : 'Партия завершена'}</b><span>Цель {GREEDY_TARGET}+ · единица сжигает копилку хода</span></div>
      <div className="dc-arena">
        {player('challenger')}
        <div className="dc-judge">
          <img src={judgeUrl} alt="Судья — зелёный попугай" draggable={false} />
          <span className="dc-vs">Цель: {GREEDY_TARGET}+</span>
<div className="gr-table">
        <Die v={die} rolling={rolling} />
        {playing && (
          <span className="gr-bank">
            <small>Копилка хода</small>
            <b>{secret(g.turn) ? '?' : g.turnPoints}</b>
          </span>
        )}
        {burnedNow && !rolling && (
          <span key={g.rolls.length} className="gr-burn" role="status">
            {g.burned > 0 ? `Сгорело ${g.burned}!` : g.lastRoll && secret(g.lastRoll.by) ? 'Сгорело!' : 'Единица!'}
            <small>{g.burned > 0 || (g.lastRoll && secret(g.lastRoll.by)) ? `${burnBy} пожадничал — ход переходит` : 'ход переходит'}</small>
          </span>
        )}
        {stopNow && stopped && (
          <span key={`stop-${stopped.seq}`} className="gr-burn gr-stop" role="status">
            Забрал!
            <small>{stopped.by === mySide ? 'копилка в счёте — ход переходит' : `${stopName} остановился — ход переходит`}</small>
          </span>
        )}
      </div>
        </div>
        {player('target')}
      </div>
      <div className="dc-turn-controls"><p className="dc-move-status" role="status">{!playing ? "Партия завершена" : myTurn ? "Твой ход" : `Ходит ${turnName}`}</p>
        <div className="gr-actions">
          <button type="button" className="ew-btn ew-btn-main dc-roll" disabled={busy || !myTurn || rolling} onClick={() => onMove('roll')}>
            <CountRing leftMs={left} totalMs={DUEL_MOVE_MS} size={28} />
            {g.turnPoints > 0 ? 'Бросить ещё' : 'Бросить'}
          </button>
          <button type="button" className="ew-btn" disabled={busy || !myTurn || rolling || g.turnPoints <= 0} onClick={() => onMove('stop')}>
            {g.turnPoints > 0 ? `Стоп, забрать ${g.turnPoints}` : 'Стоп'}
          </button>
        </div>
      </div>
    </div>
  );
}

/** «Проверить честность» Жадного гуся: зерно → замок, кто ходит первым и каждый бросок по порядку — у себя. */
function GreedyFairCheck({ duel }: { duel: DuelDto }) {
  const [verdict, setVerdict] = useState<GreedyVerdict | null>(null);
  const [busy, setBusy] = useState(false);
  const g = duel.game === 'twentyone' ? duel.twentyOne! : duel.greedy!;
  return (
    <details className="wh-fair">
      <summary>Проверить честность</summary>
      <p className="wh-fair-text">
        Зерно партии загадано до принятия вызова, а его замок (хеш) виден с самого начала. После итога зерно открыто — из него
        считаются замок, кто ходит первым и каждый бросок по порядку. Проверка идёт прямо здесь, у тебя.
      </p>
      <dl className="wh-fair-kv">
        <dt>Замок</dt>
        <dd>
          <code>{duel.commit}</code>
        </dd>
        <dt>Зерно</dt>
        <dd>
          <code>{duel.seed}</code>
        </dd>
        <dt>Первым</dt>
        <dd>{g.first === 'challenger' ? 'вызвавший' : 'принявший вызов'}</dd>
        <dt>Броски</dt>
        <dd>{g.rolls.length > 0 ? g.rolls.map(r => typeof r === 'number' ? r : r.die).join(' · ') : 'не было'}</dd>
      </dl>
      <div className="wh-fair-row">
        <button
          type="button"
          className="ew-btn"
          disabled={busy}
          onClick={() => {
            setBusy(true);
            void (duel.game === 'twentyone' ? verifyTwentyOne(duel) : verifyGreedy(duel))
              .then(setVerdict)
              .catch(() => setVerdict({ ok: false, why: 'unavailable' }))
              .finally(() => setBusy(false));
          }}
        >
          Проверить
        </button>
        {verdict && (
          <span className={`wh-verdict${verdict.ok ? ' ok' : ' bad'}`} role="status">
            {verdict.ok
              ? '✓ Совпадает: зерно открывает замок, первый ход и броски те самые'
              : verdict.why === 'unavailable'
                ? 'Браузер здесь не умеет считать хеш (нужно защищённое соединение)'
                : verdict.why === 'commit'
                  ? '✗ Зерно не открывает замок партии'
                  : verdict.why === 'no-seed'
                    ? 'Зерно ещё не открыто'
                    : verdict.why === 'first'
                      ? '✗ По зерну первым ходил другой игрок'
                      : `✗ В броске №${(verdict.at ?? 0) + 1} по зерну выходит ${verdict.got}`}
          </span>
        )}
      </div>
    </details>
  );
}
