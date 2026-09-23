/**
 * `localStorage` для настроек, привязанных к id активного инстанса (F0, #139). Правила и почему —
 * в `instanceScopeRules.ts`.
 *
 * ⚠️ Импорт `./config` здесь обязателен, а не для красоты: он гарантирует, что переход реестра
 * (`migrate()` на загрузке модуля) уже отработал, и `activeInstanceId()` отвечает по готовому реестру.
 *
 * 🔴 **Смена инстанса больше НЕ перезапускает приложение** (§5.7, `instanceSwitch.ts`). Раньше
 * перезапуск сам собой гарантировал, что модуль, прочитавший настройку один раз на загрузке, держит
 * настройку текущего инстанса. Теперь это неправда: **всякий модуль, который кеширует прочитанное
 * отсюда, обязан уметь перечитать себя** и быть вписанным в `instanceSwitch.adoptActive()`. Сейчас
 * таких трое: `channelPrefs`, `localUserAudio` и громкости стримов в `store`. Заводя четвёртого —
 * добавить туда же, иначе человек увидит у себя дома заглушённые каналы соседа.
 */
import { activeInstanceId } from './config';
import { createScopedStorage } from './instanceScopeRules';

const storage = createScopedStorage({
  activeInstanceId,
  getItem: (key) => localStorage.getItem(key),
  setItem: (key, value) => localStorage.setItem(key, value),
});

export function scopedGetItem(base: string): string | null {
  return storage.get(base);
}

/** Может бросить (хранилище переполнено/недоступно) — как и `localStorage.setItem`. */
export function scopedSetItem(base: string, value: string): void {
  storage.set(base, value);
}
