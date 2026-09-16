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
