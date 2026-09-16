import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { api, type SoundboardClip } from '../api';
import { placeByAnchor, toLayoutRect, viewport } from '../popover';
import { hintLeft } from '../hintPlacement';
import { useStore } from '../store';
import { toastError } from '../toast';
import { Icon } from './Icon';

/**
 * Задержка подсказки под мышью. Заметно короче секунды у пикера эмодзи — и намеренно: там подсказка
 * рассказывает про шорткод, о котором никто не спрашивал, а здесь она отвечает на прямой вопрос
 * «что это за кнопка», потому что имя на кнопке обрезано многоточием.
 */
const HINT_MS = 400;

/** Ниже этой высоты над кнопкой подсказка не помещается и уходит ПОД неё, а не за кромку экрана. */
const HINT_FLIP_PX = 64;

/**
 * Сетка кнопок саундборда (#21): нажал — звук услышали все, кто сидит с тобой в голосе.
 *
 * 🔴 **Кнопки не гаснут «на всякий случай».** Недоступное показывается серым и с причиной в
 * подсказке, а не прячется: исчезнувшая кнопка читается как поломка, а серая — как «сейчас нельзя,
 * и вот почему». Тот же приём, что у пункта «Сильно ткнуть», одобренный на приёмке.
 *
 * ⚠️ Панель не появляется вовсе, пока экономика выключена. Это не косметика: без монет у
 * саундборда нет тормоза, а именно ради тормоза он и ждал экономику.
 *
 * 🔴 **Размещается как пикер стикеров — `position: fixed` плюс расчёт стороны, а не абсолютом от
 * кнопки.** Кнопка живёт в доке голоса ВНУТРИ сайдбара, а у `.channels` стоит `overflow: hidden`:
 * абсолютная панель шире сайдбара просто обрезалась бы по его кромке. Первая версия была именно
 * такой — поймано на отрисовке макета, до выкладки.
 */
export function SoundboardPicker({
  channelId,
  anchor,
  onClose,
}: {
  channelId: string;
  /** Прямоугольник кнопки, от которой раскрываемся. */
  anchor: DOMRect;
  onClose: () => void;
}) {
  const serverId = useStore((s) => s.bootstrap?.server.id);
  const economy = useStore((s) => (serverId ? s.economy[serverId] : undefined));
  const [clips, setClips] = useState<SoundboardClip[] | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const box = useRef<HTMLDivElement | null>(null);
  // ⚠️ Скрыта до первого замера: панель, мигнувшая в углу и перепрыгнувшая на место, выглядит
  // поломкой. Тот же приём, что у пикеров эмодзи и стикеров.
  const [pos, setPos] = useState<{ left: number; top: number } | null>(null);

  const entry = economy?.enabled ? economy.shop?.find((e) => e.item === 'soundboard') : undefined;
  const price = entry?.enabled && entry.priceCoins > 0 ? entry.priceCoins : null;
  const balance = economy?.wallet.balance ?? 0;
  // ⚠️ Имя валюты — из настроек сервера: владелец её переименовывает (аудит текстов 03.09).
  const currencyName = economy?.currencyName ?? 'монет';

  useEffect(() => {
    if (!serverId) return;
    let alive = true;
    api
      .listSoundboard(serverId)
      .then((r) => alive && setClips(r.clips))
      // Пустой список, а не отсутствие панели: «не загрузилось» и «звуков нет» человек различает
      // по тексту внутри, а не по тому, открылось окно или нет.
      .catch(() => alive && setClips([]));
    return () => {
      alive = false;
    };
  }, [serverId]);

  /**
   * Замер и размещение. Пересчитывается и после того, как приехал список: пустая панель и панель с
   * двумя десятками кнопок — разной высоты, и место надо выбирать по итоговому размеру.
   */
  useLayoutEffect(() => {
    function place() {
      const el = box.current;
      if (!el) return;
      setPos(placeByAnchor(toLayoutRect(anchor), el.offsetWidth, el.offsetHeight, 8));
    }
    place();
    window.addEventListener('resize', place);
    window.visualViewport?.addEventListener('resize', place);
    return () => {
      window.removeEventListener('resize', place);
      window.visualViewport?.removeEventListener('resize', place);
    };
  }, [anchor, clips]);

  // Закрытие по клику мимо и по Esc — как у остальных всплывающих панелей.
  useEffect(() => {
    const away = (e: MouseEvent) => {
      if (box.current && !box.current.contains(e.target as Node)) onClose();
    };
    const esc = (e: KeyboardEvent) => e.key === 'Escape' && onClose();
    document.addEventListener('mousedown', away);
    document.addEventListener('keydown', esc);
    return () => {
      document.removeEventListener('mousedown', away);
      document.removeEventListener('keydown', esc);
    };
  }, [onClose]);

  // ─────────── Подсказка с ПОЛНЫМ именем звука под мышью ───────────
  //
  // 🔴 Имя на кнопке обрезано многоточием (иначе разная высота кнопок ломает сетку, а сетка тут и
  // есть смысл — по ней жмут не глядя). Значит длинные имена не прочитать вовсе, и подсказка не
  // украшение, а единственный способ узнать, что именно ты сейчас включишь всему каналу.
  const hintTimer = useRef<number | null>(null);
  const hintRef = useRef<HTMLDivElement | null>(null);
  const [hint, setHint] = useState<{
    name: string;
    note: string;
    cx: number;
    /** Верх и низ САМОЙ кнопки: по ним выбирается сторона и считается позиция. */
    top: number;
    bottom: number;
  } | null>(null);

  // Ширину знаем только после отрисовки: подсказка с длинным именем в разы шире, чем с коротким, и
  // клампить центр по догадке — значит срезать одну из них о кромку. Сам расчёт — в `hintLeft`
  // (чистый, под тестами): я в нём уже находил руками две ошибки, и держать его в эффекте, где его
  // нечем проверить, было неправильно.
  useLayoutEffect(() => {
    const el = hintRef.current;
    if (!hint || !el) return;
    const panel = box.current ? toLayoutRect(box.current.getBoundingClientRect()) : null;
    el.style.left = `${hintLeft(hint.cx, el.offsetWidth, panel, viewport().vw)}px`;
  }, [hint]);

  function clearHint() {
    if (hintTimer.current !== null) {
      clearTimeout(hintTimer.current);
      hintTimer.current = null;
    }
    setHint(null);
  }

  function armHint(el: HTMLElement, clip: SoundboardClip, note: string) {
    clearHint();
    // ⚠️ Мерим СЕЙЧАС, а не в теле таймера: к моменту срабатывания React уже обнулит
    // `currentTarget`, и замер вернул бы null. Ровно на этом гас весь интерфейс в #127.
    const r = toLayoutRect(el.getBoundingClientRect());
    hintTimer.current = window.setTimeout(
      () => setHint({ name: clip.name, note, cx: r.left + r.width / 2, top: r.top, bottom: r.bottom }),
      HINT_MS,
    );
  }

  // Панель закрыли (или ушли из канала) с занесённым таймером — подсказка не должна всплыть уже
  // над пустотой.
  useEffect(() => clearHint, []);

  async function fire(clip: SoundboardClip) {
    setBusy(clip.id);
    try {
      await api.fireSoundboard(channelId, clip.id);
      // ⚠️ Ничего не проигрываем здесь: звук придёт событием по сокету — тем же, что и всем
      // остальным. Локальное проигрывание дало бы стреляющему собственное эхо раньше других.
    } catch (e) {
      toastError(e);
    } finally {
      setBusy(null);
    }
  }

  const poor = price !== null && balance < price;

  return (
    <>
      <div
        className="sb-pop"
        ref={box}
        style={pos ? { left: pos.left, top: pos.top } : { left: -9999, top: -9999 }}
      >
        <div className="sb-head">
          <span className="sb-title">Саундборд</span>
          {/* 🔴 В шапке теперь только БАЛАНС: цена у каждого звука своя (решение 02.09), и одно
              число здесь врало бы про весь набор. Цена стоит на самой кнопке. */}
          <span className="sb-price">у тебя {balance}</span>
        </div>
        {clips === null ? (
          <div className="sb-empty">Загружаю…</div>
        ) : clips.length === 0 ? (
          <div className="sb-empty">Звуков пока нет — их добавляет тот, кому выдали управление саундбордом</div>
        ) : (
          <div
            className="sb-grid"
            // Уехал список под мышью — подсказка осталась бы висеть над чужой кнопкой.
            onScroll={clearHint}
          >
            {clips.map((c) => {
              // ⚠️ «Не хватает» считается ПО ЭТОМУ звуку: при разных ценах общий признак означал бы,
              // что дешёвые кнопки гаснут из-за дорогой.
              const cPoor = c.priceCoins > balance;
              const note = cPoor
                ? `Не хватает: нужно ${c.priceCoins} ${currencyName}, у тебя ${balance}`
                : `Проиграть всем в канале · ${c.priceCoins}`;
              return (
                <button
                  key={c.id}
                  type="button"
                  className="sb-btn"
                  disabled={cPoor || busy !== null}
                  // 🔴 Вместо `title`: свою подсказку рисуем сами, а браузерная всплывала бы поверх
                  // неё вторым окошком в чужом стиле. Читалкам полный текст остаётся здесь — они
                  // `title` и раньше озвучивали, потерять это молча нельзя.
                  aria-label={`${c.name} — ${note}`}
                  onMouseEnter={(e) => armHint(e.currentTarget, c, note)}
                  onMouseLeave={clearHint}
                  onFocus={(e) => armHint(e.currentTarget, c, note)}
                  onBlur={clearHint}
                  onClick={() => void fire(c)}
                >
                  <Icon name="volume" size={14} />
                  <span className="sb-btn-name">{c.name}</span>
                  {/* 🔴 Цена ВСЕГДА на кнопке, даже когда не хватает. Серая кнопка без числа читается
                      как «сломалось»; с числом — как «дорого», и это разные сообщения. */}
                  <span className={`sb-btn-price${cPoor ? ' poor' : ''}`}>{c.priceCoins}</span>
                </button>
              );
            })}
          </div>
        )}
      </div>
      {/* 🔴 СОСЕД панели, а не ребёнок: у `.sb-pop` стоит `overflow: hidden`, и подсказка внутри неё
          обрезалась бы ровно у крайних кнопок — там, где имя длиннее всего и подсказка нужнее всего.
          Тот же приём и по той же причине, что у пикера эмодзи. */}
      {hint && (
        <div
          className={`sb-hint${hint.top < HINT_FLIP_PX ? ' below' : ''}`}
          role="tooltip"
          ref={hintRef}
          // left приезжает замером в layout-эффекте выше, когда известна ширина.
          style={{ left: 0, ...(hint.top < HINT_FLIP_PX ? { top: hint.bottom + 6 } : { top: hint.top - 6 }) }}
        >
          <span className="sb-hint-name">{hint.name}</span>
          <span className="sb-hint-note">{hint.note}</span>
        </div>
      )}
    </>
  );
}
