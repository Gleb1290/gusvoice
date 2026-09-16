import { useEffect, useState } from 'react';
import { EFFECT_MS, featherCount, type EffectConditions, type EffectPlan } from '../effects';
import { SHAKE_MS } from '../uiShake';
import { playSound } from '../sounds';
import { mockEconomyView, setMockChip, setMockEconomy } from '../benchMock';
import { currentConditions, planNow, pulseChip } from '../effectsDom';
import { fireEffect } from '../effectsBus';
import { useStore } from '../store';
import { emitBenchGooseOffer } from '../sockets';

/**
 * Стенд эффектов: выстрелить любым эффектом руками, в ТЕКУЩЕЙ раскладке (#120).
 *
 * 🔴 Зачем он вперёд самих эффектов. Таблица проверок из #120 — двенадцать раскладок: узкое окно,
 * свёрнутый сайдбар, открытые ЛС, чужой сервер, модалка, полный экран, фон, мобильная ширина,
 * выключенная анимация. Дожидаться настоящих событий раз в десять минут — значит проверить три
 * случая из двенадцати, а остальное поймать в проде.
 *
 * 🔴 Живёт в НАСТОЯЩЕМ приложении, а не отдельной страницей, и это принципиально: весь смысл в том,
 * чтобы поймать «эффект летит в чип, а чипа на экране нет». Это видно только в живой раскладке — с
 * тем сайдбаром, той шириной окна и той открытой модалкой, что у человека прямо сейчас.
 *
 * ⚠️ Ничего не отправляет на сервер и не трогает монеты: только локальная отрисовка. Открывается
 * сочетанием клавиш и только у супер-админа — остальные его не увидят.
 */

/**
 * Что стенд умеет выстрелить. Новый эффект — новая строка, и он сразу получает все проверки.
 *
 * ⚠️ Подсказка у перьев считается от ТЕКУЩЕГО окна: их количество зависит от площади, и постоянное
 * число в подписи врало бы ровно там, где стенд и проверяют — на нестандартной раскладке.
 */
const effectList = (w: number, h: number) =>
  [
    { id: 'tip', label: 'Типнули меня', ms: EFFECT_MS.tip, hint: 'подсказка в списке + дёрганье чипа' },
    { id: 'feathers', label: 'Щипок целиком', ms: EFFECT_MS.feathers, hint: `${featherCount(w, h)} перьев + тряска` },
    { id: 'shake', label: 'Только тряска UI', ms: SHAKE_MS, hint: 'подобрать амплитуду отдельно' },
  ] as const;

/** Подмена условий: чтобы проверить ветку, не подгоняя под неё окно руками. */
type Override = keyof Pick<EffectConditions, 'tabHidden' | 'fullscreen' | 'sameServer' | 'reducedMotion'> | 'noTarget';

const OVERRIDES: { id: Override; label: string }[] = [
  { id: 'reducedMotion', label: 'выключена анимация' },
  { id: 'noTarget', label: 'чипа нет на экране' },
  { id: 'sameServer', label: 'событие с чужого сервера' },
  { id: 'tabHidden', label: 'вкладка в фоне' },
  { id: 'fullscreen', label: 'полноэкранный показ' },
];

function planText(p: EffectPlan): string {
  if (p.kind === 'fly') return `летим в чип · ${Math.round(p.to.x)}, ${Math.round(p.to.y)}`;
  if (p.kind === 'inplace') return 'цели нет — показываем НА МЕСТЕ';
  if (p.kind === 'static') return 'без движения (смена состояния)';
  const why =
    p.reason === 'hidden' ? 'вкладка скрыта' : p.reason === 'fullscreen' ? 'полный экран' : 'чужой сервер';
  return `не показываем: ${why}`;
}

export function EffectsBench({ onClose }: { onClose: () => void }) {
  const [on, setOn] = useState<Override[]>([]);
  const [last, setLast] = useState<{ effect: string; plan: EffectPlan; at: number } | null>(null);
  const [size, setSize] = useState({ w: window.innerWidth, h: window.innerHeight });
  /**
   * Макет чипа.
   *
   * 🔴 Пока экономика выключена, настоящего чипа в дереве нет — и любой эффект честно уходит в
   * запасной вид. Это верное поведение, но посмотреть САМ полёт при нём невозможно. Макет даёт
   * цель, не включая экономику: он с тем же классом `.eco-chip`, поэтому находится тем же кодом,
   * что и настоящий, и путь остаётся боевым.
   * ⚠️ Стоит там же, где живёт настоящий — в шапке сервера, — чтобы длина и направление полёта
   * были правдоподобными, а не «куда-нибудь в угол».
   */
  const [mockChip, setMockChipState] = useState(false);
  /**
   * Макет всей экономики: чип, кошелёк, витрина и пункт «Сильно ткнуть» оживают локально.
   *
   * 🔴 Без него проверить экономический интерфейс нельзя ВООБЩЕ: он заперт флагом инстанса, и
   * единственная альтернатива — включить экономику на бою, то есть показать фичу людям раньше
   * времени.
   */
  const [mockEcon, setMockEconState] = useState(false);
  const toggleEcon = (v: boolean) => {
    setMockEconState(v);
    setMockEconomy(v);
    const serverId = useStore.getState().bootstrap?.server.id;
    if (!serverId) return;
    if (v)
      useStore
        .getState()
        .setEconomy(serverId, mockEconomyView(undefined, useStore.getState().user?.id));
    else useStore.setState((s) => {
      // Снимаем ровно свой макет, а не чистим чужие серверы.
      const next = { ...s.economy };
      delete next[serverId];
      return { economy: next };
    });
  };
  const toggleMock = (v: boolean) => {
    setMockChipState(v);
    // Рисует его сам `CoinChip` — иначе макет не знает про раскладку и врёт (#120).
    setMockChip(v);
  };
  /**
   * Стенд закрывает собой ровно ту область, которую проверяет — особенно в узком окне, где места и
   * так нет. Поэтому он умеет сворачиваться до полоски и переезжать в другой угол.
   */
  const [folded, setFolded] = useState(false);
  const [right, setRight] = useState(false);

  // Ширину окна показываем живьём: половина проверок из таблицы — про раскладку, и подгонять её
  // вслепую неудобно.
  useEffect(() => {
    const onResize = () => setSize({ w: window.innerWidth, h: window.innerHeight });
    window.addEventListener('resize', onResize);
    return () => window.removeEventListener('resize', onResize);
  }, []);

  const overrides = (): Partial<EffectConditions> => {
    const o: Partial<EffectConditions> = {};
    if (on.includes('reducedMotion')) o.reducedMotion = true;
    if (on.includes('noTarget')) o.target = null;
    if (on.includes('sameServer')) o.sameServer = false;
    if (on.includes('tabHidden')) o.tabHidden = true;
    if (on.includes('fullscreen')) o.fullscreen = true;
    return o;
  };

  const fire = (id: string) => {
    const serverId = useStore.getState().bootstrap?.server.id ?? null;
    const o = overrides();
    setLast({ effect: id, plan: planNow(serverId, o), at: Date.now() });
    // ⚠️ Стенд стреляет ТОЙ ЖЕ шиной, что и боевой код: отдельный путь начал бы расходиться с
    // настоящим поведением ровно там, где мы этого не увидим. Подмены условий уезжают вместе с
    // событием — иначе тумблеры меняли бы только надпись ниже, а эффект летел бы как обычно.
    /**
     * 🔴 Тип НЕ пускает монету (решение 02.09): отклик — дёрганье чипа плюс подсказка «кто
     * кого» в списке. Полёт поверх подсказки был бы вторым рассказом об одном событии.
     *
     * ⚠️ Кнопка какое-то время не делала НИЧЕГО: ветки для неё в этом `if` просто не было, а стенд
     * рисовал её с подписью и длительностью, то есть выглядел рабочим. Найдено на живом.
     */
    if (id === 'tip') {
      pulseChip();
      playSound('tip');
      // Имя условное: выдумывать имена живых людей нельзя.
      const me = useStore.getState().user?.id;
      // ⚠️ Пустой идентификатор — ростер его не знает, и подставится запасное имя. Ровно то, что
      // должно случиться в бою с человеком не из ростера.
      if (me) useStore.getState().pushTipHint({ toUserId: me, fromUserId: '', fromName: 'Проверка', amount: 3 });
    }
    if (id === 'feathers') {
      // Сообщение обязательно и в стенде: без него не видно, что подпись его вообще показывает.
      fireEffect({ kind: 'feathers', fromName: 'Проверка', message: 'С днём рождения!', serverId, benchOverrides: o });
    }
    if (id === 'shake') {
      fireEffect({ kind: 'shake', serverId, benchOverrides: o });
    }
  };

  const live = currentConditions(useStore.getState().bootstrap?.server.id ?? null);

  return (
    <aside className={`bench${folded ? ' bench-folded' : ''}${right ? ' bench-right' : ''}`} role="dialog" aria-label="Стенд эффектов">
      <div className="bench-head">
        <strong>Стенд эффектов</strong>
        <span className="bench-head-btns">
          <button type="button" onClick={() => setRight((v) => !v)} title="Другой угол" aria-label="Другой угол">
            ⇄
          </button>
          <button type="button" onClick={() => setFolded((v) => !v)} title={folded ? 'Развернуть' : 'Свернуть'} aria-label="Свернуть">
            {folded ? '▢' : '—'}
          </button>
          <button type="button" onClick={onClose} aria-label="Закрыть">
            ✕
          </button>
        </span>
      </div>

      <div className="bench-live">
        окно {size.w}×{size.h} · чип {live.target ? `${Math.round(live.target.x)}, ${Math.round(live.target.y)}` : 'НЕ ВИДЕН'}
        {live.reducedMotion && ' · анимация выключена в системе'}
      </div>

      {!folded && (
        <>
      <div className="bench-group">
        {effectList(size.w, size.h).map((e) => (
          <button key={e.id} type="button" className="bench-fire" onClick={() => fire(e.id)}>
            <span>{e.label}</span>
            <small>
              {e.ms} мс · {e.hint}
            </small>
          </button>
        ))}
      </div>

      {/* Гусь-бонус: показ и анимацию иначе не отполировать — настоящий выглядывает раз в двадцать
          минут и только в голосе. ⚠️ Забрать такого гуся нельзя: сервер честно откажет по
          непригодному идентификатору, и это правильно — стенд проверяет показ, а не выдачу монет. */}
      <div className="bench-group">
        <button
          type="button"
          className="bench-fire"
          onClick={() => {
            const sid = useStore.getState().bootstrap?.server.id;
            if (sid) emitBenchGooseOffer(sid);
          }}
        >
          <span>Гусь выглянул</span>
          {/* 🔴 Написано на КНОПКЕ, а не только в комментарии кода: кнопку нажали, монеты не дождались и
              завели багом (02.09). Кнопка, которая молча не делает половину ожидаемого, — ловушка. */}
          <small>Только показ и прятки; висит до нажатия, как боевой. Монеты НЕ будет: сервер
            откажет по поддельному предложению. Полёт монеты от гуся — кнопка «Монета за бонус»
            выше</small>
        </button>
      </div>

      {/* 🔴 Звуки тоже здесь: слушать их через настоящие события значит ждать чужого жеста, а
          подбирать тембр на слух надо подряд и много раз. Играются тем же кодом, что и в бою. */}
      <div className="bench-group">
        <button type="button" className="bench-fire" onClick={() => playSound('tip')}>
          <span>Звук: тип</span>
          <small>полная запись, 750 мс, потолок 0.20</small>
        </button>
        <button type="button" className="bench-fire" onClick={() => playSound('poke')}>
          <span>Звук: тык</span>
          <small>он же звучит на щипке</small>
        </button>
      </div>

      {/* Приветствие экономики: в бою показывается один раз на человека, здесь — сколько угодно.
          ⚠️ Закрытие ставит отметку «видел» и на стенде тоже — это тот же компонент. */}
      <div className="bench-group">
        <button type="button" className="bench-fire" onClick={() => useStore.getState().setEconomyWelcomeOpen(true)}>
          <span>Приветствие экономики</span>
          <small>7 слайдов для обычного человека; закрытие ставит «видел»</small>
        </button>
      </div>

      <div className="bench-group bench-overrides">
        <label>
          <input type="checkbox" checked={mockChip} onChange={(e) => toggleMock(e.target.checked)} />
          макет кошелька <small>рисуется там же, где настоящий</small>
        </label>
        <label>
          <input type="checkbox" checked={mockEcon} onChange={(e) => toggleEcon(e.target.checked)} />
          макет экономики <small>кошелёк, лавка, «Ущипнуть» — локально</small>
        </label>
        {OVERRIDES.map((o) => (
          <label key={o.id}>
            <input
              type="checkbox"
              checked={on.includes(o.id)}
              onChange={(ev) => setOn((prev) => (ev.target.checked ? [...prev, o.id] : prev.filter((x) => x !== o.id)))}
            />
            {o.label}
          </label>
        ))}
      </div>

        </>
      )}

      {last && (
        <div className={`bench-plan bench-plan-${last.plan.kind}`}>
          <b>{effectList(size.w, size.h).find((e) => e.id === last.effect)?.label}</b>
          <span>{planText(last.plan)}</span>
        </div>
      )}

      {/* Метка в точке цели: координаты сами по себе ничего не говорят, а по метке сразу видно,
          попал ли эффект в чип или улетел мимо. */}
      {last?.plan.kind === 'fly' && <span className="bench-mark" style={{ left: last.plan.to.x, top: last.plan.to.y }} />}
    </aside>
  );
}
