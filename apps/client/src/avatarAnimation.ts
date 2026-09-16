import { useSyncExternalStore } from 'react';
import { useStore } from './store';

/**
 * Показывать ли анимированные аватары — настройка ЗРИТЕЛЯ, не владельца аватара.
 *
 * 🔴 **Включено у всех по умолчанию (решение 01.09).** Первая версия показывала анимацию
 * только по наведению — из осторожности к слабым машинам. Решение развернули: анимацию видно
 * всегда и всем, а кому тяжело — тот выключает. Так и правильнее по сути: человек, купивший
 * движущийся аватар, покупал его чтобы его видели, а не чтобы на него наводили мышь.
 *
 * ⚠️ Настройка ПЕР-УСТРОЙСТВЕННАЯ и живёт в `localStorage`: «не тянет» — это свойство конкретного
 * ноутбука и конкретного интернета, а не аккаунта. С рабочего компьютера человек может хотеть
 * выключить, с домашнего — нет.
 *
 * 🔴 **`prefers-reduced-motion` выключает её ПО УМОЛЧАНИЮ, но не запрещает включить.** Это не спор
 * с этим решением: анимацию картинки медиазапрос не останавливает сам (её крутит декодер), а
 * человек, попросивший систему не двигать ничего, попросил в том числе и об этом. Захочет —
 * включит руками, и его выбор переживёт перезагрузку.
 */

const KEY = 'gv_animated_avatars';

function prefersReducedMotion(): boolean {
  try {
    return window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  } catch {
    return false;
  }
}

function load(): boolean {
  try {
    const raw = localStorage.getItem(KEY);
    if (raw === null) return !prefersReducedMotion();
    return raw === '1';
  } catch {
    return true;
  }
}

let enabled = load();
const subs = new Set<() => void>();

export function animatedAvatarsEnabled(): boolean {
  return enabled;
}

export function setAnimatedAvatarsEnabled(v: boolean): void {
  enabled = v;
  try {
    localStorage.setItem(KEY, v ? '1' : '0');
  } catch {
    /* приватный режим — настройка проживёт до перезагрузки */
  }
  for (const s of subs) s();
}

export function useAnimatedAvatarsEnabled(): boolean {
  return useSyncExternalStore(
    (fn) => {
      subs.add(fn);
      return () => subs.delete(fn);
    },
    () => enabled,
    () => true,
  );
}

/**
 * Достать анимацию для человека — годится и внутри `map`, в отличие от хука на каждого.
 *
 * 🔴 Источник ОДИН — общий ростер участников сервера. Развесь мы поле по местам, где собирается
 * `target` для меню и плиток, где-нибудь его забыли бы передать, и анимация пропадала бы на
 * отдельных поверхностях без всякой видимой причины.
 *
 * ⚠️ Возвращает `undefined`, когда зритель анимацию выключил, — то есть `Avatar` даже не узнает про
 * ссылку и не станет её грузить. Выключатель обязан экономить трафик, а не только прятать движение:
 * его для этого и просили.
 */
export function useAnimatedAvatarUrl(): (userId: string | undefined) => string | undefined {
  const on = useAnimatedAvatarsEnabled();
  const members = useStore((s) => s.members);
  if (!on) return () => undefined;
  return (userId) =>
    (userId ? members.find((m) => m.user.id === userId)?.user.animatedAvatarUrl : null) ?? undefined;
}
