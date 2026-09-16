import { useRef, useState } from 'react';
import { api } from '../api';
import { playSound, SOUND_EVENT_LABELS, type SoundEvent } from '../sounds';
import { useStore } from '../store';
import { toast, toastError } from '../toast';
import { Icon } from './Icon';

const EVENTS: SoundEvent[] = ['join', 'leave', 'mute', 'unmute', 'deafen', 'undeafen', 'dm', 'mention', 'stream', 'streamStop', 'move', 'tip'];

/**
 * Per-channel custom sounds, managed by the channel's general (or a MANAGE_SOUNDS holder). Mirrors
 * ServerSoundsPanel but writes channel sounds — these override the server pack for events that happen
 * in THIS channel (resolution: channel → server → synthesized cue). Optimistic via patchChannelSound.
 */
export function ChannelSoundsPanel({ channelId }: { channelId: string }) {
  const sounds = useStore((s) => s.bootstrap?.channels.find((c) => c.id === channelId)?.sounds ?? {});
  const serverSounds = useStore((s) => s.bootstrap?.sounds ?? {});
  const patchChannelSound = useStore((s) => s.patchChannelSound);
  const [busy, setBusy] = useState<SoundEvent | null>(null);
  const inputs = useRef<Record<string, HTMLInputElement | null>>({});

  async function upload(event: SoundEvent, file: File) {
    if (file.size > 512 * 1024) return toastError(new Error('файл больше 512 КБ'));
    setBusy(event);
    try {
      const res = await api.uploadChannelSound(channelId, event, file);
      patchChannelSound(channelId, event, res.url);
      toast('success', 'Звук канала загружен');
    } catch (e) {
      toastError(e);
    } finally {
      setBusy(null);
    }
  }

  async function clear(event: SoundEvent) {
    setBusy(event);
    try {
      await api.deleteChannelSound(channelId, event);
      patchChannelSound(channelId, event, null);
      toast('info', 'Сброшено — снова серверный/стандартный');
    } catch (e) {
      toastError(e);
    } finally {
      setBusy(null);
    }
  }

  return (
    <div className="sound-rows">
      {EVENTS.map((ev) => {
        const channelCustom = !!sounds[ev];
        // Show where the sound actually comes from: this channel's override, the server pack, or synth.
        const state = channelCustom
          ? { label: 'свой', cls: 'custom' }
          : serverSounds[ev]
            ? { label: 'сервер', cls: 'server' }
            : { label: 'стандарт', cls: '' };
        return (
          <div className="sound-row" key={ev}>
            <span className="sound-row-label">{SOUND_EVENT_LABELS[ev]}</span>
            <span className={`sound-row-state ${state.cls}`}>{state.label}</span>
            <button type="button" className="sound-icon-btn" title="Прослушать" onClick={() => playSound(ev, channelId)}>
              <Icon name="volume" size={16} />
            </button>
            <button type="button" className="seg-mini" disabled={busy === ev} onClick={() => inputs.current[ev]?.click()}>
              {busy === ev ? '…' : 'Загрузить'}
            </button>
            {channelCustom && (
              <button
                type="button"
                className="sound-icon-btn danger"
                title="Сбросить на серверный/стандартный"
                disabled={busy === ev}
                onClick={() => void clear(ev)}
              >
                <Icon name="trash" size={15} />
              </button>
            )}
            <input
              ref={(el) => {
                inputs.current[ev] = el;
              }}
              type="file"
              accept="audio/*"
              hidden
              onChange={(e) => {
                const f = e.target.files?.[0];
                if (f) void upload(ev, f);
                e.target.value = '';
              }}
            />
          </div>
        );
      })}
    </div>
  );
}
