import { useState } from 'react';
import { api } from '../api';
import coinDefaultIcon from '../assets/guscoin.svg';
import { gamesView } from '../economy';
import { useStore } from '../store';
import { Icon } from './Icon';
import { Toggle } from './Toggle';

/** Пресеты «сундука на день»: выше потолка сервера не показываем — действовал бы всё равно потолок. */
const LIMIT_PRESETS = [100, 500, 1000] as const;

/**
 * «Сундук на день» — свой предел проигрыша в карточке «Активности» (владелец 29.10: «не перегружать настройки, а сделать
 * настройку своих лимитов прям в карточку активностей… понятную и иммерсивную»). Свернутая строка-сводка «Сегодня можно
 * проиграть ещё N · изменить» раскрывается в шкалу сегодняшнего проигрыша, переключатель «Свой предел» и пресеты.
 *
 * 🔴 Правило сервера (`lossLimitRaise`): понизить — сразу, повысить или снять — с 00:00 МСК; клиент это только говорит
 * словами и показывает отложенное значение, сам ничего не решает. «Свой предел выкл» = `gamesLossLimit: null`: действует
 * только потолок сервера (0 на сервере — без ограничений).
 * ⚠️ Нет блока, если сервер не прислал `wallet.games` (старый сервер), игры выключены, человек отказался от экономики или
 * скрыл себе игры — «Не показывать мне игры» живёт в кошельке, иначе скрытые игры было бы не вернуть.
 */
export function GamesLimit({ serverId }: { serverId: string }) {
  const view = useStore((s) => s.economy[serverId]);
  const setEconomy = useStore((s) => s.setEconomy);
  const [open, setOpen] = useState(false);
  // Включил «Свой предел», а сумму ещё не выбрал: на сервер уходит только выбранная сумма.
  const [picking, setPicking] = useState(false);
  const [custom, setCustom] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const seen = view ? gamesView(view) : null;
  if (!view || !seen || view.wallet.optedOut || seen.games.optOut) return null;
  const { games, serverMax } = seen;
  const coin = <img src={view.iconUrl || coinDefaultIcon} alt="" className="wh-coin" />;
  const lost = Math.max(0, games.lossToday);
  const limit = games.effectiveLimit;
  const left = limit === null ? null : Math.max(0, limit - lost);
  const own = games.lossLimit !== null || picking;
  const raise = games.lossLimitRaise;
  const presets = LIMIT_PRESETS.filter((v) => serverMax === 0 || v < serverMax);
  // Выбранная сумма — то, что будет действовать: отложенное повышение уже «выбрано», просто вступит с полуночи.
  const chosen = raise && raise.value !== null ? raise.value : games.lossLimit;

  async function save(gamesLossLimit: number | null) {
    if (!view) return;
    setBusy(true);
    setError(null);
    try {
      const result = await api.setEconomyOptOut(serverId, { gamesLossLimit });
      const cur = useStore.getState().economy[serverId] ?? view;
      if (result.games) setEconomy(serverId, { ...cur, wallet: { ...cur.wallet, games: result.games } });
      setPicking(false);
      setCustom('');
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  }

  const summary =
    left === null ? (
      <>Сегодня проигрыш без предела</>
    ) : left === 0 ? (
      <>На сегодня сундук закрыт — предел исчерпан</>
    ) : (
      <>
        Сегодня можно проиграть ещё <b>{left}</b>
        {coin}
      </>
    );
  const ownHint = !own
    ? serverMax > 0
      ? `Выключен — действует потолок сервера: ${serverMax} в сутки`
      : 'Выключен — на сервере потолка нет, играешь без ограничений'
    : games.lossLimit === null
      ? 'Выбери сумму — сколько готов проиграть за сутки'
      : `Не больше ${games.lossLimit} в сутки${serverMax > 0 ? ` (потолок сервера — ${serverMax})` : ''}`;
  const customValue = Number(custom);
  const customOk = custom.trim() !== '' && Number.isInteger(customValue) && customValue >= 0 && customValue <= 1_000_000;

  return (
    <div className={`act-limit${open ? ' open' : ''}`}>
      <button type="button" className="act-limit-row" aria-expanded={open} onClick={() => setOpen((v) => !v)}>
        <span className="act-limit-chest" aria-hidden="true">
          {/* Сундук колеса здесь не берём: арт колеса грузит только его ленивая сцена (страж `Activities.wheelWiring`). */}
          {left === 0 ? <Icon name="lock" size={20} /> : <img src={view.iconUrl || coinDefaultIcon} alt="" />}
        </span>
        <span className="act-limit-text">
          <span className="act-limit-eyebrow">Сундук на день</span>
          <span className="act-limit-sum">{summary}</span>
        </span>
        <span className="act-limit-edit">
          {open ? 'свернуть' : 'изменить'}
          <Icon name={open ? 'chevron-up' : 'chevron-down'} size={16} />
        </span>
      </button>
      {open && (
        <div className="act-limit-body">
          {limit !== null && (
            <div
              className={`act-limit-bar${left === 0 ? ' full' : ''}`}
              role="meter"
              aria-label="Проиграно сегодня"
              aria-valuemin={0}
              aria-valuemax={limit}
              aria-valuenow={Math.min(lost, limit)}
            >
              <span style={{ width: `${limit > 0 ? Math.min(100, (lost / limit) * 100) : 100}%` }} />
            </div>
          )}
          <p className="act-limit-line">
            {limit === null
              ? `Сегодня проиграно ${lost} — предела нет.`
              : left === 0
                ? `Сегодня проиграно ${lost} из ${limit} — на сегодня всё, ставки откроются с полуночи МСК.`
                : `Сегодня проиграно ${lost} из ${limit} — можно ещё ${left}.`}
          </p>
          <div className="act-limit-own">
            <span className="act-limit-own-text" id={`act-limit-own-${serverId}`}>
              Свой предел
              <small>{ownHint}</small>
            </span>
            <Toggle
              checked={own}
              disabled={busy}
              labelledBy={`act-limit-own-${serverId}`}
              onChange={(v) => {
                if (v) setPicking(true);
                else {
                  setPicking(false);
                  if (games.lossLimit !== null) void save(null);
                }
              }}
            />
          </div>
          {own && (
            <div className="act-limit-presets">
              <div className="wh-amount" role="radiogroup" aria-label="Свой предел в сутки">
                {presets.map((v) => (
                  <button
                    key={v}
                    type="button"
                    role="radio"
                    aria-checked={chosen === v}
                    className={`wh-chip${chosen === v ? ' sel' : ''}`}
                    disabled={busy}
                    onClick={() => void save(v)}
                  >
                    {v}
                  </button>
                ))}
                <input
                  className="wh-amount-input"
                  type="number"
                  inputMode="numeric"
                  min={0}
                  placeholder="Своя сумма"
                  aria-label="Своя сумма предела"
                  value={custom}
                  disabled={busy}
                  onChange={(e) => setCustom(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter' && customOk) void save(customValue);
                  }}
                />
                <button type="button" className="ew-btn" disabled={busy || !customOk} onClick={() => void save(customValue)}>
                  Поставить
                </button>
              </div>
            </div>
          )}
          {raise && (
            <p className="act-limit-line act-limit-pending" role="status">
              {raise.value === null ? 'Свой предел снимется с 00:00 МСК' : `Предел вырастет до ${raise.value} с 00:00 МСК`}
            </p>
          )}
          <p className="wh-hint">Понизить предел можно сразу, повысить или снять — с полуночи МСК: азарт до утра подождёт.</p>
          {error && (
            <p className="wh-err" role="alert">
              Не удалось изменить предел: {error}
            </p>
          )}
        </div>
      )}
    </div>
  );
}
