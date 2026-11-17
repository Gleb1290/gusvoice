import { useEffect, useState } from 'react';
import type { AdminSoundboardSettings, AdminStorageReport } from '@gusvoice/shared';
import { adminApi } from '../adminApi';
import { formatBytes } from '../byteSize';
import { confirmAction } from '../confirm';
import './SoundboardAdmin.css';
import { soundboardForecast, soundboardScopeIncludes } from './soundboardForecast';

const errorText = (e: unknown) => e instanceof Error ? e.message : 'Неизвестная ошибка';

export function SoundboardAdmin() {
  const [settings, setSettings] = useState<AdminSoundboardSettings | null>(null);
  const [storage, setStorage] = useState<AdminStorageReport | null>(null);
  const [settingsError, setSettingsError] = useState('');
  const [storageError, setStorageError] = useState('');
  const [mode, setMode] = useState<'off' | 'all' | 'selected'>('off');
  const [serverIds, setServerIds] = useState<string[]>([]);
  const [legacyLimit, setLegacyLimit] = useState('24');
  const [saving, setSaving] = useState(false);
  const [loadingStorage, setLoadingStorage] = useState(true);

  function loadSettings() {
    setSettingsError('');
    adminApi().adminSoundboard().then((data) => {
      setSettings(data);
      setMode(data.mode);
      setServerIds(data.serverIds);
      setLegacyLimit(String(data.legacyLimit));
    }).catch((e) => setSettingsError(errorText(e)));
  }
  function loadStorage() {
    setLoadingStorage(true);
    setStorageError('');
    adminApi().adminStorage().then(setStorage).catch((e) => {
      setStorage(null);
      setStorageError(errorText(e));
    }).finally(() => setLoadingStorage(false));
  }
  useEffect(() => { loadSettings(); loadStorage(); }, []);

  const limit = Number(legacyLimit);
  const validLimit = legacyLimit.trim() !== '' && Number.isInteger(limit) && limit >= 0 && limit <= 2_147_483_647;
  const active = (id: string) => soundboardScopeIncludes(mode, serverIds, id);
  const affected = settings?.servers.filter((server) => active(server.id)) ?? [];
  const valid = validLimit && (mode !== 'selected' || affected.length > 0);
  const affectedLegacyLimit = affected.reduce((sum, server) => sum + Math.max(server.clipCount, settings?.legacyLimit ?? 0), 0);
  const projected = soundboardForecast(affected, mode, serverIds);
  async function save() {
    if (!valid || saving) return;
    const ok = await confirmAction({
      title: 'Изменить настройки саундборда?',
      body: mode === 'off'
        ? 'К каждому серверу будет применён общий лимит старой модели. Существующие звуки останутся.'
        : 'На выбранных серверах исчезнет общий потолок. Выдача права новым людям и увеличение личной квоты увеличат расход хранилища.',
      confirmLabel: 'Применить',
      tone: 'danger',
    });
    if (!ok) return;
    setSaving(true);
    setSettingsError('');
    try {
      await adminApi().adminSetSoundboard({ mode, serverIds: settings?.servers.filter((server) => serverIds.includes(server.id)).map((server) => server.id) ?? [], legacyLimit: limit });
      loadSettings();
    } catch (e) { setSettingsError(errorText(e)); }
    finally { setSaving(false); }
  }

  return <section className="sb-admin">
    <h2>Саундборд</h2>
    <p className="muted">Выберите, где действует личный лимит звуков. На остальных серверах действует общий лимит.</p>
    {settingsError && <div className="error" role="alert">Не удалось загрузить или сохранить настройки: {settingsError} <button type="button" onClick={loadSettings}>Повторить загрузку</button></div>}
    {settings && <>
      <fieldset className="sb-admin-modes"><legend>Охват личного лимита</legend>
        {([['off', 'Выключен'], ['all', 'Все серверы'], ['selected', 'Выбранные серверы']] as const).map(([value, label]) =>
          <label key={value}><input type="radio" name="soundboard-mode" checked={mode === value} onChange={() => setMode(value)} /> {label}</label>)}
      </fieldset>
      <label className="sb-admin-limit">Общий лимит старой модели
        <input type="number" min={0} max={2_147_483_647} step={1} value={legacyLimit} onChange={(e) => setLegacyLimit(e.target.value)} />
      </label>
      {!validLimit && <div className="error" role="alert">Укажите целое число от 0 до 2 147 483 647.</div>}
      {mode === 'selected' && affected.length === 0 && <p className="muted">Выберите хотя бы один сервер.</p>}
      {mode !== 'off' && <div className="sb-admin-projection" role="status">
        <strong>У личной модели нет общего потолка</strong>
        <p>По старому лимиту — до {affectedLegacyLimit} звуков ({formatBytes(affectedLegacyLimit * 256 * 1024)}). По текущим правам и личным квотам — до {projected} звуков ({formatBytes(projected * 256 * 1024)}).</p>
        <p>Выдача права новым людям и увеличение личной квоты увеличат расход хранилища. {mode === 'all' && 'Правило действует и для будущих серверов.'}</p>
      </div>}
      <div className="sb-admin-list">
        {settings.servers.map((s) => <div className="sb-admin-row" key={s.id}>
          <div>{mode === 'selected' ? <label><input type="checkbox" checked={serverIds.includes(s.id)} onChange={(e) => { const checked = e.target.checked; setServerIds((ids) => checked ? [...ids, s.id] : ids.filter((id) => id !== s.id)); }} /> <strong>{s.name}</strong></label> : <strong>{s.name}</strong>}
            <div className="muted">Сейчас {s.clipCount} · редакторов {s.eligibleEditors} · лимит на человека {s.perUserLimit}</div>
          </div>
          <div>{active(s.id) ? `Прогноз ${s.projectedClipCount} · до ${formatBytes(s.projectedClipCount * 256 * 1024)}` : validLimit ? `Общий лимит ${limit}` : 'Общий лимит'}</div>
        </div>)}
      </div>
      <button type="button" className="seg-mini" disabled={!valid || saving} onClick={() => void save()}>{saving ? 'Сохранение…' : 'Применить настройки'}</button>
    </>}
    <h3>Расход хранилища</h3>
    {storageError && <div className="error" role="alert">Не удалось измерить хранилище: {storageError} <button type="button" onClick={loadStorage}>Повторить</button></div>}
    {!storage && loadingStorage && <p className="muted">Загружаем отчёт…</p>}
    {storage && (storage.measuredAt === null ? <div className="error" role="status">Замер хранилища недоступен. <button type="button" onClick={loadStorage}>Повторить</button></div> : <>
      <p className="muted">Замер: {new Date(storage.measuredAt).toLocaleString('ru-RU')} · всего {formatBytes(storage.totalBytes)}</p>
      <div className="sb-admin-list">{storage.servers.map((s) => <details className="sb-admin-storage" key={s.id}>
        <summary><strong>{s.name}</strong> · {formatBytes(s.totalBytes)}</summary>
        <div>Саундборд: {formatBytes(s.soundboardBytes)} · {s.soundboardClips} звуков</div>
        <div>Звуки событий: {formatBytes(s.eventSoundsBytes)} · вложения каналов: {formatBytes(s.channelAttachmentsBytes)} · оформление: {formatBytes(s.appearanceBytes)}</div>
        {s.soundboardAuthors.map((a, i) => <div key={a.userId ?? i}>{a.name ?? 'Неизвестный автор'}: {a.clips} звуков · {formatBytes(a.bytes)}</div>)}
      </details>)}</div>
      <p className="muted">Инстанс: ЛС {formatBytes(storage.instance.directMessagesBytes)} · аватары {formatBytes(storage.instance.avatarsBytes)} · не распределено {formatBytes(storage.instance.unassignedBytes)} · всего {formatBytes(storage.instance.totalBytes)}</p>
      <button type="button" className="seg-mini" disabled={loadingStorage} onClick={loadStorage}>{loadingStorage ? 'Загружаем…' : 'Обновить отчёт'}</button>
    </>)}
  </section>;
}
