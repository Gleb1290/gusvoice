import { useEffect, useMemo, useState, type ReactNode } from 'react';
import { DEFAULT_GAME_TITLE_NAMES, isGameTitleKey, type RecapDto } from '@gusvoice/shared';
import { api } from '../api';
import coinIcon from '../assets/guscoin.svg';
import { isMockEconomy, mockRecap } from '../benchMock';
import { ensureGameTitles, recapStorage } from '../gameBoardClient';
import { recapSlides, titleValueText, titleUnit, writeRecapSeen, type RecapArt, type RecapSlide } from '../gameBoardRules';
import { usePhoneLayout } from '../phoneLayout';
import { useStore, type RecapOpen } from '../store';
import { BottomSheet } from './BottomSheet';
import { GameTitleMark } from './GameTitleChip';
import { Goose } from './Goose';
import { Icon } from './Icon';

/**
 * «Итоги» (ГусКоины 2, этап 6) — карусель слайдов по образцу `EconomyWelcome`: месяц игр или сезон экономики, общий и личный.
 * Ленивая сцена (`MainLayout`): ПК — модалка, телефон — `BottomSheet page`. Слайды собирает чистый `recapSlides`.
 *
 * Картинки — `assets/recap/<сцена>.png|webp|svg` (рисует Codex: cover, number, wheel, duels, predictions, voice, titles,
 * podium, burned, final): файл подхватывается сам, без правки кода; пока его нет — заглушка из простых форм и чисел.
 * Живут в этом ленивом куске, в основной бандл не попадают. Анимация — одно появление слайда; `prefers-reduced-motion` — без неё.
 *
 * Закрытие отмечает период «видел» в `localStorage` (удобство, не данные: потеряется — покажется ещё раз). Черновик
 * управляющего (`preview`) ничего не отмечает.
 */

const ART: Record<string, string> = import.meta.glob<string>('../assets/recap/*.{png,svg,webp}', {
  eager: true,
  import: 'default',
  query: '?url',
});

function artUrl(art: RecapArt, kind: RecapDto['kind']): string | null {
  // Обложка бывает в двух вариантах (`cover-games`, `cover-economy`) — сначала вариант, потом общая.
  const names = art === 'cover' ? [`cover-${kind}`, 'cover'] : [art];
  for (const n of names) {
    for (const ext of ['png', 'webp', 'svg']) {
      const url = ART[`../assets/recap/${n}.${ext}`];
      if (url) return url;
    }
  }
  return null;
}

function useNameOf(): (userId: string | null) => string {
  const members = useStore((s) => s.members);
  const me = useStore((s) => s.user);
  return useMemo(() => {
    const names = new Map(members.map((m) => [m.user.id, m.nickname || m.user.displayName]));
    return (userId) => {
      if (!userId) return 'Кто-то, кто скрыл себя';
      if (userId === me?.id) return 'Ты';
      return names.get(userId) ?? 'Кто-то из стаи';
    };
  }, [members, me?.id]);
}

/** Заглушка картинки: простые формы и числа, пока Codex не нарисовал сцену. */
function ArtStub({ slide, kind, label, titleName }: { slide: RecapSlide; kind: RecapDto['kind']; label: string; titleName: (k: string) => string }) {
  switch (slide.art) {
    case 'cover':
      return (
        <div className="ew-art-row">
          <Goose pose={kind === 'games' ? 'honk' : 'wave'} size={104} />
          <span className="rc-cal">
            <b>{label.split(' ')[0]}</b>
            <small>{label.split(' ').slice(1).join(' ')}</small>
          </span>
        </div>
      );
    case 'wheel':
      return (
        <span className="rc-wheel">
          <b>{slide.pick ?? '?'}</b>
        </span>
      );
    case 'duels':
      return (
        <div className="ew-art-row">
          <span className="ew-bubble ew-bubble-hit">Я</span>
          <span className="rc-vs">VS</span>
          <span className="ew-bubble">?</span>
        </div>
      );
    case 'predictions':
      return <span className="rc-orb">{slide.big ?? '?'}</span>;
    case 'voice':
      return (
        <span className="rc-clock">
          <Icon name="clock" size={40} />
        </span>
      );
    case 'titles':
      return (
        <div className="ew-art-row">
          {(slide.titles ?? []).slice(0, 3).map((t) => (
            <GameTitleMark key={t.key} titleKey={t.key} name={titleName(t.key)} size={64} />
          ))}
        </div>
      );
    case 'podium':
      return (
        <div className="rc-podium" aria-hidden>
          <span className="rc-step rc-step-2">2</span>
          <span className="rc-step rc-step-1">1</span>
          <span className="rc-step rc-step-3">3</span>
        </div>
      );
    case 'burned':
      return (
        <span className="rc-flame">
          <Icon name="flame" size={44} />
        </span>
      );
    case 'final':
      return <Goose pose="wave" size={120} />;
    default:
      // «Твоё число»: само число крупно под картинкой, здесь — монета (как в приветствии экономики).
      return (
        <span className="ew-coin ew-coin-big">
          <img src={coinIcon} alt="" />
        </span>
      );
  }
}

function SlideBody({
  slide,
  recap,
  currency,
  nameOf,
  titleName,
}: {
  slide: RecapSlide;
  recap: RecapDto;
  currency: string;
  nameOf: (id: string | null) => string;
  titleName: (k: string) => string;
}) {
  const url = artUrl(slide.art, recap.kind);
  let extra: ReactNode = null;
  if (slide.titles) {
    extra = (
      <div className="rc-titles">
        {slide.titles.map((t) => (
          <div className="gt-row" key={t.key}>
            <GameTitleMark titleKey={t.key} name={titleName(t.key)} size={32} />
            <span className="gt-row-body">
              <span className="gt-row-name">{titleName(t.key)}</span>
              <span className="gt-row-holders">
                {t.userIds.length ? t.userIds.map(nameOf).join(', ') : 'Ты'}
                <small> · {titleValueText(titleUnit(t.key), t.value, currency)}</small>
              </span>
            </span>
          </div>
        ))}
      </div>
    );
  } else if (slide.podium) {
    extra = (
      <div className="rc-stats">
        {slide.podium.map((p) => (
          <div className="rc-stat" key={p.label}>
            <span>{p.label}</span>
            <b>
              {nameOf(p.userId)} · {p.value}
            </b>
          </div>
        ))}
      </div>
    );
  } else if (slide.stats?.length) {
    extra = (
      <div className="rc-stats">
        {slide.stats.map((s) => (
          <div className="rc-stat" key={s.label}>
            <span>{s.label}</span>
            <b>{s.value}</b>
          </div>
        ))}
      </div>
    );
  }
  return (
    <>
      {/* Ключ — чтобы смена слайда проигрывала появление картинки, а не морфила (как в приветствии). */}
      <div className={`ew-art rc-art rc-art-${slide.art}`} key={slide.key}>
        {url ? <img src={url} alt="" className="rc-art-img" /> : <ArtStub slide={slide} kind={recap.kind} label={recap.name} titleName={titleName} />}
      </div>
      <h2 className="ew-title">{slide.title}</h2>
      {slide.big && slide.art !== 'predictions' && (
        <div className="rc-big">
          <b>{slide.big}</b>
          {slide.bigNote && <small>{slide.bigNote}</small>}
        </div>
      )}
      {slide.art === 'predictions' && slide.bigNote && <div className="rc-big"><small>{slide.bigNote}</small></div>}
      {slide.share !== undefined && (
        <span className="rc-share" aria-hidden>
          <span style={{ width: `${slide.share}%` }} />
        </span>
      )}
      <p className="ew-text">{slide.text}</p>
      {extra}
    </>
  );
}

export default function RecapScene({ open, onClose }: { open: RecapOpen; onClose: () => void }) {
  const phone = usePhoneLayout();
  const cached = useStore((s) => (!open.preview && !open.periodId ? s.recaps[open.serverId]?.[open.kind] : undefined));
  const currency = useStore((s) => s.economy[open.serverId]?.currencyName || 'монет');
  const titleNames = useStore((s) => s.gameTitles[open.serverId]);
  const meId = useStore((s) => s.user?.id ?? 'me');
  const [loaded, setLoaded] = useState<RecapDto | null | undefined>(cached);
  const [step, setStep] = useState(0);
  const nameOf = useNameOf();
  const recap = loaded ?? null;

  useEffect(() => {
    if (cached !== undefined && !open.preview && !open.periodId) return;
    let alive = true;
    api
      .getRecap(open.serverId, open.kind, { period: open.periodId, preview: open.preview })
      .then((r) => alive && setLoaded(r.recap))
      .catch(() => alive && setLoaded(isMockEconomy() ? mockRecap(open.kind, meId, !!open.preview) : null));
    return () => {
      alive = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open.serverId, open.kind, open.periodId, open.preview]);

  const slides = useMemo(() => (recap ? recapSlides(recap, { currency }) : []), [recap, currency]);
  const last = step >= slides.length - 1;
  // Названия с переименованиями сервера; ещё не загрузились — по умолчанию.
  const titleName = (k: string) =>
    titleNames?.titles.find((t) => t.key === k)?.name ?? (isGameTitleKey(k) ? DEFAULT_GAME_TITLE_NAMES[k] : k);

  useEffect(() => ensureGameTitles(open.serverId), [open.serverId]);

  function close() {
    if (recap && !recap.preview) {
      writeRecapSeen(recapStorage(), open.serverId, recap.kind, recap.periodId);
    }
    onClose();
  }

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && !phone) close();
      else if (e.key === 'ArrowRight') setStep((s) => Math.min(slides.length - 1, s + 1));
      else if (e.key === 'ArrowLeft') setStep((s) => Math.max(0, s - 1));
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [slides.length, phone, recap]);

  const slide = slides[Math.min(step, slides.length - 1)];
  const eyebrow = recap?.preview ? 'Черновик итогов · видишь только ты' : open.kind === 'games' ? 'Итоги месяца игр' : 'Итоги сезона';
  const content = !slide ? (
    <p className="ew-text">{loaded === undefined ? 'Загружаем…' : 'Итогов пока нет: они появятся, когда закроется период.'}</p>
  ) : (
    <>
      <SlideBody slide={slide} recap={recap!} currency={currency} nameOf={nameOf} titleName={titleName} />
      <div className="ew-nav">
        <button type="button" className="ew-btn" disabled={step === 0} onClick={() => setStep((s) => s - 1)}>
          Назад
        </button>
        <span className="ew-dots" aria-label={`Слайд ${step + 1} из ${slides.length}`}>
          {slides.map((s, i) => (
            <button key={s.key} type="button" className={i === step ? 'ew-dot ew-dot-on' : 'ew-dot'} aria-label={s.title} onClick={() => setStep(i)} />
          ))}
        </span>
        {last ? (
          <button type="button" className="ew-btn ew-btn-main" onClick={close}>
            Готово
          </button>
        ) : (
          <button type="button" className="ew-btn ew-btn-main" onClick={() => setStep((s) => s + 1)}>
            Дальше
          </button>
        )}
      </div>
    </>
  );

  if (phone) {
    return (
      <BottomSheet page title={eyebrow} onClose={close}>
        <div className="pr-body rc-body">{content}</div>
      </BottomSheet>
    );
  }
  return (
    <div className="modal-overlay" onClick={close}>
      <section className="modal eco-welcome rc-card" role="dialog" aria-modal="true" aria-label={eyebrow} onClick={(e) => e.stopPropagation()}>
        <div className="ew-head">
          <span className={`ew-eyebrow${recap?.preview ? ' rc-draft' : ''}`}>
            <Icon name="star" size={14} />
            {eyebrow}
          </span>
          <button type="button" className="icon-close" title="Закрыть" onClick={close}>
            <Icon name="close" size={18} />
          </button>
        </div>
        {content}
      </section>
    </div>
  );
}
