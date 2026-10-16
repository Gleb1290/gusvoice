/**
 * Сетка сцены голосового канала «под окно» (10.10). Все плитки — камеры, участники без видео и
 * превью несмотрящихся показов — одного размера 16:9 и ВСЕ влезают в доступную область без прокрутки.
 *
 * Алгоритм — как у Discord и Google Meet: перебрать число колонок 1..N, для каждого взять самую
 * большую плитку с нужным соотношением сторон, которая влезает и по ширине, и по высоте контейнера,
 * и выбрать вариант с наибольшей плиткой. Чистая функция — без DOM: размеры и зазор передаёт
 * вызывающий (`VoiceChannelView`, ResizeObserver на `.stage-grid`).
 */

/** Соотношение сторон плитки сцены (ширина / высота). */
export const STAGE_TILE_ASPECT = 16 / 9;
/**
 * Нижняя граница ширины плитки, px. Ниже неё имя и значки на плитке уже не читаются — тогда сетка
 * честно уходит в прокрутку (десятки участников), а не мельчит дальше.
 */
export const STAGE_TILE_MIN_W = 112;
/** Полоса сцены задаётся общим CSS; расчёт резервирует её даже без прокрутки. */
export const STAGE_SCROLLBAR_PX = 12;
/** Мёртвая зона смены колонок больше целой полосы прокрутки. */
export const STAGE_GRID_HYSTERESIS_PX = STAGE_SCROLLBAR_PX + 4;

export type StageGridInput = {
  /** Внутренняя ширина контейнера, px. */
  width: number;
  /** Внутренняя высота контейнера, px. */
  height: number;
  /** Сколько плиток разложить. */
  count: number;
  /** Зазор между плитками, px (и по строкам, и по колонкам). */
  gap: number;
  /** Ширина / высота плитки; по умолчанию 16:9. */
  aspect?: number;
  /** Нижняя граница ширины плитки; по умолчанию `STAGE_TILE_MIN_W`. */
  minTileW?: number;
  /** Предыдущие колонки той же сцены; без них остаётся обычный поиск максимальной плитки. */
  prevCols?: number;
  /** Полуширина зоны вокруг границы смены колонок, px. */
  hysteresisPx?: number;
};

export type StageGridLayout = {
  cols: number;
  rows: number;
  /** Ширина плитки, px (целое, округление вниз — чтобы ряд гарантированно влезал). */
  tileW: number;
  /** Высота плитки, px (целое). */
  tileH: number;
};

/**
 * Раскладка: число колонок и размер плитки. Нет плиток или контейнер ещё не измерен — одна колонка
 * с нулевой плиткой (вызывающий тогда не ставит размеры вовсе).
 */
export function fitStageGrid(input: StageGridInput): StageGridLayout {
  const next = fitGridAt(input);
  const prev = input.prevCols;
  const threshold = input.hysteresisPx ?? STAGE_GRID_HYSTERESIS_PX;
  if (!prev || !Number.isInteger(prev) || prev < 1 || prev > Math.floor(input.count)
    || prev === next.cols || !(threshold > 0) || next.tileW === 0) return next;
  // Граница должна выйти из всей мёртвой зоны, прежде чем меняем колонки.
  // Обе пробы — чистый расчёт: ни ширина плитки, ни наличие полосы не влияют на вход.
  const narrow = fitGridAt({ ...input, width: input.width - threshold });
  const wide = fitGridAt({ ...input, width: input.width + threshold });
  if (narrow.cols !== prev && wide.cols !== prev) return next;
  const aspect = input.aspect && input.aspect > 0 ? input.aspect : STAGE_TILE_ASPECT;
  const gap = Math.max(0, input.gap);
  const rows = Math.ceil(Math.floor(input.count) / prev);
  const byWidth = Math.max(0, (input.width - gap * (prev - 1)) / prev);
  const byHeight = ((input.height - gap * (rows - 1)) / rows) * aspect;
  // В deadband колонки сохраняются, размеры всё равно подгоняются к реальной ширине.
  // Ниже minW допускаем только вынужденное сжатие по ширине; по высоте — честная прокрутка.
  const tileW = Math.floor(Math.min(byWidth, Math.max(input.minTileW ?? STAGE_TILE_MIN_W, Math.min(byWidth, byHeight))));
  return { cols: prev, rows, tileW, tileH: Math.floor(tileW / aspect) };
}

function fitGridAt(input: StageGridInput): StageGridLayout {
  const aspect = input.aspect && input.aspect > 0 ? input.aspect : STAGE_TILE_ASPECT;
  const minW = input.minTileW ?? STAGE_TILE_MIN_W;
  const n = Math.max(0, Math.floor(input.count));
  const gap = Math.max(0, input.gap);
  const W = Math.max(0, input.width);
  const H = Math.max(0, input.height);
  if (n === 0 || W <= 0 || H <= 0) return { cols: 1, rows: n, tileW: 0, tileH: 0 };

  let best: { cols: number; rows: number; w: number } | null = null;
  for (let cols = 1; cols <= n; cols++) {
    const rows = Math.ceil(n / cols);
    const byWidth = (W - gap * (cols - 1)) / cols;
    const byHeight = ((H - gap * (rows - 1)) / rows) * aspect;
    const w = Math.min(byWidth, byHeight);
    // Строго больше: при равенстве остаётся меньшее число колонок (ровнее последний ряд).
    if (!best || w > best.w) best = { cols, rows, w };
  }
  const chosen = best ?? { cols: 1, rows: n, w: 0 };

  if (chosen.w < minW) {
    // Не влезает даже лучшая раскладка — держим нижнюю границу и столько колонок, сколько её
    // вмещает ширина; лишние ряды уходят под прокрутку.
    const cols = Math.max(1, Math.min(n, Math.floor((W + gap) / (minW + gap))));
    const tileW = Math.floor(Math.min(minW, (W - gap * (cols - 1)) / cols));
    return { cols, rows: Math.ceil(n / cols), tileW: Math.max(0, tileW), tileH: Math.max(0, Math.floor(tileW / aspect)) };
  }
  const tileW = Math.floor(chosen.w);
  return { cols: chosen.cols, rows: chosen.rows, tileW, tileH: Math.floor(tileW / aspect) };
}

/**
 * Размер аватарки на плитке без видео: от высоты плитки, в пределах 40…96 px (на прежней плитке
 * в 132 px было 92 — крупная плитка не должна держать крошечный кружок, мелкая — вылезать за край).
 */
export function stageAvatarSize(tileH: number): number {
  if (!(tileH > 0)) return 92;
  return Math.max(40, Math.min(96, Math.round(tileH * 0.55)));
}
