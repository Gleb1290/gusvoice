import { useEffect, useState, type ReactNode } from 'react';
import { api } from '../api';
import coinIcon from '../assets/guscoin.svg';
import featherLong from '../assets/confetti/feather-cobalt-long.png';
import featherCrown from '../assets/confetti/feather-ivory-crown.png';
import featherShaft from '../assets/confetti/feather-ivory-shaft.png';
import { useStore } from '../store';
import { Goose } from './Goose';
import { Icon } from './Icon';

/**
 * Приветственное окно экономики — презентация фичи ОБЫЧНОМУ человеку (запрос 03.09).
 *
 * 🔴 **Язык монет и званий, без кухни.** Ни минут, ни ставок, ни множителей, ни потолка: человек
 * узнаёт, ОТКУДА монеты, ЧТО с ними делать и ГДЕ смотреть. Правила игры, которые нужны, чтобы
 * действовать («в компании больше», «гусь ждёт клика», «типы в звание не идут»), — есть; как это
 * считается — нет. Кухня живёт в панели того, кто управляет экономикой.
 *
 * 🔴 **Картинки — из настоящих деталей фичи**, а не чужие иллюстрации: маскот в своих позах, наша
 * монета, корона и свечение ника, перья МЕГА пока, чипы лестницы званий. Человек потом узнаёт их в
 * приложении — окно учит глаз, а не только читает текст.
 *
 * ⚠️ Показывается ОДИН РАЗ на человека: отметка `economyWelcomeSeen` едет с профилем и ставится при
 * закрытии — любым способом, включая Esc. Закрыл сразу — значит не хотел; повторно открывается
 * кнопкой «Как это работает» в кошельке и со стенда эффектов.
 */

interface Slide {
  key: string;
  title: string;
  text: string;
  art: ReactNode;
}

/** Аватар-кружок с буквой — как в списках, только без человека. */
function Bubble({ letter, className }: { letter: string; className?: string }) {
  return <span className={`ew-bubble${className ? ` ${className}` : ''}`}>{letter}</span>;
}

const SLIDES: Slide[] = [
  {
    key: 'coins',
    title: 'На сервере появились монеты',
    text: 'Они капают сами, пока ты сидишь в голосовом канале с друзьями. Одному — по чуть-чуть, вдвоём — полной мерой, втроём и больше — с надбавкой. Выключенный микрофон заработку не мешает, а вот «отошёл» — четверть ставки: за пустое кресло полную не платят. Сколько накапало, видно в кошельке — это монетка с числом наверху; нажми на неё.',
    art: (
      <div className="ew-art-row">
        <Goose pose="wave" size={110} />
        <span className="ew-coin ew-coin-big">
          <img src={coinIcon} alt="" />
        </span>
      </div>
    ),
  },
  {
    key: 'goose',
    title: 'Лови гуся',
    text: 'Иногда из-за края окна выглядывает гусь. Успей нажать — получишь монеты сверху. Он терпеливый: висит, пока его не поймают. Пропущенные не копятся — новый просто сменяет старого. Выглядывает только тем, кто сидит в голосовом канале.',
    art: (
      <div className="ew-art-peek">
        <Goose pose="peek" size={120} className="ew-peek" />
        <span className="ew-plus">+монеты</span>
      </div>
    ),
  },
  {
    key: 'streak',
    title: 'Дни подряд',
    // ⚠️ Первая версия говорила «бонус чуть больше» и не говорила, К ЧЕМУ он (вопрос на приёмке). Теперь
    // прямо: монеты сверху к обычному заработку, за сам приход, раз в день.
    text: 'Заходишь в голосовой канал день за днём — и каждый день сверху капает бонус за сам приход: монеты плюсом к обычному заработку, раз в день, с каждым днём подряд больше — до недели. Пропустил день — счёт с первого, но за сегодня всё равно дадут. Свои дни подряд видны в кошельке.',
    art: (
      <div className="ew-art-row">
        <Goose pose="honk" size={84} />
        <span className="ew-days" aria-hidden>
          {['пн', 'вт', 'ср', 'чт', 'пт', 'сб', 'вс'].map((d, i) => (
            <span key={d} className={i < 4 ? 'ew-day ew-day-on' : 'ew-day'}>
              {d}
            </span>
          ))}
        </span>
      </div>
    ),
  },
  {
    key: 'tips',
    title: 'Типни за шутку',
    text: 'Кто-то классно пошутил? Зажми Alt и щёлкни по его нику в списке канала — или открой карточку и нажми «Типнуть» — он получит монеты от тебя, а рядом с ником всплывёт, кто кого. Типы — благодарность: они пополняют кошелёк, но в звание не идут.',
    art: (
      <div className="ew-art-row">
        <Bubble letter="Т" />
        <span className="ew-arrow" aria-hidden>
          <span className="ew-coin">
            <img src={coinIcon} alt="" />
          </span>
          <Icon name="chevron-right" size={18} />
        </span>
        <Bubble letter="Ш" className="ew-bubble-hit" />
        <span className="ew-hint-chip">Т типнул Ш</span>
      </div>
    ),
  },
  {
    key: 'levels',
    title: 'Звания',
    text: 'Заработанные монеты складываются в уровень и звание — от Птенца до Того самого Гуся. Пороги в монетах видны в кошельке. Тратишь монеты — звание не падает: считается заработанное, а не остаток.',
    art: (
      <ol className="level-stages ew-stages" aria-hidden>
        <li className="level-stage-done"><span>Птенец</span><b>0</b></li>
        <li className="level-stage-now"><span>Гусёнок</span><b>360</b></li>
        <li><span>Свой в стае</span><b>1440</b></li>
        <li><span>Матёрый гусь</span><b>4000</b></li>
        <li><span>…</span><b>Тот самый Гусь</b></li>
      </ol>
    ),
  },
  {
    key: 'season',
    title: 'Сезон и корона',
    text: 'У каждого сезона своя таблица лидеров — она в кошельке. Кто заработал больше всех, весь следующий сезон носит корону над аватаркой и светится в списках.',
    art: (
      <div className="ew-art-row">
        <span className="ew-crowned">
          <span className="ew-crown" aria-hidden>
            <Icon name="crown" size={22} />
          </span>
          <Bubble letter="П" />
        </span>
        <span className="ew-name crowned-name">Победитель сезона</span>
      </div>
    ),
  },
  {
    key: 'shop',
    title: 'Лавка',
    text: 'Щипок — перья, звук и тряска окна тому, кого выбрал: правой кнопкой по человеку в голосовом канале → «Ущипнуть». Звуки саундборда — кнопка в доке голосового канала. Анимированный аватар — на 30 дней и на всех серверах. Цены — в лавке, она в кошельке.',
    art: (
      <div className="ew-art-row ew-art-shop">
        <img src={featherLong} alt="" className="ew-feather ew-feather-1" aria-hidden />
        <img src={featherCrown} alt="" className="ew-feather ew-feather-2" aria-hidden />
        <img src={featherShaft} alt="" className="ew-feather ew-feather-3" aria-hidden />
        <span className="ew-shop-icon" aria-hidden>
          <Icon name="volume" size={22} />
        </span>
        <Bubble letter="Я" className="ew-bubble-anim" />
      </div>
    ),
  },
];

export function EconomyWelcome({ onClose }: { onClose: () => void }) {
  const [step, setStep] = useState(0);
  const currency = useStore((s) => {
    const id = s.bootstrap?.server.id;
    return (id && s.economy[id]?.currencyName) || 'монеты';
  });
  const setAuth = useStore((s) => s.setAuth);
  const last = step === SLIDES.length - 1;

  /**
   * Закрытие = «видел». Отметка уезжает на сервер молча: провал не должен ни мешать закрыть окно,
   * ни ронять приложение — худшее, что случится, окно покажется ещё раз при следующем входе.
   */
  function close() {
    onClose();
    api
      .updateProfile({ economyWelcomeSeen: true })
      .then((me) => setAuth(me))
      .catch(() => {});
  }

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') close();
      else if (e.key === 'ArrowRight') setStep((s) => Math.min(SLIDES.length - 1, s + 1));
      else if (e.key === 'ArrowLeft') setStep((s) => Math.max(0, s - 1));
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const slide = SLIDES[step];
  return (
    <div className="modal-overlay" onClick={close}>
      <section
        className="modal eco-welcome"
        role="dialog"
        aria-modal="true"
        aria-labelledby="ew-title"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="ew-head">
          <span className="ew-eyebrow">
            <img src={coinIcon} alt="" className="ew-eyebrow-coin" />
            {currency}
          </span>
          <button type="button" className="icon-close" title="Закрыть" onClick={close}>
            <Icon name="close" size={18} />
          </button>
        </div>

        {/* Ключ на слайде — чтобы смена перерисовывала картинку с входной анимацией, а не морфила. */}
        <div className="ew-art" key={slide.key}>
          {slide.art}
        </div>
        <h2 id="ew-title" className="ew-title">
          {slide.title}
        </h2>
        <p className="ew-text">{slide.text}</p>
        {last && (
          <p className="ew-foot">
            Не хочешь участвовать — в кошельке есть выключатели. Это окно снова откроется по кнопке «Как это работает»
            там же.
          </p>
        )}
        {/* ⚠️ Честное предупреждение вместо тихой правки чисел (запрос 04.09). Экономику
            калибруют по живым данным, цены и бонусы будут двигаться — человек, который узнал об
            этом ЗАРАНЕЕ, воспримет сдвиг как настройку, а не как «у меня отняли». Висит на каждом
            слайде, а не только на последнем: до последнего доходят не все. */}
        <p className="ew-beta">
          Монеты только запустились: цены, бонусы и правила ещё будут меняться. Следите за новостями сервера.
        </p>

        <div className="ew-nav">
          <button type="button" className="ew-btn" disabled={step === 0} onClick={() => setStep((s) => s - 1)}>
            Назад
          </button>
          <span className="ew-dots" aria-label={`Шаг ${step + 1} из ${SLIDES.length}`}>
            {SLIDES.map((s, i) => (
              <button
                key={s.key}
                type="button"
                className={i === step ? 'ew-dot ew-dot-on' : 'ew-dot'}
                aria-label={s.title}
                onClick={() => setStep(i)}
              />
            ))}
          </span>
          {last ? (
            <button type="button" className="ew-btn ew-btn-main" onClick={close}>
              Понятно
            </button>
          ) : (
            <button type="button" className="ew-btn ew-btn-main" onClick={() => setStep((s) => s + 1)}>
              Дальше
            </button>
          )}
        </div>
      </section>
    </div>
  );
}
