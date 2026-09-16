import { useEffect, useState } from 'react';
import { api } from '../api';
import { isMockEconomy, mockLeaderboard } from '../benchMock';
import { useStore } from '../store';
import {
  LEDGER_REASON,
  explainAccrual,
  type EconomyView,
  type Leaderboard,
  type LedgerEntry,
  type LevelStage,
  type LevelState,
} from '../economy';
import { ensureEconomy } from '../economyClient';
import { ledgerCsv, ledgerFileName } from '../ledgerCsv';
import { useNameResolver } from '../memberName';
import { streakCaption, streakDots, streakExplain, type StreakView } from '../streakView';
import { toast, toastError } from '../toast';
import { Goose } from './Goose';
import { Icon } from './Icon';

/**
 * Почему за это время начислено именно столько.
 *
 * 🔴 **Только тому, кто управляет экономикой** (решение 03.09: минуты, множители, затухание и
 * потолок — внутренняя кухня; обычный человек видит монеты и звание). Разбор строки — это и есть
 * кухня: «10 минут в голосе · полная ставка дала бы 20 − 15: вы были одни». Владельцу он нужен, чтобы
 * ответить на «почему у Пети больше»; остальным вместо него — приветственное окно с картинками.
 *
 * ⚠️ Ничего не рисуем, когда разбора нет (старые строки журнала) или когда никто ни на что не
 * повлиял: строка «полная ставка, и ничего её не меняло» — это шум, а не объяснение.
 */
function AccrualWhy({ entry, currency, detailed }: { entry: LedgerEntry; currency: string; detailed: boolean }) {
  if (!detailed) return null;
  const why = explainAccrual(entry.data);
  if (!why) return null;
  if (why.parts.length === 0 && !why.cappedByDaily) return <small>{why.time}</small>;
  return (
    <small className="wallet-why">
      {why.time} · полная ставка дала бы {why.fullCoins} {currency}
      {why.parts.map((p) => (
        <span key={p.label}>
          {p.coins > 0 ? ' + ' : ' − '}
          {Math.abs(p.coins)}: {p.label}
        </span>
      ))}
      {why.cappedByDaily && <span className="wallet-capped"> · дальше сегодня не начисляем: достигнут суточный потолок</span>}
    </small>
  );
}

function amountText(amount: number) {
  return `${amount > 0 ? '+' : ''}${amount}`;
}

function ledgerText(entry: LedgerEntry, nameOf: ReturnType<typeof useNameResolver>) {
  const reason = LEDGER_REASON[entry.reason] ?? entry.reason;
  // День серии — из данных строки: «Дни подряд · 4-й день» объясняет, почему сумма выросла.
  if (entry.reason === 'streak' && typeof entry.data?.days === 'number') return `${reason} · ${entry.data.days}-й день`;
  if (!entry.refUserId) return reason;
  const name = nameOf(entry.refUserId, 'Участник');
  if (entry.reason === 'tip.in') return `${reason} от ${name}`;
  if (entry.reason === 'tip.out') return `${reason} ${name}`;
  return `${reason} · ${name}`;
}

/**
 * Витрина наград.
 *
 * 🔴 **Витрина отвечает «что вообще есть и почём», а действие живёт в контекстном меню человека.**
 * Это не половинчатость, а разделение работ: адресная награда начинается с ЧЕЛОВЕКА, и кнопки
 * «купить» здесь быть не должно — иначе рядом с настоящим выбором людей (меню в голосе) появился
 * бы второй, кривой: список участников в модалке кошелька взяться неоткуда, а если его туда
 * притащить, получится две разные двери в одно и то же.
 *
 * Поэтому карточка адресной награды заканчивается не кнопкой, а подсказкой, ГДЕ это делается.
 * ⚠️ У БЕЗАДРЕСНЫХ наград кнопка есть — им человек не нужен, и покупка тут единственная дверь.
 * Канальные (саундборд) снова уходят подсказкой: жать их надо там, где сидишь голосом.
 * 🔴 Купленное навсегда показывается как «куплено», а не серой кнопкой: серая кнопка приглашает
 * жать и получать отказ, а надпись отвечает на вопрос до нажатия.
 *
 * 🔴 Обычному человеку цена — ТОЛЬКО в монетах (решение 03.09: «людям вообще не надо знать,
 * что мы считаем в минутах»). Минуты рядом с ценой видит лишь тот, кто управляет экономикой: ему они
 * объясняют масштаб — «дорого» понятно только в сравнении с вечером, — а обычному человеку выдали бы
 * кухню, которую он не просил.
 */
function ShopSection({ view, serverId }: { view: EconomyView; serverId: string }) {
  const [busy, setBusy] = useState<string | null>(null);
  // Право на анимацию глобальное и живёт на самом человеке, а не в кошельке сервера.
  const ownsAnimated = useStore((s) => s.user?.animatedAvatarUnlocked ?? false);
  const animatedUntil = useStore((s) => s.user?.animatedAvatarUntil ?? null);
  const setAuth = useStore((s) => s.setAuth);
  /**
   * 🔴 Аватар — АРЕНДА на 30 дней, а не покупка навсегда, и продлевать её сервер разрешает
   * (`alreadyOwned: false`). Клиент же прятал кнопку и писал «Уже куплено» — то есть продлить было
   * нельзя ровно все тридцать дней, а срок нигде не показывался (аудит текстов 03.09).
   * ⚠️ Поэтому «куплено» здесь нет вовсе: есть остаток дней и кнопка «Продлить».
   */
  const daysLeft =
    ownsAnimated && animatedUntil
      ? Math.max(1, Math.ceil((new Date(animatedUntil).getTime() - Date.now()) / 86_400_000))
      : null;

  async function buy(item: string) {
    setBusy(item);
    try {
      const r = await api.buySelfItem(serverId, item);
      toast('success', 'Куплено', `Списано ${r.spent} ${view.currencyName}`);
      // Разрешение приезжает на самом человеке — перечитываем профиль, иначе кнопка ещё раз
      // предложит купить уже купленное.
      setAuth(await api.me());
      ensureEconomy(serverId, true);
    } catch (e) {
      toastError(e);
    } finally {
      setBusy(null);
    }
  }

  // Снятые с продажи не показываем вовсе: серая карточка без объяснения только рождает вопрос
  // «а почему нельзя», ответа на который у человека нет.
  const items = (view.shop ?? []).filter((e) => e.enabled && e.priceCoins > 0);
  // «Лавка» — имя витрины, выбранное 03.09 (из пары «На что потратить / Лавка»).
  if (items.length === 0) {
    return (
      <>
        <h3>Лавка</h3>
        <div className="muted wallet-empty">Пока покупать нечего — владелец сервера ещё не открыл лавку</div>
      </>
    );
  }

  return (
    <>
      <h3>Лавка</h3>
      <div className="shop-list">
        {items.map((e) => {
          /**
           * 🔴 Есть разброс — показываем ЕГО, а не общую цену каталога. У саундборда цена своя у
           * каждого звука, и одно число здесь было прямым обманом: в витрине 16, а платится от 4 до
           * 120 (замечание 03.09). «Хватает или нет» тоже считаем по минимальной цене: хоть
           * один звук по карману — награда доступна.
           */
          const range = e.priceRange;
          const cheapest = range ? range.minCoins : e.priceCoins;
          const short = view.wallet.balance - cheapest;
          return (
            <div className={`shop-item${short < 0 ? ' shop-item-poor' : ''}`} key={e.item}>
              <div className="shop-head">
                <strong>{e.label}</strong>
                <span className="shop-price">
                  {/* ⚠️ Само число — отдельным узлом с `nowrap`: цену рвать посреди нельзя, а вот
                      пояснению переноситься нужно, иначе длинная цена выталкивает название на две
                      строки (замечание 04.09 на цене аватара в 1500 минут). */}
                  <span className="shop-amount">
                    {range && range.minCoins !== range.maxCoins
                      ? `${range.minCoins}–${range.maxCoins} ${view.currencyName}`
                      : `${cheapest} ${view.currencyName}`}
                  </span>
                  {/* Минуты — только управляющему: см. разбор над компонентом. */}
                  {view.canManage && !range && <small>это как {e.priceMinutes} мин в голосовом канале</small>}
                  {view.canManage && range && <small>у каждого звука своя</small>}
                </span>
              </div>
              <div className="shop-hint">{e.hint}</div>
              <div className="shop-how">
                {e.item === 'animated-avatar' && daysLeft !== null ? (
                  <>
                    <span className="shop-owned">Работает ещё {daysLeft} дн.</span>
                    <button
                      type="button"
                      className="shop-buy"
                      disabled={busy !== null || short < 0}
                      onClick={() => void buy(e.item)}
                    >
                      {short < 0 ? `Не хватает ${-short}` : 'Продлить'}
                    </button>
                  </>
                ) : short < 0 ? (
                  <span className="shop-short">Не хватает {-short}</span>
                ) : e.target === 'user' ? (
                  // Подсказка, а не кнопка: см. разбор над компонентом.
                  <span>Правой кнопкой по человеку в голосовом канале → «Ущипнуть»</span>
                ) : e.target === 'channel' ? (
                  <span>Кнопка саундборда в доке голосового канала</span>
                ) : (
                  <button type="button" className="shop-buy" disabled={busy !== null} onClick={() => void buy(e.item)}>
                    Купить
                  </button>
                )}
              </div>
            </div>
          );
        })}
      </div>
    </>
  );
}

/**
 * Уровень с полоской прогресса и лестницей званий.
 *
 * 🔴 **Этапы — в числах, и числа — те же монеты, что человек видит в строке «за всё время»** (запрос
 * 03.09: «надо чтоб было видно прям этапы в числах, и этапы должны достигаться циферками
 * пользователя»). Никакой второй единицы: одна шкала, звание = сколько заработал.
 *
 * 🔴 **Полученные типы в уровень не идут, и это написано ПРЯМО** («типы в лвл не идут вообще,
 * но людям в кошельке надо написать это явно»). Умолчание было бы хуже правила: человек, которого
 * много типают, ждал бы роста и не понимал, почему его нет.
 *
 * ⚠️ Прежняя подпись говорила «растёт от времени в голосе … и того, сколько разных людей тебя
 * типнули» — оба утверждения после 03.09 ложны: минуты не единица, а признание из уровня убрано.
 */
function LevelBlock({ level, stages, currency }: { level: LevelState; stages: LevelStage[]; currency: string }) {
  return (
    <div className="level-block">
      <div className="level-head">
        <strong>
          {level.title} · уровень {level.level}
        </strong>
        <span className="level-points">
          {level.points} / {level.nextAt} {currency}
        </span>
      </div>
      <div className="level-bar" role="progressbar" aria-valuenow={Math.round(level.progress * 100)} aria-valuemin={0} aria-valuemax={100}>
        <span style={{ width: `${Math.round(level.progress * 100)}%` }} />
      </div>
      {/* Лестница: пройденные ступени — обычным цветом, текущая — акцентом, будущие — приглушённо.
          Числа — заработанные монеты, никакого перевода. */}
      <ol className="level-stages" aria-label="Звания и сколько монет нужно">
        {stages.map((s) => (
          <li
            key={s.title}
            className={s.title === level.title ? 'level-stage-now' : s.at <= level.points ? 'level-stage-done' : undefined}
          >
            <span>{s.title}</span>
            <b>{s.at}</b>
          </li>
        ))}
      </ol>
      <div className="level-hint">
        Считается от заработанных {currency}: за время в голосовом канале, пойманных гусей, дни подряд и начисление за прошлые вечера. Полученные типы в уровень
        не идут — их дарят, а не зарабатывают.
      </div>
    </div>
  );
}

/**
 * Серия дней — тем же рисунком, что в приветственном окне (правка 03.09: «в кошельке не видно
 * стрик, можно добавить его туда в таком же дизайне»).
 *
 * 🔴 Семь точек — последние семь суток по СЕРВЕРНОМУ ключу дня, залитые = засчитанные, сегодня без
 * захода — пунктиром. Первая строка: где ты в серии и сколько это даёт; вторая отвечает на второй
 * вопрос с приёмки — «на что конкретно распространяется бонус»: за сам приход, раз в день, монетами
 * сверху к обычному заработку.
 * ⚠️ Числа — с сервера, той же логикой, что и награда; здесь только слова и точки.
 */
function StreakBlock({ streak, currency }: { streak: StreakView; currency: string }) {
  if (!streak.enabled) return null;
  return (
    <div className="streak-block">
      <div className="streak-art">
        <Goose pose="honk" size={52} />
        <span className="ew-days" aria-hidden>
          {streakDots(streak).map((d, i) => (
            <span key={i} className={`ew-day${d.state === 'on' ? ' ew-day-on' : d.state === 'today' ? ' ew-day-today' : ''}`}>
              {d.label}
            </span>
          ))}
        </span>
      </div>
      <div className="streak-caption">{streakCaption(streak, currency)}</div>
      <div className="level-hint">{streakExplain(streak, currency)}</div>
    </div>
  );
}

/**
 * Сезонная таблица лидеров.
 *
 * 🔴 Показываем ЗАРАБОТАННОЕ за сезон, а не баланс: баланс тратится, и человек, купивший награду,
 * не должен из-за этого падать в таблице. Иначе выбор «потратить или остаться в топе» превращает
 * магазин в наказание.
 * ⚠️ Своя строка выделена — без этого в списке из семнадцати человек себя не найти.
 */
function LeaderboardSection({ board, meId, currency }: { board: Leaderboard | null; meId: string | undefined; currency: string }) {
  if (!board) return null;
  if (board.people.length === 0) {
    return (
      <>
        <h3>{board.season.name}</h3>
        <div className="muted wallet-empty">Сезон только начался — в таблице пока пусто</div>
      </>
    );
  }
  return (
    <>
      <h3>{board.season.name}</h3>
      <div className="board-list">
        {board.people.map((p) => (
          <div className={`board-row${p.userId === meId ? ' board-row-me' : ''}`} key={p.userId}>
            <span className="board-place">{p.place}</span>
            <span className="board-name">
              {/* Корона достаётся победителю ПРОШЛОГО сезона и висит ровно один сезон. */}
              {board.crown?.userId === p.userId && <span className="board-crown" title="Победитель прошлого сезона">👑</span>}
              {p.displayName}
              <small> · {p.level.title}</small>
            </span>
            <span className="board-earned">
              {p.earned} {currency}
            </span>
          </div>
        ))}
      </div>
    </>
  );
}

export function CoinWalletModal({
  serverId,
  view,
  onViewChange,
  onClose,
}: {
  serverId: string;
  view: EconomyView;
  onViewChange: (next: EconomyView) => void;
  onClose: () => void;
}) {
  const nameOf = useNameResolver();
  const me = useStore((s) => s.user);
  const setWelcomeOpen = useStore((s) => s.setEconomyWelcomeOpen);
  const [ledger, setLedger] = useState<LedgerEntry[] | null>(null);
  const [board, setBoard] = useState<Leaderboard | null>(null);
  const [ledgerError, setLedgerError] = useState<string | null>(null);
  /** Какая выгрузка сейчас едет: чтобы кнопка не давала нажать себя трижды подряд. */
  const [exporting, setExporting] = useState<'week' | 'month' | 'season' | null>(null);
  const [optOutBusy, setOptOutBusy] = useState(false);
  const [optOutError, setOptOutError] = useState<string | null>(null);

  /**
   * Выгрузить журнал за период таблицей.
   *
   * 🔴 Собираем файл ЗДЕСЬ, а не на сервере: человеческие подписи причин («Тип от Маши», «За
   * время в голосовом канале») живут на клиенте, и вторая их копия на бэкенде разошлась бы с этой
   * при первом же переименовании. Сервер отдаёт строки, клиент — слова.
   */
  const exportLedger = (period: 'week' | 'month' | 'season') => {
    if (exporting) return;
    setExporting(period);
    api
      .getEconomyLedger(serverId, period)
      .then((rows) => {
        const csv = ledgerCsv(
          rows.map((e) => ({
            at: new Date(e.createdAt).toLocaleString('ru-RU', { dateStyle: 'short', timeStyle: 'short' }),
            what: ledgerText(e, nameOf),
            amount: e.amount,
            detail:
              typeof e.data?.burned === 'number'
                ? `сгорело ${e.data.burned}`
                : typeof e.data?.days === 'number'
                  ? `${e.data.days}-й день подряд`
                  : '',
          })),
          view.currencyName,
        );
        const blob = new Blob([csv], { type: 'text/csv;charset=utf-8' });
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = ledgerFileName(period, new Date());
        a.click();
        URL.revokeObjectURL(url);
        toast('success', 'Журнал выгружен', `${rows.length} операций · ${a.download}`);
      })
      .catch((err: Error) => toastError(err))
      .finally(() => setExporting(null));
  };

  useEffect(() => {
    let alive = true;
    api
      .getEconomyLedger(serverId)
      .then((entries) => {
        if (alive) setLedger(entries);
      })
      .catch((err: Error) => {
        if (alive) setLedgerError(err.message);
      });
    // Таблица грузится молча и не мешает кошельку: она приятная, но не обязательная.
    // ⚠️ При макете экономики (стенд) маршрута нет — подставляем синтетическую. Подстановка живёт
    // ЗДЕСЬ, а не в стенде, по той же причине, что и макет чипа: рисовать её должен тот же
    // компонент, что и настоящую, иначе проверка врёт про раскладку.
    api
      .getLeaderboard(serverId)
      .then((b) => alive && setBoard(b))
      .catch(() => alive && setBoard(isMockEconomy() ? mockLeaderboard(me?.id ?? 'me', me?.displayName ?? 'Я') : null));
    return () => {
      alive = false;
    };
    /**
     * 🔴 **`view.wallet.balance` в зависимостях — это перезагрузка журнала на КАЖДОЕ движение монет**
     * (фикс 05.09). Баланс приезжает живым пушем, а журнал грузился ровно один раз при открытии — и
     * человек с открытым кошельком видел, как число растёт, а список операций стоит. Со стороны это
     * читается как «типы не дошли»: именно так и прозвучал отзыв — «у него в истории даже нет моих
     * типов», хотя в базе строки были на месте.
     * ⚠️ Запрос на каждое движение — осознанная цена: журнал перечитывается ТОЛЬКО пока кошелёк
     * открыт, а внутри семнадцати человек это единицы запросов за вечер.
     */
  }, [serverId, me?.id, me?.displayName, view.wallet.balance]);

  /** Два независимых переключателя: правка одного не должна молча переставлять другой (#122). */
  async function patchMe(patch: { optedOut?: boolean; tipsOptOut?: boolean }) {
    setOptOutBusy(true);
    setOptOutError(null);
    try {
      const result = await api.setEconomyOptOut(serverId, patch);
      onViewChange({ ...view, wallet: { ...view.wallet, optedOut: result.optedOut, tipsOptOut: result.tipsOptOut } });
    } catch (err) {
      setOptOutError((err as Error).message);
    } finally {
      setOptOutBusy(false);
    }
  }

  return (
    <div className="modal-overlay" onClick={onClose}>
      <section className="modal wallet-modal" role="dialog" aria-modal="true" aria-labelledby="wallet-title" onClick={(e) => e.stopPropagation()}>
        <div className="admin-head">
          <h2 id="wallet-title">Мой кошелёк</h2>
          {/* Приветствие можно перечитать: первый показ один на человека, а вопрос «откуда монеты»
              возникает и через месяц. */}
          <button type="button" className="wallet-how" onClick={() => setWelcomeOpen(true)}>
            Как это работает
          </button>
          <button type="button" className="icon-close" title="Закрыть" onClick={onClose}>
            <Icon name="close" size={18} />
          </button>
        </div>

        {/* 🔴 Статус «отошёл» стоит денег — и человек должен видеть это ЗДЕСЬ, а не догадываться по
            медленно растущему числу. Первый же день показал, как тихо это бывает: двое застряли в
            «Отошёл» ещё со старой сборки (она не помечала авто-уход как авто, поэтому автоматика их
            не возвращала) — играли и получали четверть, не зная об этом. */}
        {me?.status === 'away' && view.awayPercent !== null && view.awayPercent < 100 && (
          <div className="wallet-away" role="status">
            Ты в статусе «Отошёл» — начисляется {view.awayPercent} % ставки. Смени статус на «В сети»,
            если ты на месте.
          </div>
        )}

        <div className="wallet-summary">
          <div><span>Баланс</span><strong>{view.wallet.balance} {view.currencyName}</strong></div>
          <div><span>За всё время</span><strong>{view.wallet.earnedTotal} {view.currencyName}</strong></div>
          <div><span>{view.season.name}</span><strong>{view.wallet.seasonEarned} {view.currencyName}</strong></div>
        </div>

        {view.level && <LevelBlock level={view.level} stages={view.levelStages ?? []} currency={view.currencyName} />}
        {view.streak && <StreakBlock streak={view.streak} currency={view.currencyName} />}

        <LeaderboardSection board={board} meId={me?.id} currency={view.currencyName} />

        <ShopSection view={view} serverId={serverId} />

        <h3>Последние операции</h3>
        {/* 🔴 Двадцати хватает на «что было только что» — за этим сюда и заходят. Длинный список
            отжимал бы вниз всё остальное и всё равно не читался бы (решение 03.09).
            За бо́льшим — выгрузка таблицей, которую открывают там, где такое смотреть удобно. */}
        <div className="ledger-export">
          <span className="muted">Выгрузить таблицей:</span>
          {(
            [
              ['week', 'за неделю'],
              ['month', 'за месяц'],
              ['season', 'за сезон'],
            ] as const
          ).map(([p, label]) => (
            <button key={p} type="button" onClick={() => exportLedger(p)} disabled={exporting !== null}>
              {exporting === p ? '…' : label}
            </button>
          ))}
        </div>
        {ledgerError && <div className="error">Не удалось загрузить журнал: {ledgerError}</div>}
        {!ledger && !ledgerError && <div className="muted wallet-loading">Загружаю журнал…</div>}
        {ledger?.length === 0 && <div className="muted wallet-empty">Пока ничего не было</div>}
        {ledger && ledger.length > 0 && (
          <div className="wallet-ledger">
            {ledger.map((entry) => (
              <div className="wallet-entry" key={entry.id}>
                <div>
                  <strong>{ledgerText(entry, nameOf)}</strong>
                  <span>{new Date(entry.createdAt).toLocaleString('ru-RU', { dateStyle: 'medium', timeStyle: 'short' })}</span>
                  {typeof entry.data?.burned === 'number' && <small>Сгорело: {entry.data.burned} {view.currencyName}</small>}
                  <AccrualWhy entry={entry} currency={view.currencyName} detailed={view.canManage} />
                </div>
                <b className={entry.amount < 0 ? 'wallet-negative' : 'wallet-positive'}>{amountText(entry.amount)}</b>
              </div>
            ))}
          </div>
        )}

        {/* 🔴 Два РАЗНЫХ выключателя. Тому, кому надоели типы, не за что переставать зарабатывать —
            поэтому «не принимать типы» отдельно от «не участвовать» (#122). */}
        <label className="wallet-opt-out">
          <input
            type="checkbox"
            checked={view.wallet.tipsOptOut}
            disabled={optOutBusy || view.wallet.optedOut}
            onChange={(e) => void patchMe({ tipsOptOut: e.target.checked })}
          />
          <span>
            <strong>Не принимать типы</strong>
            <small>Монеты продолжают начисляться. Отправителю не сообщаем, что вы отключили приём.</small>
          </span>
        </label>
        <label className="wallet-opt-out">
          <input type="checkbox" checked={view.wallet.optedOut} disabled={optOutBusy} onChange={(e) => void patchMe({ optedOut: e.target.checked })} />
          <span>
            <strong>Не участвовать в экономике</strong>
            <small>Монеты не начисляются и вам нельзя типнуть. И сами вы, пока это включено, не сможете ни типать, ни покупать в лавке, ни ловить гуся.</small>
          </span>
        </label>
        {optOutError && <div className="error">Не удалось изменить участие: {optOutError}</div>}
      </section>
    </div>
  );
}
