import { useState } from 'react';
import { addInstance, fetchDiscovery, normalizeServerInput } from '../config';
import { adoptActiveInstance } from '../instanceSwitch';
import { Icon } from './Icon';

/**
 * "Add an instance" flow for the multi-instance switcher (#7). The user types another GusVoice
 * server's address; we discover <base>/config.json, create a token-less instance, make it active, and
 * restart the app — which then boots into that instance's login screen (reusing ALL of Login's flows:
 * 2FA / email-verify / forgot-password). No password is captured here.
 */
export function AddInstanceModal({ onClose }: { onClose: () => void }) {
  const [input, setInput] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    if (!normalizeServerInput(input)) {
      setError('Введите адрес сервера');
      return;
    }
    setBusy(true);
    try {
      const cfg = await fetchDiscovery(input);
      addInstance(cfg, { activate: true });
      // Новый инстанс без токена — принимаем его как активный, и `App` показывает экран входа в
      // него. Раньше здесь был перезапуск приложения; §5.7 сделала переход мягким.
      await adoptActiveInstance();
    } catch {
      setError('Не удалось подключиться. Проверьте адрес сервера.');
      setBusy(false);
    }
  }

  return (
    <div className="modal-overlay" onClick={onClose}>
      <form className="modal create-channel" onClick={(e) => e.stopPropagation()} onSubmit={submit}>
        <div className="admin-head">
          <h2>Добавить инстанс</h2>
          <button type="button" className="icon-close" title="Закрыть" onClick={onClose}>
            <Icon name="close" size={18} />
          </button>
        </div>
        <div className="muted" style={{ fontSize: 13, marginBottom: 4 }}>
          Адрес другого GusVoice-сервера. После добавления приложение перезапустится и предложит вход на этот
          инстанс.
        </div>
        <label className="field">
          Адрес сервера
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
          />
        </label>
        {error && <div className="error">{error}</div>}
        <div className="modal-actions">
          <button type="button" className="link" onClick={onClose}>
            Отмена
          </button>
          <button type="submit" disabled={busy || !input.trim()}>
            {busy ? 'Подключаюсь…' : 'Добавить'}
          </button>
        </div>
      </form>
    </div>
  );
}
