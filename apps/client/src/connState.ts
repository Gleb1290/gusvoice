/**
 * Связь с сервером — для шапки беседы (замечание владельца 05.10, как у Telegram): пока соединение со шлюзом потеряно,
 * в шапке вместо статуса собеседника «Подключение…», а если у устройства нет сети — «Ожидание сети». «В сети» собеседника
 * в это время не показываем: оно устарело вместе с соединением (события о его статусе не приходят).
 *
 * Шлюз отмечает `sockets.ts`: `ready` — связь есть; обрыв своего сокета — нет; выход и смена инстанса — забыть. Потерянным
 * считается только соединение, которое уже было: до первого `ready` (запуск, окна и тесты без шлюза) «Подключение…» не
 * показываем — нечего терять, а статуса собеседника без шлюза и так нет. Сеть устройства — `navigator.onLine` и события
 * `online` / `offline` окна. Правила — чистые (`connStateOf`, `connLabel`), остальное — крошечный сторонний стор, тот же
 * приём, что у `dmSelection.ts`.
 */
import { useSyncExternalStore } from 'react';

/** `online` — связь есть; `connecting` — шлюз оборвался и переподключается; `waiting` — у устройства нет сети. */
export type ConnState = 'online' | 'connecting' | 'waiting';

/** Чистое правило: нет сети у устройства — ждём сеть; есть, но соединение со шлюзом потеряно — подключаемся. */
export function connStateOf(p: { deviceOffline: boolean; gatewayLost: boolean }): ConnState {
  if (p.deviceOffline) return 'waiting';
  return p.gatewayLost ? 'connecting' : 'online';
}

/**
 * Тексты состояния связи — ОДНО место правды для заголовка списка бесед и шапки беседы. Telegram Android, ключи
 * `strings.xml`: `Connecting` / `WaitingForNetwork` / `Updating` («Connecting...» / «Waiting for network...» /
 * «Updating...»); официальный русский — «Соединение...» / «Ожидание сети...» / «Обновление...» (в клоне `values-ru`
 * этих ключей нет, русский взят из ресерча `tg-research/03-navigation.md` п. 2.1.3). Многоточие у нас одним знаком «…».
 */
export const CONN_TEXT = {
  connecting: 'Соединение…',
  waiting: 'Ожидание сети…',
  updating: 'Обновление…',
} as const;

/** Подпись вместо статуса собеседника; `null` — связь есть, статус обычный. */
export function connLabel(s: ConnState): string | null {
  if (s === 'waiting') return CONN_TEXT.waiting;
  if (s === 'connecting') return CONN_TEXT.connecting;
  return null;
}

let wasLive = false;
let lost = false;
let deviceOffline = false;
let state: ConnState = 'online';
const subs = new Set<() => void>();
let watching = false;

function update(): void {
  const next = connStateOf({ deviceOffline, gatewayLost: lost });
  if (next === state) return;
  state = next;
  for (const f of subs) f();
}

/** Шлюз сказал `ready` (`true`) или оборвался его сокет (`false`). */
export function setGatewayLive(live: boolean): void {
  if (live) wasLive = true;
  lost = !live && wasLive;
  update();
}

/** Выход из аккаунта или смена инстанса: соединения ещё не было — и терять нечего. */
export function resetGatewayLive(): void {
  wasLive = false;
  lost = false;
  update();
}

function readDevice(): void {
  deviceOffline = typeof navigator !== 'undefined' && navigator.onLine === false;
  update();
}

function subscribe(f: () => void): () => void {
  if (!watching && typeof window !== 'undefined') {
    watching = true;
    window.addEventListener('online', readDevice);
    window.addEventListener('offline', readDevice);
    readDevice();
  }
  subs.add(f);
  return () => {
    subs.delete(f);
  };
}

export function useConnState(): ConnState {
  return useSyncExternalStore(
    subscribe,
    () => state,
    () => 'online',
  );
}
