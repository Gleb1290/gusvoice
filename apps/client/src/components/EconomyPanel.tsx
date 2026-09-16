import { useCallback, useEffect, useRef, useState } from 'react';
import { api } from '../api';
import {
  coinsPerHour,
  minutesForCoins,
  type EconomyPreview,
  type EconomySettingsDto,
  type EconomySummary,
  type ShopEntry,
} from '../economy';
import { Toggle } from './Toggle';

/**
 * Настройка экономики сервера (#117) — вкладка «Монеты».
 *
 * 🔴 Требование: ставку и множители владелец крутит сам, без правки кода и без релиза. Поэтому все
 * числа экономики живут здесь, а не в коде.
 *
 * 🔴 И главное — **под ползунками показывается пересчёт по РЕАЛЬНЫМ вечерам этих людей**, а не
 * абстрактная ставка. Ползунок без цифры последствий — гадание: «10 монет за 5 минут» никому ничего
 * не говорит, а «Петя за прошлую неделю получил бы 1400» говорит всё. Считает сервер той же
 * функцией, что и начисление, — иначе панель обещала бы одно, а начислялось бы другое.
 */

/** Награды, по которым показываем «сколько это в минутах сидения». Пока справочно: магазина нет. */
const PRICE_HINTS: { label: string; coins: (s: EconomySettingsDto) => number }[] = [
  { label: 'Типнуть друга', coins: (s) => s.tipAmount },
];

interface SliderProps {
  label: string;
  hint?: string;
  value: number;
  min: number;
  max: number;
  step?: number;
  suffix?: string;
  onChange: (v: number) => void;
}

/**
 * Цена анимированного аватара на сервере: своя, но не ниже цены инстанса (решение 14.09).
 *
 * 🔴 **Поле с кнопкой, а не бегунок**, как у остальных наград. Бегунок каталога шлёт запрос на
 * каждый тик — при диапазоне в тысячи минут это десятки PATCH и столько же записей в журнал аудита
 * за одно движение пальцем. Цену аватара ставят обдуманно и редко, глядя на заработок людей.
 * ⚠️ Монеты для черновика НЕ считаем: цену переводит только сервер (см. `patchShop`). Поэтому рядом
 * стоят текущая цена и пол — оба в двух единицах, из ответа сервера, и соотношение видно по ним.
 * ⚠️ Проверка пола здесь — только подсказка до отправки. Решает сервер (`avatarPriceAllowed`).
 */
function AvatarPriceEditor({
  entry,
  currencyName,
  busy,
  onSave,
}: {
  entry: ShopEntry;
  currencyName: string;
  busy: boolean;
  onSave: (minutes: number | null) => void;
}) {
  const floor = entry.floor ?? { minutes: 0, coins: 0 };
  const [draft, setDraft] = useState(String(entry.priceMinutes));
  // Сервер вернул новую цену (сохранение, сброс, сдвиг пола) — черновик за ней, а не наоборот.
  useEffect(() => setDraft(String(entry.priceMinutes)), [entry.priceMinutes]);

  const value = Number(draft);
  const valid = draft.trim() !== '' && Number.isInteger(value);
  const belowFloor = valid && value < floor.minutes;
  const unchanged = valid && value === entry.priceMinutes;
  const overridden = entry.serverMinutes !== null && entry.serverMinutes !== undefined;

  return (
    <div className="eco-slider">
      <div className="eco-slider-hint">
        Сейчас — <b>{entry.priceMinutes} мин</b> ({entry.priceCoins} {currencyName})
        {overridden ? ', это твоя наценка.' : ', это цена инстанса.'} Ниже цены инстанса —{' '}
        <b>{floor.minutes} мин</b> ({floor.coins} {currencyName}) — опустить нельзя: её задаёт держатель
        инстанса, потому что анимация постоянно расходует его хранилище и трафик. Выше — на твоё усмотрение.
      </div>
      <label className="eco-field">
        <span>Цена на этом сервере, мин в голосовом канале</span>
        <input
          type="number"
          inputMode="numeric"
          min={floor.minutes}
          step={50}
          value={draft}
          disabled={busy}
          onChange={(e) => setDraft(e.target.value)}
        />
      </label>
      {belowFloor && (
        <div className="eco-slider-hint">Не ниже {floor.minutes} мин — это цена инстанса.</div>
      )}
      <div className="eco-actions">
        <button
          type="button"
          className="btn"
          disabled={busy || !valid || belowFloor || unchanged}
          onClick={() => onSave(value)}
        >
          Сохранить цену
        </button>
        {overridden && (
          <button type="button" className="acc-ghost" disabled={busy} onClick={() => onSave(null)}>
            Вернуть цену инстанса
          </button>
        )}
      </div>
    </div>
  );
}

function Slider({ label, hint, value, min, max, step = 1, suffix, onChange }: SliderProps) {
  return (
    <div className="eco-slider">
      <div className="eco-slider-top">
        <span className="eco-slider-label">{label}</span>
        <span className="eco-slider-value">
          {value}
          {suffix ? ` ${suffix}` : ''}
        </span>
      </div>
      <input
        type="range"
        min={min}
        max={max}
        step={step}
        value={value}
        onChange={(e) => onChange(Number(e.target.value))}
      />
      {hint && <div className="eco-slider-hint">{hint}</div>}
    </div>
  );
}

export function EconomyPanel({ serverId }: { serverId: string }) {
  const [settings, setSettings] = useState<EconomySettingsDto | null>(null);
  const [preview, setPreview] = useState<EconomyPreview | null>(null);
  const [summary, setSummary] = useState<EconomySummary | null>(null);
  /**
   * Каталог наград владельца.
   *
   * 🔴 Цена задаётся в МИНУТАХ сидения, а не в монетах: в монеты её переводит сервер по текущей
   * ставке. Иначе один сдвиг ползунка ставки разом ломает весь прайс — вчера награда стоила вечер,
   * сегодня пять минут.
   */
  const [shop, setShop] = useState<ShopEntry[] | null>(null);
  const [shopBusy, setShopBusy] = useState<string | null>(null);
  const [retroDone, setRetroDone] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);
  // Пересчёт спрашиваем не на каждый пиксель ползунка, а с задержкой: иначе один протяг мышью
  // отправил бы к серверу десятки запросов, каждый из которых читает недельную историю.
  const debounce = useRef<number | null>(null);
  const iconRef = useRef<HTMLInputElement | null>(null);

  useEffect(() => {
    void (async () => {
      try {
        const view = await api.getEconomy(serverId);
        if (view.settings) {
          setSettings(view.settings);
          setRetroDone(!!view.settings.retroGrantedAt);
        }
        // Сводку тянем отдельно и молча: она полезна, но панель без неё работает, и ронять
        // ползунки из-за неё нельзя.
        api.getEconomySummary(serverId).then(setSummary).catch(() => setSummary(null));
        setShop(view.shop ?? null);
      } catch (err) {
        setError((err as Error).message);
      }
    })();
  }, [serverId]);

  const refreshPreview = useCallback(
    (next: EconomySettingsDto) => {
      if (debounce.current) window.clearTimeout(debounce.current);
      debounce.current = window.setTimeout(() => {
        void api
          .previewEconomy(serverId, next)
          .then(setPreview)
          .catch(() => setPreview(null));
      }, 400);
    },
    [serverId],
  );

  useEffect(() => {
    if (settings) refreshPreview(settings);
  }, [settings, refreshPreview]);

  useEffect(() => () => { if (debounce.current) window.clearTimeout(debounce.current); }, []);

  // 🔴 Ошибка ДЕЙСТВИЯ не прячет панель (04.09). Раньше любой отказ — например «экономика ещё не
  // настроена» в ответ на ретро — заменял собой ВСЮ панель: человек нажимал кнопку и терял из виду
  // ползунки, тумблер и сам повод, по которому нажимал. Прячем только тогда, когда показывать
  // действительно нечего: настройки не загрузились вовсе.
  if (error && !settings) return <div className="admin-error">{error}</div>;
  if (!settings) return <div className="muted">Загрузка…</div>;

  const patch = (p: Partial<EconomySettingsDto>) => setSettings({ ...settings, ...p });

  async function save() {
    if (!settings) return;
    setBusy(true);
    setError(null);
    try {
      await api.saveEconomy(serverId, settings);
      setSaved(true);
      window.setTimeout(() => setSaved(false), 2000);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  }

  async function uploadIcon(file: File) {
    if (!settings) return;
    setBusy(true);
    setError(null);
    try {
      const { iconUrl } = await api.uploadCoinIcon(serverId, file);
      setSettings({ ...settings, iconUrl });
    } catch (err) {
      // Отказ приходит текстом с сервера («анимированную нельзя», «файл больше 128 КБ») — показываем
      // его как есть: он написан для человека и объясняет ПОЧЕМУ.
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  }

  /**
   * Сохранить цену или доступность позиции.
   *
   * ⚠️ Ответ сервера содержит ВЕСЬ каталог с пересчитанными монетами — берём его целиком, а не
   * правим строку у себя. Считать цену на клиенте значило бы завести вторую формулу, которая рано
   * или поздно разойдётся с серверной.
   */
  async function patchShop(item: string, patch: { priceMinutes?: number | null; enabled?: boolean }) {
    setShopBusy(item);
    setError(null);
    try {
      const res = await api.setShopItem(serverId, item, patch);
      setShop(res.shop);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setShopBusy(null);
    }
  }

  async function retro() {
    if (!settings) return;
    // 🔴 Предпросмотр — ОБЯЗАТЕЛЬНЫЙ шаг (#121). Ретро одноразово и необратимо, а настройки при
    // нажатии любые: нажал с неверной ставкой — откатывать руками по журналу. Поэтому спрашиваем
    // не «начислить?», а показываем итоговые числа по людям и спрашиваем про НИХ.
    setBusy(true);
    setError(null);
    let plan;
    try {
      plan = await api.previewRetro(serverId);
    } catch (err) {
      setError((err as Error).message);
      setBusy(false);
      return;
    }
    setBusy(false);
    if (plan.samples === 0) {
      alert('Статистики присутствия ещё нет — начислять не за что.');
      return;
    }
    const lines = plan.people.map((p) => `  ${p.displayName} — ${p.coins} (${p.hours} ч)`).join(`\n`);
    const tail = plan.skipped > 0 ? `\n\nОбойдём ${plan.skipped}: отказались от участия либо уже не на сервере.` : '';
    if (
      !confirm(
        `Начислить ${plan.granted} монет на ${plan.people.length} человек?\n\n` +
          `${lines}${tail}\n\n` +
          `Считано по ${plan.samples} срезам за всё время до ${new Date(plan.until).toLocaleString('ru-RU')}.\n` +
          `Это делается ОДИН раз за всю жизнь сервера, и отменить его нельзя.`,
      )
    )
      return;
    setBusy(true);
    setError(null);
    try {
      const res = await api.grantRetro(serverId);
      setRetroDone(true);
      // ⚠️ Про пропущенных говорим прямо: кого-то обошли (отказался от участия или уже не на
      // сервере), и «почему мне не пришло» обязано иметь ответ ещё до того, как вопрос прозвучит.
      const skipped =
        res.skipped > 0 ? `\n\nОбошли ${res.skipped}: они отказались от участия либо уже не на сервере.` : '';
      alert(`Начислено ${res.granted} монет на ${res.people} человек.${skipped}`);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="eco-panel">
      {error && <div className="admin-error">{error}</div>}
      <div className="eco-row-toggle">
        <div>
          <strong>Монеты на этом сервере</strong>
          <div className="eco-slider-hint">
            Выключено — никто ничего не копит и не видит. Сбор статистики присутствия при этом идёт
            своим чередом.
          </div>
        </div>
        <Toggle checked={settings.enabled} onChange={(v) => patch({ enabled: v })} />
      </div>

      {/* Иконка + название рядом: вместе они и составляют «лицо» валюты, порознь выглядят
          недоделкой. Своих классов не завожу — `styles.css` сейчас за Codex под жест типа. */}
      <div className="eco-row-toggle">
        <span>
          Значок валюты{' '}
          {settings.iconUrl ? (
            <img src={settings.iconUrl} alt="" style={{ width: 18, height: 18, verticalAlign: 'middle', borderRadius: 4 }} />
          ) : (
            <span aria-hidden>🪙</span>
          )}
        </span>
        <button type="button" className="btn eco-retro" disabled={busy} onClick={() => iconRef.current?.click()}>
          Загрузить
        </button>
      </div>
      <input
        ref={iconRef}
        type="file"
        accept="image/png,image/webp"
        hidden
        onChange={(e) => {
          const f = e.target.files?.[0];
          e.target.value = '';
          if (f) void uploadIcon(f);
        }}
      />

      <label className="eco-field">
        <span>Как называется валюта</span>
        <input
          value={settings.currencyName}
          maxLength={24}
          onChange={(e) => patch({ currencyName: e.target.value })}
        />
      </label>

      <h4 className="eco-head">Сколько капает</h4>
      <Slider
        label="Ставка"
        suffix="монет за 5 минут"
        min={0}
        max={100}
        value={settings.ratePer5min}
        hint={`Вдвоём это ${coinsPerHour(settings.ratePer5min, 100)} монет в час. Для сравнения: у Twitch — 120 в час.`}
        onChange={(v) => patch({ ratePer5min: v })}
      />
      <Slider
        label="Один в канале"
        suffix="% ставки"
        min={0}
        max={100}
        value={settings.alonePercent}
        hint="Главный тормоз против «оставил на ночь». Ноль — совсем не капает, но тогда и тот, кто зашёл первым и ждёт друзей, не получает ничего."
        onChange={(v) => patch({ alonePercent: v })}
      />
      <Slider
        label="Втроём и больше"
        suffix="% ставки"
        min={100}
        max={300}
        value={settings.companyPercent}
        hint="Надбавка за компанию: монеты за то, что вы общаетесь, а не за то, что приложение запущено."
        onChange={(v) => patch({ companyPercent: v })}
      />
      <Slider
        label="Потолок за сутки"
        suffix="монет"
        min={0}
        max={5000}
        step={50}
        value={settings.dailyCap}
        hint="Предохранитель: упирается в него и честный марафонец, и удавшийся фарм. Ноль — без потолка."
        onChange={(v) => patch({ dailyCap: v })}
      />
      <Slider
        label="Выплата раз в"
        suffix="минут в голосовом канале"
        min={1}
        max={60}
        step={1}
        value={settings.payoutMinutes}
        hint="Между выплатами заработанное копится и переживает выход из канала: недосиженное время замирает и продолжается, когда человек вернётся."
        onChange={(v) => patch({ payoutMinutes: v })}
      />
      <div className="eco-row-toggle">
        <span className="eco-toggle-text">
          Доначислять при повышении ставки
          <small>
            Выключено — балансы не меняются ни при каком движении ползунка. Включать стоит на одно
            осознанное крупное повышение: иначе качели вверх-вниз незаметно раздувают кошельки.
          </small>
        </span>
        <Toggle checked={settings.compensateOnRaise} onChange={(v) => patch({ compensateOnRaise: v })} />
      </div>
      <Slider
        label="Резать ставку после"
        suffix="минут за сутки"
        min={0}
        max={720}
        step={30}
        value={settings.decayAfterMinutes}
        hint="Ноль — не резать вовсе."
        onChange={(v) => patch({ decayAfterMinutes: v })}
      />
      <Slider
        label="…и во сколько раз"
        suffix="% от прошлой"
        min={0}
        max={100}
        step={5}
        value={settings.decayPercent}
        hint="Ступенчато: каждый следующий такой отрезок режется ещё раз. При 120 минутах и 50 % это «первые два часа полностью, следующие два — вполовину, дальше вчетверо»."
        onChange={(v) => patch({ decayPercent: v })}
      />

      <Slider
        label="Выключен микрофон"
        suffix="% от ставки"
        min={0}
        max={100}
        step={5}
        value={settings.mutedPercent}
        hint="Замьюченный ≠ отсутствующий: человек слушает и играет со всеми, просто дома шумно. По умолчанию без штрафа."
        onChange={(v) => patch({ mutedPercent: v })}
      />
      <Slider
        label="Надето «не слышу»"
        suffix="% от ставки"
        min={0}
        max={100}
        step={5}
        value={settings.deafenedPercent}
        hint="Тут человек не участвует в разговоре вовсе. Перекрывает предыдущий ползунок — множители не перемножаются."
        onChange={(v) => patch({ deafenedPercent: v })}
      />
      <Slider
        label="Статус «отошёл»"
        suffix="% от ставки"
        min={0}
        max={100}
        step={5}
        value={settings.awayPercent}
        hint="Человека нет у компьютера: он поставил «отошёл» сам либо его увела автоматика — она считает простой мыши и клавиатуры на уровне системы, поэтому играющего в полноэкранную игру не трогает. Перекрывает оба ползунка выше. ⚠️ Это единственная защита от «выключил микрофон на железе и ушёл»: о таком мьюте приложение не знает вовсе."
        onChange={(v) => patch({ awayPercent: v })}
      />

      <h4 className="eco-head">Типнуть друга</h4>
      <Slider
        label="Сколько уходит за жест"
        suffix="монет"
        min={1}
        max={200}
        value={settings.tipAmount}
        onChange={(v) => patch({ tipAmount: v })}
      />
      <Slider
        label="Налог на перевод"
        suffix="%"
        min={0}
        max={90}
        step={5}
        value={settings.tipTaxPercent}
        hint={`Дойдёт ${Math.floor((settings.tipAmount * (100 - settings.tipTaxPercent)) / 100)} из ${settings.tipAmount}. Налог не наказание: он делает ферму на пустых аккаунтах невыгодной и заодно не даёт монетам копиться бесконечно. На дружеском сервере можно поставить ноль.`}
        onChange={(v) => patch({ tipTaxPercent: v })}
      />
      <Slider
        label="Больше этого за сутки не отдать"
        suffix="монет"
        min={0}
        max={2000}
        step={25}
        value={settings.tipDailyOut}
        onChange={(v) => patch({ tipDailyOut: v })}
      />
      <Slider
        label="Больше этого за сутки не получить"
        suffix="монет"
        min={0}
        max={2000}
        step={25}
        value={settings.tipDailyIn}
        onChange={(v) => patch({ tipDailyIn: v })}
      />
      <Slider
        label="Больше этого за сутки не получить ОТ ОДНОГО"
        suffix="монет"
        min={0}
        max={2000}
        step={5}
        value={settings.tipDailyPair}
        hint="Чтобы один человек не мог в одиночку забить кому-то весь дневной приём и запереть его от остальных. Толпой засыпать монетами по-прежнему можно — это про одного отправителя, а не про всех. 0 — без предела."
        onChange={(v) => patch({ tipDailyPair: v })}
      />

      <h4 className="eco-head">Бонус по клику</h4>
      <Slider
        label="Надбавка за пойманного гуся"
        suffix="монет"
        min={0}
        max={100}
        step={1}
        value={settings.gooseBonus}
        hint="Гусь выглядывает и висит, пока его не нажмут; поймавший получает НАДБАВКУ сверх обычного начисления. Это дешёвое доказательство присутствия: спящий не кликнет. Играющий в полный экран увидит его не сразу — поэтому гусь и ждёт. Одному в канале гусь не выходит вовсе. 0 — гуся нет нигде."
        onChange={(v) => patch({ gooseBonus: v })}
      />
      <Slider
        label="Следующий гусь — не раньше, чем через"
        suffix="минут"
        min={0}
        max={240}
        step={5}
        value={settings.gooseMinutes}
        hint="Отсчёт идёт от ПОИМКИ, а не от появления: пропустить гуся нельзя, можно только отложить — и тогда следующий сдвинется на столько же. Считается по человеку, а не по каналу: перескакивание между каналами ожидание не обнуляет."
        onChange={(v) => patch({ gooseMinutes: v })}
      />
      <Slider
        label="Надбавка, если поймал в деафене"
        suffix="монет"
        min={0}
        max={100}
        step={1}
        value={settings.gooseDeafenedBonus}
        hint="Выключенный звук означает «в канале, но вне разговора» — та же логика, по которой деафен режет и ставку голоса. Состояние смотрится в момент нажатия, а не появления гуся. Больше обычной надбавки не бывает: выставите выше — сработает обычная."
        onChange={(v) => patch({ gooseDeafenedBonus: v })}
      />

      <Slider
        label="Стрик: монет за каждый день подряд"
        suffix="монет"
        min={0}
        max={100}
        step={1}
        value={settings.streakBonus}
        hint="Награда за регулярность, а не за длительность: пришёл сегодня — получил, пришёл семь дней подряд — семикратно. Дальше недели не растёт. Пропустил день — цепочка начинается заново, но бонус за сегодня всё равно даётся. 0 — стрика нет."
        onChange={(v) => patch({ streakBonus: v })}
      />

      <h4 className="eco-head">Сезоны</h4>
      <div className="eco-row-toggle">
        <span>Помесячные сезоны</span>
        <Toggle
          checked={settings.seasonLength === 'month'}
          onChange={(v) => {
            // 🔴 Спрашиваем ДО применения. Смена сетки может досрочно подвести прошедшие месяцы и
            // выдать корону — это необратимо, и узнавать об этом постфактум человек не должен.
            // Текст описывает то, что делает сервер (`freezeWindow` + пересчёт по журналу): сезон
            // по новой сетке начинается с её календарной границы, а не с момента нажатия.
            if (
              !confirm(
                v
                  ? 'Перейти на помесячные сезоны?\n\nСчёт сезона у всех пересчитается с 1-го числа текущего месяца. Если сезон начался в этом же месяце, он просто продолжится как месяц; если раньше — прошедшие полные месяцы подведутся досрочно: итоги заморозятся, победитель получит корону.'
                  : 'Вернуться к сезонам по временам года?\n\nСчёт сезона у всех пересчитается с первого дня текущего времени года — уже закрытые месяцы войдут в него целиком. Корона за последний закрытый месяц остаётся до конца сезона.',
              )
            )
              return;
            patch({ seasonLength: v ? 'month' : 'quarter' });
          }}
          label={settings.seasonLength === 'month' ? 'месяц' : 'времена года'}
        />
      </div>
      <div className="eco-slider-hint">
        Времена года — длинный сезон: смысл появляется к концу, корона меняется четыре раза в год.
        Месяц даёт двенадцать поводов и живую гонку. ⚠️ Переключение — смена календарной сетки: счёт
        сезона пересчитывается с её границы, прошедшие полные периоды старой сетки подводятся досрочно.
      </div>

      <h4 className="eco-head">Что продаётся</h4>
      {shop === null ? (
        <div className="muted">Каталог не загрузился.</div>
      ) : (
        <>
          <div className="eco-slider-hint">
            🔴 Цена в МИНУТАХ сидения, а не в монетах. В монеты её пересчитывает сервер по текущей
            ставке, поэтому подъём ставки не ломает прайс: награда как стоила вечер, так и стоит.
          </div>
          {shop.map((e) => (
            <div className="eco-shop-item" key={e.item}>
              <div className="eco-row-toggle">
                <strong>{e.label}</strong>
                <Toggle
                  checked={e.enabled}
                  onChange={(v) => void patchShop(e.item, { enabled: v })}
                  label={e.enabled ? 'продаётся' : 'снята с продажи'}
                />
              </div>
              <div className="eco-slider-hint">{e.hint}</div>
              {/* 🔴 Цена аватара — две ступени (14.09): пол задаёт держатель инстанса (02.09 — анимация
                  расходует его хранилище и трафик постоянно), владелец сервера вправе наценить сверху. */}
              {e.item === 'animated-avatar' ? (
                <AvatarPriceEditor
                  entry={e}
                  currencyName={settings.currencyName}
                  busy={shopBusy === e.item}
                  onSave={(minutes) => void patchShop(e.item, { priceMinutes: minutes })}
                />
              ) : (
                <Slider
                  label="Цена"
                  suffix="мин в голосовом канале"
                  min={1}
                  max={600}
                  step={5}
                  value={e.priceMinutes}
                  hint={`По нынешней ставке это ${e.priceCoins} ${settings.currencyName}.`}
                  onChange={(v) => void patchShop(e.item, { priceMinutes: v })}
                />
              )}
              {shopBusy === e.item && <div className="muted">Сохраняю…</div>}
            </div>
          ))}
        </>
      )}

      {/* Цены в минутах, а не в монетах — тогда сдвиг ставки меняет масштаб, а не ломает прайс. */}
      <h4 className="eco-head">Во сколько это обходится человеку</h4>
      <div className="eco-prices">
        {PRICE_HINTS.map((p) => (
          <div key={p.label} className="eco-price">
            <span>{p.label}</span>
            <span className="eco-price-val">
              {p.coins(settings)} монет · {minutesForCoins(p.coins(settings), settings.ratePer5min)} мин сидения
            </span>
          </div>
        ))}
      </div>

      <h4 className="eco-head">Что было бы за прошлую неделю</h4>
      {preview === null ? (
        <div className="muted">Считаю…</div>
      ) : preview.samples === 0 ? (
        <div className="muted">
          Статистики пока нет. Она копится сама, пока люди сидят в голосовом канале — вернитесь через несколько
          дней, и здесь появятся настоящие цифры.
        </div>
      ) : (
        <>
          <div className="eco-slider-hint">
            По {preview.samples} срезам за {preview.days} дней. Это не прикидка, а прогон реальной
            истории через ту же формулу, по которой идёт начисление.
          </div>
          <table className="eco-table">
            <thead>
              <tr>
                <th>Кто</th>
                <th className="num">В канале</th>
                <th className="num">Получил бы</th>
              </tr>
            </thead>
            <tbody>
              {preview.people.map((p) => (
                <tr key={p.userId}>
                  <td>{p.displayName}</td>
                  <td className="num">{p.hours} ч</td>
                  <td className="num strong">{p.coins}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </>
      )}

      <h4 className="eco-head">Что происходит сегодня</h4>
      {summary === null ? (
        <div className="muted">Сводка пока не загрузилась.</div>
      ) : (
        <>
          {/* 🔴 Сверка журнала с балансами — единственный способ ЗАМЕТИТЬ порчу денег раньше, чем
              на неё пожалуется человек. Сумма строк журнала обязана равняться балансу; каждый
              писатель баланса пишет и строку журнала одной транзакцией, поэтому расхождение при
              исправной работе невозможно. Показываем ВСЕГДА, в том числе когда всё в порядке:
              «проверено, сходится» — это и есть ценность, а блок, появляющийся только при беде,
              легко принять за отсутствующий. */}
          {summary.drift.length === 0 ? (
            <div className="eco-slider-hint">
              ✅ Журнал сходится с кошельками — у всех {summary.wallets} до монеты.
            </div>
          ) : (
            <div className="eco-drift">
              <strong>Журнал разошёлся с кошельками — этого не должно происходить никогда</strong>
              <div>
                Баланс меняется только вместе со строкой журнала, в одной транзакции. Расхождение
                значит, что деньги где-то поменялись мимо журнала. Не крутить ползунки, пока не
                разобрались.
              </div>
              {summary.drift.map((d) => (
                <div key={d.userId} className="eco-drift-row">
                  <span>{d.displayName}</span>
                  <span>
                    в кошельке {d.balance}, по журналу {d.ledger} ({d.balance - d.ledger > 0 ? '+' : ''}
                    {d.balance - d.ledger})
                  </span>
                </div>
              ))}
            </div>
          )}
          <div className="eco-prices">
            <div className="eco-price">
              <span>Начислено за сегодня</span>
              <span className="eco-price-val">{summary.totals.accrued} монет</span>
            </div>
            <div className="eco-price">
              <span>Подарено типами</span>
              <span className="eco-price-val">
                {summary.totals.tipped} монет за {summary.totals.tips} жестов
              </span>
            </div>
            <div className="eco-price">
              <span>Сгорело налогом</span>
              <span className="eco-price-val">{summary.totals.burned} монет</span>
            </div>
            <div className="eco-price">
              <span>Всего на руках</span>
              <span className="eco-price-val">
                {summary.circulation} монет в {summary.wallets} кошельках
              </span>
            </div>
          </div>
          {summary.top.length > 0 && (
            <table className="eco-table">
              <thead>
                <tr>
                  <th>Кто</th>
                  <th className="num">Наработал сегодня</th>
                </tr>
              </thead>
              <tbody>
                {summary.top.map((p) => (
                  <tr key={p.userId}>
                    <td>{p.displayName}</td>
                    <td className="num strong">{p.coins}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </>
      )}

      <h4 className="eco-head">Начислить за уже собранное</h4>
      <div className="eco-slider-hint">
        Пока шёл сбор, никто не знал, что идёт счёт, — значит никто и не подстраивался. Такой честной
        картины больше не будет. Начислите её один раз, и в день запуска у людей уже что-то есть, а
        не пустой ноль.
      </div>
      <button type="button" className="btn eco-retro" disabled={busy || retroDone} onClick={() => void retro()}>
        {retroDone ? 'Уже начислено' : 'Начислить за прошлые вечера'}
      </button>

      <div className="eco-actions">
        <button type="button" className="btn primary" disabled={busy} onClick={() => void save()}>
          Сохранить
        </button>
        {saved && <span className="eco-saved">Сохранено</span>}
      </div>
    </div>
  );
}
