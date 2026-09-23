import type { InstanceInfo } from '@gusvoice/shared';
import { useSyncExternalStore } from 'react';
import { api } from './api';

/**
 * Работает ли федерация на инстансе, в который мы вошли (#139, F4).
 *
 * 🔴 Зачем признак вообще. На выключенной федерации маршрутов НЕТ ВОВСЕ — не 403, а 404. Без этого
 * знания окно проверки ссылки било бы в несуществующий адрес на каждую вставку кода и показывало
 * человеку поломку там, где её нет: у него просто обычный инстанс без федерации.
 *
 * ⚠️ Спрашиваем ОДИН раз за запуск и не подписываемся: признак меняется перезапуском бэкенда
 * (`FEDERATION_ENABLED` в `.env`), а не по ходу дела. При смене инстанса приложение перезапускается
 * целиком — модуль загрузится заново и спросит уже новый инстанс.
 *
 * ⚠️ Не ответил — считаем, что федерации нет. Так ошибка сети превращается в «обычное поведение, как
 * до федерации», а не в неработающее окно.
 */
let known: boolean | null = null;
let asked = false;
const subs = new Set<() => void>();

function publish(v: boolean): void {
  if (known === v) return;
  known = v;
  for (const s of subs) s();
}

/**
 * Спросить заново — после перехода в другой инстанс (§5.7).
 *
 * ⚠️ Признак принадлежит инстансу: у соседа федерация есть, у дома может не быть. Раньше это
 * держалось на перезапуске приложения при смене инстанса; мягкий переход перезапуска не делает.
 */
export function resetFederationProbe(): void {
  asked = false;
  known = null;
  for (const s of subs) s();
}

/** Спросить инстанс (один раз за запуск). Возвращает то, что уже известно, не дожидаясь ответа. */
export function askFederation(): void {
  if (asked) return;
  asked = true;
  api
    .instance()
    .then((info: InstanceInfo) => publish(info.federation === true))
    .catch(() => publish(false));
}

export function useFederationEnabled(): boolean {
  askFederation();
  return useSyncExternalStore(
    (fn) => {
      subs.add(fn);
      return () => subs.delete(fn);
    },
    () => known === true,
    () => false,
  );
}
