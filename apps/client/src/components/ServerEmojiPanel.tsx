import {
  checkEmojiName,
  checkEmojiUpload,
  EMOJI_MAX_BYTES,
  EMOJI_PER_SERVER,
  type ServerEmoji,
  suggestEmojiName,
} from '@gusvoice/shared';
import { useEffect, useRef, useState } from 'react';
import { api } from '../api';
import { useStore } from '../store';
import { toast, toastError } from '../toast';
import { Icon } from './Icon';

const EMPTY: ServerEmoji[] = [];

/**
 * Экран управления кастомными эмодзи сервера (#18, право `MANAGE_EMOJIS`).
 *
 * Проверки — те же `shared/emojiRules`, что и на сервере: здесь они нужны, чтобы кнопка «Добавить»
 * не отправляла заведомо отказной запрос и человек видел причину сразу, а не после круга по сети.
 * Защитой они не являются — она в роуте.
 */
export function ServerEmojiPanel({ serverId }: { serverId: string }) {
  const emojis = useStore((s) => s.bootstrap?.emojis ?? EMPTY);
  const [file, setFile] = useState<File | null>(null);
  const [preview, setPreview] = useState<string | null>(null);
  const [name, setName] = useState('');
  const [busy, setBusy] = useState(false);
  const [removing, setRemoving] = useState<string | null>(null);
  const input = useRef<HTMLInputElement | null>(null);

  // Ссылка на выбранный файл живёт ровно пока показываем предпросмотр: без revoke каждый повторный
  // выбор оставлял бы в памяти прошлую картинку.
  useEffect(() => {
    if (!file) {
      setPreview(null);
      return;
    }
    const url = URL.createObjectURL(file);
    setPreview(url);
    return () => URL.revokeObjectURL(url);
  }, [file]);

  const nameCheck = checkEmojiName(name);
  const fileCheck = file ? checkEmojiUpload(file.type, file.size, emojis.length) : null;
  const taken = nameCheck.ok && emojis.some((e) => e.name === nameCheck.name);
  const problem = fileCheck && !fileCheck.ok
    ? fileCheck.error
    : taken
      ? `:${nameCheck.ok ? nameCheck.name : name}: уже занято`
      : name && !nameCheck.ok
        ? nameCheck.error
        : null;
  const full = emojis.length >= EMOJI_PER_SERVER;

  function pick(f: File) {
    setFile(f);
    // Имя файла — только заготовка: у русского имени она пустая, и человек впишет своё.
    if (!name.trim()) setName(suggestEmojiName(f.name));
  }

  async function add() {
    if (!file || !nameCheck.ok || taken || (fileCheck && !fileCheck.ok)) return;
    setBusy(true);
    try {
      await api.uploadServerEmoji(serverId, nameCheck.name, file);
      await useStore.getState().refreshBootstrap(serverId);
      setFile(null);
      setName('');
      toast('success', `:${nameCheck.name}: добавлено`);
    } catch (e) {
      toastError(e);
    } finally {
      setBusy(false);
    }
  }

  async function remove(e: ServerEmoji) {
    if (
      !confirm(
        `Удалить :${e.name}:?\n\nВ старых сообщениях он снова станет текстом, а уже поставленные реакции — знаком вопроса.`,
      )
    )
      return;
    setRemoving(e.id);
    try {
      await api.deleteServerEmoji(serverId, e.id);
      await useStore.getState().refreshBootstrap(serverId);
    } catch (err) {
      toastError(err);
    } finally {
      setRemoving(null);
    }
  }

  return (
    <div className="settings-pane">
      <div className="muted" style={{ fontSize: 12 }}>
        Свои эмодзи сервера: набираются в сообщении как <code>:имя:</code> и доступны на первой вкладке
        пикера. PNG / GIF / WebP до {Math.round(EMOJI_MAX_BYTES / 1024)} КБ, не больше {EMOJI_PER_SERVER} штук
        на сервер. Анимация в GIF и WebP сохраняется.
      </div>

      <div className="emoji-manage-count">
        {emojis.length} из {EMOJI_PER_SERVER}
      </div>

      {emojis.length > 0 ? (
        <div className="emoji-manage-grid">
          {emojis.map((e) => (
            <div className="emoji-manage-item" key={e.id}>
              <img src={e.url} alt={e.name} loading="lazy" />
              <span className="emoji-manage-name" title={`:${e.name}:`}>
                :{e.name}:
              </span>
              <button
                type="button"
                className="sound-icon-btn danger"
                title="Удалить"
                disabled={removing === e.id}
                onClick={() => void remove(e)}
              >
                <Icon name="trash" size={15} />
              </button>
            </div>
          ))}
        </div>
      ) : (
        <div className="muted emoji-manage-empty">
          Пока ни одного. Загрузите первый — он сразу появится у всех, кто на сервере.
        </div>
      )}

      <div className="emoji-manage-add">
        <button
          type="button"
          className={`emoji-manage-drop ${preview ? 'has-file' : ''}`}
          title="Выбрать картинку"
          disabled={busy || full}
          onClick={() => input.current?.click()}
        >
          {preview ? <img src={preview} alt="" /> : <Icon name="plus" size={18} />}
        </button>
        <input
          ref={input}
          type="file"
          accept="image/png,image/gif,image/webp"
          hidden
          onChange={(e) => {
            const f = e.target.files?.[0];
            if (f) pick(f);
            e.target.value = '';
          }}
        />
        <label className="field emoji-manage-name-field">
          Имя
          <input
            value={name}
            placeholder="например, pepe"
            maxLength={40}
            disabled={busy || full}
            onChange={(e) => setName(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') void add();
            }}
          />
        </label>
        <button
          type="button"
          disabled={busy || full || !file || !nameCheck.ok || taken || !!(fileCheck && !fileCheck.ok)}
          onClick={() => void add()}
        >
          {busy ? '…' : 'Добавить'}
        </button>
      </div>

      {full && <div className="muted">Достигнут предел — удалите лишние, чтобы добавить новые.</div>}
      {problem && <div className="error">{problem}</div>}
    </div>
  );
}
