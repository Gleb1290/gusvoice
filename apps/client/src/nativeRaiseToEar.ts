import { useSyncExternalStore } from 'react';
import { isAndroid } from './hotkeys';

/**
 * «Поднести к уху» на Android (G67, 14.10, #218): пока играет голосовое сообщение и телефон поднесли к уху, звук идёт в
 * разговорный динамик, экран гаснет; отвели — снова громкий. Мост — `window.GusVoiceNative.raiseToEar*` (`MainActivity.kt` →
 * `RaiseToEar.kt`). Telegram Android: настройка «Поднести к уху» (`SharedConfig.raiseToListen`, по умолчанию включена),
 * `MediaController.onSensorChanged` / `setUseFrontSpeaker`. Запись по поднесению и расшифровку голосовых не делаем.
 *
 * Только в приложении Android с датчиком приближения; на вебе, на ПК и в старом APK без методов моста — нет ни слушания, ни настройки.
 */

interface RaiseToEarBridge {
  raiseToEarSupported(): boolean;
  raiseToEarSet(on: boolean): void;
}

const KEY = 'gv.raiseToEar';

function bridge(): RaiseToEarBridge | null {
  if (!isAndroid()) return null;
  const b = (window as unknown as { GusVoiceNative?: Partial<RaiseToEarBridge> }).GusVoiceNative;
  if (!b || typeof b.raiseToEarSupported !== 'function' || typeof b.raiseToEarSet !== 'function') return null;
  return b as RaiseToEarBridge;
}

/** Есть мост и датчик приближения (иначе настройки в «Данных и памяти» нет). */
export function raiseToEarSupported(): boolean {
  const b = bridge();
  if (!b) return false;
  try {
    return b.raiseToEarSupported() === true;
  } catch (e) {
    console.warn('[raise-to-ear] raiseToEarSupported failed:', e);
    return false;
  }
}

/** Запомненная настройка: пусто — включено (как в Telegram), `0` — выключено. */
export function parseRaiseToEar(raw: string | null | undefined): boolean {
  return raw !== '0';
}

const listeners = new Set<() => void>();

export function getRaiseToEarPref(): boolean {
  try {
    return parseRaiseToEar(localStorage.getItem(KEY));
  } catch {
    return true;
  }
}

export function setRaiseToEarPref(on: boolean): void {
  try {
    localStorage.setItem(KEY, on ? '1' : '0');
  } catch {
    /* хранилища нет — настройка живёт до перезапуска только в слушателях */
  }
  for (const fn of listeners) fn();
}

function subscribe(fn: () => void): () => void {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

/** Настройка «Поднести к уху» для переключателя (перерисовка по смене). */
export function useRaiseToEarPref(): boolean {
  return useSyncExternalStore(subscribe, getRaiseToEarPref, getRaiseToEarPref);
}

/**
 * Нужно ли слушать датчик: настройка включена, голосовое сообщение играет (не пауза) и человек не в голосовом канале
 * (микрофон и звук канала ведёт Chromium — маршрут не трогаем; звонок 1:1 нативная сторона отсекает сама).
 */
export function raiseToEarWanted(o: { enabled: boolean; playing: boolean; hasTrack: boolean; inVoiceChannel: boolean }): boolean {
  return o.enabled && o.playing && o.hasTrack && !o.inVoiceChannel;
}

/** Передать нативной стороне «слушай / не слушай датчик» (нет моста — ничего). */
export function setRaiseToEar(on: boolean): void {
  try {
    bridge()?.raiseToEarSet(on);
  } catch (e) {
    console.warn('[raise-to-ear] raiseToEarSet failed:', e);
  }
}
