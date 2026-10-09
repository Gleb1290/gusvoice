/**
 * «Написать» — выбор человека для новой беседы (раунд 11, HANDOFF §3–§4): общий выключатель, а не состояние одного
 * компонента. Зовут его из четырёх мест: карандаш в шапке списка (ПК), плавающая кнопка (телефон), кнопка под гусём
 * пустого списка (главная область ПК, `MainLayout`) и «Написать новому человеку» под пустым поиском (с тем же запросом).
 * Лист (телефон) или окно по центру (ПК) рисует `DmSidebar`. Тот же приём, что у шпаргалки (`cheatSheet.ts`): крошечный
 * сторонний стор.
 */
import { useSyncExternalStore } from 'react';

export interface DmComposeState {
  open: boolean;
  /** С чего начать поиск человека: запрос из поиска бесед, если звали из «ничего не нашлось». */
  query: string;
  /** Номер открытия: новое открытие — новый лист (поле ввода с этим запросом). */
  seq: number;
}

let state: DmComposeState = { open: false, query: '', seq: 0 };
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

export function openDmCompose(query = ''): void {
  state = { open: true, query, seq: state.seq + 1 };
  emit();
}

export function closeDmCompose(): void {
  if (!state.open) return;
  state = { ...state, open: false };
  emit();
}

export function useDmCompose(): DmComposeState {
  return useSyncExternalStore(subscribe, () => state, () => state);
}
