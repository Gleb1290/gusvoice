import { useEffect, useRef, useState } from 'react';
import { api } from '../api';
import { alertDialog, confirmAction } from '../confirm';
import {
  gamesToggleVisible,
  launchButtonVisible,
  LAUNCH_GIFT_SLIDER,
  type EconomySettingsDto,
  type EconomyView,
} from '../economy';
import { Slider } from './EconomyPanel';
import { GameTitlesCard } from './GameTitlesCard';
import { Toggle } from './Toggle';

/**
 * Раздел «Игры» в настройках сервера (ГусКоины 2; вынесен из «Монет» решением владельца 30.10).
 *
 * Зачем свой раздел: (1) пока игры в работе, их видит только супер-админ инстанса — пункт рельса закрыт флагом
 * `features.games` в `serverSettingsTabs.ts`, а в «Монетах» игр нет вовсе, так что админ чужого сервера не видит ни
 * потолков, ни комиссии; (2) включение и запуск были запрятаны посреди экономики — теперь всё про игры в одном месте:
 * сверху состояние и включение/запуск, ниже правила и пределы.
 *
 * ⚠️ Логика и запросы — ровно те, что жили в `EconomyPanel`: настройки игр — поля того же `EconomySettingsDto`,
 * читаются `api.getEconomy` и сохраняются ЦЕЛИКОМ `api.saveEconomy` (поля экономики уходят такими, какими пришли),
 * запуск — `api.launchGames`. Права проверяет сервер, как раньше (`MANAGE_ECONOMY`, замок `GAMES_OPEN`): скрытие
 * раздела — это интерфейс, не новое право.
 *
 * Старый сервер без полей игр (`gamesEnabled` не пришло) — раздел не ломается, а говорит, что сервер игр не знает.
 */
export function GamesSettingsPanel({ serverId }: { serverId: string }) {
  const [settings, setSettings] = useState<EconomySettingsDto | null>(null);
  // Потолок проигрыша до включения «Без потолка»: выключили обратно — вернулось прежнее число, а не ноль ползунка.
  const lossCapBefore = useRef(1000);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);
  /** Ответ пришёл, но настроек нет — экономика на сервере ещё не заводилась. */
  const [noEconomy, setNoEconomy] = useState(false);
  /**
   * Замок игр и «Запустить игры» (29.10, `gamesLaunchRules.ts`): `gamesLocked` — этому человеку включать игры нельзя
   * (`GAMES_OPEN` закрыт, он не супер-админ); `gamesLaunch` — отметка запуска (`null` — не запускали, `undefined` — старый
   * сервер); `loadedGamesOn` — игры были включены на момент загрузки (тогда переключатель остаётся: выключать можно).
   */
  const [gamesLocked, setGamesLocked] = useState<boolean | undefined>(undefined);
  const [gamesLaunch, setGamesLaunch] = useState<EconomyView['gamesLaunch']>(undefined);
  const [loadedGamesOn, setLoadedGamesOn] = useState(false);
  /** Что СЕЙЧАС на сервере (после загрузки, сохранения или запуска) — по нему крупная строка состояния, а не по черновику. */
  const [savedGamesOn, setSavedGamesOn] = useState(false);
  const [launchGift, setLaunchGift] = useState<number>(LAUNCH_GIFT_SLIDER.default);

  useEffect(() => {
    void (async () => {
      try {
        const view = await api.getEconomy(serverId);
        if (view.settings) {
          setSettings(view.settings);
          setLoadedGamesOn(!!view.settings.gamesEnabled);
          setSavedGamesOn(!!view.settings.gamesEnabled);
        } else {
          setNoEconomy(true);
        }
        setGamesLocked(view.gamesLocked);
        setGamesLaunch(view.gamesLaunch);
      } catch (err) {
        setError((err as Error).message);
      }
    })();
  }, [serverId]);

  // Ошибка ДЕЙСТВИЯ не прячет раздел (как в «Монетах»): прячем, только если показывать нечего.
  if (error && !settings) return <div className="admin-error">{error}</div>;
  if (noEconomy) {
    return (
      <div className="eco-panel">
        <div className="eco-slider-hint">
          Игры идут на монетах сервера, а монеты здесь ещё не настроены. Сначала откройте раздел «Монеты» и сохраните
          настройки — после этого здесь можно будет включить игры.
        </div>
      </div>
    );
  }
  if (!settings) return <div className="muted">Загрузка…</div>;
  // Старый сервер: полей игр не прислал — значит, игр не знает. Раньше в этом случае раздел игр в «Монетах» просто не
  // рисовался; здесь раздел уже открыт, поэтому говорим словами.
  if (settings.gamesEnabled === undefined) {
    return (
      <div className="eco-panel">
        <div className="eco-slider-hint">Этот сервер пока не знает игр — они появятся после его обновления.</div>
      </div>
    );
  }

  const patch = (p: Partial<EconomySettingsDto>) => setSettings({ ...settings, ...p });
  const toggleShown = gamesToggleVisible(gamesLocked, loadedGamesOn);
  const draftDiffers = !!settings.gamesEnabled !== savedGamesOn;

  async function save() {
    if (!settings) return;
    setBusy(true);
    setError(null);
    try {
      await api.saveEconomy(serverId, settings);
      setSavedGamesOn(!!settings.gamesEnabled);
      setSaved(true);
      window.setTimeout(() => setSaved(false), 2000);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  }

  /**
   * «Запустить игры» (решения 29.10, пп. 8–9): включить игры и подарить `launchGift` монет каждому, кто сейчас в голосе
   * сервера, — один раз за жизнь сервера. Сцену «БУМ» запустивший видит, как все (решение владельца 29.10): отметку «видел»
   * здесь не ставим, событие шлюза кладёт запрос в стор, а `MainLayout` покажет сцену, когда закроется окно настроек.
   */
  async function launchGamesNow() {
    const gift = launchGift;
    const ok = await confirmAction({
      title: 'Запустить игры на сервере?',
      body:
        (gift > 0
          ? `Игры включатся сразу, и каждый, кто сейчас сидит в голосовых каналах сервера, получит ${gift} монет в подарок.`
          : 'Игры включатся сразу, подарка не будет.') +
        ' Участники, которые сейчас онлайн, увидят сцену запуска. Запуск делается один раз, подарок не отменить.',
      confirmLabel: 'Запустить',
    });
    if (!ok) return;
    setBusy(true);
    setError(null);
    try {
      const res = await api.launchGames(serverId, gift);
      setGamesLaunch({ at: res.at, gift: res.gift, mine: 0 });
      setLoadedGamesOn(true);
      setSavedGamesOn(true);
      setSettings((cur) => (cur ? { ...cur, gamesEnabled: true } : cur));
      await alertDialog(
        'Игры запущены',
        res.gift > 0 && res.people > 0
          ? `Подарили по ${res.gift} монет: ${res.people} чел. в голосе.`
          : res.gift > 0
            ? 'В голосе сейчас никого не было — подарков нет.'
            : 'Без подарка.',
      );
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  }

  // Строка под крупным состоянием: когда запускали и что дарили, либо что запуска ещё не было.
  const launchedLine = gamesLaunch
    ? `Запущены ${new Date(gamesLaunch.at).toLocaleDateString('ru-RU')}` +
      (gamesLaunch.gift > 0 ? `, подарок за запуск — ${gamesLaunch.gift} монет каждому в голосе.` : ', без подарка.')
    : gamesLaunch === null
      ? launchButtonVisible({ gamesLaunch, gamesLocked })
        ? 'Торжественного запуска ещё не было — он ниже.'
        : 'Торжественного запуска ещё не было.'
      : null;

  return (
    <div className="eco-panel">
      {error && <div className="admin-error">{error}</div>}

      {/* Главное — сверху и крупно: что с играми на этом сервере сейчас и как это поменять. */}
      <div className={`games-state${savedGamesOn ? ' on' : ''}`}>
        <div className="eco-row-toggle">
          <span className="eco-toggle-text" id="games-state-title">
            <strong className="games-state-title">{savedGamesOn ? 'Игры включены' : 'Игры выключены'}</strong>
            <small>
              Колесо, дуэли и прогнозы в голосовых каналах этого сервера. Монеты не покупаются и не выводятся; выигрыш не
              идёт в сезон.
            </small>
            {launchedLine && <small>{launchedLine}</small>}
          </span>
          {toggleShown && (
            <Toggle
              checked={settings.gamesEnabled}
              labelledBy="games-state-title"
              onChange={(v) => patch({ gamesEnabled: v })}
            />
          )}
        </div>
        {!toggleShown && (
          <div className="eco-slider-hint">Игры пока проходят приёмку — включит их администратор инстанса.</div>
        )}
        {draftDiffers && (
          <div className="eco-slider-hint">
            {settings.gamesEnabled ? 'Игры включатся' : 'Игры выключатся'}, когда вы нажмёте «Сохранить» внизу.
          </div>
        )}
      </div>

      {launchButtonVisible({ gamesLaunch, gamesLocked }) && (
        <>
          <h4 className="eco-head">Запуск</h4>
          <div className="eco-slider-hint">
            Игры включатся сразу. Участники онлайн увидят сцену запуска, а
            сидящие в голосе получат подарок. Делается один раз за жизнь сервера.
          </div>
          <Slider
            label="Подарок за запуск каждому, кто сидит в голосе"
            suffix="монет"
            min={LAUNCH_GIFT_SLIDER.min}
            max={LAUNCH_GIFT_SLIDER.max}
            step={LAUNCH_GIFT_SLIDER.step}
            value={launchGift}
            hint="Один раз: монеты получат все, кто в момент запуска сидит в голосовых каналах сервера. Подарок не идёт в сезон и уровень. 0 — без подарка."
            onChange={setLaunchGift}
          />
          <button type="button" className="btn primary eco-retro" disabled={busy} onClick={() => void launchGamesNow()}>
            Запустить игры
          </button>
        </>
      )}

      {/* Правила видны и при выключенных играх (видно, что включится), но не двигаются. */}
      {(settings.gamesBetMax !== undefined || settings.gamesFeePercent !== undefined) && (
        <h4 className="eco-head">Ставки</h4>
      )}
      {settings.gamesBetMax !== undefined && (
        <Slider
          label="Максимальная ставка"
          suffix="монет"
          min={10}
          max={Math.max(5000, settings.gamesBetMax)}
          step={10}
          value={settings.gamesBetMax}
          disabled={!settings.gamesEnabled}
          hint="Больше этого одной ставкой не поставить ни в одной игре."
          onChange={(v) => patch({ gamesBetMax: v })}
        />
      )}
      {settings.gamesFeePercent !== undefined && (
        <Slider
          label="Комиссия дуэлей и прогнозов"
          suffix="%"
          min={0}
          max={50}
          step={1}
          value={settings.gamesFeePercent}
          disabled={!settings.gamesEnabled}
          hint="Доля банка, которая сгорает: монеты уходят из оборота, а не к кому-то."
          onChange={(v) => patch({ gamesFeePercent: v })}
        />
      )}

      {(settings.gamesDailyLossMax !== undefined || settings.gamesPairDailyMax !== undefined) && (
        <h4 className="eco-head">Пределы на сутки</h4>
      )}
      {settings.gamesDailyLossMax !== undefined && (
        <Slider
          label="Потолок проигрыша в сутки на человека"
          suffix="монет"
          min={0}
          max={Math.max(50000, settings.gamesDailyLossMax)}
          step={100}
          value={settings.gamesDailyLossMax}
          disabled={!settings.gamesEnabled}
          hint="Сколько один человек может проиграть на этом сервере за сутки по Москве. Каждый может поставить себе предел ниже — внизу карточки «Активности»."
          onChange={(v) => patch({ gamesDailyLossMax: v })}
        />
      )}
      {/* «Без потолка» — явный переключатель вместо загадочного нуля на ползунке (владелец 29.10). В настройках по-прежнему
          число: 0 и значит «без потолка» (ползунок на нуле включает переключатель); выключение возвращает прошлое
          значение (`lossCapBefore`, по умолчанию 1000). */}
      {settings.gamesDailyLossMax !== undefined && (
        <div className="eco-row-toggle">
          <span className="eco-toggle-text" id="eco-games-no-cap">
            Без потолка
            <small>
              {settings.gamesDailyLossMax === 0
                ? 'Сейчас потолка нет: каждый играет в пределах своего лимита, а без него — без ограничений.'
                : 'Снять общий потолок: останутся только личные пределы — у тех, кто их себе поставил.'}
            </small>
          </span>
          <Toggle
            checked={settings.gamesDailyLossMax === 0}
            disabled={!settings.gamesEnabled}
            labelledBy="eco-games-no-cap"
            onChange={(v) => {
              if (v) lossCapBefore.current = settings.gamesDailyLossMax || lossCapBefore.current;
              patch({ gamesDailyLossMax: v ? 0 : lossCapBefore.current });
            }}
          />
        </div>
      )}
      {settings.gamesPairDailyMax !== undefined && (
        <Slider
          label="Предел выигрыша одной пары за сутки в играх с выбором"
          suffix="монет"
          min={0}
          max={Math.max(10000, settings.gamesPairDailyMax)}
          step={100}
          value={settings.gamesPairDailyMax}
          disabled={!settings.gamesEnabled}
          hint="Сколько двое могут выиграть друг у друга в «Камень-ножницы-бумага» и «Жадном гусе» за сутки по Москве: взаимные выигрыши гасят друг друга. Кубики не ограничены. 0 — без предела."
          onChange={(v) => patch({ gamesPairDailyMax: v })}
        />
      )}

      <GameTitlesCard serverId={serverId} gamesEnabled={!!settings.gamesEnabled} />

      <div className="eco-actions">
        <button type="button" className="btn primary" disabled={busy} onClick={() => void save()}>
          Сохранить
        </button>
        {saved && <span className="eco-saved">Сохранено</span>}
      </div>
    </div>
  );
}
