/**
 * Стартовый масштаб картинки в просмотрщике.
 *
 * Аватар — это 256×256 (кроп при загрузке), и на полном экране «в натуральную величину» он
 * выглядит маркой посреди чёрного поля: формально показан целиком, а рассмотреть нечего. Поэтому
 * маленькую картинку сразу подтягиваем к размеру сцены — но не дальше `cap`, чтобы показывать
 * увеличенное, а не мыло.
 *
 * Картинка, которая в сцену не влезает, остаётся на 1: её и так вписывает `max-width/height` у
 * `.lb-img`, и `scale` поверх этого только увёл бы края за экран.
 */
export const ZOOM_CAP = 2;

export function fitZoom(
  natural: { w: number; h: number },
  stage: { w: number; h: number },
  cap: number = ZOOM_CAP,
): number {
  if (natural.w <= 0 || natural.h <= 0 || stage.w <= 0 || stage.h <= 0) return 1;
  const fit = Math.min(stage.w / natural.w, stage.h / natural.h);
  if (fit <= 1) return 1;
  return Math.min(cap, Math.floor(fit * 100) / 100);
}

/** Точка или сдвиг на экране, px. */
export type ZoomPoint = { x: number; y: number };

/**
 * Щипок двумя пальцами в просмотре фото (05.10): страница сама больше не масштабируется (`index.html`, `user-scalable=no`),
 * увеличивает только просмотр. Картинка стоит как `translate(pan) scale(zoom)` от своей середины.
 * - масштаб — во столько раз, во сколько разошлись пальцы с начала щипка (`dist / dist0`), в пределах `min…max` (те же,
 *   что у кнопок «+» / «−»);
 * - сдвиг — чтобы точка картинки, бывшая в начале под серединой пальцев (`mid0`), и сейчас была под их серединой (`mid`):
 *   так увеличивает галерея телефона и Telegram, а не «от центра экрана».
 * `center` — середина картинки без сдвига (экранная), `zoom0` / `pan0` — масштаб и сдвиг в начале щипка.
 */
export function pinchStep(p: {
  zoom0: number;
  pan0: ZoomPoint;
  center: ZoomPoint;
  mid0: ZoomPoint;
  mid: ZoomPoint;
  dist0: number;
  dist: number;
  min: number;
  max: number;
}): { zoom: number; pan: ZoomPoint } {
  const ratio = p.dist0 > 0 && p.dist > 0 ? p.dist / p.dist0 : 1;
  const zoom = Math.min(p.max, Math.max(p.min, p.zoom0 * ratio));
  const z0 = p.zoom0 > 0 ? p.zoom0 : 1;
  // Точка картинки под пальцами в начале — от её середины, в единицах картинки (без масштаба).
  const lx = (p.mid0.x - p.center.x - p.pan0.x) / z0;
  const ly = (p.mid0.y - p.center.y - p.pan0.y) / z0;
  return { zoom, pan: { x: p.mid.x - p.center.x - zoom * lx, y: p.mid.y - p.center.y - zoom * ly } };
}

/**
 * Сдвиг увеличенной картинки — не дальше, чем она вылезает за сцену: край картинки не отходит от края сцены внутрь. По оси,
 * где картинка влезает целиком, сдвига нет (стоит посередине). `size` — размер картинки при масштабе 1, `stage` — сцены.
 */
export function clampPan(
  pan: ZoomPoint,
  zoom: number,
  size: { w: number; h: number },
  stage: { w: number; h: number },
): ZoomPoint {
  const rx = Math.max(0, (size.w * zoom - stage.w) / 2);
  const ry = Math.max(0, (size.h * zoom - stage.h) / 2);
  return { x: Math.min(rx, Math.max(-rx, pan.x)) || 0, y: Math.min(ry, Math.max(-ry, pan.y)) || 0 };
}
