import { useState } from 'react';
import { fetchDiscovery, normalizeServerInput, saveServer } from '../config';

/**
 * First-launch "which server?" screen for generic desktop/mobile builds (nothing baked in). The user
 * types their instance address; we fetch <base>/config.json (discovery), store it, and reload so all
 * config re-resolves from the chosen server. A wrong/unreachable address never locks the user out — it
 * just shows an error and lets them fix it. Shown by App only when config.needsServerPick() is true.
 */
export function ServerPicker() {
  const [input, setInput] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setError('');
    if (!normalizeServerInput(input)) {
      setError('Введите адрес сервера');
      return;
    }
    setBusy(true);
    try {
      const cfg = await fetchDiscovery(input);
      saveServer(cfg);
      window.location.reload();
    } catch {
      setError('Не удалось подключиться. Проверьте адрес сервера.');
      setBusy(false);
    }
  }

  return (
    <div className="auth-wrap">
      <div className="auth-col">
        <div className="auth-brand">
          <div className="auth-brand-name">GusVoice</div>
        </div>
        <form className="auth-card" onSubmit={submit}>
          <div style={{ textAlign: 'center' }}>
            <div className="auth-title">Подключение к серверу</div>
            <div className="auth-sub">Введите адрес вашего GusVoice-сервера.</div>
            <input
              type="text"
              inputMode="url"
              autoCapitalize="none"
              autoCorrect="off"
              spellCheck={false}
              autoFocus
              placeholder="voice.example.com"
              value={input}
              onChange={(e) => setInput(e.target.value)}
              disabled={busy}
              style={{ width: '100%', marginTop: 4, marginBottom: 12 }}
            />
            {error && (
              <div className="error" style={{ marginBottom: 12 }}>
                {error}
              </div>
            )}
            <button type="submit" className="auth-cta" disabled={busy || !input.trim()}>
              {busy ? 'Подключаюсь…' : 'Подключиться'}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}
