import { useState } from 'react';
import { STATUS_LABEL } from '../status';
import { useStore } from '../store';
import { toggleSelfDeafen, toggleSelfMute } from '../voiceSelf';
import { Avatar } from './Avatar';
import { useAnimatedAvatarsEnabled } from '../avatarAnimation';
import { Icon } from './Icon';
import { StatusDot } from './StatusDot';
import { StatusPicker } from './StatusPicker';

/**
 * Always-visible self voice bar (Discord-style account panel) at the bottom of the channel / DM
 * sidebar. Mic-mute + deafen toggle the GLOBAL intent (voiceSelf → store), so they work and show
 * the right state whether or not you're in a voice channel; when you later join, VoiceConnection's
 * apply effect carries the intent into the room. Also a quick settings shortcut.
 */
export function SelfVoiceBar() {
  const user = useStore((s) => s.user);
  const selfMuted = useStore((s) => s.selfMuted);
  const selfDeafened = useStore((s) => s.selfDeafened);
  const inVoice = useStore((s) => !!s.voice);
  const voiceState = useStore((s) => s.voiceState);
  const [pickerOpen, setPickerOpen] = useState(false);
  const animatedOn = useAnimatedAvatarsEnabled();
  if (!user) return null;

  // Traffic-light voice status: green = connected, red = connecting/reconnecting, grey = not in voice.
  const voiceStatus =
    voiceState === 'connected'
      ? { cls: 'connected', label: 'В канале' }
      : voiceState === 'reconnecting'
        ? { cls: 'problem', label: 'Переподключение…' }
        : { cls: 'problem', label: 'Подключение…' };
  const custom = user.customStatus;
  const hasCustom = !!(custom && (custom.emoji || custom.text));

  return (
    <div className="self-bar">
      {pickerOpen && <StatusPicker onClose={() => setPickerOpen(false)} />}
      <button
        className="self-id"
        title="Задать статус"
        onMouseDown={(e) => e.stopPropagation()} // don't let the picker's outside-click close fire before our toggle
        onClick={() => setPickerOpen((v) => !v)}
      >
        <span className="self-ava-wrap">
          <Avatar
            url={user.avatarUrl}
            animatedUrl={animatedOn ? user.animatedAvatarUrl : undefined}
            name={user.displayName}
            size={32}
          />
          <span className="self-ava-dot">
            <StatusDot status={user.status} size={11} ringColor="var(--bg-2)" />
          </span>
        </span>
        <span className="self-meta">
          <span className="self-name">{user.displayName}</span>
          {inVoice ? (
            <span className={`self-state ${voiceStatus.cls}`}>
              <span className="self-dot" />
              {voiceStatus.label}
            </span>
          ) : hasCustom ? (
            <span className="self-custom">
              {custom!.emoji && <span className="self-custom-emoji">{custom!.emoji}</span>}
              {custom!.text}
            </span>
          ) : (
            <span className="self-state">{STATUS_LABEL[user.status]}</span>
          )}
        </span>
      </button>
      <div className="self-actions">
        <button
          type="button"
          className={`self-ctl ${selfMuted ? 'off' : ''}`}
          title={selfMuted ? 'Включить микрофон' : 'Выключить микрофон'}
          onClick={toggleSelfMute}
        >
          <Icon name={selfMuted ? 'mic-off' : 'mic'} size={18} />
        </button>
        <button
          type="button"
          className={`self-ctl ${selfDeafened ? 'off' : ''}`}
          title={selfDeafened ? 'Включить звук' : 'Заглушить звук (деафен)'}
          onClick={toggleSelfDeafen}
        >
          <Icon name={selfDeafened ? 'headphones-off' : 'headphones'} size={18} />
        </button>
      </div>
    </div>
  );
}
