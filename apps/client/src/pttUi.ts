/** UI holds have their own source IDs; they never masquerade as an Android bubble hold. */
type UiPttListener = (source: symbol, down: boolean, immediate: boolean) => void;
let input: UiPttListener | null = null;
export function onUiPtt(listener: UiPttListener): () => void {
  input = listener;
  return () => { if (input === listener) input = null; };
}
export function sendUiPtt(source: symbol, down: boolean, immediate = false): void {
  input?.(source, down, immediate);
}

let micOpen = false;
const listeners = new Set<() => void>();
export function setPttMicOpen(open: boolean): void {
  if (micOpen === open) return;
  micOpen = open;
  for (const listener of listeners) listener();
}
export const getPttMicOpen = () => micOpen;
export function subscribePttMic(listener: () => void): () => void {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}
