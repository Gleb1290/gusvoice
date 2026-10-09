/**
 * Заказ «открыть беседу и положить в неё файлы» (G37): файлы, брошенные из проводника на строку беседы в списке. Беседа может
 * быть открыта (окно отправки встаёт сразу) или нет (её ленту ждёт заказ: `MessagePane` забирает его, когда лента сменилась).
 * Тот же приём, что `feedJump.ts`. Источник поведения — Telegram Desktop: `Dialogs::Widget::dropEvent` → `filesOrForwardDrop`
 * (открывает беседу и показывает окно отправки файлов) и `dragMoveEvent` с `ChoosePeerByDragTimeout` = 1 с (мышь с файлами
 * постояла над строкой — беседа открывается, и файл можно бросить прямо в неё).
 */
import { useSyncExternalStore } from 'react';

/** Сколько мышь с файлами должна простоять над строкой, чтобы беседа открылась (tdesktop `ChoosePeerByDragTimeout`), мс. */
export const CHOOSE_BY_DRAG_MS = 1000;
/** Заказ, который никто не забрал, через это время протухает: брошенное давно не должно выскочить в случайной беседе, мс. */
export const FILES_DROP_TTL_MS = 8000;
/** Сдвиг мыши меньше этого — «не двигалась»: `dragover` приходит по таймеру и без движения. */
export const DRAG_STILL_PX = 4;

let pending: { feedId: string; files: File[]; at: number } | null = null;
let seq = 0;
const subs = new Set<() => void>();

/** В переносе есть файлы из проводника (текст и свои сообщения — не они). */
export function hasFilesDrag(types: ReadonlyArray<string> | DOMStringList | null | undefined): boolean {
  if (!types) return false;
  return Array.from(types as ArrayLike<string>).includes('Files');
}

/** Заказать. Лента `feedId` заберёт файлы (`takeFilesDrop`) — сразу, если открыта, или когда откроется. */
export function requestFilesDrop(feedId: string, files: File[], now: number = Date.now()): void {
  if (files.length === 0) return;
  pending = { feedId, files, at: now };
  seq += 1;
  for (const f of subs) f();
}

/** Забрать свой заказ (один раз). Чужой лежит, пока не протухнет или его не заберёт та лента. */
export function takeFilesDrop(feedId: string | undefined, now: number = Date.now()): File[] | null {
  if (!feedId || pending?.feedId !== feedId) return null;
  const { files, at } = pending;
  pending = null;
  return now - at > FILES_DROP_TTL_MS ? null : files;
}

/** Номер заказа — меняется на каждый новый; лента с ним в зависимостях эффекта перепроверяет свой заказ. */
export function useFilesDropSeq(): number {
  return useSyncExternalStore(
    (cb) => {
      subs.add(cb);
      return () => subs.delete(cb);
    },
    () => seq,
    () => 0,
  );
}

/** Сдвинулась ли мышь с прошлой точки заметно (`DRAG_STILL_PX`) — тогда таймер «выбора по переносу» начинается заново. */
export function dragMoved(prev: { x: number; y: number } | null, x: number, y: number): boolean {
  return !prev || Math.abs(x - prev.x) > DRAG_STILL_PX || Math.abs(y - prev.y) > DRAG_STILL_PX;
}
