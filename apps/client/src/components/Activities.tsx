import { lazy, Suspense, useEffect, useState } from 'react';
import { duelLive } from '../duelRules';
import { ensureDuel, ensureEconomy, ensurePredictions, ensureWheel } from '../economyClient';
import { gamesView } from '../economy';
import { usePhoneLayout } from '../phoneLayout';
import { predictionLive, predictionsOpen } from '../predictionRules';
import { useStore, voiceIsHere } from '../store';
import { clockLabel, wheelLive, wheelPhase } from '../wheelRules';
import { BottomSheet } from './BottomSheet';
import { GameBoardScene } from './GameBoard';
import { DuelCard, DuelInvite, DuelNewCard, GameToastShelf } from './Duel';
import { GamesLimit } from './GamesLimit';
import { Icon } from './Icon';

/** Полоса партии дуэли в голосовом канале (`VoiceChannelView`) — отсюда, чтобы у канала не появлялась новая граница. */
export { DuelCard };

/**
 * «Активности» голосового канала (ГусКоины 2, этап 2): кнопка в доке голоса и карточка со списком игр.
 *
 * 🔴 Колесо открывается ТОЛЬКО отсюда (решение владельца: ни вкладки в кошельке, ни чипа в шапке) — играть можно лишь
 * сидя в голосе этого сервера, и кнопка живёт там же, где голос. Видна, когда человек в голосе сервера, экономика ему
 * видна и сервер включил игры (`gamesView`). Точка на кнопке — у сервера живой раунд колеса.
 *
 * Кнопка объявлена ОДИН раз и подставлена в обе ветки `VoiceControls` (обычная и «идёт показ», урок 05.09) и в
 * телефонную панель звонка `MobileCallBar`. Что открыто — в сторе (`activities`), а не в кнопке: ветка дока меняется при
 * старте показа, кнопка перемонтируется, а открытая сцена не должна от этого закрываться. Хост — `ActivitiesHost`
 * в `MainLayout`.
 */

/** Сервер, в голосе которого сидим здесь (голос на другом инстансе — игр отсюда нет). */
function useVoiceServerId(): string | null {
  return useStore((s) => (s.voice && voiceIsHere(s.voice) ? (s.voice.serverId ?? s.bootstrap?.server.id ?? null) : null));
}

function useGamesOn(serverId: string | null): boolean {
  return useStore((s) => {
    const eco = serverId ? s.economy[serverId] : undefined;
    return !!eco && gamesView(eco) !== null;
  });
}

export function ActivitiesButton({ variant }: { variant: 'dock' | 'wide' | 'call' }) {
  const serverId = useVoiceServerId();
  const gamesOn = useGamesOn(serverId);
  const wheelOn = useStore((s) => (serverId ? wheelLive(s.wheel[serverId]) : false));
  // Дуэль (этап 3) — в МОЁМ голосовом канале: точка «идёт игра» и на ней.
  const duelOn = useStore((s) => (s.voice?.channelId ? duelLive(s.duels[s.voice.channelId]) : false));
  // Ставки на события (этап 5) — уровня сервера: точка, пока на сервере открыт приём ставок.
  const eventsOn = useStore((s) => (serverId ? predictionsOpen(s.predictions[serverId]?.events) : false));
  const live = wheelOn || duelOn || eventsOn;
  const open = useStore((s) => !!serverId && s.activitiesOpen?.serverId === serverId);
  const setActivities = useStore((s) => s.openActivities);
  useEffect(() => {
    if (serverId) ensureEconomy(serverId);
  }, [serverId]);
  useEffect(() => {
    if (!gamesOn) return;
    ensureWheel(serverId);
    ensurePredictions(serverId);
  }, [gamesOn, serverId]);
  if (!serverId || !gamesOn) return null;

  const title = duelOn
    ? 'Активности — идёт дуэль'
    : wheelOn
      ? 'Активности — идёт раунд колеса'
      : eventsOn
        ? 'Активности — идёт приём ставок на событие'
        : 'Активности';
  const cls = variant === 'call' ? `call-btn act-btn${open ? ' on' : ''}` : `ctl act-btn act-btn-${variant}${open ? ' on' : ''}`;
  return (
    <button
      type="button"
      className={cls}
      title={title}
      aria-label={title}
      aria-haspopup="dialog"
      onClick={() => setActivities(open ? null : { serverId, view: 'list' })}
    >
      <Icon name="gamepad" size={variant === 'call' ? 26 : variant === 'wide' ? 18 : 20} />
      {live && <span className="act-dot" aria-hidden="true" />}
    </button>
  );
}

const WheelScene = lazy(() => import('./WheelScene'));
const DuelScene = lazy(() => import('./DuelScene'));
const PredictionsScene = lazy(() => import('./Predictions'));

/**
 * Карточка «Активности», сцены колеса и дуэли, входящий вызов на дуэль и тост-полка игр — поверх всего, у корня
 * `MainLayout`.
 */
export function ActivitiesHost() {
  const act = useStore((s) => s.activitiesOpen);
  const setActivities = useStore((s) => s.openActivities);
  const voiceServerId = useVoiceServerId();
  const voiceChannelId = useStore((s) => (s.voice && voiceIsHere(s.voice) ? s.voice.channelId : null));
  const gamesOn = useGamesOn(act?.serverId ?? null);
  const voiceGamesOn = useGamesOn(voiceServerId);
  // Вошёл в голосовой канал сервера с играми — снимок дуэли канала (там же входящий мне вызов).
  useEffect(() => {
    if (voiceGamesOn && voiceServerId && voiceChannelId) ensureDuel(voiceServerId, voiceChannelId, true);
  }, [voiceGamesOn, voiceServerId, voiceChannelId]);
  // Вышел из голоса или сервер выключил игры — список и форма вызова закрываются сами. Открытые сцены остаются:
  // досмотреть вращение или партию можно и после выхода, а новую ставку сервер всё равно не примет (`not_in_voice`).
  const listGone = (act?.view === 'list' || act?.view === 'duel-new') && (act.serverId !== voiceServerId || !gamesOn);
  useEffect(() => {
    if (listGone) setActivities(null);
  }, [listGone, setActivities]);
  const openDuelScene = (serverId: string, channelId: string) => setActivities({ serverId, view: 'duel', channelId });
  const shared = (
    <>
      <DuelInvite onOpenScene={openDuelScene} />
      <GameToastShelf onOpenScene={openDuelScene}>
        <PredictionToastItem onOpen={(serverId, eventId) => setActivities({ serverId, view: 'events', eventId })} />
      </GameToastShelf>
    </>
  );
  if (!act || listGone) return shared;
  const close = () => setActivities(null);
  const back = () => setActivities({ serverId: act.serverId, view: 'list' });
  let main;
  if (act.view === 'wheel') {
    main = (
      <Suspense fallback={null}>
        <WheelScene serverId={act.serverId} onClose={close} onBack={back} />
      </Suspense>
    );
  } else if ((act.view === 'duel' || (act.view === 'duel-practice' && act.practiceGame)) && act.channelId) {
    // `duel-practice` — тренировка с капитаном без ставки: та же сцена, партия на клиенте (`duelPractice.ts`). «Назад» и «К выбору
    // игр» — к форме вызова и у партии канала, и у тренировки (владелец 29.10: из игры — к выбору игры, не к списку «Активностей»).
    const practice = act.view === 'duel-practice' ? act.practiceGame : undefined;
    const backToForm = () => setActivities({ serverId: act.serverId, view: 'duel-new' });
    main = (
      <Suspense fallback={null}>
        <DuelScene key={`${act.serverId}:${act.channelId}:${practice ?? 'live'}`} serverId={act.serverId} channelId={act.channelId} practice={practice} onClose={close} onBack={backToForm}
          onModeChange={(training) => setActivities({ serverId: act.serverId, view: 'duel-new', ...(training ? { practiceGame: act.practiceGame ?? 'dice' } : {}) })} />
      </Suspense>
    );
  } else if (act.view === 'events') {
    main = (
      <Suspense fallback={null}>
        <PredictionsScene serverId={act.serverId} focusEventId={act.eventId} onClose={close} onBack={back} />
      </Suspense>
    );
  } else if (act.view === 'board') {
    main = <GameBoardScene serverId={act.serverId} onClose={close} onBack={back} />;
  } else if (act.view === 'duel-new') {
    main = (
      <DuelNewCard
        serverId={act.serverId}
        initialPractice={!!act.practiceGame}
        initialGame={act.practiceGame}
        targetId={act.targetId}
        onClose={close}
        onBack={back}
        onOpenScene={(channelId) => openDuelScene(act.serverId, channelId)}
        onPractice={(game) => setActivities({ serverId: act.serverId, view: 'duel-practice', practiceGame: game, channelId: voiceChannelId ?? 'practice' })}
      />
    );
  } else {
    main = (
      <ActivitiesCard
        serverId={act.serverId}
        onClose={close}
        onOpenWheel={() => setActivities({ serverId: act.serverId, view: 'wheel' })}
        onOpenEvents={() => setActivities({ serverId: act.serverId, view: 'events' })}
        onOpenBoard={() => setActivities({ serverId: act.serverId, view: 'board' })}
        onOpenDuel={(channelId, live) =>
          setActivities(live && channelId ? { serverId: act.serverId, view: 'duel', channelId } : { serverId: act.serverId, view: 'duel-new' })
        }
      />
    );
  }
  return (
    <>
      {main}
      {shared}
    </>
  );
}

/**
 * Тост ставок на события на полке игр: «Новое событие: … · Смотреть» сидящим в голосе сервера и «Ты угадал: +N» по итогу.
 * Кладёт его `sockets.ts` (≤ 1 «нового» на событие); гаснет сам к `until`.
 */
function PredictionToastItem({ onOpen }: { onOpen: (serverId: string, eventId: string) => void }) {
  const t = useStore((s) => s.predictionToast);
  const setToast = useStore((s) => s.setPredictionToast);
  useEffect(() => {
    if (!t) return;
    const id = window.setTimeout(() => setToast(null), Math.max(0, t.until - Date.now()));
    return () => window.clearTimeout(id);
  }, [t, setToast]);
  if (!t) return null;
  return (
    <div className={`game-toast pr-toast${t.kind === 'win' ? ' win' : ''}`} role="status">
      <Icon name={t.kind === 'win' ? 'star' : 'megaphone'} size={18} />
      <span className="game-toast-text">
        {t.kind === 'win' ? (
          <>
            Ты угадал: <b>+{t.amount}</b> · {t.title}
          </>
        ) : (
          <>
            Новое событие: <b>{t.title}</b>
          </>
        )}
      </span>
      <button
        type="button"
        className="ew-btn ew-btn-main game-toast-btn"
        onClick={() => {
          setToast(null);
          onOpen(t.serverId, t.eventId);
        }}
      >
        {t.kind === 'win' ? 'Итог' : 'Смотреть'}
      </button>
      <button type="button" className="icon-close" title="Скрыть" onClick={() => setToast(null)}>
        <Icon name="close" size={16} />
      </button>
    </div>
  );
}

/** Тикает раз в секунду, пока карточка открыта и идёт раунд (таймер на плитке игры). */
function useSecondTick(on: boolean): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!on) return;
    const id = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(id);
  }, [on]);
  return now;
}

function ActivitiesCard({
  serverId,
  onClose,
  onOpenWheel,
  onOpenEvents,
  onOpenBoard,
  onOpenDuel,
}: {
  serverId: string;
  onClose: () => void;
  onOpenWheel: () => void;
  onOpenEvents: () => void;
  onOpenBoard: () => void;
  onOpenDuel: (channelId: string | null, live: boolean) => void;
}) {
  const phone = usePhoneLayout();
  const view = useStore((s) => s.wheel[serverId]);
  const live = wheelLive(view);
  const now = useSecondTick(live);
  const [captain, setCaptain] = useState<string | null>(null);
  const [judge, setJudge] = useState<string | null>(null);
  const [host, setHost] = useState<string | null>(null);
  const events = useStore((s) => s.predictions[serverId]?.events);
  const voiceChannelId = useStore((s) => s.voice?.channelId ?? null);
  const duelView = useStore((s) => (voiceChannelId ? s.duels[voiceChannelId] : undefined));
  const duelOn = duelLive(duelView);
  // «Что это у нас?» (владелец 29.10, п. 14) — проиграть сцену запуска игр заново, без строки о подарке; только на сервере,
  // где игры запускали. «Активности» закрываются: сцена не встаёт поверх других окон (ворота `MainLayout`).
  const launched = useStore((s) => s.economy[serverId]?.gamesLaunch ?? null);
  const setLaunchNotice = useStore((s) => s.setGamesLaunchNotice);
  const whatsThis = launched ? (
    <button
      type="button"
      className="wallet-how act-whats"
      onClick={() => {
        onClose();
        setLaunchNotice({ serverId, at: launched.at, gift: launched.gift, mine: 0, replay: true });
      }}
    >
      Что это у нас?
    </button>
  ) : null;
  useEffect(() => {
    // Капитан — отдельный файл сцены: тянем его динамическим импортом, в основной бандл картинка не попадает.
    let alive = true;
    void import('../assets/wheel/captain.png').then((m) => alive && setCaptain(m.default));
    // Судья дуэлей — так же отдельным файлом (его же грузит ленивая сцена дуэли).
    void import('../assets/duel/judge.png').then((m) => alive && setJudge(m.default));
    // Ведущий прогнозов (голубой попугай с подзорной трубой) — тоже отдельным файлом, его же тянет ленивая лента.
    void import('../assets/predictions/host.png').then((m) => alive && setHost(m.default));
    return () => {
      alive = false;
    };
  }, []);
  useEffect(() => {
    if (phone) return; // у листа свой Esc
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [phone, onClose]);

  const phase = view ? wheelPhase(view, now) : null;
  const status =
    phase?.kind === 'open'
      ? `Идёт раунд · ставки ещё ${clockLabel(phase.leftMs)}`
      : phase?.kind === 'spinning'
        ? 'Колесо крутится'
        : view && view.jackpot > 0
          ? `В сундуке ${view.jackpot}`
          : null;

  const tile = (
    <button type="button" className="act-game" onClick={onOpenWheel}>
      <span className="act-game-art">{captain && <img src={captain} alt="" />}</span>
      <span className="act-game-body">
        <span className="act-game-title">Колесо гусей-пиратов</span>
        <span className="act-game-sub">Ставь на число и жди, где встанет стрелка. Выигрыш до ×23, а сундук с джекпотом пополняется с каждой ставки.</span>
        {status && (
          <span className={`act-game-status${live ? ' live' : ''}`}>
            {live && <span className="act-dot inline" aria-hidden="true" />}
            {status}
          </span>
        )}
      </span>
      <Icon name="chevron-right" size={20} />
    </button>
  );
  const duelTile = (
    <button type="button" className="act-game" onClick={() => onOpenDuel(voiceChannelId, duelOn)}>
      <span className="act-game-art">{judge && <img src={judge} alt="" />}</span>
      <span className="act-game-body">
        <span className="act-game-title">Гусиная дуэль</span>
        <span className="act-game-sub">Вызови соседа по каналу: кубики, камень-ножницы-бумага или «Жадный гусь». Ставки равные — победитель забирает банк.</span>
        {duelOn && (
          <span className="act-game-status live">
            <span className="act-dot inline" aria-hidden="true" />
            {duelView?.duel.state === 'playing' ? 'В канале идёт дуэль' : 'Вызов ждёт ответа'}
          </span>
        )}
      </span>
      <Icon name="chevron-right" size={20} />
    </button>
  );
  const openEvents = events?.filter((e) => e.state === 'open').length ?? 0;
  const liveEvents = events?.filter((e) => predictionLive(e)).length ?? 0;
  const eventsStatus = openEvents > 0 ? 'Идёт приём ставок' : liveEvents > 0 ? 'Ждём итога события' : null;
  const eventsTile = (
    <button type="button" className="act-game" onClick={onOpenEvents}>
      <span className="act-game-art">{host && <img src={host} alt="" />}</span>
      <span className="act-game-body">
        <span className="act-game-title">Ставки на события</span>
        <span className="act-game-sub">Угадай исход матча, спора или стрима. Банк вопроса делят угадавшие — пропорционально ставкам.</span>
        {eventsStatus && (
          <span className={`act-game-status${openEvents > 0 ? ' live' : ''}`}>
            {openEvents > 0 && <span className="act-dot inline" aria-hidden="true" />}
            {eventsStatus}
            {liveEvents > 1 && ` · событий: ${liveEvents}`}
          </span>
        )}
      </span>
      <Icon name="chevron-right" size={20} />
    </button>
  );
  // Таблица и звания (этап 6): не игра, а витрина — плитка без картинки сцены, со значком.
  const boardTile = (
    <button type="button" className="act-game act-game-board" onClick={onOpenBoard}>
      <span className="act-game-art act-game-art-icon" aria-hidden>
        <Icon name="list" size={26} />
      </span>
      <span className="act-game-body">
        <span className="act-game-title">Таблица и звания</span>
        <span className="act-game-sub">Кто в плюсе за месяц и сезон, звания прошлого месяца и «Итоги».</span>
      </span>
      <Icon name="chevron-right" size={20} />
    </button>
  );
  // ПК: четыре плитки сеткой 2×2 в общей рамке игр (`.act-tiles`); на телефоне — столбиком в листе.
  const tilesGrid = (
    <div className="act-tiles">
      {tile}
      {duelTile}
      {eventsTile}
      {boardTile}
    </div>
  );
  const foot = <p className="act-foot">Монеты здесь только игровые: не покупаются и не выводятся. Выигрыш не идёт в сезон.</p>;

  if (phone) {
    return (
      <BottomSheet title="Активности" subtitle="Игры голосового канала на игровые монеты" onClose={onClose}>
        <div className="act-sheet-body">
          {whatsThis}
          {tile}
          {duelTile}
          {eventsTile}
          {boardTile}
          <GamesLimit serverId={serverId} />
          {foot}
        </div>
      </BottomSheet>
    );
  }
  return (
    <div className="modal-overlay" onClick={onClose}>
      <section
        className="modal eco-welcome act-card game-frame"
        role="dialog"
        aria-modal="true"
        aria-labelledby="act-title"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="ew-head">
          <span className="ew-eyebrow">
            <Icon name="gamepad" size={14} />
            Голосовой канал
          </span>
          {whatsThis}
          <button type="button" className="icon-close" title="Закрыть" onClick={onClose}>
            <Icon name="close" size={18} />
          </button>
        </div>
        <h2 id="act-title" className="ew-title">
          Активности
        </h2>
        <p className="ew-text">Играть можно, пока сидишь в голосе этого сервера.</p>
        {/* ПК: рамка общая со всеми окнами игр (`.game-frame`, владелец 29.10) — плитки сеткой 2×2, внизу «Сундук на день». */}
        {tilesGrid}
        <div className="act-bottom">
          <GamesLimit serverId={serverId} />
          {foot}
        </div>
      </section>
    </div>
  );
}
