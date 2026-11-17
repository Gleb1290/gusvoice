/**
 * Каким путём телефон получает пуш (#247) — чистое правило без моста и побочных эффектов (`nativeUnifiedPush.ts`).
 *
 * - `store` — пуш магазина (Google FCM): сборка Google Play и на устройстве есть Google Play services. Первым:
 *   ни второго приложения, ни вечного уведомления службы.
 * - `embedded` — встроенный распространитель (своя служба с сокетом к ntfy инстанса): мост его умеет, сборка его
 *   не вычеркнула (в Google Play вычеркнут) и инстанс назвал адрес ntfy (`config.pushGateway`).
 * - `external` — внешний распространитель UnifiedPush (отдельное приложение ntfy). Последний запасной путь.
 */
export type PushPath = 'store' | 'embedded' | 'external';

export interface PushPathInput {
  /** Мост умеет пуш магазина и сказал «есть» (`storePushAvailable()`). */
  storeAvailable: boolean;
  /** В мосту есть `enableEmbeddedPush` (старые APK без него). */
  embeddedBridge: boolean;
  /** Сборка не вычеркнула встроенный распространитель (`embeddedPushAllowed()`; метода нет — старый APK, есть). */
  embeddedAllowed: boolean;
  /** Адрес ntfy инстанса из обнаружения (`config.pushGateway`); пусто — встроенному не к чему подключаться. */
  pushGateway: string | undefined;
}

export function choosePushPath(i: PushPathInput): PushPath {
  if (i.storeAvailable) return 'store';
  if (i.embeddedBridge && i.embeddedAllowed && i.pushGateway) return 'embedded';
  return 'external';
}
