import { useNameResolver } from '../memberName';
import { useStore, voiceIsHere } from '../store';
import { returnToVoice } from './VoicePanel';
import { toggleSelfMute } from '../voiceSelf';
import { toastError } from '../toast';
import { Avatar } from './Avatar';
import { Icon } from './Icon';

/**
 * Mobile minimized call chip (design-step8 B3): the single persistent voice surface shown above the tab
 * bar while connected to voice. Replaces the desktop VoicePanel + SelfVoiceBar stack so mobile never has
 * three stacked bottom bars. Tap it to open the call view; quick mic toggle + red hang-up.
 *
 * Reads everything from the store (presence + liveVoice), so it works over ANY sidebar (channels or DMs)
 * without needing a LiveKit RoomContext. Rendered by MainLayout while `voice` is set — in the app and, since 06.10, in
 * the phone layout of a browser (≤ 760 px), where the mobile styles hide VoicePanel + SelfVoiceBar too.
 */
export function MobileCallChip() {
  const voice = useStore((s) => s.voice);
  const bootstrap = useStore((s) => s.bootstrap);
  const presence = useStore((s) => s.presence);
  const liveVoice = useStore((s) => s.liveVoice);
  const selfMuted = useStore((s) => s.selfMuted);
  const openChannel = useStore((s) => s.openChannel);
  const leaveVoice = useStore((s) => s.leaveVoice);
  const nameOf = useNameResolver();
  if (!voice) return null;

  // Голос на другом инстансе (01.10): снимка того сервера и присутствия тут нет — подписи из запомненного, клик
  // возвращает туда.
  const away = !voiceIsHere(voice);
  const channel = away ? undefined : bootstrap?.channels.find((c) => c.id === voice.channelId);
  const here = away ? [] : (presence[voice.channelId] ?? []);
  const speaker = here.find((p) => liveVoice[p.userId]?.speaking);
  // Presence про ники не знает — подставляем из ростера (#73).
  const sub = away
    ? `на «${voice.instanceName || 'другом инстансе'}» · вернуться`
    : speaker
    ? `${nameOf(speaker.userId, speaker.displayName)} говорит`
    : here.length
      ? `${here.length} в канале`
      : 'В канале';

  /* Нажатие — экран звонка. 🔴 Одного `openChannel` мало (06.10, стенд): с вкладки «Сообщения» вид оставался беседами, и
     вместо звонка открывалось «Выбери диалог» без нижнего меню (`m-incall` его прячет); голос на другом сервере того же
     инстанса — то же с «Выбери канал». Сначала сервер голоса (с ним и его вид), потом канал. */
  const openCall = async () => {
    const s = useStore.getState();
    if (voice.serverId && s.currentServerId !== voice.serverId) await s.openServer(voice.serverId);
    else if (s.view !== 'server') s.setView('server');
    await openChannel(voice.channelId);
  };

  return (
    <div className="call-chip" role="button" tabIndex={0} onClick={() => (away ? returnToVoice(voice) : void openCall().catch(toastError))}>
      <div className="cc-avas">
        {here.slice(0, 3).map((p) => (
          <span key={p.userId} className={`cc-ava ${liveVoice[p.userId]?.speaking ? 'speaking' : ''}`}>
            <Avatar url={p.avatarUrl} name={nameOf(p.userId, p.displayName)} size={32} fallback="icon" />
          </span>
        ))}
      </div>
      <div className="cc-info">
        <div className="cc-title">
          <span className="cc-dot" />
          {channel?.name ?? (away ? voice.channelName : 'Голос')}
        </div>
        <div className="cc-sub">{sub}</div>
      </div>
      <button
        type="button"
        className={`cc-btn ${selfMuted ? 'off' : ''}`}
        title={selfMuted ? 'Включить микрофон' : 'Выключить микрофон'}
        onClick={(e) => {
          e.stopPropagation();
          toggleSelfMute();
        }}
      >
        <Icon name={selfMuted ? 'mic-off' : 'mic'} size={20} />
      </button>
      <button
        type="button"
        className="cc-btn leave"
        title="Отключиться"
        onClick={(e) => {
          e.stopPropagation();
          leaveVoice();
        }}
      >
        <Icon name="leave" size={20} />
      </button>
    </div>
  );
}
