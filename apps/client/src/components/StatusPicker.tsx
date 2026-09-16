import type { PresenceStatus } from '@gusvoice/shared';
import { noteManualStatusChange } from '../afk';
import { useEffect, useRef, useState } from 'react';
import { api } from '../api';
import { STATUS_LABEL, STATUS_OPTIONS, STATUS_SUBTITLE } from '../status';
import { useStore } from '../store';
import { toast, toastError } from '../toast';
import { EmojiPicker } from './EmojiPicker';
import { Icon } from './Icon';
import { StatusDot } from './StatusDot';

const CLEAR_OPTIONS: { label: string; minutes: number | null }[] = [
  { label: 'Не сбрасывать', minutes: null },
  { label: '30 минут', minutes: 30 },
  { label: '1 час', minutes: 60 },
  { label: '4 часа', minutes: 240 },
  { label: '24 часа', minutes: 1440 },
];

/**
 * Popover (anchored above the self-bar) to pick a presence state and set a custom status.
 * Each change PATCHes /users/me/status; the response updates the live user (setAuth), which the
 * gateway also broadcasts so peers see the new dot/status.
 */
export function StatusPicker({ onClose }: { onClose: () => void }) {
  const user = useStore((s) => s.user)!;
  const setAuth = useStore((s) => s.setAuth);
  const ref = useRef<HTMLDivElement>(null);
  const [emoji, setEmoji] = useState(user.customStatus?.emoji ?? '');
  const [text, setText] = useState(user.customStatus?.text ?? '');
  const [clearAfter, setClearAfter] = useState<number | null>(null);
  const [busy, setBusy] = useState(false);
  const [emojiOpen, setEmojiOpen] = useState(false);
  const emojiBtnRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    const onDown = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) onClose();
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('mousedown', onDown);
    window.addEventListener('keydown', onKey);
    return () => {
      window.removeEventListener('mousedown', onDown);
      window.removeEventListener('keydown', onKey);
    };
  }, [onClose]);

  async function pickStatus(status: PresenceStatus) {
    if (busy || user.status === status) return;
    setBusy(true);
    try {
      // Picking a status by hand takes it out of auto-away's hands (#16).
      noteManualStatusChange();
      setAuth(await api.setStatus({ status }));
    } catch (e) {
      toastError(e);
    } finally {
      setBusy(false);
    }
  }

  async function saveCustom() {
    setBusy(true);
    try {
      setAuth(
        await api.setStatus({ customStatus: { emoji: emoji.trim() || null, text: text.trim() || null, clearAfterMinutes: clearAfter } }),
      );
      toast('success', 'Статус обновлён');
      onClose();
    } catch (e) {
      toastError(e);
    } finally {
      setBusy(false);
    }
  }

  async function clearCustom() {
    setEmoji('');
    setText('');
    setClearAfter(null);
    setBusy(true);
    try {
      setAuth(await api.setStatus({ customStatus: null }));
    } catch (e) {
      toastError(e);
    } finally {
      setBusy(false);
    }
  }

  const hasCustom = !!(emoji.trim() || text.trim());

  return (
    <div className="status-pop" ref={ref} role="menu">
      <div className="status-pop-label">Статус</div>
      {STATUS_OPTIONS.map((s) => (
        <button key={s} type="button" className={`status-opt ${user.status === s ? 'on' : ''}`} onClick={() => void pickStatus(s)}>
          <StatusDot status={s} size={11} />
          <span className="status-opt-text">
            <span>{STATUS_LABEL[s]}</span>
            {STATUS_SUBTITLE[s] && <span className="status-opt-sub">{STATUS_SUBTITLE[s]}</span>}
          </span>
          {user.status === s && <Icon name="check" size={15} />}
        </button>
      ))}

      <div className="status-pop-divider" />
      <div className="status-pop-label">Свой статус</div>
      <div className="status-custom-row">
        <button
          ref={emojiBtnRef}
          type="button"
          className={`status-emoji-btn ${emoji ? '' : 'placeholder'}`}
          title="Выбрать эмодзи"
          onClick={() => setEmojiOpen((v) => !v)}
        >
          {emoji || '🙂'}
        </button>
        <input
          className="status-text"
          value={text}
          maxLength={128}
          placeholder="Что происходит?"
          onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') void saveCustom();
          }}
        />
        {emoji && (
          <button type="button" className="status-emoji-clear" title="Убрать эмодзи" onClick={() => setEmoji('')}>
            <Icon name="close" size={13} />
          </button>
        )}
      </div>
      {emojiOpen && emojiBtnRef.current && (
        <EmojiPicker
          anchor={emojiBtnRef.current.getBoundingClientRect()}
          onPick={(e) => {
            setEmoji(e);
            setEmojiOpen(false);
          }}
          onClose={() => setEmojiOpen(false)}
        />
      )}
      <label className="status-clear-row">
        <span>Сбросить через</span>
        <select
          className="settings-select"
          value={clearAfter ?? ''}
          onChange={(e) => setClearAfter(e.target.value ? Number(e.target.value) : null)}
        >
          {CLEAR_OPTIONS.map((o) => (
            <option key={o.label} value={o.minutes ?? ''}>
              {o.label}
            </option>
          ))}
        </select>
      </label>
      <div className="status-pop-actions">
        <button type="button" className="status-save-btn" onClick={() => void saveCustom()} disabled={busy}>
          Сохранить статус
        </button>
        {hasCustom && (
          <button type="button" className="status-clear-btn" onClick={() => void clearCustom()} disabled={busy}>
            Очистить
          </button>
        )}
      </div>
    </div>
  );
}
