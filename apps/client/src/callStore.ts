/**
 * Звонки 1:1 в ЛС (08.10, #211, С5, `calls1`) — состояние звонка на этом устройстве. Сервер — источник правды: каждое
 * событие `call.state` (сокет, `sockets.ts`) и ответ ручки кладутся через `apply`; что показать — `callView.callViewFor`.
 * Медиа (комната LiveKit), звонок-рингтон и разметка — `components/CallLayer.tsx`.
 */
import { CALL_BUSY_ERROR, CALL_PRIVACY_ERROR, type CallJoinResponse, type DmCall } from '@gusvoice/shared';
import type { LocalVideoTrack, RemoteTrack } from 'livekit-client';
import { create } from 'zustand';
import { api } from './api';
import { callApiFor } from './callFed';
import { callPrivacyNotice, callViewFor, serverFedCalls } from './callView';
import { alertDialog } from './confirm';
import { peerNameNow } from './peerName';
import { useStore } from './store';
import { toast, toastError } from './toast';

/** Id этой вкладки: ответ на одном устройстве гасит входящий на остальных (`DmCall.calleeDevice`). */
/** Окно «<Имя> ограничил(а) звонки» (`callView.callPrivacyNotice`): трубка при `canCall === false` и 403 `call_privacy`. */
export function explainCallPrivacy(name: string): void {
  const n = callPrivacyNotice(name);
  void alertDialog(n.title, n.body, { icon: n.icon });
}

export const CALL_DEVICE: string =
  typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function' ? crypto.randomUUID() : `d${Math.random().toString(36).slice(2)}`;

export interface CallPeer {
  id: string;
  name: string;
  avatarUrl: string | null;
}

interface CallState {
  call: DmCall | null;
  /** Пропуск в комнату — только у устройства, которое ведёт звонок. */
  join: Pick<CallJoinResponse, 'url' | 'token' | 'room'> | null;
  peer: CallPeer | null;
  muted: boolean;
  /** Медиа подключено и собеседник в комнате — с этого момента идёт счётчик. */
  connected: boolean;
  /** Телефон: экран звонка развёрнут (свёрнут — полоса над лентой). */
  expanded: boolean;
  /** Только что кончившийся звонок — экран показывает «звонок завершён» пару секунд. */
  ended: DmCall | null;
  /** Видео (`calls2`): хочу ли я камеру и показ экрана — комнату под это подгоняет `CallLayer.useCallMedia`. */
  camera: boolean;
  screen: boolean;
  /** Телефон: какая камера (фронт / тыл). */
  facing: 'user' | 'environment';
  /** Своя камера (превью в углу) и видео собеседника (показ экрана важнее камеры) — дорожки комнаты. */
  localVideo: LocalVideoTrack | null;
  remoteVideo: RemoteTrack | null;
  /** Видео собеседника — показ экрана (вписать целиком), а не камера (заполнить). */
  remoteScreen: boolean;
  start: (conversationId: string) => Promise<void>;
  answer: () => Promise<void>;
  decline: () => Promise<void>;
  hangup: () => Promise<void>;
  /** Знак жизни звонка этого устройства; у звонка с другого инстанса (`DmCall.host`) — туда же, по сессии у звонящего. */
  ping: (callId: string, video?: boolean) => Promise<void>;
  apply: (call: DmCall | null) => void;
  resync: () => Promise<void>;
  setMuted: (muted: boolean) => void;
  setConnected: (connected: boolean) => void;
  setExpanded: (expanded: boolean) => void;
  setCamera: (camera: boolean) => void;
  setScreen: (screen: boolean) => void;
  flipCamera: () => void;
  setVideoTracks: (v: { localVideo?: LocalVideoTrack | null; remoteVideo?: RemoteTrack | null; remoteScreen?: boolean }) => void;
}

/** Медиа звонка — в исходное (новый звонок, конец звонка). */
const NO_VIDEO = { camera: false, screen: false, facing: 'user' as const, localVideo: null, remoteVideo: null, remoteScreen: false };

function me(): string | undefined {
  return useStore.getState().user?.id;
}

/** Имя собеседника беседы для окон — подпись контакта, иначе имя (`peerName.ts`). */
function convPeerName(conversationId: string): string {
  const u = useStore.getState().dms.find((d) => d.id === conversationId)?.otherUser;
  return u ? peerNameNow(u.id, u.displayName) : '';
}

/** Как назвать инстанс собеседника-соседа в тексте отказа звонка: название от держателя или домен; свой человек — `null`. */
function peerHomeName(conversationId: string): string | null {
  const h = useStore.getState().dms.find((d) => d.id === conversationId)?.otherUser.homeInstance;
  return h?.name?.trim() || h?.domain || null;
}

/** Собеседник звонка — из списка бесед (сводка ЛС несёт имя и аватар). */
function peerOf(call: DmCall): CallPeer {
  const other = call.callerId === me() ? call.calleeId : call.callerId;
  const dm = useStore.getState().dms.find((d) => d.id === call.conversationId);
  const u = dm?.otherUser;
  // Подпись контакта вместо имени (решение владельца 08.10 п.27, `peerName.ts`): окно звонка и входящий.
  return { id: other, name: u ? peerNameNow(u.id, u.displayName) : 'Собеседник', avatarUrl: u?.avatarUrl ?? null };
}

let endedTimer: ReturnType<typeof setTimeout> | null = null;

export const useCall = create<CallState>((set, get) => ({
  call: null,
  join: null,
  peer: null,
  muted: false,
  connected: false,
  expanded: true,
  ended: null,
  ...NO_VIDEO,

  start: async (conversationId) => {
    if (get().call) return;
    // Р-9: у Telegram одна линия — звоню из голосового канала, значит сперва выхожу из него.
    if (useStore.getState().voice) useStore.getState().leaveVoice();
    try {
      const res = await api.callStart(conversationId, CALL_DEVICE);
      /* Развернуть — только НОВЫЙ звонок (`apply`: другой id → `expanded: true`). 🔴 callbar (08.10): событие шлюза `call.state`
         приходит раньше ответа на этот запрос и уже показывает экран вызова; человек успевал его свернуть («назад», шеврон),
         а поздний ответ разворачивал обратно поверх беседы или списка. */
      set({ join: { url: res.url, token: res.token, room: res.room }, muted: false, ...NO_VIDEO });
      get().apply(res.call);
    } catch (e) {
      if ((e as Error).message === CALL_BUSY_ERROR) toast('info', 'Линия занята', 'Собеседник сейчас в другом звонке');
      // `presence4`: «Кто может звонить» собеседника (трубка была видна до смены его настройки). Текст — tdesktop
      // `lng_call_error_not_available`; то же окно, что на нажатие трубки при известном запрете (`explainCallPrivacy`).
      else if ((e as Error).message === CALL_PRIVACY_ERROR) explainCallPrivacy(convPeerName(conversationId));
      // Э6 (`fedcall1`): отказ дома/инстанса собеседника-соседа (`federation.unsupported`, `federation.peer_unreachable`) — про звонок.
      else toastError(Object.assign(e as object, { fedCall: true, fedWho: peerHomeName(conversationId) }), 'Не удалось позвонить');
    }
  },

  answer: async () => {
    const call = get().call;
    if (!call) return;
    // Р-9: «Выйти из канала и ответить».
    if (useStore.getState().voice) useStore.getState().leaveVoice();
    try {
      // Э6: звонок с другого инстанса (`call.host`) принимаем ТАМ (`callFed.callApiFor`): пропуск в его комнату, не в свой дом.
      const res = await (await callApiFor(call)).callAnswer(call.id, CALL_DEVICE);
      // Пока шёл ответ, звонок кончился у меня (отклонил, отменили): не воскрешаем его — а на стороне звонящего ответ уже принят, кладём трубку.
      if (call.host && get().call?.id !== call.id) {
        void callApiFor(call).then((a) => a.callHangup(call.id)).catch(() => {});
        return;
      }
      set({ join: { url: res.url, token: res.token, room: res.room }, muted: false, expanded: true, ...NO_VIDEO });
      // Ответ хозяина несёт ЕГО номера людей; наш дом пришлёт `active` со своими. Пока — своя запись звонка, ставшая «идёт».
      get().apply(
        call.host ? { ...call, phase: 'active', calleeDevice: CALL_DEVICE, answeredAt: res.call.answeredAt ?? new Date().toISOString() } : res.call,
      );
    } catch (e) {
      toastError(Object.assign(e as object, { fedCall: true }), 'Не удалось ответить');
      get().apply(null);
    }
  },

  decline: async () => {
    const call = get().call;
    if (!call) return;
    get().apply({ ...call, phase: 'ended', reason: 'busy' });
    await callApiFor(call).then((a) => a.callDecline(call.id)).catch(() => {});
  },

  hangup: async () => {
    const call = get().call;
    if (!call) return;
    get().apply({ ...call, phase: 'ended', reason: call.phase === 'ringing' ? 'missed' : 'hangup' });
    await callApiFor(call).then((a) => a.callHangup(call.id)).catch(() => {});
  },

  ping: async (callId, video) => {
    const call = get().call;
    if (!call || call.id !== callId) return;
    await (await callApiFor(call)).callPing(callId, video);
  },

  apply: (call) => {
    const cur = get().call;
    // Событие о чужом звонке, когда у меня свой, — не моё дело (сервер так не шлёт, но страховка дешёвая).
    if (call && cur && call.id !== cur.id && call.phase !== 'ended' && callViewFor(cur, me(), CALL_DEVICE) !== 'none') return;
    const view = callViewFor(call, me(), CALL_DEVICE);
    if (view === 'none' || view === 'elsewhere') {
      const wasMine = !!cur && (!call || call.id === cur.id);
      if (!wasMine) return;
      // Кончился у меня на глазах — пару секунд «звонок завершён»; ответили на другом устройстве — гаснет молча.
      const shown = call && call.phase === 'ended' && callViewFor(cur, me(), CALL_DEVICE) !== 'incoming' ? call : null;
      set({ call: null, join: null, connected: false, ended: shown, ...NO_VIDEO });
      if (endedTimer) clearTimeout(endedTimer);
      if (shown) endedTimer = setTimeout(() => set({ ended: null }), 1800);
      return;
    }
    if (endedTimer) clearTimeout(endedTimer);
    set({ call, peer: peerOf(call!), ended: null, ...(cur?.id !== call!.id ? { expanded: true, connected: false } : {}) });
  },

  /** После (пере)подключения шлюза или загрузки страницы — мой текущий звонок у сервера. */
  resync: async () => {
    try {
      // `fed` (Э6): и входящий с другого инстанса; без признака у сервера его нет — и спрашивать нечего.
      const { call } = await api.callActive(serverFedCalls(useStore.getState().serverFeatures));
      const cur = get().call;
      if (!call) {
        if (cur) get().apply({ ...cur, phase: 'ended', reason: 'disconnect' });
        return;
      }
      // Разговор этого устройства после перезагрузки страницы не восстановить (пропуска нет) — кладём трубку.
      const view = callViewFor(call, me(), CALL_DEVICE);
      get().apply(call);
      if ((view === 'active' || view === 'outgoing') && !get().join) void get().hangup();
    } catch {
      /* сервер без `calls1` или сеть — ничего */
    }
  },

  setMuted: (muted) => set({ muted }),
  setConnected: (connected) => set({ connected }),
  setExpanded: (expanded) => set({ expanded }),
  setCamera: (camera) => set({ camera }),
  setScreen: (screen) => set({ screen }),
  flipCamera: () => set({ facing: get().facing === 'user' ? 'environment' : 'user' }),
  setVideoTracks: (v) => set(v),
}));
