/**
 * Мост между чистыми правилами (`effects.ts`) и живым окном (#120).
 *
 * 🔴 Здесь и только здесь эффекты смотрят на DOM. Правила решают ЧТО показать, этот модуль отвечает
 * на вопрос «какая сейчас обстановка». Разделение нужно, чтобы правила проверялись тестом: с
 * `document` внутри они не запускаются вовсе.
 */
import { planEffect, targetPoint, type EffectConditions, type EffectPlan, type Point } from './effects';
import { useStore } from './store';

/** Куда летят монеты: чип баланса в шапке сервера. */
const CHIP_SELECTOR = '.eco-chip';

/**
 * Где сейчас чип баланса — или `null`, если его на экране нет.
 *
 * ⚠️ Спрашиваем не «есть ли узел», а «попадает ли он в окно»: свёрнутый сайдбар оставляет чип в
 * дереве, но уводит за край. Полёт по таким координатам уходит за границу экрана — ровно тот баг,
 * ради которого всё это и заведено.
 */
export function chipPoint(): Point | null {
  const el = document.querySelector(CHIP_SELECTOR);
  if (!el) return null;
  const r = el.getBoundingClientRect();
  return targetPoint(
    { left: r.left, top: r.top, width: r.width, height: r.height },
    { width: window.innerWidth, height: window.innerHeight },
  );
}

/**
 * Короткий отклик чипа баланса: число изменилось.
 *
 * 🔴 **Для типа это ЕДИНСТВЕННЫЙ визуальный отклик** (решение 02.09: «монетки пусть вообще не
 * летят, просто анимашка в ЧИПе»). Кто кого типнул, говорят подсказки в списке канала; полёт монеты
 * поверх них был бы вторым рассказом об одном событии.
 *
 * ⚠️ Ищем чип в момент вызова, а не держим ссылку: сайдбар могли свернуть, сервер переключить.
 * Чипа нет — не делаем ничего, и это правильно: подсказка своё уже сказала.
 */
export function pulseChip(): void {
  if (!chipPoint()) return;
  const el = document.querySelector(CHIP_SELECTOR);
  if (!el) return;
  el.classList.remove('eco-chip-hit');
  // Перезапуск анимации: без чтения свойства браузер склеит снятие и добавление класса в один кадр.
  void (el as HTMLElement).offsetWidth;
  el.classList.add('eco-chip-hit');
  window.setTimeout(() => el.classList.remove('eco-chip-hit'), 600);
}

/**
 * Открыт ли показ на весь экран — и браузерный, и НАШ.
 *
 * 🔴 **`document.fullscreenElement` покрывает не все случаи.** На мобиле и там, где браузер отказал
 * в `requestFullscreen`, показ разворачивается CSS-оверлеем `.pseudo-fs` (#29) — и `fullscreenElement`
 * при этом ПУСТ. Проверка только по нему пропускала эффекты поверх чужого показа ровно там, где
 * мешать больнее всего: человек смотрит на весь экран, а ему через кадр летит монета.
 */
export function fullscreenNow(): boolean {
  if (document.fullscreenElement) return true;
  return !!document.querySelector('.pseudo-fs');
}

/** Просил ли человек не двигать интерфейс. */
export function reducedMotion(): boolean {
  try {
    return window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  } catch {
    return false;
  }
}

/**
 * Снять текущую обстановку окна.
 *
 * `serverId` — сервер, к которому относится СОБЫТИЕ (не тот, что открыт). `null` означает «событие
 * не привязано к серверу», и тогда проверка на чужой сервер не применяется.
 */
export function currentConditions(serverId: string | null, overrides: Partial<EffectConditions> = {}): EffectConditions {
  const open = useStore.getState().bootstrap?.server.id ?? null;
  return {
    tabHidden: document.visibilityState === 'hidden',
    fullscreen: fullscreenNow(),
    sameServer: serverId === null || serverId === open,
    reducedMotion: reducedMotion(),
    target: chipPoint(),
    ...overrides,
  };
}

/** Что показать прямо сейчас для события этого сервера. */
export function planNow(serverId: string | null, overrides: Partial<EffectConditions> = {}): EffectPlan {
  return planEffect(currentConditions(serverId, overrides));
}
