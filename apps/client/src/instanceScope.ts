/**
 * `localStorage` для настроек, привязанных к id активного инстанса (F0, #139). Правила и почему —
 * в `instanceScopeRules.ts`.
 *
 * ⚠️ Импорт `./config` здесь обязателен, а не для красоты: он гарантирует, что переход реестра
 * (`migrate()` на загрузке модуля) уже отработал, и `activeInstanceId()` отвечает по готовому реестру.
 * ⚠️ Смена инстанса перезапускает приложение (`restartApp`), поэтому модули, прочитавшие настройки
 * один раз на загрузке, всегда держат настройки ТЕКУЩЕГО инстанса.
 */
import { activeInstanceId } from './config';
import { readScopedValue, scopedStorageKey } from './instanceScopeRules';

export function scopedGetItem(base: string): string | null {
  try {
    return readScopedValue(
      base,
      activeInstanceId(),
      (k) => localStorage.getItem(k),
      (k, v) => localStorage.setItem(k, v),
    );
  } catch {
    return null;
  }
}

/** Может бросить (хранилище переполнено/недоступно) — как и `localStorage.setItem`. */
export function scopedSetItem(base: string, value: string): void {
  localStorage.setItem(scopedStorageKey(base, activeInstanceId()), value);
}
