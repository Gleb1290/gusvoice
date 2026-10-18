/**
 * Правила окошка «картинка в картинке» для чужого показа (#222) — без DOM, чтобы проверять отдельно.
 * Само окошко, стили и запасной путь — `streamPip.ts`, вид — `components/StreamPipView.tsx`.
 */

/** Размер окошка: ширина и высота содержимого в CSS-пикселях. */
export interface PipSize {
  width: number;
  height: number;
}

/** Ключ последнего размера окошка в localStorage. */
export const STREAM_PIP_SIZE_KEY = 'gv_stream_pip_size';

/** Окошко по умолчанию: 480×270 — 16:9, как у кадра показа. */
export const STREAM_PIP_DEFAULT: PipSize = { width: 480, height: 270 };

/** Меньше — кнопки не помещаются в ряд. */
export const STREAM_PIP_MIN_WIDTH = 240;

/**
 * Размер, который просить у браузера: сохранённая ширина (или по умолчанию), высота — под 16:9, не уже
 * `STREAM_PIP_MIN_WIDTH` и не больше половины экрана (`screen` — размер экрана; нет — без верхней границы).
 * Высоту берём из ширины, а не из сохранённой высоты: окно браузер мог растянуть как угодно, а кадр
 * показа — 16:9 почти всегда, и полосы сверху/снизу в окошке выглядят как поломка.
 */
export function streamPipSize(saved: Partial<PipSize> | null | undefined, screen?: { width: number; height: number } | null): PipSize {
  let width = Number.isFinite(saved?.width) && (saved?.width ?? 0) > 0 ? Math.round(saved!.width!) : STREAM_PIP_DEFAULT.width;
  if (screen && screen.width > 0 && screen.height > 0) {
    width = Math.min(width, Math.floor(screen.width / 2), Math.floor((screen.height / 2) * (16 / 9)));
  }
  width = Math.max(STREAM_PIP_MIN_WIDTH, width);
  return { width, height: Math.round((width * 9) / 16) };
}

/** Разбор сохранённого размера; мусор — `null`. */
export function parsePipSize(raw: string | null | undefined): PipSize | null {
  if (!raw) return null;
  try {
    const v = JSON.parse(raw) as Partial<PipSize> | null;
    if (!v || typeof v.width !== 'number' || typeof v.height !== 'number') return null;
    if (!Number.isFinite(v.width) || !Number.isFinite(v.height)) return null;
    // Проверяем уже округлённое: 0.4 после округления — ноль, а не «положительная ширина» (нашёл Codex, R254).
    const width = Math.round(v.width);
    const height = Math.round(v.height);
    if (width <= 0 || height <= 0) return null;
    return { width, height };
  } catch {
    return null;
  }
}

/** Сколько показов помещается в одно окошко (#223): сетка 2×2. Пятый заменяет самый старый. */
export const PIP_MAX = 4;

/** Показы в окошке: список (#223) или один identity (как было в #222) — к одному виду. */
function pipList(pip: readonly string[] | string | null | undefined): readonly string[] {
  if (!pip) return [];
  return typeof pip === 'string' ? [pip] : pip;
}

/**
 * Добавить показ в окошко (#223): в конец, без дублей; больше `max` — уходит самый старый (первый).
 * Уже в окошке — тот же список (тот же объект: стор не перерисовывает зря).
 */
export function pipAdd(list: readonly string[], id: string, max: number = PIP_MAX): readonly string[] {
  if (!id || list.includes(id)) return list;
  const next = [...list, id];
  const keep = Math.max(1, Math.floor(max));
  return next.length > keep ? next.slice(next.length - keep) : next;
}

/** Убрать показ из окошка; его там нет — тот же список. */
export function pipRemove(list: readonly string[], id: string): readonly string[] {
  return list.includes(id) ? list.filter((x) => x !== id) : list;
}

/**
 * Какие показы «смотрим» для звука и слоя: открытые на сцене плюс показы в окошке. Окошко живёт и без
 * сцены (ушли в текстовый канал — сцена размонтировалась и очистила `watchedStreams`), а звук и
 * картинка в нём при этом должны идти. `pip` — список показов окошка (или один identity).
 */
export function streamsInView(watched: readonly string[], pip: readonly string[] | string | null | undefined): string[] {
  const out = [...watched];
  for (const id of pipList(pip)) if (id && !out.includes(id)) out.push(id);
  return out;
}

/** Показ участника `identity` сейчас в окошке. `pip` — список identity показов окошка (бывает спутник `<id>#screen`). */
export function isInPip(identity: string, pip: readonly string[] | string | null | undefined): boolean {
  return !!identity && pipList(pip).includes(identity);
}

/** Показы окошка, которых больше нет в комнате (стример завершил показ или ушёл): их — убрать, остальные остаются. */
export function pipGone(pip: readonly string[], live: readonly string[]): string[] {
  return pip.filter((id) => !live.includes(id));
}

/** Ячейка раскладки окошка — доли окна (0…1): левый верхний угол, ширина, высота. */
export interface PipCell {
  x: number;
  y: number;
  w: number;
  h: number;
}

/** Доля окна под полосу остальных показов при крупном (как полоса «Фокуса» на сцене). */
export const PIP_STRIP = 0.25;

/**
 * Раскладка окошка на `count` показов (#223). `w`×`h` — размер окна: от него, где длинная сторона.
 * - 1 — во всё окно;
 * - 2 — рядом по длинной стороне: окно шире, чем выше (или квадрат), — в ряд, иначе столбиком;
 * - 3–4 — сетка 2×2 (третий — по центру нижнего ряда);
 * - `focusedIndex` в пределах и показов ≥ 2 — он крупно, остальные полосой вдоль короткой стороны
 *   (окно шире — полоса снизу, выше — справа), как «Фокус» на сцене.
 * Порядок ячеек = порядок показов. Больше `PIP_MAX` не раскладываем — лишние не рисуются.
 */
export function pipLayout(count: number, focusedIndex: number | null | undefined, w: number, h: number): PipCell[] {
  const n = Math.max(0, Math.min(PIP_MAX, Math.floor(Number.isFinite(count) ? count : 0)));
  if (n === 0) return [];
  if (n === 1) return [{ x: 0, y: 0, w: 1, h: 1 }];
  const wide = !(h > w); // квадрат и мусорный размер — как «шире»
  const f = focusedIndex ?? -1;
  if (Number.isInteger(f) && f >= 0 && f < n) {
    const rest = n - 1;
    const main: PipCell = wide ? { x: 0, y: 0, w: 1, h: 1 - PIP_STRIP } : { x: 0, y: 0, w: 1 - PIP_STRIP, h: 1 };
    const cells: PipCell[] = [];
    let k = 0;
    for (let i = 0; i < n; i++) {
      if (i === f) {
        cells.push(main);
        continue;
      }
      cells.push(
        wide
          ? { x: k / rest, y: 1 - PIP_STRIP, w: 1 / rest, h: PIP_STRIP }
          : { x: 1 - PIP_STRIP, y: k / rest, w: PIP_STRIP, h: 1 / rest },
      );
      k++;
    }
    return cells;
  }
  if (n === 2) {
    return wide
      ? [
          { x: 0, y: 0, w: 0.5, h: 1 },
          { x: 0.5, y: 0, w: 0.5, h: 1 },
        ]
      : [
          { x: 0, y: 0, w: 1, h: 0.5 },
          { x: 0, y: 0.5, w: 1, h: 0.5 },
        ];
  }
  const cells: PipCell[] = [
    { x: 0, y: 0, w: 0.5, h: 0.5 },
    { x: 0.5, y: 0, w: 0.5, h: 0.5 },
  ];
  if (n === 3) cells.push({ x: 0.25, y: 0.5, w: 0.5, h: 0.5 });
  else cells.push({ x: 0, y: 0.5, w: 0.5, h: 0.5 }, { x: 0.5, y: 0.5, w: 0.5, h: 0.5 });
  return cells;
}

/**
 * Где показывать кнопку «Картинка в картинке»: не на Android (там своё системное окошко, #222 его не
 * трогает) и только если есть хоть один путь — окно документа или окошко у `<video>`.
 */
export function streamPipButtonShown(env: { android: boolean; documentPip: boolean; videoPip: boolean }): boolean {
  if (env.android) return false;
  return env.documentPip || env.videoPip;
}

/**
 * Закрыть ли окошко само: показа в комнате больше нет (стример завершил показ или ушёл), или мы вышли
 * из голоса. `live` — identity показов, что сейчас в комнате.
 */
export function pipShouldClose(pip: string | null | undefined, live: readonly string[], inVoice: boolean): boolean {
  if (!pip) return false;
  if (!inVoice) return true;
  return !live.includes(pip);
}
