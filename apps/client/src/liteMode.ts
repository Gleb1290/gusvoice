import { useSyncExternalStore } from 'react';

/**
 * «Оптимизированный режим» — интерфейс не двигается сам по себе (27.09, #207).
 *
 * 🔴 **Граница, что сюда, а что нет (решение владельца 27.09).** Экономия, которой на глаз не видно
 * (лишний цикл отрисовки livekit-client, опрос статистики, пересылка звука показа, отрисовка в трее,
 * анимация в НАКРЫТОМ окне), включена у всех без настройки. Сюда — только то, что меняет «живость»:
 * - анимированные аватары показывают первый кадр и оживают по наведению;
 * - бесконечные украшения (пульс LIVE, свечение короны, гусь, скелетоны) стоят;
 * - под полноэкранной игрой аватары замирают и там, где окно видно на втором мониторе.
 *
 * Зачем: на четырёх ядрах под игрой каждое движение в окне отнимает процессор у игры (тестер на
 * i5-7500 + GTX 1060). Трейс на машине владельца: одни только GIF-аватарки и дыхание гуся — ~150 мс
 * процессора в секунду на процессах WebView2.
 *
 * ⚠️ Настройка ПЕР-УСТРОЙСТВЕННАЯ (`localStorage`), как анимированные аватары: «не тянет» — свойство
 * компьютера, а не аккаунта. По умолчанию ВЫКЛЮЧЕНА. Класс `gv-lite` на `<html>` ставится при старте
 * (`main.tsx`) и на смену; список остановленных анимаций — в `styles.css` рядом с `gv-game-fg`.
 */

const KEY = 'gv_lite_mode';
const CLASS = 'gv-lite';

function load(): boolean {
  try {
    return localStorage.getItem(KEY) === '1';
  } catch {
    return false;
  }
}

let enabled = load();
const subs = new Set<() => void>();

/** Заводское значение — выключено. */
export function liteModeDefault(): boolean {
  return false;
}

export function liteModeEnabled(): boolean {
  return enabled;
}

/** Поставить класс на документ по текущему значению — при старте и после смены. */
export function applyLiteMode(): void {
  document.documentElement.classList.toggle(CLASS, enabled);
}

export function setLiteModeEnabled(v: boolean): void {
  enabled = v;
  try {
    localStorage.setItem(KEY, v ? '1' : '0');
  } catch {
    /* приватный режим — настройка проживёт до перезагрузки */
  }
  applyLiteMode();
  for (const s of subs) s();
}

/**
 * Показывать ли у аватара первый кадр вместо анимации.
 *
 * - анимации нет — и вопроса нет;
 * - окно НАКРЫТО — стоит всегда, даже без режима: его никто не видит;
 * - в оптимизированном режиме — стоит, кроме наведения, а под игрой стоит и при наведении (окно под
 *   игрой можно видеть на втором мониторе, но «навести» туда во время игры — случайность).
 */
export function avatarShowsStill(o: {
  hasAnimation: boolean;
  covered: boolean;
  gameFg: boolean;
  lite: boolean;
  hover: boolean;
}): boolean {
  if (!o.hasAnimation) return false;
  if (o.covered) return true;
  return o.lite && (o.gameFg || !o.hover);
}

export function useLiteMode(): boolean {
  return useSyncExternalStore(
    (fn) => {
      subs.add(fn);
      return () => subs.delete(fn);
    },
    () => enabled,
    () => false,
  );
}
