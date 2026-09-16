import { useRef, useState } from 'react';
import { api } from '../api';
import { playSound, SOUND_EVENT_LABELS, type SoundEvent } from '../sounds';
import { useStore } from '../store';
import { toast, toastError } from '../toast';
import { Icon } from './Icon';

const EVENTS: SoundEvent[] = ['join', 'leave', 'mute', 'unmute', 'deafen', 'undeafen', 'dm', 'mention', 'stream', 'streamStop', 'move', 'tip'];

/**
 * Per-server custom sound pack (MANAGE_SOUNDS): upload a short audio clip per event, or clear to
 * fall back to the synthesized cue. Uploads broadcast server.invalidate, so the store refetches the
 * bootstrap (updating `sounds` + the playback resolver) — the preview button then plays the new one.
 */
export function ServerSoundsPanel({ serverId }: { serverId: string }) {
  const sounds = useStore((s) => s.bootstrap?.sounds ?? {});
  const patchServerSound = useStore((s) => s.patchServerSound);
  const [busy, setBusy] = useState<SoundEvent | null>(null);
  const inputs = useRef<Record<string, HTMLInputElement | null>>({});

  async function upload(event: SoundEvent, file: File) {
    if (file.size > 512 * 1024) return toastError(new Error('файл больше 512 КБ'));
    setBusy(event);
    try {
      const res = await api.uploadServerSound(serverId, event, file);
      patchServerSound(event, res.url); // reflect immediately (badge + preview), don't wait for the broadcast
      toast('success', 'Звук загружен');
    } catch (e) {
      toastError(e);
    } finally {
      setBusy(null);
    }
  }

  async function clear(event: SoundEvent) {
    setBusy(event);
    try {
      await api.deleteServerSound(serverId, event);
      patchServerSound(event, null);
      toast('info', 'Сброшено на стандартный');
    } catch (e) {
      toastError(e);
    } finally {
      setBusy(null);
    }
  }

  return (
    <div className="settings-pane">
      <div className="muted" style={{ fontSize: 12 }}>
        Свои короткие звуки для событий сервера (≤512 КБ; MP3 / OGG / WAV / WEBM / M4A). Пусто = стандартный
        синтезированный сигнал. Каждый участник всё равно может приглушить звуки у себя в настройках.
      </div>
      <div className="sound-rows">
        {EVENTS.map((ev) => {
          const custom = !!sounds[ev];
          return (
            <div className="sound-row" key={ev}>
              <span className="sound-row-label">{SOUND_EVENT_LABELS[ev]}</span>
              <span className={`sound-row-state ${custom ? 'custom' : ''}`}>{custom ? 'свой' : 'стандартный'}</span>
              <button type="button" className="sound-icon-btn" title="Прослушать" onClick={() => playSound(ev)}>
                <Icon name="volume" size={16} />
              </button>
              <button
                type="button"
                className="seg-mini"
                disabled={busy === ev}
                onClick={() => inputs.current[ev]?.click()}
              >
                {busy === ev ? '…' : 'Загрузить'}
              </button>
              {custom && (
                <button
                  type="button"
                  className="sound-icon-btn danger"
                  title="Сбросить на стандартный"
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
    </div>
  );
}
