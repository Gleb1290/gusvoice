import { useEffect, useRef, useState } from 'react';
import type { ServerBootstrap } from '@gusvoice/shared';
import { api } from '../api';
import { ATTACH_MAX, ATTACH_MAX_BYTES, dmAttachMaxBytes } from '../attachRules';
import { dmPeerLabel, usePeerName } from '../peerName';
import { sendShareTo, type ShareTarget } from '../shareSend';
import { nativeMediaAvailable, sharedDropNative, sharedFilesNative, sharedPeekNative } from '../nativeMedia';
import {
  parseIncomingShare,
  shareChannels,
  shareDoneText,
  shareFilesWithin,
  shareHead,
  shareSkippedText,
  type IncomingShare,
  type ShareChannel,
} from '../shareInbox';
import { useStore } from '../store';
import { subscribeToServer } from '../sockets';
import { toast, toastError } from '../toast';
import { ForwardPicker } from './ForwardPicker';

/**
 * «Поделиться в GusVoice» (09.10, G79; мультивыбор и каналы серверов — `andr2`): окно выбора беседы для пришедшего из чужого приложения (Android: системное «Поделиться»
 * → `ShareIntent.kt` / `MediaBridge.onShareIntent`). Как Telegram Android: `LaunchActivity.handleIntent` → `DialogsActivity`
 * в режиме выбора одного чата → чат с вложениями в предпросмотре. Окно — `ForwardPicker` с `pickOne` (беседы, группы и каналы
 * из списка ЛС, включая открытую). Выбрали — байты из кеша приложения становятся `File`-ами и вместе с текстом ждут ленту
 * беседы (`store.sharedIn` → `MessagePane`), беседа открывается. «Отмена» (крестик, мимо, «назад») — пришедшее забыто, копии
 * стёрты. Без объекта `GusVoiceMedia` (браузер, ПК, старая сборка APK) компонент ничего не делает — кроме старого WebView
 * Android (D22, без `ArrayBuffer`-сообщений): там пришедший ТЕКСТ идёт обычным мостом `GusVoiceNative.sharedText()`, а файлы
 * не передаются вовсе (оболочка их не копирует) — тост [SHARE_FILES_NEED_WEBVIEW].
 */

/** Старый WebView (D22): мост `@JavascriptInterface` оболочки, только текст. Нет методов — старая сборка APK. */
interface LegacyShareBridge {
  sharedText?: () => string;
  sharedTextDrop?: (token: string) => void;
}

function legacyShare(): Required<LegacyShareBridge> | null {
  if (nativeMediaAvailable()) return null;
  const b = (window as unknown as { GusVoiceNative?: LegacyShareBridge }).GusVoiceNative;
  return b && typeof b.sharedText === 'function' && typeof b.sharedTextDrop === 'function' ? (b as Required<LegacyShareBridge>) : null;
}

/** Файлы со старым WebView не передаются: объекта `GusVoiceMedia` нет, а base64 через строковый мост — не для 25 МБ. */
export const SHARE_FILES_NEED_WEBVIEW = 'Чтобы делиться файлами, обновите Android System WebView';

async function peekShare(): Promise<unknown> {
  if (nativeMediaAvailable()) return sharedPeekNative();
  const raw = legacyShare()?.sharedText() ?? '';
  if (!raw) return null;
  try {
    return JSON.parse(raw) as unknown;
  } catch {
    return null;
  }
}

function dropShare(token: string): void {
  if (nativeMediaAvailable()) {
    void sharedDropNative(token);
    return;
  }
  try {
    legacyShare()?.sharedTextDrop(token);
  } catch {
    /* мост старой оболочки — пришедшее заменится следующим */
  }
}

/**
 * Текстовые каналы всех моих серверов, куда я могу писать, для окна «Поделиться в…»: bootstrap каждого сервера (текущий —
 * из стора, без запроса). Сбой одного сервера — его каналов просто нет в списке. Пока грузится — список дополняется.
 */
function useShareChannels(on: boolean): ShareChannel[] {
  const [list, setList] = useState<ShareChannel[]>([]);
  useEffect(() => {
    if (!on) return;
    let alive = true;
    const st = useStore.getState();
    const loaded = new Map<string, ServerBootstrap>();
    const publish = () => {
      if (!alive) return;
      const order = useStore.getState().servers.map((sv) => loaded.get(sv.id)).filter((b): b is ServerBootstrap => !!b);
      setList(shareChannels(order));
    };
    for (const sv of st.servers) {
      if (st.bootstrap?.server.id === sv.id) loaded.set(sv.id, st.bootstrap);
    }
    publish();
    for (const sv of st.servers) {
      if (loaded.has(sv.id)) continue;
      void api
        .getServer(sv.id)
        .then((b) => {
          loaded.set(sv.id, b);
          publish();
        })
        .catch(() => {});
    }
    return () => {
      alive = false;
    };
  }, [on]);
  return list;
}

export function ShareIncoming() {
  const [share, setShare] = useState<IncomingShare | null>(null);
  const channels = useShareChannels(!!share);
  const nameOf = usePeerName();
  /** Метка, по которой уже выбрали беседу: закрытие окна после выбора не должно стирать копии раньше, чем их прочли. */
  const pickedToken = useRef('');

  useEffect(() => {
    if (!nativeMediaAvailable() && !legacyShare()) return;
    let alive = true;
    const peek = async () => {
      const raw = await peekShare();
      if (!alive) return;
      const parsed = parseIncomingShare(raw);
      const s = parsed ? { ...parsed, files: shareFilesWithin(parsed.files, dmAttachMaxBytes()) } : null;
      const token = raw && typeof raw === 'object' ? String((raw as { token?: unknown }).token ?? '') : '';
      // Старый WebView прислал файлы — их не будет (D22); текст, если есть, всё равно идёт в окно выбора.
      const filesOff = raw && typeof raw === 'object' ? Number((raw as { filesOff?: unknown }).filesOff) || 0 : 0;
      if (filesOff > 0) toast('warn', SHARE_FILES_NEED_WEBVIEW);
      if (!s) {
        if (token) dropShare(token);
        return;
      }
      // Ничего годного (всё больше 25 МБ / не читается) — окно не открываем, сразу говорим почему.
      if (!s.text && !s.files.some((f) => !f.skip)) {
        dropShare(s.token);
        toast(
          'warn',
          shareSkippedText(
            s.files.map((f) => ({ name: f.name, reason: f.skip ?? 'unreadable' })),
            s.dropped,
            dmAttachMaxBytes(),
            ATTACH_MAX,
          ) || 'Нечего отправить',
        );
        return;
      }
      setShare((cur) => (cur?.token === s.token ? cur : s));
      const st = useStore.getState();
      if (st.dms.length === 0) void st.loadDms().catch(() => {});
    };
    const w = window as unknown as { __gvShare?: () => void };
    const hook = () => void peek();
    w.__gvShare = hook;
    void peek();
    return () => {
      alive = false;
      if (w.__gvShare === hook) delete w.__gvShare;
    };
  }, []);

  if (!share) return null;

  /**
   * Принятые файлы натива → `File`-ы (один раз; в каждое место уходят те же). Натив отдаёт все свои копии — больше `max`
   * (предел ЛС с сервера: без `bigfile1` — 25 МБ; канал сервера — всегда `ATTACH_MAX_BYTES`) не прикрепляем.
   */
  async function takeFiles(s: IncomingShare, max: number) {
    const got = s.files.some((f) => !f.skip)
      ? await sharedFilesNative(s.token)
      : { files: [] as File[], skipped: s.files.map((f) => ({ name: f.name, reason: f.skip ?? ('unreadable' as const) })), dropped: s.dropped };
    return {
      ...got,
      files: got.files.filter((f) => f.size <= max),
      skipped: [...got.skipped, ...got.files.filter((f) => f.size > max).map((f) => ({ name: f.name, reason: 'too-big' as const }))],
    };
  }

  async function pick(s: IncomingShare, convId: string) {
    pickedToken.current = s.token;
    try {
      const ch = channels.find((c) => c.id === convId);
      const max = ch ? ATTACH_MAX_BYTES : dmAttachMaxBytes();
      const res = await takeFiles(s, max);
      const st = useStore.getState();
      st.setSharedIn({ convId, files: res.files, text: s.text });
      if (ch) {
        // Канал сервера: открыть сервер (если не он) и канал — лента канала заберёт `sharedIn`, как лента беседы.
        if (st.currentServerId !== ch.serverId) await st.openServer(ch.serverId, ch.id);
        else {
          st.setView('server');
          await st.openChannel(ch.id);
        }
        subscribeToServer(ch.serverId);
      } else void st.selectDm(convId).catch(() => {});
      const why = shareSkippedText(res.skipped, s.dropped, max, ATTACH_MAX);
      if (why) toast('warn', why);
    } catch {
      toast('error', 'Не удалось взять файлы — поделитесь ещё раз');
    } finally {
      dropShare(s.token);
    }
  }

  /** «Отправить (N)»: сразу всем отмеченным (беседам и каналам), комментарий окна — отдельным сообщением первым. */
  async function sendAll(s: IncomingShare, ids: string[], comment: string) {
    pickedToken.current = s.token;
    const st = useStore.getState();
    const label = (id: string): string => {
      const ch = channels.find((c) => c.id === id);
      if (ch) return `#${ch.name}`;
      const d = st.dms.find((x) => x.id === id);
      return d ? dmPeerLabel(d, nameOf) : 'беседа';
    };
    try {
      // Есть канал сервера среди мест — его предел (25 МБ) общий для всех: файлы одни на всех.
      const max = ids.some((id) => channels.some((c) => c.id === id)) ? Math.min(ATTACH_MAX_BYTES, dmAttachMaxBytes()) : dmAttachMaxBytes();
      const res = await takeFiles(s, max);
      const why = shareSkippedText(res.skipped, s.dropped, max, ATTACH_MAX);
      if (why) toast('warn', why);
      const targets: ShareTarget[] = ids.map((id) => ({ kind: channels.some((c) => c.id === id) ? 'channel' : 'conv', id }));
      toast('info', ids.length > 1 ? 'Отправляю…' : `Отправляю: ${label(ids[0])}`);
      const out = await sendShareTo(targets, { text: s.text, files: res.files, comment });
      const done = out.filter((r) => r.ok).map((r) => label(r.target.id));
      for (const r of out) if (!r.ok) toastError(r.error, `Не отправлено: ${label(r.target.id)}`);
      if (done.length > 0) toast('success', shareDoneText(done));
    } catch {
      toast('error', 'Не удалось взять файлы — поделитесь ещё раз');
    } finally {
      dropShare(s.token);
    }
  }

  const s = share;
  return (
    <ForwardPicker
      key={s.token}
      count={Math.max(1, s.files.length)}
      share={{ title: 'Поделиться в…', head: shareHead(s), channels }}
      onDraft={(id) => void pick(s, id)}
      onSend={(ids, o) => void sendAll(s, ids, o.comment)}
      onClose={() => {
        setShare((cur) => (cur?.token === s.token ? null : cur));
        if (pickedToken.current !== s.token) dropShare(s.token);
      }}
    />
  );
}
