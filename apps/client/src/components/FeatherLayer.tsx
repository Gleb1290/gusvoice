import { useEffect, useRef, useState } from 'react';
import cobaltLong from '../assets/confetti/feather-cobalt-long.png';
import cobaltRoot from '../assets/confetti/feather-cobalt-root.png';
import ivoryCrown from '../assets/confetti/feather-ivory-crown.png';
import ivoryShaft from '../assets/confetti/feather-ivory-shaft.png';
import { EFFECT_MS, featherCount, freshEffects, pendingEffects, planEffect } from '../effects';
import { type Feathers, onEffect } from '../effectsBus';
import { currentConditions } from '../effectsDom';
import { degradeStep, featherFade, makeFeathers, stepFeather } from '../featherFall';
import { shakeUi, stopShake } from '../uiShake';

/**
 * Осыпание перьев — эффект МЕГА пока (#117, этап 3).
 *
 * 🔴 **Почему это не «конфетти».** Конфетти — одинаковые бумажки с одинаковым падением. Перья
 * отличает РАЗНОБОЙ: разные кадры, размеры, режимы падения и фазы. Одинаковые частицы читаются как
 * мусор, а не как праздник. Разбор и числа — `docs/animation-playbook.md`, раздел 5.
 *
 * 🔴 **Скорость сознательно завышена относительно физики.** Измеренная предельная скорость падающей
 * пластины — 0.145 м/с; настоящее перо пересекало бы окно 4–10 секунд, а у нас потолок 4.2 с. Из
 * физики взят ХАРАКТЕР (порхание и кувыркание), а не скорость. Не «чинить» в сторону реализма:
 * получатся висящие в воздухе перья и человек, ждущий, когда это кончится.
 *
 * 🔴 **`prefers-reduced-motion` убирает ДВИЖЕНИЕ, а не время.** Осыпание — это полный экран плюс
 * вращение плюс разнонаправленность, то есть три самых рискованных типа движения сразу. Ускоренная
 * версия тут не помощь; безопасная замена — неподвижная подпись с прозрачностью.
 *
 * ⚠️ **В оверлее перьев нет** и быть не должно: он висит поверх чужой игры, и осыпание там —
 * оплаченная помеха человеку в бою. Держится структурно: оверлей рендерит свой корень, а этот слой
 * живёт в `MainLayout`.
 */

const SPRITES = [ivoryCrown, ivoryShaft, cobaltLong, cobaltRoot];

/**
 * Сколько эффектов может ждать в очереди.
 *
 * ⚠️ Сверху очередь и так держит суточный предел получателя, но полагаться на него нельзя: он про
 * СУТКИ, а прилететь всё может за минуту. Три ожидающих — это около двадцати секунд перьев подряд;
 * дальше это уже не награда, а осада.
 */
const MAX_QUEUED = 3;

/**
 * Сколько ждёт ОТЛОЖЕННЫЙ эффект, пока показывать его негде (свёрнутое окно, полный экран).
 *
 * 🔴 Ограничение нужно ровно затем, зачем нужна и сама отсрочка. Вернулся через час и получил залп
 * перьев за весь вечер — хуже, чем не получить ничего: это уже не подарок, а помеха. Десять минут —
 * срок, на котором «мне только что прилетело» ещё правда.
 */
const PENDING_MAX_MS = 10 * 60_000;

/** Отложенный или ждущий очереди эффект: сам запрос плюс момент, когда он прилетел. */
interface Pending {
  req: Feathers;
  at: number;
}

/**
 * ⚠️ Вся физика — в `featherFall.ts` и покрыта тестом на пяти раскладках. Здесь остаётся только
 * отрисовка: держать модель рядом с канвой означало бы, что «долетает ли перо до низа» можно
 * проверить исключительно глазами на своём мониторе. Ровно так баг и уехал в прод.
 */

export function FeatherLayer() {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const rafRef = useRef<number | null>(null);
  const images = useRef<HTMLImageElement[]>([]);
  /**
   * 🔴 Очередь, а НЕ замена (требование к фиче). Прилетело два МЕГА пока подряд — второй ждёт первого
   * и начинается строго после него. Замена была бы честна для бесплатного эффекта, но здесь за
   * каждый заплачены монеты: съеденный эффект — это купленное и не полученное. Одновременно при
   * этом всё равно идёт ровно один: два осыпания разом — уже не праздник, а помеха.
   *
   * ⚠️ Длина очереди ограничена. Сверху её и так держит суточный предел получателя, но полагаться на
   * это нельзя: очередь в десять штук означала бы минуту непрерывных перьев, а это уже не награда.
   */
  const queueRef = useRef<Pending[]>([]);
  /** Что играет прямо сейчас — чтобы вернуть его в очередь, если вкладку спрятали посреди показа. */
  const currentRef = useRef<Pending | null>(null);
  const runningRef = useRef(false);
  /** Неподвижная подмена для тех, кто просил не двигать интерфейс. */
  const [still, setStill] = useState<{ from: string; message: string; at: number } | null>(null);
  /**
   * 🔴 Подпись несёт и СООБЩЕНИЕ отправителя. Оно приезжало в событии с самого начала, но нигде не
   * рисовалось: человек писал текст, платил за щипок — и текст улетал в пустоту (найдено на
   * первом живом щипке 03.09). У бесплатного тыка сообщение показывалось всегда, у платного нет.
   */
  const [caption, setCaption] = useState<{ from: string; message: string } | null>(null);

  // Кадры грузим один раз и заранее: подгрузка в момент эффекта дала бы пустой первый кадр.
  useEffect(() => {
    images.current = SPRITES.map((src) => {
      const img = new Image();
      img.src = src;
      return img;
    });
  }, []);

  useEffect(() => {
    /**
     * Погасить текущий эффект.
     *
     * `next` — что делать с очередью: `true` (эффект доиграл до конца) запускает следующий,
     * `false` (человек нажал клавишу, уход со страницы) выбрасывает её целиком. Второе важно: если
     * человек гасит осыпание руками, а из очереди тут же стартует следующее, выглядит это как будто
     * клавиша не работает.
     */
    const stop = (next: boolean) => {
      if (rafRef.current !== null) cancelAnimationFrame(rafRef.current);
      rafRef.current = null;
      runningRef.current = false;
      currentRef.current = null;
      stopShake();
      const c = canvasRef.current;
      if (c) c.getContext('2d')?.clearRect(0, 0, c.width, c.height);
      setCaption(null);
      if (!next) {
        queueRef.current = [];
        return;
      }
      const pending = queueRef.current.shift();
      if (pending) start(pending);
    };

    /** Запустить осыпание немедленно. Очередь разбирает `stop(true)`. */
    const start = (item: Pending) => {
      const canvas = canvasRef.current;
      if (!canvas) return;
      runningRef.current = true;
      currentRef.current = item;
      setCaption({ from: item.req.fromName, message: item.req.message ?? '' });
      // Тряска идёт вместе с осыпанием: это один жест, а не два эффекта. И у КАЖДОГО в очереди своя —
      // иначе второй подарок пришёл бы молча.
      shakeUi();

      const dpr = Math.min(window.devicePixelRatio || 1, 2);
      const w = window.innerWidth;
      const h = window.innerHeight;
      canvas.width = Math.floor(w * dpr);
      canvas.height = Math.floor(h * dpr);
      const ctx = canvas.getContext('2d');
      if (!ctx) return;

      // Плотность по площади окна: постоянное число на широком мониторе выглядит редкой пылью.
      const feathers = makeFeathers(w, h, featherCount(w, h));
      const started = performance.now();
      let prev = started;
      /**
       * 🔴 Прореживание под слабую машину. Плотность выбрана под картинку («перья занимают всё
       * пространство»), а не под самый медленный компьютер, — и это правильный порядок: целиться в
       * нужный вид и отступать по факту честнее, чем занижать заранее для всех. Если кадры пошли
       * длиннее 20 мс (меньше 50 в секунду), режем часть частиц. Эффект срабатывает ровно тогда,
       * когда запаса меньше всего: человек играет или смотрит чужой показ.
       */
      // Состояние политики отступления. Сама политика — чистая, в `featherFall.ts`.
      let degrade = { active: feathers.length, slowFrames: 0 };

      const frame = (now: number) => {
        const elapsed = now - started;
        // Потолок жёсткий: бесконечный эффект читается как зависание.
        if (elapsed >= EFFECT_MS.feathers) return stop(true);
        // ⚠️ Шаг берём из РАЗНИЦЫ кадров, а не из константы: на 144 Гц и на 30 Гц частицы обязаны
        // падать одинаково, иначе эффект живёт разное время у разных людей.
        const dt = Math.min((now - prev) / 1000, 0.05);
        const frameMs = now - prev;
        prev = now;
        degrade = degradeStep(degrade, elapsed, frameMs);

        // Сброс к масштабу экрана нужен и для очистки: ниже трансформация задаётся на каждую частицу.
        ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
        ctx.clearRect(0, 0, w, h);
        // Прозрачность одна на кадр — ставить её внутри цикла значило бы трогать состояние канвы
        // сотни раз на ровном месте.
        ctx.globalAlpha = featherFade(elapsed);

        for (let i = 0; i < degrade.active; i++) {
          const f = feathers[i];
          stepFeather(f, elapsed, dt);
          if (elapsed < f.delay) continue;
          // Ушло за нижний край — рисовать нечего.
          if (f.y > h + f.size * 2) continue;

          const img = images.current[f.sprite];
          if (!img?.complete || img.naturalWidth === 0) continue;
          const scale = f.size / Math.max(img.naturalWidth, img.naturalHeight);
          const dw = img.naturalWidth * scale;
          const dh = img.naturalHeight * scale;

          // ⚠️ `setTransform` вместо `save/translate/rotate/restore`: на сотнях частиц в кадре
          // разница в работе с состоянием канвы становится заметной, а результат тот же.
          const cos = Math.cos(f.angle);
          const sin = Math.sin(f.angle);
          ctx.setTransform(dpr * cos, dpr * sin, -dpr * sin, dpr * cos, dpr * f.x, dpr * f.y);
          ctx.drawImage(img, -dw / 2, -dh / 2, dw, dh);
        }
        rafRef.current = requestAnimationFrame(frame);
      };
      rafRef.current = requestAnimationFrame(frame);
    };

    /**
     * Положить в очередь, отбросив протухшее и лишнее.
     * ⚠️ `front` — вернуть то, что играло, когда вкладку спрятали: оно прилетело раньше остальных и
     * показать его надо первым, иначе порядок «кто когда щипнул» переврётся.
     */
    const enqueue = (item: Pending, front = false) => {
      queueRef.current = pendingEffects(queueRef.current, item, {
        now: Date.now(),
        maxAgeMs: PENDING_MAX_MS,
        max: MAX_QUEUED,
        front,
      });
    };

    /**
     * Показать накопившееся, когда стало можно (вернулись во вкладку, вышли из полного экрана).
     * ⚠️ План пересчитываем ЗАНОВО: условия могли и не улучшиться, и тогда эффект остаётся ждать
     * дальше, а не сгорает впустую.
     */
    const drain = () => {
      if (runningRef.current) return;
      queueRef.current = freshEffects(queueRef.current, Date.now(), PENDING_MAX_MS);
      const next = queueRef.current[0];
      if (!next) return;
      const plan = planEffect({ ...currentConditions(next.req.serverId), ...next.req.benchOverrides });
      if (plan.kind === 'skip') return;
      queueRef.current.shift();
      if (plan.kind === 'static') {
        setStill({ from: next.req.fromName, message: next.req.message ?? '', at: Date.now() });
        return;
      }
      start(next);
    };

    const off = onEffect((req) => {
      // Тряска в одиночку — для стенда: подобрать амплитуду, не глядя каждый раз на всё осыпание.
      if (req.kind === 'shake') {
        // ⚠️ Трясём только когда план разрешает ДВИЖЕНИЕ. `static` (человек просил не двигать
        // интерфейс) сюда не попадает: полноэкранная тряска — как раз то, от чего он отказался.
        const p = planEffect({ ...currentConditions(req.serverId), ...req.benchOverrides });
        if (p.kind === 'fly' || p.kind === 'inplace') shakeUi();
        return;
      }
      if (req.kind !== 'feathers') return;
      // 🔴 Решение «показывать ли» принимает `planEffect` по живой обстановке — тот же путь, что у
      // полёта монеты. Свой ответ на этот вопрос эффект придумывать не должен.
      const plan = planEffect({ ...currentConditions(req.serverId), ...req.benchOverrides });
      /**
       * 🔴 **Показывать негде — ОТКЛАДЫВАЕМ, а не выбрасываем** (решение 03.09). Звук щипка
       * человек слышит всегда, в том числе из свёрнутого окна; услышал — альт-табается и обязан
       * увидеть то, за что заплатили, и всё, что накопилось следом.
       * ⚠️ `other-server` откладывать нельзя: человек смотрит другой сервер, и вспышка без контекста
       * читается как сбой. Откладываем только «негде показать сейчас» — скрытая вкладка и полный
       * экран.
       */
      if (plan.kind === 'skip') {
        if (plan.reason !== 'other-server') enqueue({ req, at: Date.now() });
        return;
      }
      if (plan.kind === 'static') {
        setStill({ from: req.fromName, message: req.message ?? '', at: Date.now() });
        return;
      }
      if (runningRef.current) {
        // ⚠️ Уже идёт — ждём своей очереди, а не перебиваем.
        enqueue({ req, at: Date.now() });
        return;
      }
      start({ req, at: Date.now() });
    });

    /**
     * Выход по любой клавише: эффект поверх всего экрана обязан иметь способ прекратиться раньше
     * срока, а не только «дождитесь».
     *
     * ⚠️ Но НЕ когда человек печатает. Буквально «любая клавиша» означала бы, что перья, прилетевшие
     * во время набора сообщения, гаснут на первой же букве — то есть купивший заплатил, а получатель
     * ничего не увидел. Escape гасит всегда, остальные клавиши — только вне полей ввода.
     */
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') {
        const el = e.target as HTMLElement | null;
        const tag = el?.tagName;
        if (tag === 'INPUT' || tag === 'TEXTAREA' || el?.isContentEditable) return;
      }
      // Гасим ВСЮ очередь: человек убрал эффект руками, и следующий, стартовавший тут же, выглядел
      // бы как «клавиша не сработала».
      stop(false);
      setStill(null);
    };
    window.addEventListener('keydown', onKey);

    /**
     * 🔴 Вкладку спрятали посреди осыпания — гасим НЕМЕДЛЕННО и чистим холст.
     *
     * Иначе перья остаются на странице навсегда: браузер ставит `requestAnimationFrame` на паузу у
     * скрытого (перекрытого другим окном, свёрнутого) окна, цикл замирает на последнем кадре, а
     * вместе с ним замирает и уборка — она живёт внутри того же цикла. Человек альт-табается в игру
     * на минуту, возвращается — и видит застывший сугроб (поймано 03.09).
     *
     * ⚠️ `stop(false)`, то есть с выбросом очереди: показывать накопившееся тому, кто всё это время
     * смотрел в другое окно, поздно и незачем — ровно та же логика, по которой `planEffect` вообще
     * не запускает эффект на скрытой вкладке.
     */
    const onVisibility = () => {
      if (document.hidden) {
        /**
         * 🔴 Вкладку спрятали посреди осыпания — ПАРКУЕМ его обратно в очередь, а не выбрасываем.
         * Рисовать в скрытой вкладке браузер всё равно не даёт: он останавливает кадры, цикл
         * замирает на последнем, и вместе с ним замирает уборка — она живёт внутри того же цикла.
         * Поэтому гасим и чистим холст сразу, а показываем заново, когда человек вернётся.
         * ⚠️ В начало очереди: этот щипок прилетел раньше тех, что встали за ним.
         */
        const parked = currentRef.current;
        stop(false);
        setStill(null);
        if (parked) enqueue(parked, true);
        return;
      }
      drain();
    };
    document.addEventListener('visibilitychange', onVisibility);
    // Полный экран — вторая причина «показывать негде»: вышли из него, значит стало можно.
    document.addEventListener('fullscreenchange', drain);
    window.addEventListener('focus', drain);

    return () => {
      off();
      window.removeEventListener('keydown', onKey);
      document.removeEventListener('visibilitychange', onVisibility);
      document.removeEventListener('fullscreenchange', drain);
      window.removeEventListener('focus', drain);
      stop(false);
    };
  }, []);

  // Неподвижная подмена живёт своим таймером: движения в ней нет, поэтому и кадры не нужны.
  useEffect(() => {
    if (!still) return;
    const t = window.setTimeout(() => setStill(null), 2200);
    return () => window.clearTimeout(t);
  }, [still]);

  return (
    <>
      <canvas ref={canvasRef} className="feather-layer" aria-hidden />
      {caption && (
        <div className="feather-caption">
          Щипок от {caption.from}
          {caption.message && <span className="feather-message">{caption.message}</span>}
        </div>
      )}
      {still && (
        <div className="feather-still">
          Щипок от {still.from}
          {still.message && <span className="feather-message">{still.message}</span>}
        </div>
      )}
    </>
  );
}
