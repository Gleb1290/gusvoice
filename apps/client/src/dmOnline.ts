import { useEffect, useMemo, useRef, useSyncExternalStore } from 'react';
import { FEATURE_LASTSEEN2, FEATURE_PRESENCE4, type UserLastSeen } from '@gusvoice/shared';
import { api } from './api';
import { useStore } from './store';

/**
 * «В сети» в ЛС с учётом приватности «Время захода» (Р-2, `lastseen2`, #211). Скрытое время захода прячет и «в сети»:
 * вместо зелёной точки собеседник виден как «был(а) недавно» (Telegram: статус один — online / offline / recently).
 * Решает сервер (`UserLastSeen.exact` — видно ли мне его время захода, взаимно); здесь — только применение к точкам.
 *
 * Только ЛС: списки участников серверов (`ServerMembersPanel`, `MemberProfileSheet`, `ChatView`) живут по присутствию как
 * раньше — это открытый вопрос владельцу.
 *
 * 🔴 `presence4` (решения владельца 08.10) отменяет правило выше: в ЛС «в сети» и точка — по факту присутствия ВСЕГДА (и при
 * «Никто»), приватность прячет только время у вышедшего; «Невидимый» в ЛС не действует — его «в сети для ЛС» шлюз шлёт
 * отдельно (`online.dm` → `store.dmOnlineUsers`). Серверный `exact` для точек тогда не нужен — `dmDot` и `useVisibleOnline`
 * его не спрашивают. На серверах точка — только `onlineUsers` (невидимый не в сети, «Время захода» не влияет).
 */

/** Сервер умеет `presence4`: «в сети» в ЛС по присутствию (включая «Невидимых» — `dmOnlineUsers`), время — по приватности. */
export function serverPresence4(features: readonly string[] | null | undefined): boolean {
  return !!features?.includes(FEATURE_PRESENCE4);
}

/**
 * ЧИСТАЯ (08.10, D4, решение 42): «в сети» для ЛС по присутствию шлюза — в сети на серверах или «Невидимый» в сети для ЛС
 * (`presence4`), и не «не здесь» (`presence5`, `dmAwayUsers`: приложение скрыто или простаивает). Серверные места — только
 * `onlineUsers`.
 */
export function dmPresent(
  s: { onlineUsers: readonly string[]; dmOnlineUsers: readonly string[]; dmAwayUsers?: readonly string[] },
  userId: string,
): boolean {
  return (s.onlineUsers.includes(userId) || s.dmOnlineUsers.includes(userId)) && !s.dmAwayUsers?.includes(userId);
}

/**
 * «В сети» в ЛС (шапка, карточка из ЛС, строки списков): с `presence4` — присутствие или локальное «в сети» после действия
 * (Telegram `LastseenStatus::isOnline` не смотрит на приватность); без — прежнее `dotShown`.
 */
export function dmDot(
  online: boolean,
  exact: boolean | undefined,
  features: readonly string[] | null | undefined,
  local = false,
): boolean {
  if (serverPresence4(features)) return online || local;
  return dotShown(online, exact, serverHidesOnline(features), local);
}

/** Сервер прячет «в сети» вместе со скрытым временем захода (`lastseen2`); без признака — точка по присутствию, как было. */
export function serverHidesOnline(features: readonly string[] | null | undefined): boolean {
  return !!features?.includes(FEATURE_LASTSEEN2);
}

/**
 * Показывать ли «в сети» / зелёную точку. `exact` — `UserLastSeen.exact` (`undefined` — ответа ещё нет: пока не знаем, прячем,
 * чтобы скрытый статус не мигнул «в сети»). Без `lastseen2` (`hides` = false) — присутствие как раньше.
 * `local` (G07) — «в сети» ещё `LOCAL_ONLINE_MS` после действия собеседника (сообщение, «печатает»): здесь (`lastseen2` без
 * `presence4`) считается ТОЛЬКО когда время захода мне видно (`exact`). С `presence4` — всегда, как у Telegram (`dmDot`).
 */
export function dotShown(online: boolean, exact: boolean | undefined, hides: boolean, local = false): boolean {
  if (hides) return exact === true && (online || local);
  return online;
}

/** Сколько «в сети» держится после действия собеседника (tdesktop `data_user.cpp` `kSetOnlineAfterActivity` = 30 с). */
export const LOCAL_ONLINE_MS = 30_000;

/** Локальное «в сети» после действия активно ещё `LOCAL_ONLINE_MS`. `at` — момент действия (`undefined` — действий не было). */
export function localOnlineActive(at: number | undefined, now: number): boolean {
  return at !== undefined && now - at >= 0 && now - at < LOCAL_ONLINE_MS;
}

/** Пачками по столько человек за запрос (потолок сервера — 200). */
export const BATCH = 200;

// Кэш `exact` по людям: общий для всех списков, чтобы строки не спрашивали одно и то же. Принадлежит одному аккаунту.
let owner: string | null = null;
const exactOf = new Map<string, boolean>();
const subs = new Set<() => void>();
let version = 0;

function bump() {
  version += 1;
  for (const f of subs) f();
}

function subscribe(f: () => void): () => void {
  subs.add(f);
  return () => {
    subs.delete(f);
  };
}

/** Забыть всё (смена аккаунта). */
export function resetExactCache(): void {
  owner = null;
  exactOf.clear();
  actionAt.clear();
  for (const t of actionTimers.values()) clearTimeout(t);
  actionTimers.clear();
  bump();
}

// Действия собеседников (G07, `lastseen3`): пришло его сообщение / «печатает» — до `LOCAL_ONLINE_MS` он «в сети» локально.
const actionAt = new Map<string, number>();
const actionTimers = new Map<string, ReturnType<typeof setTimeout>>();

/** Собеседник что-то сделал в ЛС (его сообщение, «печатает…») — «в сети» ещё 30 с (если время захода мне видно, `dotShown`). */
export function noteDmActivity(userId: string, now = Date.now()): void {
  const was = localOnlineActive(actionAt.get(userId), now);
  actionAt.set(userId, now);
  clearTimeout(actionTimers.get(userId));
  actionTimers.set(
    userId,
    setTimeout(() => {
      actionTimers.delete(userId);
      bump();
    }, LOCAL_ONLINE_MS + 50),
  );
  if (!was) bump();
}

/** Сервер сказал, что человек вышел из сети, — локальное «в сети» снимается (Telegram: серверный статус перекрывает локальный). */
export function clearDmActivity(userId: string): void {
  if (!actionAt.delete(userId)) return;
  clearTimeout(actionTimers.get(userId));
  actionTimers.delete(userId);
  bump();
}

/** Локальное «в сети» человека после его действия (перерисовка — по смене и по истечении 30 с). */
export function useLocalOnline(userId: string | null | undefined): boolean {
  return useSyncExternalStore(subscribe, () => (userId ? localOnlineActive(actionAt.get(userId), Date.now()) : false));
}

function merge(items: readonly UserLastSeen[]): void {
  let changed = false;
  for (const v of items) {
    if (exactOf.get(v.userId) !== v.exact) {
      exactOf.set(v.userId, v.exact);
      changed = true;
    }
  }
  if (changed) bump();
}

/** Люди, по которым запрос уже летит (одно и то же не спрашиваем дважды, пока он не вернулся). */
const pending = new Set<string>();

async function fetchExact(ids: readonly string[]): Promise<void> {
  const todo = ids.filter((id) => !pending.has(id));
  for (const id of todo) pending.add(id);
  for (let i = 0; i < todo.length; i += BATCH) {
    const part = todo.slice(i, i + BATCH);
    try {
      merge((await api.usersLastSeen(part)).items);
    } catch {
      /* 429 / сеть: следующая смена списка спросит снова; пока неизвестные остаются скрытыми */
    } finally {
      for (const id of part) pending.delete(id);
    }
  }
}

/**
 * Какие из `ids` показывать «в сети» (присутствие шлюза + время захода мне видно). Сама спрашивает сервер пачкой: новых
 * людей, вновь зашедших в сеть (настройку мог сменить кто угодно) и всех — при смене моей настройки «Время захода».
 */
export function useVisibleOnline(ids: readonly string[]): Set<string> {
  const p4 = useStore((s) => serverPresence4(s.serverFeatures));
  // С `presence4` спрашивать `exact` незачем: точка — по присутствию.
  const hides = useStore((s) => serverHidesOnline(s.serverFeatures)) && !p4;
  const onlineUsers = useStore((s) => s.onlineUsers);
  const dmOnlineUsers = useStore((s) => s.dmOnlineUsers);
  const dmAwayUsers = useStore((s) => s.dmAwayUsers);
  const meId = useStore((s) => s.user?.id ?? null);
  // Моя настройка и статус («Невидимый» скрывает время захода от всех) меняют то, что я вижу у других (взаимность).
  const myPrivacy = useStore((s) => `${s.user?.lastSeenPrivacy ?? ''}|${s.user?.status === 'invisible' ? 'inv' : ''}`);
  useSyncExternalStore(subscribe, () => version);
  const key = useMemo(() => [...new Set(ids)].sort().join(','), [ids]);
  const prevOnline = useRef<Set<string>>(new Set());
  const prevPrivacy = useRef(myPrivacy);

  useEffect(() => {
    if (!hides || !meId) return;
    if (owner !== meId) {
      owner = meId;
      exactOf.clear();
      bump();
    }
    const list = key ? key.split(',') : [];
    const onlineNow = new Set(onlineUsers);
    const privacyChanged = prevPrivacy.current !== myPrivacy;
    prevPrivacy.current = myPrivacy;
    const want = list.filter(
      (id) => privacyChanged || !exactOf.has(id) || (onlineNow.has(id) && !prevOnline.current.has(id)),
    );
    prevOnline.current = onlineNow;
    // Без отмены по смене зависимостей: каждый приход `online.update` пересоздаёт эффект, и дребезг съел бы запрос.
    if (want.length > 0) setTimeout(() => void fetchExact(want), 300);
  }, [hides, meId, myPrivacy, key, onlineUsers]);

  const seen = version; // смена кэша `exactOf` (внешнее хранилище) — в зависимости, чтобы набор пересчитался
  return useMemo(() => {
    const online = new Set(onlineUsers);
    if (p4) for (const id of dmOnlineUsers) online.add(id);
    // `presence5` (D4): «не здесь» — для ЛС не в сети, хотя сокет открыт.
    for (const id of dmAwayUsers ?? []) online.delete(id);
    const out = new Set<string>();
    const now = Date.now();
    for (const id of ids) {
      const local = localOnlineActive(actionAt.get(id), now);
      if (p4 ? online.has(id) || local : dotShown(online.has(id), exactOf.get(id), hides, local)) out.add(id);
    }
    return out;
  }, [ids, onlineUsers, dmOnlineUsers, dmAwayUsers, p4, hides, seen]);
}
