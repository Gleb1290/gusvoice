import type { GameActivity } from '@gusvoice/shared';

/**
 * Чистые правила игровой активности (#40) — БЕЗ хранилища и broadcast'а.
 *
 * Вынесено из `activity.ts` по просьбе Codex (2026-07-27): тот модуль импортирует `gateway.js` и
 * держит модульный `Map`, поэтому приоритет источников и переход по TTL проверялись только живьём.
 * Время везде передаётся аргументом — иначе «истекло ровно сейчас» невоспроизводимо.
 */

export type ActivitySource = 'steam' | 'client';

/** Both sources re-report every ~30s (heartbeat); expire if one goes silent past this. */
export const ACTIVITY_TTL_MS = 90_000;

export interface SrcEntry {
  game: GameActivity;
  expiresAt: number;
}

/** Что известно про одного человека: по записи на источник, каждая со своим сроком. */
export type ActivityRecord = Partial<Record<ActivitySource, SrcEntry>>;

/** Порядок приоритета: Steam авторитетнее локального детекта клиента. */
export const SOURCES: ActivitySource[] = ['steam', 'client'];

function sameGame(a: GameActivity, b: GameActivity): boolean {
  return a.name === b.name && a.appId === b.appId;
}

export function sameEffective(a: GameActivity | null, b: GameActivity | null): boolean {
  if (!a && !b) return true;
  if (!a || !b) return false;
  return sameGame(a, b);
}

/**
 * Показываемая активность: Steam бьёт клиента, просроченные игнорируются.
 *
 * ⚠️ Строгое `>`: запись, у которой срок наступил РОВНО сейчас, считается истёкшей. Иначе
 * `sweepExpired` (у него `<=`) и этот расчёт разошлись бы на одну миллисекунду, и подметание
 * рассылало бы «изменение», которого никто не видел.
 */
export function effectiveOf(rec: ActivityRecord | undefined, now: number): GameActivity | null {
  if (!rec) return null;
  for (const src of SOURCES) {
    const e = rec[src];
    if (e && e.expiresAt > now) return e.game;
  }
  return null;
}

/**
 * Записать (или снять при `null`) игру ОДНОГО источника, освежив его срок. Возвращает НОВУЮ запись;
 * пустая (`{}`) означает, что человека можно убрать из хранилища целиком.
 *
 * ⚠️ Снятие через `null` убирает только СВОЙ источник: клиент, закрывший игру, не должен гасить
 * то, что про этого же человека сообщает Steam.
 */
export function setSource(
  rec: ActivityRecord | undefined,
  source: ActivitySource,
  game: GameActivity | null,
  now: number,
): ActivityRecord {
  const next: ActivityRecord = { ...rec };
  if (game == null) delete next[source];
  else next[source] = { game, expiresAt: now + ACTIVITY_TTL_MS };
  return next;
}

/** Выбросить просроченные записи. Возвращает НОВУЮ запись (пустая ⇒ убрать человека из хранилища). */
export function sweepExpired(rec: ActivityRecord, now: number): ActivityRecord {
  const next: ActivityRecord = {};
  for (const src of SOURCES) {
    const e = rec[src];
    if (e && e.expiresAt > now) next[src] = e;
  }
  return next;
}

/** Есть ли в записи хоть один источник (иначе хранилищу её держать незачем). */
export function isEmptyRecord(rec: ActivityRecord): boolean {
  return Object.keys(rec).length === 0;
}
