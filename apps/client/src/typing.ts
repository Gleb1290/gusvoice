import { useSyncExternalStore } from 'react';
import type { TypingAction } from '@gusvoice/shared';

/**
 * Ephemeral "who is typing" state, keyed by channel id OR dm id (round-7 P4). Each typing
 * event refreshes a 6s expiry for that user; a 1s prune drops the stale ones. Names are
 * resolved by the caller (roster / DM other-user), so we only track userIds here.
 */
/**
 * Сколько держится «печатает» после сигнала — 6 с, как у Telegram (Desktop `history_view_send_action.cpp:
 * kStatusShowClientsideTyping`, Web K `appProfileManager`). Было 5 с.
 */
const TTL_MS = 6000;
/**
 * Как часто клиент шлёт сигнал набора, мс. Telegram — раз в 5 с (`api_send_progress.cpp: kSendMyTypingInterval`), у нас 4 с:
 * клиенты до этой версии показывают «печатает» 5 с, и при отправке раз в 5 с, плюс задержка сети, подпись у них мигала бы.
 * С 4 с и старый клиент (5 с), и новый (6 с) держат подпись непрерывно; когда старых клиентов не останется — вернуть 5000.
 * Старые клиенты шлют раз в 2,5 с — для нового показ 6 с их тоже не мигает.
 */
export const TYPING_SEND_MS = 4000;
/** Запись о человеке: до когда держится и что он делает (G21: «печатает» / «записывает голосовое» / «отправляет …»). */
interface Entry {
  exp: number;
  action: TypingAction;
}
/**
 * Что главнее (копия `typingActionRank` из `@gusvoice/shared`: этот модуль в тесте грузится отдельно, из зависимостей ему
 * разрешён один `react`, поэтому значение — а не импорт; таблицы обязаны совпадать).
 */
const RANK: Record<TypingAction, number> = { typing: 1, sticker: 1, photo: 2, video: 2, file: 2, voice: 3, voice_upload: 3, round: 3 };
const typing = new Map<string, Map<string, Entry>>(); // key -> userId -> запись
const listeners = new Set<() => void>();
let version = 0;
let timer: ReturnType<typeof setInterval> | null = null;

function emit() {
  version++;
  for (const l of listeners) l();
}

/** Забыть, кто печатал: после перехода в другой инстанс это чужие люди в чужих каналах (§5.7). */
export function clearTyping(): void {
  if (typing.size === 0) return;
  typing.clear();
  emit();
}

function ensureTimer() {
  if (timer) return;
  timer = setInterval(() => {
    const now = Date.now();
    let changed = false;
    for (const [key, m] of typing) {
      for (const [uid, e] of m) {
        if (e.exp <= now) {
          m.delete(uid);
          changed = true;
        }
      }
      if (m.size === 0) typing.delete(key);
    }
    if (changed) emit();
    if (typing.size === 0 && timer) {
      clearInterval(timer);
      timer = null;
    }
  }, 1000);
}

/**
 * Что человек делает сейчас (G21). Новый сигнал заменяет прежний, КРОМЕ одного случая: пока жива запись «главнее»
 * (запись голоса > отправка файла/фото/видео > набор текста), более слабый сигнал её не вытесняет — иначе пока файл
 * грузится, а человек печатает следующее, подпись мигала бы между двумя (набор шлётся каждые `TYPING_SEND_MS`, как и загрузка).
 * Слабый сигнал при этом всё равно ничего не продлевает: сильное гаснет в свой срок.
 */
export function noteTyping(key: string, userId: string, next: TypingAction = 'typing'): void {
  let m = typing.get(key);
  if (!m) typing.set(key, (m = new Map()));
  const now = Date.now();
  const cur = m.get(userId);
  if (cur && cur.exp > now && RANK[next] < RANK[cur.action]) {
    ensureTimer();
    return;
  }
  m.set(userId, { exp: now + TTL_MS, action: next });
  ensureTimer();
  emit();
}

/**
 * Человек дописал и отправил — его «печатает…» гаснет СРАЗУ, а не доживает свои 5 с (06.10, сверка с Telegram: у
 * Telegram статус уходит с приходом его сообщения). Зовёт гейтвей на каждое новое чужое сообщение — и канала, и ЛС.
 * Не было такого в списке — ничего не рассылаем: событие приходит на каждое сообщение, а перерисовка нужна только тем,
 * у кого что-то погасло.
 */
export function dropTyping(key: string, userId: string): void {
  const m = typing.get(key);
  if (!m || !m.delete(userId)) return;
  if (m.size === 0) typing.delete(key);
  emit();
}

function typingUsers(key: string): string[] {
  const m = typing.get(key);
  if (!m) return [];
  const now = Date.now();
  return [...m.entries()].filter(([, e]) => e.exp > now).map(([uid]) => uid);
}

const LABELS: Record<TypingAction, string> = {
  typing: 'печатает',
  voice: 'записывает голосовое',
  photo: 'отправляет фото',
  video: 'отправляет видео',
  file: 'отправляет файл',
  voice_upload: 'отправляет голосовое',
  sticker: 'выбирает стикер',
  // Кружок (09.10): tdesktop `lng_send_action_record_round` / Android `RecordingRound` — «записывает видеосообщение»; в ЛС и группах одинаково.
  round: 'записывает видеосообщение',
};

/** Подпись вида действия для шапки беседы и строки списка (без многоточия: его рисуют точки `.typing-dots`). */
export function typingActionLabel(action: TypingAction): string {
  return LABELS[action];
}

/** Что сейчас делает `userId` в `key` (нет живой записи — `'typing'`, хотя звать имеет смысл при `useTyping(key).includes`). */
export function useTypingAction(key: string, userId: string): TypingAction {
  useTyping(key);
  const e = typing.get(key)?.get(userId);
  return e && e.exp > Date.now() ? e.action : 'typing';
}

/** Currently-typing userIds for a channel/dm key. Re-renders on changes; prune handled internally. */
export function useTyping(key: string): string[] {
  useSyncExternalStore(
    (fn) => {
      listeners.add(fn);
      return () => listeners.delete(fn);
    },
    () => version,
  );
  return typingUsers(key);
}
