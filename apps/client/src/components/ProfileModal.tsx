import { ANIMATED_AVATAR_MAX_BYTES } from '@gusvoice/shared';
import { useRef, useState } from 'react';
import { api } from '../api';
import { useStore } from '../store';
import { Avatar } from './Avatar';
import { AvatarCropModal } from './AvatarCropModal';
import { Icon } from './Icon';

export function ProfileModal({ onClose }: { onClose: () => void }) {
  const user = useStore((s) => s.user)!;
  const setAuth = useStore((s) => s.setAuth);
  const [displayName, setDisplayName] = useState(user.displayName);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const fileRef = useRef<HTMLInputElement>(null);
  const [cropFile, setCropFile] = useState<File | null>(null);
  const animRef = useRef<HTMLInputElement>(null);

  async function saveName() {
    if (!displayName.trim() || displayName.trim() === user.displayName) return;
    setBusy(true);
    setError(null);
    try {
      setAuth(await api.updateProfile({ displayName: displayName.trim() }));
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  async function doUpload(f: File | Blob) {
    setBusy(true);
    setError(null);
    try {
      const file = f instanceof File ? f : new File([f], 'avatar.png', { type: 'image/png' });
      setAuth(await api.uploadAvatar(file));
      setCropFile(null);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  }

  /**
   * Обычный аватар режется ВСЕГДА, включая GIF.
   *
   * ⚠️ Раньше гифка шла мимо обрезки, «чтобы анимация выжила», — но сервер анимацию тут больше не
   * принимает: она стала отдельной наградой со своими проверками. Пропусти мы гифку мимо холста
   * теперь, человек получил бы отказ уже после выбора файла, не понимая, при чём тут обрезка.
   * Холст оставит первый кадр — это ровно то, что и нужно статичному аватару.
   */
  function onPick(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    if (fileRef.current) fileRef.current.value = '';
    if (!file) return;
    setCropFile(file);
  }

  /** Анимация: своя кнопка, свой маршрут, без обрезки — холст убил бы движение. */
  async function pickAnimated(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    if (animRef.current) animRef.current.value = '';
    if (!file) return;
    setBusy(true);
    setError(null);
    try {
      setAuth(await api.uploadAnimatedAvatar(file));
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  }

  async function clearAnimated() {
    setBusy(true);
    try {
      setAuth(await api.clearAnimatedAvatar());
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="modal-overlay" onClick={onClose}>
      <div className="modal create-channel" onClick={(e) => e.stopPropagation()}>
        <div className="admin-head">
          <h2>Профиль</h2>
          <button type="button" className="icon-close" title="Закрыть" onClick={onClose}>
            <Icon name="close" size={18} />
          </button>
        </div>

        <div className="profile-avatar">
          <Avatar url={user.avatarUrl} name={user.displayName} size={84} />
          <div>
            <button type="button" onClick={() => fileRef.current?.click()} disabled={busy}>
              Загрузить аватар
            </button>
            <input
              ref={fileRef}
              type="file"
              accept="image/png,image/jpeg,image/webp,image/gif"
              style={{ display: 'none' }}
              onChange={onPick}
            />
            <div className="muted">PNG / JPG / WEBP / GIF, до 5 МБ</div>
          </div>
        </div>

        {/* Анимация — только купившим. Не купил — блока нет вовсе: кнопка, ведущая в отказ,
            обещает то, чего не будет. Про саму награду человек узнаёт в кошельке, где витрина. */}
        {user.animatedAvatarUnlocked && (
          <div className="profile-anim">
            <div className="profile-anim-head">
              <strong>Анимированный аватар</strong>
              {/* ⚠️ Предел берётся ИЗ КОНСТАНТЫ, а не написан числом: повторённый в подписи, он
                  разошёлся бы с проверкой при первой же правке — а разъехавшийся предел читается не
                  как ошибка, а как каприз. */}
              <span className="muted">
                GIF, APNG или анимированный WebP · почти квадратный · до{' '}
                {Math.round(ANIMATED_AVATAR_MAX_BYTES / 1024 / 1024)} МБ
              </span>
            </div>
            <div className="profile-anim-row">
              <Avatar url={user.avatarUrl} animatedUrl={user.animatedAvatarUrl} name={user.displayName} size={48} />
              <button type="button" onClick={() => animRef.current?.click()} disabled={busy}>
                {user.animatedAvatarUrl ? 'Заменить' : 'Загрузить анимацию'}
              </button>
              {user.animatedAvatarUrl && (
                <button type="button" className="danger" onClick={() => void clearAnimated()} disabled={busy}>
                  Убрать
                </button>
              )}
              <input
                ref={animRef}
                type="file"
                accept="image/gif,image/png,image/webp"
                style={{ display: 'none' }}
                onChange={pickAnimated}
              />
            </div>
            {/* ⚠️ Говорим и про чужой выключатель: иначе человек, у которого друг анимации не
                видит, решит, что покупка сломалась. */}
            <div className="muted">
              Видно всем и везде. У кого компьютер или интернет не тянет — тот выключает показ у
              себя в настройках, и тогда увидит обычный аватар. В оверлее поверх игры анимации нет
              намеренно.
            </div>
          </div>
        )}
        {cropFile && (
          <AvatarCropModal file={cropFile} busy={busy} onCancel={() => setCropFile(null)} onCrop={(b) => void doUpload(b)} />
        )}

        <label className="field">
          Отображаемое имя
          <input value={displayName} onChange={(e) => setDisplayName(e.target.value)} />
        </label>
        <div className="muted">
          @{user.username}
          {user.superAdmin ? ' · super-admin' : ''}
        </div>

        {error && <div className="error">{error}</div>}

        <div className="modal-actions">
          <button type="button" className="link" onClick={onClose}>
            Закрыть
          </button>
          <button
            type="button"
            onClick={saveName}
            disabled={busy || !displayName.trim() || displayName.trim() === user.displayName}
          >
            Сохранить имя
          </button>
        </div>
      </div>
    </div>
  );
}
