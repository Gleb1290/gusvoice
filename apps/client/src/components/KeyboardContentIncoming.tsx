import { useEffect } from 'react';
import { ATTACH_MAX, ATTACH_MAX_BYTES, dmAttachMaxBytes } from '../attachRules';
import { nativeMediaAvailable, sharedDropNative, sharedFilesNative, sharedPeekNative } from '../nativeMedia';
import { parseIncomingShare, shareFilesWithin, shareSkippedText } from '../shareInbox';
import { useStore } from '../store';
import { toast } from '../toast';

/**
 * Картинки и GIF из клавиатуры (Gboard и др.), G50 (14.10). Оболочка Android (`KeyboardContent.kt`) объявляет полю ввода
 * `image/*` и при `commitContent` копирует файл в кеш тем же путём, что «Поделиться» (`MediaBridge.onKeyboardContent` →
 * `copyShared`), затем зовёт `window.__gvKeyboardContent()`. Здесь: берём копию (`shared` / `sharedOpen` / `sharedDrop` —
 * те же операции моста) и кладём в ленту ОТКРЫТОЙ беседы или канала через `store.sharedIn` — дальше её забирает `MessagePane`
 * тем же `addFiles`, что для «Прикрепить» и «Поделиться»: файл встаёт вложением в поле, отправляет человек.
 * Как Telegram Android: `EditTextCaption` отдаёт `commitContent` в `ChatActivityEnterView` → превью вложения в поле
 * (код Telegram не копировали). Без объекта `GusVoiceMedia` (браузер, ПК, старая сборка APK) — ничего не делает.
 */
export function KeyboardContentIncoming() {
  useEffect(() => {
    if (!nativeMediaAvailable()) return;
    const w = window as unknown as { __gvKeyboardContent?: () => void };
    let alive = true;
    const take = async () => {
      let token = '';
      try {
        const raw = await sharedPeekNative();
        // Метку берём ДО проверки `alive`: сняли компонент, пока ждали ответа, — файл всё равно стираем в `finally`.
        token = raw && typeof raw === 'object' ? String((raw as { token?: unknown }).token ?? '') : '';
        if (!alive) return;
        const parsed = parseIncomingShare(raw);
        if (!parsed) return;
        const st = useStore.getState();
        const feed = st.view === 'dm' ? st.currentDmId : st.currentChannelId;
        if (!feed) {
          toast('info', 'Откройте беседу, чтобы вставить картинку');
          return;
        }
        // Предел файла — как у «Поделиться»: в ЛС по серверу (`bigfile1`), в канале сервера — прежние 25 МБ.
        const max = st.view === 'dm' ? dmAttachMaxBytes() : ATTACH_MAX_BYTES;
        const files = shareFilesWithin(parsed.files, max);
        const got = files.some((f) => !f.skip)
          ? await sharedFilesNative(parsed.token)
          : { files: [] as File[], skipped: files.map((f) => ({ name: f.name, reason: f.skip ?? ('unreadable' as const) })), dropped: parsed.dropped };
        if (!alive) return;
        const fit = got.files.filter((f) => f.size <= max);
        const skipped = [...got.skipped, ...got.files.filter((f) => f.size > max).map((f) => ({ name: f.name, reason: 'too-big' as const }))];
        if (fit.length > 0) useStore.getState().setSharedIn({ convId: feed, files: fit, text: '' });
        const why = shareSkippedText(skipped, got.dropped, max, ATTACH_MAX);
        if (why) toast('warn', why);
      } catch {
        toast('error', 'Не удалось взять картинку из клавиатуры');
      } finally {
        if (token) void sharedDropNative(token);
      }
    };
    const hook = () => void take();
    w.__gvKeyboardContent = hook;
    return () => {
      alive = false;
      if (w.__gvKeyboardContent === hook) delete w.__gvKeyboardContent;
    };
  }, []);
  return null;
}
