import { useEffect, useState, useSyncExternalStore } from 'react';
import { api } from './api';
import { ensureEconomy } from './economyClient';
import { useStore } from './store';
import { toast, toastError } from './toast';
import { nextTipMode } from './tipMode';

/**
 * Браузерная обвязка жеста «тип»: зажатый Alt и сама отправка (#117).
 *
 * 🔴 **Почему отдельным модулем.** Жест живёт в ДВУХ местах сразу: на плитках сцены и на никах в
 * сайдбаре. Пока состояние Alt лежало внутри сцены, сайдбар о нём не знал вовсе — и рамок на никах
 * не появлялось ни при каком нажатии. Два независимых слушателя дали бы два источника правды,
 * расходящихся на Alt+Tab: сцена успевает поймать `keyup`, а сайдбар остаётся с зажатым Alt
 * навсегда.
 *
 * ⚠️ Сами правила перехода лежат в `tipMode.ts` и проверяются тестом. Здесь только окно и React.
 */

/** Зажат ли Alt прямо сейчас. Один флаг на приложение — см. шапку. */
let altHeld = false;
/** Сколько компонентов сейчас нуждаются в слушателях. */
let consumers = 0;
const subs = new Set<() => void>();

function signal(s: Parameters<typeof nextTipMode>[1]): void {
  const next = nextTipMode(altHeld, s);
  if (next === altHeld) return;
  altHeld = next;
  for (const cb of subs) cb();
}

/**
 * ⚠️ `preventDefault` на голом Alt обязателен: иначе Windows уводит фокус в меню окна, и `keyup`
 * приходит уже мимо страницы — кнопка «Тип» осталась бы висеть после отпускания.
 */
const onDown = (e: KeyboardEvent) => {
  if (e.key !== 'Alt') return;
  e.preventDefault();
  signal('alt-down');
};
const onUp = (e: KeyboardEvent) => {
  if (e.key !== 'Alt') return;
  e.preventDefault();
  signal('alt-up');
};
/** Alt+Tab забирает `keyup` себе — на потерю фокуса гасим состояние принудительно. */
const onBlur = () => signal('blur');

function attach(): () => void {
  if (consumers++ === 0) {
    window.addEventListener('keydown', onDown);
    window.addEventListener('keyup', onUp);
    window.addEventListener('blur', onBlur);
  }
  return () => {
    if (--consumers > 0) return;
    window.removeEventListener('keydown', onDown);
    window.removeEventListener('keyup', onUp);
    window.removeEventListener('blur', onBlur);
    signal('blur');
  };
}

function subscribe(cb: () => void): () => void {
  subs.add(cb);
  return () => {
    subs.delete(cb);
  };
}

/**
 * Зажат ли Alt. `enabled === false` — слушателей не вешаем вовсе.
 *
 * 🔴 Слушатель ОДИН на приложение, с подсчётом подписчиков. Alt жмут часто и не ради типа: держать
 * `preventDefault` на всём окне, когда экономика выключена, значит отбирать у системы меню на
 * ровном месте.
 */
export function useAltHeld(enabled: boolean): boolean {
  const held = useSyncExternalStore(
    subscribe,
    () => altHeld,
    () => false,
  );
  useEffect(() => (enabled ? attach() : undefined), [enabled]);
  return enabled && held;
}

/**
 * Отправка типа. `busyId` — кому прямо сейчас отправляем (на время запроса жест заперт целиком).
 *
 * ⚠️ Сумму и законность решает сервер: клиент отвечает только за доступность жеста. Кулдаун,
 * суточные пределы и отказы получателя он не угадывает.
 */
export function useTip(): {
  tip: (channelId: string, userId: string, name: string) => Promise<void>;
  busyId: string | null;
} {
  const [busyId, setBusyId] = useState<string | null>(null);
  const serverId = useStore((s) => s.bootstrap?.server.id ?? null);
  const economy = useStore((s) => (serverId ? s.economy[serverId] : undefined));

  const tip = async (channelId: string, userId: string, name: string) => {
    if (!serverId || !economy?.enabled || busyId) return;
    setBusyId(userId);
    try {
      const result = await api.tip(channelId, userId);
      toast('success', 'Тип отправлен', `${name}: +${result.credited} ${economy.currencyName}`);
      // Свой баланс приедет пушем `economy.wallet` — сервер шлёт его при любом движении монет.
      // Перезапрос оставлен страховкой на случай, если событие не доехало; его провал не должен
      // превращать уже состоявшийся тип в ложную ошибку у отправителя.
      ensureEconomy(serverId, true);
    } catch (e) {
      // tipRules.ts возвращает человеческий текст в `error`; не подменяем его догадкой клиента.
      toastError(e);
    } finally {
      setBusyId(null);
    }
  };

  return { tip, busyId };
}
