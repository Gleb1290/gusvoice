import { useEffect, useRef, useSyncExternalStore, type ButtonHTMLAttributes } from 'react';
import { getAudioSettings, subscribeAudioSettings } from './audioSettings';
import { pttButtonShouldToggle } from './pttController';
import { getPttMicOpen, sendUiPtt, subscribePttMic } from './pttUi';
import { useStore } from './store';
import { toggleSelfMute } from './voiceSelf';

const subscribeMode = (notify: () => void) => subscribeAudioSettings(notify);
const getMode = () => getAudioSettings().pushToTalk;

/** The same existing mic button is a hold in PTT and a mute toggle in open-mic mode. */
export function usePttMicButton() {
  const ptt = useSyncExternalStore(subscribeMode, getMode);
  const micOpen = useSyncExternalStore(subscribePttMic, getPttMicOpen);
  const inVoice = useStore((s) => !!s.voice);
  const muted = useStore((s) => s.selfMuted);
  const deafened = useStore((s) => s.selfDeafened);
  const active = ptt && inVoice;
  const source = useRef(Symbol('ui-ptt'));
  const pointer = useRef<number | null>(null);
  const key = useRef<string | null>(null);
  const suppressClick = useRef(false);
  const unmuteOnClick = useRef(false);
  const release = (immediate: boolean) => {
    pointer.current = null;
    key.current = null;
    unmuteOnClick.current = false;
    sendUiPtt(source.current, false, immediate);
  };
  useEffect(() => {
    const cancel = () => release(true);
    const hidden = () => { if (document.hidden) cancel(); };
    const up = (event: PointerEvent) => {
      if (event.pointerId !== pointer.current) return;
      if (event.type === 'pointercancel') { cancel(); return; }
      pointer.current = null;
      if (!key.current) sendUiPtt(source.current, false);
    };
    const keyUp = (event: KeyboardEvent) => {
      if (event.code !== key.current) return;
      key.current = null;
      if (pointer.current === null) sendUiPtt(source.current, false);
    };
    window.addEventListener('pointerup', up);
    window.addEventListener('pointercancel', up);
    window.addEventListener('keyup', keyUp);
    window.addEventListener('blur', cancel);
    document.addEventListener('visibilitychange', hidden);
    return () => {
      window.removeEventListener('pointerup', up);
      window.removeEventListener('pointercancel', up);
      window.removeEventListener('keyup', keyUp);
      window.removeEventListener('blur', cancel);
      document.removeEventListener('visibilitychange', hidden);
      cancel();
    };
  }, [active]);
  const title = active
    ? muted || deafened ? 'Включить микрофон; затем удерживайте, чтобы говорить' : 'Рация: удерживайте, чтобы говорить'
    : muted ? 'Включить микрофон' : 'Выключить микрофон';
  const props: ButtonHTMLAttributes<HTMLButtonElement> & { 'data-ptt': boolean; 'data-ptt-open': boolean } = {
    'data-ptt': active,
    'data-ptt-open': active && micOpen && !muted && !deafened,
    title,
    'aria-label': title,
    'aria-pressed': active ? micOpen && !muted && !deafened : !muted,
    onPointerDown(event) {
      if (!active) suppressClick.current = false;
      if (!active || event.button !== 0 || !event.isPrimary || pointer.current !== null) return;
      event.preventDefault();
      event.stopPropagation();
      pointer.current = event.pointerId;
      suppressClick.current = true;
      unmuteOnClick.current = muted || deafened;
      try { event.currentTarget.setPointerCapture(event.pointerId); } catch { /* window release is a fallback */ }
      if (!muted && !deafened) sendUiPtt(source.current, true);
    },
    onPointerUp(event) {
      if (event.pointerId !== pointer.current) return;
      pointer.current = null;
      if (!key.current) sendUiPtt(source.current, false);
    },
    onPointerCancel() { release(true); },
    onLostPointerCapture(event) { if (event.pointerId === pointer.current) release(true); },
    onBlur() { release(true); },
    onKeyDown(event) {
      if (event.code !== 'Space' && event.code !== 'Enter') return;
      if (!active) { suppressClick.current = false; unmuteOnClick.current = false; return; }
      if (muted || deafened) {
        if (event.repeat) { event.preventDefault(); return; }
        unmuteOnClick.current = true;
        return; // A blocked button keeps the native keyboard click to unmute only.
      }
      event.preventDefault();
      event.stopPropagation();
      if (event.repeat) return;
      key.current = event.code;
      suppressClick.current = true;
      sendUiPtt(source.current, true);
    },
    onKeyUp(event) {
      if (event.code !== key.current) return;
      event.preventDefault();
      key.current = null;
      if (pointer.current === null) sendUiPtt(source.current, false);
    },
    onContextMenu(event) { if (active) event.preventDefault(); },
    onClick(event) {
      event.stopPropagation();
      const toggle = pttButtonShouldToggle({
        active, blocked: muted || deafened,
        unmuteGesture: unmuteOnClick.current || (event.detail === 0 && !suppressClick.current),
        suppressClick: suppressClick.current,
      });
      if (toggle) toggleSelfMute();
      else event.preventDefault();
      suppressClick.current = false;
      unmuteOnClick.current = false;
    },
  };
  return props;
}
