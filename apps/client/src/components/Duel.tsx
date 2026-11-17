import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { DUEL_GAMES, DUEL_INVITE_MS, DUEL_MOVE_MS, DUEL_ROLL_TURN_MS, FEATURE_DUEL2, GREEDY_MAX_TIMEOUTS, type DuelDto, type DuelGame, type RpsHand } from '@gusvoice/shared';
import { api } from '../api';
import coinDefaultIcon from '../assets/guscoin.svg';
import { DUEL_GAME_INFO, duelChallengeErrorText, duelErrorText, duelGameTitle, duelGameWord, duelLeftMs, duelLive, duelPot } from '../duelRules';
import { gamesView } from '../economy';
import { usePhoneLayout } from '../phoneLayout';
import { useStore } from '../store';
import { betPresets, clampBet } from '../wheelRules';
import { Avatar } from './Avatar';
import { BottomSheet } from './BottomSheet';
import { Icon } from './Icon';
import { GameRules } from './GameRules';

/**
 * Гусиная дуэль (ГусКoины 2, этап 3) — лёгкие части, которые живут вне сцены: форма вызова в «Активностях», карточка
 * входящего вызова, полоса партии в голосовом канале (`DuelCard`) и тост-полка игр. Сцена с кубиками и судьёй —
 * `DuelScene.tsx` (lazy, только она тянет арт). Подключаются через `Activities.tsx` (там же хост).
 */

/**
 * Ответ POST дуэли — тем же путём, что событие шлюза: стор не знает, откуда пришла партия. `myHand` (ответ на ход КНБ,
 * этап 4) — своя рука, её событие не несёт.
 */
export function applyDuelReply(serverId: string, r: { duel: DuelDto; serverNow: string; myHand?: RpsHand | null }): void {
  useStore
    .getState()
    .applyDuelEvent({ t: 'duel.state', serverId, channelId: r.duel.channelId, duel: r.duel, serverNow: r.serverNow }, r.myHand);
}

/** Код отказа: сервер кладёт его в `error` (→ `Error.message`), на будущее понимаем и `reason`. */
export function duelFailText(e: unknown): string {
  const er = e as Error & { reason?: string };
  return duelErrorText(er?.reason ?? er?.message);
}

/** Имя и аватар человека для дуэли: сначала из голосового канала, потом из списка участников сервера. */
export function useDuelPeople(channelId: string | null | undefined): (id: string) => { name: string; avatar: string | null } {
  const inChannel = useStore((s) => (channelId ? s.presence[channelId] : undefined));
  const members = useStore((s) => s.members);
  const me = useStore((s) => s.user);
  return useMemo(() => {
    return (id: string) => {
      const p = inChannel?.find((x) => x.userId === id);
      const m = members.find((x) => x.user.id === id);
      const name = m?.nickname || p?.displayName || m?.user.displayName || m?.user.username || (me?.id === id ? me.displayName : '') || 'Гусь';
      return { name, avatar: p?.avatarUrl ?? m?.user.avatarUrl ?? (me?.id === id ? (me.avatarUrl ?? null) : null) };
    };
  }, [inChannel, members, me]);
}

export function useNowTick(ms: number, on = true): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!on) return;
    const id = window.setInterval(() => setNow(Date.now()), ms);
    return () => window.clearInterval(id);
  }, [ms, on]);
  return now;
}

/** Потолок ставки: максимум сервера (снимок дуэли, иначе колеса, иначе настройки), баланс и остаток суточного предела. */
function useStakeCap(serverId: string): { betMax: number; balance: number; lossLeft: number | null; cap: number; feePercent: number } {
  const eco = useStore((s) => s.economy[serverId]);
  const limits = useStore((s) => s.duelLimits[serverId]);
  const wheelBetMax = useStore((s) => s.wheel[serverId]?.betMax);
  const games = eco ? gamesView(eco) : null;
  const balance = eco?.wallet.balance ?? 0;
  const betMax = limits?.betMax ?? wheelBetMax ?? eco?.settings?.gamesBetMax ?? 0;
  const lossLeft = games?.games.effectiveLimit != null ? Math.max(0, games.games.effectiveLimit - games.games.lossToday) : null;
  const cap = Math.max(0, Math.min(betMax, balance, lossLeft ?? Number.MAX_SAFE_INTEGER));
  // ⚠️ Комиссию до вызова отдаёт снимок дуэли (`duelLimits`); старый сервер её не шлёт — тогда настройки (их видят
  // управляющие) или значение по умолчанию (10 %). В самой партии — замороженная `duel.feePercent`.
  const feePercent = limits?.feePercent ?? eco?.settings?.gamesFeePercent ?? 10;
  return { betMax, balance, lossLeft, cap, feePercent };
}

/** Строка про банк: «банк 2×N, комиссия F % сгорает, победитель получит M». */
export function PotLine({ amount, feePercent, iconUrl }: { amount: number; feePercent: number; iconUrl?: string | null }) {
  const p = duelPot(amount, feePercent);
  return (
    <p className="duel-pot">
      Банк {p.pot}
      <img src={iconUrl || coinDefaultIcon} alt="" className="wh-coin" /> · комиссия {feePercent} % сгорает · победитель получит{' '}
      <b>{p.payout}</b>
    </p>
  );
}

/**
 * Форма вызова: соперник (сидящие в канале без меня и ботов), игра (Кубики / Камень-ножницы-бумага / Жадный гусь —
 * строка правил под каждой; игры с выбором — только если сервер объявил `duel2` в `/auth/me features`), ставка, «Вызвать».
 * Соперника нет — «Тренировка с капитаном» (`onPractice`): те же игры с ботом без ставки, ставка скрыта; соперники
 * есть — тренировка ссылкой под «Вызвать». Тренировка живёт на клиенте (`duelPractice.ts`), сервер о ней не знает,
 * поэтому все три игры доступны и у старого сервера.
 */
export function DuelNewCard({
  serverId,
  targetId: initialTarget,
  onClose,
  onBack,
  onOpenScene,
  onPractice,
  initialPractice,
  initialGame,
}: {
  serverId: string;
  targetId?: string;
  onClose: () => void;
  onBack: () => void;
  onOpenScene: (channelId: string) => void;
  /** Открыть тренировку с капитаном в выбранной игре; нет — тренировки в форме нет. */
  onPractice?: (game: DuelGame) => void;
  initialPractice?: boolean;
  initialGame?: DuelGame;
}) {
  const phone = usePhoneLayout();
  const channelId = useStore((s) => s.voice?.channelId ?? null);
  const meId = useStore((s) => s.user?.id ?? null);
  const people = useStore((s) => (channelId ? s.presence[channelId] : undefined));
  const iconUrl = useStore((s) => s.economy[serverId]?.iconUrl ?? null);
  const live = useStore((s) => (channelId ? s.duels[channelId] : undefined));
  const rivals = (people ?? []).filter((p) => p.userId !== meId && !p.bot);
  const [target, setTarget] = useState<string | null>(initialTarget ?? null);
  const { betMax, balance, lossLeft, cap, feePercent } = useStakeCap(serverId);
  const presets = betPresets(cap, cap);
  const [amountRaw, setAmountRaw] = useState('');
  const amount = clampBet(Number(amountRaw || (presets[0] ?? 0)), betMax, cap);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const chosen = rivals.some((r) => r.userId === target) ? target : null;
  const busyChannel = duelLive(live);
  const challengePending = useRef(false);
  // Этап 4: КНБ и Жадный гусь — только у сервера, что их умеет (`duel2`); старый сервер — одни кубики.
  const choiceOn = useStore((s) => !!s.serverFeatures?.includes(FEATURE_DUEL2));
  const twentyOneOn = useStore((s) => !!s.serverFeatures?.includes('duel21'));
  const seriesOn = useStore((s) => !!s.serverFeatures?.includes('duel-series1'));
  const [series, setSeries] = useState(false);
  const [gamePick, setGame] = useState<DuelGame>(initialGame ?? 'dice');
  const [practiceMode, setPracticeMode] = useState(initialPractice ?? (rivals.length === 0 && !!onPractice));
  // Не с кем — форма становится тренировкой: игры локальные, им сервер не нужен.
  const solo = practiceMode && !!onPractice;
  const game: DuelGame = solo || (gamePick === 'twentyone' ? twentyOneOn : choiceOn) ? gamePick : 'dice';

  useEffect(() => {
    if (phone) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [phone, onClose]);

  async function challenge() {
    if (challengePending.current || busyChannel || !channelId || !chosen || amount < 1) return;
    challengePending.current = true;
    setBusy(true);
    setErr(null);
    try {
      const r = await api.challengeDuel(serverId, { channelId, targetId: chosen, game, amount, ...(seriesOn && series ? { series: true } : {}) });
      applyDuelReply(serverId, r);
      onOpenScene(channelId);
    } catch (e) {
      const er = e as Error & { reason?: string };
      setErr(duelChallengeErrorText(er?.reason ?? er?.message, game));
    } finally {
      challengePending.current = false;
      setBusy(false);
    }
  }

  const body = (
    <div className="duel-new">
      {onPractice && (
        <div className="duel-mode" role="group" aria-label="Режим игры">
          <button type="button" className={`ew-btn${!solo ? ' ew-btn-main' : ''}`} aria-pressed={!solo} disabled={busy} onClick={() => setPracticeMode(false)}>С людьми</button>
          <button type="button" className={`ew-btn${solo ? ' ew-btn-main' : ''}`} aria-pressed={solo} disabled={busy} onClick={() => setPracticeMode(true)}>Тренировка</button>
        </div>
      )}
      {!solo && <>
      <h3 className="wh-h">Соперник</h3>
      {rivals.length === 0 ? (
        <p className="wh-empty">
          В канале больше никого — позови гуся в голос, и будет с кем сразиться.
          {solo && ' А пока можно потренироваться с капитаном.'}
        </p>
      ) : (
        <div className="duel-rivals" role="radiogroup" aria-label="Соперник">
          {rivals.map((r) => (
            <button
              key={r.userId}
              type="button"
              role="radio"
              aria-checked={chosen === r.userId}
              className={`duel-rival${chosen === r.userId ? ' sel' : ''}`}
              disabled={busy}
              onClick={() => setTarget(r.userId)}
            >
              <Avatar url={r.avatarUrl} name={r.displayName} size={36} />
              <span className="duel-rival-name">{r.displayName}</span>
            </button>
          ))}
        </div>
      )}
      </>}

      <h3 className="wh-h">Игра</h3>
      <div className="duel-games" role="radiogroup" aria-label="Игра">
        {DUEL_GAMES.map((g) => {
          const off = !solo && (g === 'twentyone' ? !twentyOneOn : g !== 'dice' && !choiceOn);
          return (
            <button
              key={g}
              type="button"
              role="radio"
              aria-checked={game === g}
              disabled={off || busy}
              className={`duel-game${game === g ? ' sel' : ''}`}
              onClick={() => setGame(g)}
            >
              <span className="duel-game-title">{DUEL_GAME_INFO[g].title}</span>
              <span className="duel-game-rule">{DUEL_GAME_INFO[g].rule}</span>
            </button>
          );
        })}
      </div>
      {/* Подсказка к игре — в одной ячейке с местом под две строки (владелец 29.10: окно не прыгает): у кубиков она пустая,
          у КНБ и гуся — правило хода, у старого сервера — «появятся, когда обновят». */}
      <p className="wh-hint duel-game-hint">
        {game === 'twentyone'
          ? 'На решение — 20 секунд. Не успел — «Стоп» на набранном. Сравним очки, когда оба закончат.'
          : !choiceOn && !solo
          ? 'Камень-ножницы-бумага и «21» появятся, когда обновят сервер.'
          : game === 'rps'
            ? `На ход — ${DUEL_MOVE_MS / 1000} секунд. Не выбрал вовремя — поражение${solo ? '.' : '; промолчали оба — ставки вернутся.'}`
            : game === 'greedy'
              ? `На ход — ${DUEL_MOVE_MS / 1000} секунд. Не успел — за тебя сходит ${solo ? 'судья' : 'капитан'}; ${GREEDY_MAX_TIMEOUTS} пропуска подряд — поражение.`
              : `На бросок — ${DUEL_ROLL_TURN_MS / 1000} секунд. Не успел — за тебя бросит судья.`}
      </p>
      <GameRules game={game} />

      {solo ? (
        <>
          <h3 className="wh-h">Ставка</h3>
          <p className="wh-hint duel-practice-stake">Без ставки — тренировка: монеты не двигаются, в таблицу игр не идёт.</p>
        </>
      ) : (
        <>
          <h3 className="wh-h">Ставка</h3>
          <div className="wh-amount">
            {presets.map((v) => (
              <button key={v} type="button" className={`wh-chip${amount === v ? ' sel' : ''}`} disabled={busy} onClick={() => setAmountRaw(String(v))}>
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
              disabled={busy}
              onChange={(e) => setAmountRaw(e.target.value)}
            />
          </div>
          <p className="wh-hint">
            Ставки равные: соперник ставит столько же. Максимум {betMax}
            {lossLeft !== null && ` · сегодня можно проиграть ещё ${lossLeft}`} · в кошельке {balance}
          </p>
          {/* Банк — строка с местом всегда: пустая сумма не сдвигает кнопку вниз. */}
          <div className="duel-pot-slot">{amount > 0 && <PotLine amount={amount} feePercent={feePercent} iconUrl={iconUrl} />}</div>
          {seriesOn && (
            <label className="duel-series-option">
              <input type="checkbox" checked={series} disabled={busy} onChange={(e) => setSeries(e.target.checked)} />
              <span><b>Играть серией</b><span className="wh-hint">Ставка {amount} с каждого в каждом раунде. Следующий — автоматически, пока оба продолжают. Счёт — для этой пары и игры.</span></span>
            </label>
          )}
        </>
      )}
      {busyChannel && channelId && (
        <p className="wh-err">
          В канале уже идёт дуэль.{' '}
          <button type="button" className="duel-link" onClick={() => onOpenScene(channelId)}>
            Смотреть
          </button>
        </p>
      )}
      {err && (
        <p className="wh-err" role="alert">
          {err}
        </p>
      )}
      {/* Кнопка — внизу окна при любой игре и любой длине правил (`margin-top: auto`, владелец 29.10). */}
      <div className="game-actions">
        {solo ? (
          <button type="button" className="ew-btn ew-btn-main wh-place game-actions-main" onClick={() => onPractice?.(game)}>
            Тренировка с капитаном
          </button>
        ) : (
          <>
            {onPractice && (
              <button type="button" className="ew-btn game-actions-back" title="Тренировка с капитаном — без ставки" disabled={busy} onClick={() => onPractice(game)}>
                Тренировка
              </button>
            )}
            <button
              type="button"
              className="ew-btn ew-btn-main wh-place game-actions-main"
              disabled={busy || busyChannel || !chosen || amount < 1}
              onClick={() => void challenge()}
            >
              {chosen ? seriesOn && series ? `Пригласить в серию · ${amount || '…'} за раунд` : `Вызвать на ${amount || '…'}` : 'Выбери соперника'}
            </button>
          </>
        )}
      </div>
    </div>
  );

  if (phone) {
    return (
      <BottomSheet page title="Гусиная дуэль" onClose={onClose} onBack={onBack}>
        {body}
      </BottomSheet>
    );
  }
  return (
    <div className="modal-overlay" onClick={onClose}>
      <section className="modal eco-welcome act-card game-frame duel-new-card" role="dialog" aria-modal="true" aria-labelledby="duel-new-title" onClick={(e) => e.stopPropagation()}>
        <div className="ew-head">
          <button type="button" className="wh-back" onClick={onBack}>
            <Icon name="chevron-left" size={16} />
            Активности
          </button>
          <button type="button" className="icon-close" title="Закрыть" onClick={onClose}>
            <Icon name="close" size={18} />
          </button>
        </div>
        <h2 id="duel-new-title" className="ew-title">
          Гусиная дуэль
        </h2>
        {body}
      </section>
    </div>
  );
}

/** Кольцо отсчёта: доля оставшегося времени, без бесконечной анимации (перерисовка тиком). */
export function CountRing({ leftMs, totalMs, size = 44 }: { leftMs: number; totalMs: number; size?: number }) {
  const r = size / 2 - 3;
  const c = 2 * Math.PI * r;
  const frac = totalMs > 0 ? Math.max(0, Math.min(1, leftMs / totalMs)) : 0;
  return (
    <span className="duel-ring" style={{ width: size, height: size }}>
      <svg width={size} height={size} viewBox={`0 0 ${size} ${size}`} aria-hidden="true">
        <circle className="duel-ring-bg" cx={size / 2} cy={size / 2} r={r} />
        <circle
          className="duel-ring-fg"
          cx={size / 2}
          cy={size / 2}
          r={r}
          strokeDasharray={c}
          strokeDashoffset={c * (1 - frac)}
          transform={`rotate(-90 ${size / 2} ${size / 2})`}
        />
      </svg>
      <span className="duel-ring-num">{Math.ceil(leftMs / 1000)}</span>
    </span>
  );
}

/** Открыта ли сейчас другая модалка или лист — тогда вызов не встаёт поверх, а ждёт на тост-полке (очередь). */
function otherModalOpen(): boolean {
  return typeof document !== 'undefined' && !!document.querySelector('.modal-overlay:not(.duel-invite-overlay), .sheet-scrim');
}

/** Входящий вызов и действия по нему — общее для карточки по центру и строки на полке. */
function useIncomingDuel(onOpenScene: (serverId: string, channelId: string) => void) {
  const invite = useStore((s) => s.duelInvite);
  const now = useNowTick(250, !!invite);
  const people = useDuelPeople(invite?.duel.channelId);
  const iconUrl = useStore((s) => (invite ? (s.economy[invite.duel.serverId]?.iconUrl ?? null) : null));
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  useEffect(() => setErr(null), [invite?.duel.id]);
  const actionPending = useRef(false);
  const d = invite?.duel ?? null;
  const left = invite && d ? duelLeftMs(d.inviteUntil, invite.skewMs, now) : 0;
  async function act(action: 'accept' | 'decline') {
    if (!d || actionPending.current || left <= 0) return;
    actionPending.current = true;
    setBusy(true);
    setErr(null);
    try {
      const r = action === 'accept' && d.series?.status === 'offered'
        ? await api.duelAction(d.serverId, d.id, action, { series: true })
        : await api.duelAction(d.serverId, d.id, action);
      applyDuelReply(d.serverId, r);
      if (action === 'accept') onOpenScene(d.serverId, d.channelId);
    } catch (e) {
      setErr(duelFailText(e));
    } finally {
      actionPending.current = false;
      setBusy(false);
    }
  }
  const buttons = (
    <div className="duel-invite-actions">
      <button type="button" className="ew-btn" disabled={busy} onClick={() => void act('decline')}>
        Отказаться
      </button>
      <button type="button" className="ew-btn ew-btn-main" disabled={busy} onClick={() => void act('accept')}>
        {d?.series?.status === 'offered' ? 'Принять серию' : 'Принять'}
      </button>
    </div>
  );
  return { d: left > 0 ? d : null, left, who: d ? people(d.challengerId) : null, iconUrl, err, buttons };
}

/**
 * Входящий вызов: маленькая карточка по центру (образец `RecountNotice`) — кто вызвал, игра, ставка, кольцо отсчёта
 * 30 с по часам сервера, «Принять / Отказаться». Поверх ДРУГОЙ модалки не встаёт — тогда вызов ждёт на тост-полке
 * (`InviteToast`) теми же кнопками. Крестик прячет карточку, а не отказывает: ответить можно с полосы канала.
 */
export function DuelInvite({ onOpenScene }: { onOpenScene: (serverId: string, channelId: string) => void }) {
  const { d, left, who, iconUrl, err, buttons } = useIncomingDuel(onOpenScene);
  const [hidden, setHidden] = useState<string | null>(null);
  if (!d || !who || hidden === d.id || otherModalOpen()) return null;
  return (
    <div className="modal-overlay duel-invite-overlay">
      <section className="modal eco-welcome duel-invite" role="alertdialog" aria-modal="true" aria-labelledby="duel-invite-title">
        <div className="ew-head">
          <span className="ew-eyebrow">
            <Icon name="gamepad" size={14} />
            Гусиная дуэль
          </span>
          <button type="button" className="icon-close" title="Скрыть" onClick={() => setHidden(d.id)}>
            <Icon name="close" size={18} />
          </button>
        </div>
        <div className="duel-invite-who">
          <Avatar url={who.avatar} name={who.name} size={56} />
          <CountRing leftMs={left} totalMs={DUEL_INVITE_MS} />
        </div>
        <h2 id="duel-invite-title" className="ew-title">
          {who.name} вызывает тебя на дуэль
        </h2>
        <p className="ew-text">
          Игра — {duelGameWord(d.game)}. Ставка {d.amount}
          <img src={iconUrl || coinDefaultIcon} alt="" className="wh-coin" /> с каждого.
        </p>
        <PotLine amount={d.amount} feePercent={d.feePercent} iconUrl={iconUrl} />
        {d.series?.status === 'offered' && <p className="wh-hint">Серия: {d.amount} с каждого за каждый раунд. После итога — продолжение автоматически; «К выбору игр» завершает серию. Счёт сохраняется для вас двоих в этой игре.</p>}
        {buttons}
        {err && (
          <p className="wh-err" role="alert">
            {err}
          </p>
        )}
      </section>
    </div>
  );
}

/** Вызов на полке — пока открыта другая модалка. */
function InviteToast({ onOpenScene }: { onOpenScene: (serverId: string, channelId: string) => void }) {
  const { d, left, who, err, buttons } = useIncomingDuel(onOpenScene);
  if (!d || !who || !otherModalOpen()) return null;
  return (
    <div className="game-toast duel-invite-toast" role="alertdialog" aria-label="Вызов на дуэль">
      <Avatar url={who.avatar} name={who.name} size={32} />
      <span className="game-toast-text">
        <b>{who.name}</b> вызывает на дуэль · {duelGameWord(d.game)} · {d.amount}
        {d.series?.status === 'offered' && <span> за каждый раунд серии · продолжение автоматически</span>}
        {err && <span className="wh-err"> · {err}</span>}
      </span>
      <CountRing leftMs={left} totalMs={DUEL_INVITE_MS} size={32} />
      {buttons}
    </div>
  );
}

/** Полоса партии в голосовом канале — между шапкой и сценой: «Кубики: А против Б · ставка N · идёт» + «Смотреть». */
export function DuelCard({ channelId }: { channelId: string }) {
  const view = useStore((s) => s.duels[channelId]);
  const serverId = useStore((s) => s.voice?.serverId ?? s.bootstrap?.server.id ?? null);
  const open = useStore((s) => s.openActivities);
  const people = useDuelPeople(channelId);
  if (!view || !duelLive(view) || !serverId) return null;
  const d = view.duel;
  const a = people(d.challengerId).name;
  const b = people(d.targetId).name;
  return (
    <div className="duel-card" role="status">
      <Icon name="gamepad" size={16} />
      <span className="duel-card-text">
        <b>{duelGameTitle(d.game)}:</b> {a} против {b} · ставка {d.amount} · {d.state === 'playing' ? 'идёт' : 'ждём ответа'}
      </span>
      <button type="button" className="duel-card-btn" onClick={() => open({ serverId, view: 'duel', channelId })}>
        Смотреть
      </button>
    </div>
  );
}

/**
 * Тост-полка игр внизу по центру (`.game-toast-shelf`, своя от правого стека тостов): «началась дуэль» сидящим в канале
 * (≤ 1 на партию, 10 с) и вызов, ждущий в очереди за другой модалкой.
 */
export function GameToastShelf({ onOpenScene, children }: { onOpenScene: (serverId: string, channelId: string) => void; children?: ReactNode }) {
  const t = useStore((s) => s.gameToast);
  const setToast = useStore((s) => s.setGameToast);
  const people = useDuelPeople(t?.channelId);
  useEffect(() => {
    if (!t) return;
    const id = window.setTimeout(() => setToast(null), Math.max(0, t.until - Date.now()));
    return () => window.clearTimeout(id);
  }, [t, setToast]);
  return (
    <div className="game-toast-shelf">
      <InviteToast onOpenScene={onOpenScene} />
      {/* Тосты других игр на той же полке (ставки на события, этап 5) — их рисует `Activities.tsx`. */}
      {children}
      {t && (
        <div className="game-toast" role="status">
          <Icon name="gamepad" size={18} />
          <span className="game-toast-text">
            Дуэль · {duelGameWord(t.game ?? 'dice')}: <b>{people(t.challengerId).name}</b> против <b>{people(t.targetId).name}</b> · ставка {t.amount}
          </span>
          <button
            type="button"
            className="ew-btn ew-btn-main game-toast-btn"
            onClick={() => {
              setToast(null);
              onOpenScene(t.serverId, t.channelId);
            }}
          >
            Смотреть
          </button>
          <button type="button" className="icon-close" title="Скрыть" onClick={() => setToast(null)}>
            <Icon name="close" size={16} />
          </button>
        </div>
      )}
    </div>
  );
}
