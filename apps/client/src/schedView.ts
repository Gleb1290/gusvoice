/**
 * Вид «Отложенные» беседы ЛС (раунд 12, порция 8, `docs/design/design-step12/HANDOFF.md` §8.4, макет `Phone` с
 * `screen=sched`): на телефоне кнопка «назад» в шапке (`.mobile-back`) на время вида ведёт «К беседе», а не к списку бесед.
 * Кнопка живёт в `MainLayout` (поверх шапки ленты), вид — `DmChatView`; связывает их этот выключатель — тот же приём, что у
 * режима выделения (`dmSelection.ts`): крошечный сторонний стор. Вид, открывшись, отдаёт сюда, как вернуться к беседе
 * (`holdSchedView`), и забирает обратно, когда закрылся или ушёл с экрана.
 */
import { useSyncExternalStore } from 'react';

let back: (() => void) | null = null;
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

/**
 * Вид «Отложенные» открыт: `onBack` — вернуться к беседе. Возвращает «отпустить» (вид закрыт или размонтирован); отпускает
 * только своё — вид следующей беседы, если он уже взят, не трогает.
 */
export function holdSchedView(onBack: () => void): () => void {
  back = onBack;
  emit();
  return () => {
    if (back !== onBack) return;
    back = null;
    emit();
  };
}

/** «К беседе» (кнопка на месте «назад»). `false` — вид не открыт. */
export function backFromSchedView(): boolean {
  const f = back;
  if (!f) return false;
  f();
  return true;
}

/** Открыт ли вид «Отложенные» — для кнопки «назад» в шапке телефона. */
export function useSchedViewOpen(): boolean {
  return useSyncExternalStore(subscribe, () => back !== null, () => back !== null);
}
