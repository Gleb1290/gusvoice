import { sentAtLabel } from '../messagePaneRules';
import { usePhoneLayout } from '../phoneLayout';
import { useStore } from '../store';
import { closeVoice, requestVoiceJump, skipVoice, toggleCurrentVoice, useVoicePlayer, voiceNeighbors } from '../voicePlayer';
import { Icon } from './Icon';
import { VoiceSpeedButton } from './VoiceSpeedButton';

/**
 * Полоса плеера голосовых под шапкой ленты (07.10, #211; Telegram AD-04 на ПК, AA-03 и GA-23 на телефоне).
 *
 * Видна, пока в общем плеере (`voicePlayer.ts`) загружено голосовое из ленты — играет или на паузе, в этой беседе или
 * в другой. Слева ▶/⏸, в середине автор и время сообщения (клик — к сообщению; из другой беседы — открыть её на нём),
 * справа скорость (`VoiceSpeedButton`, та же настройка, что у пузыря) и крестик «закрыть плеер». По нижнему краю — прогресс.
 * На компьютере вокруг ▶/⏸ — «предыдущее» и «следующее» голосовое ленты (Telegram Desktop `Media::Player::Widget`:
 * `_previousTrack` / `_nextTrack`, у голосовых тоже; нет соседа — кнопка серая).
 * Стоит над полосой закрепа: у Telegram плеер — сразу под шапкой, закреп — под ним.
 */
export function VoiceTopBar({ feedId, onJump }: { feedId: string | undefined; onJump: (messageId: string) => void }) {
  const { track, playing, at } = useVoicePlayer();
  const phone = usePhoneLayout();

  const src = track?.source;
  if (!track || !src) return null;
  const progress = track.durationMs > 0 ? Math.min(1, at / track.durationMs) : 0;

  function open() {
    if (!src || !track) return;
    if (src.conversationId === feedId) {
      onJump(src.messageId);
      return;
    }
    // Голосовое из другой ленты (Telegram AA-03): открыть ту ленту, а переход к сообщению она сделает сама, когда покажется.
    requestVoiceJump(src.conversationId, src.messageId);
    const s = useStore.getState();
    const place = track.place;
    if (place?.view === 'dm') {
      void s.selectDm(src.conversationId);
      return;
    }
    void (async () => {
      if (place?.serverId && s.currentServerId !== place.serverId) await useStore.getState().openServer(place.serverId);
      useStore.getState().setView('server');
      await useStore.getState().openChannel(src.conversationId);
    })();
  }

  const label = playing ? 'Пауза' : 'Слушать';
  const near = phone ? null : voiceNeighbors();
  return (
    <div className="voice-topbar">
      {near && (
        <button
          type="button"
          className="topbar-btn voice-topbar-skip"
          title="Предыдущее"
          aria-label="Предыдущее голосовое"
          disabled={!near.prev}
          onClick={() => skipVoice(-1)}
        >
          <Icon name="skip-back" size={16} />
        </button>
      )}
      <button type="button" className="voice-play" title={label} aria-label={label} onClick={toggleCurrentVoice}>
        <Icon name={playing ? 'pause' : 'play'} size={16} />
      </button>
      {near && (
        <button
          type="button"
          className="topbar-btn voice-topbar-skip"
          title="Следующее"
          aria-label="Следующее голосовое"
          disabled={!near.next}
          onClick={() => skipVoice(1)}
        >
          <Icon name="skip-forward" size={16} />
        </button>
      )}
      <button type="button" className="voice-topbar-main" onClick={open} aria-label="К голосовому сообщению">
        <span className="voice-topbar-author">{src.author ?? 'Голосовое сообщение'}</span>
        {src.createdAt ? <span className="voice-topbar-when">{sentAtLabel(src.createdAt)}</span> : null}
      </button>
      <VoiceSpeedButton />
      <button type="button" className="topbar-btn voice-topbar-close" aria-label="Закрыть плеер" title="Закрыть плеер" onClick={closeVoice}>
        <Icon name="close" size={18} />
      </button>
      <span className="voice-topbar-progress" style={{ width: `${progress * 100}%` }} aria-hidden="true" />
    </div>
  );
}
