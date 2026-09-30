/**
 * Ключи шифрования пуша от нативного моста Android → форма для `/push/register` (#213, WebPush RFC 8291).
 *
 * Вынесено из `nativeUnifiedPush.ts` (просьба Codex 28.09): тот модуль тянет стор, сокеты и браузер, и разбор
 * проверялся только файловым стражем. Здесь — чистая функция над строкой, которую вернул `pushKeys()` моста.
 *
 * Любой сбой — `null`: регистрация без ключей лучше, чем никакой (пуш тогда придёт без текста). Пустая строка,
 * битый JSON, не объект, поле не строкой или пустое — всё это «ключей нет».
 */
export function parsePushKeys(raw: string | null | undefined): { p256dh: string; auth: string } | null {
  if (!raw) return null;
  try {
    const k = JSON.parse(raw) as { p256dh?: unknown; auth?: unknown } | null;
    // Пустая строка — тоже «ключей нет»: `/push/register` отверг бы её 400 и телефон остался бы вовсе без пуша (Codex 30.09).
    return k && typeof k.p256dh === 'string' && typeof k.auth === 'string' && k.p256dh !== '' && k.auth !== ''
      ? { p256dh: k.p256dh, auth: k.auth }
      : null;
  } catch {
    return null;
  }
}
