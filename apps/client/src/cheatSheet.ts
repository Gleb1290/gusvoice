/**
 * Шпаргалка горячих клавиш — общий выключатель, а не локальное состояние одного экрана.
 *
 * 🔴 **Повод (19.09).** Список сочетаний в приложении есть и честный: показывает только то, что
 * реально работает. Но открыть его можно было ровно одним способом — нажать `?`, о чём написано
 * только ВНУТРИ самой шпаргалки. То есть узнать о ней человек мог случайно или от знакомых.
 * Функция, о существовании которой неоткуда узнать, всё равно что отсутствует.
 *
 * Чтобы к шпаргалке можно было позвать кнопкой из любого места, выключатель вынесен из
 * `MainLayout` сюда. Тот же приём, что у тостов и окна подтверждения: крошечный сторонний стор,
 * на который подписывается один хост.
 */
import { useSyncExternalStore } from 'react';

let open = false;
const subs = new Set<() => void>();

function emit(): void {
  for (const f of subs) f();
}

function subscribe(f: () => void): () => void {
  subs.add(f);
  return () => {
    subs.delete(f);
  };
}

export function openCheatSheet(): void {
  open = true;
  emit();
}

export function closeCheatSheet(): void {
  open = false;
  emit();
}

/** Переключить — так работает клавиша `?`: нажал ещё раз, закрыл. */
export function toggleCheatSheet(): void {
  open = !open;
  emit();
}

export function useCheatSheetOpen(): boolean {
  // Серверного рендера у нас нет, но третий аргумент обязателен по сигнатуре хука.
  return useSyncExternalStore(subscribe, () => open, () => false);
}
