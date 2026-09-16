import type { InstanceInfo } from '@gusvoice/shared';
import { type MouseEvent, useEffect, useRef, useState } from 'react';
import { api, setToken } from '../api';
import {
  activeInstance,
  instances,
  multiInstanceEnabled,
  removeInstance,
  restartApp,
  serverHost,
  setActiveInstance,
  updateActiveInstance,
} from '../config';
import { useStore } from '../store';
import { AddInstanceModal } from './AddInstanceModal';
import { Goose } from './Goose';
import { Icon } from './Icon';
import { isMobile } from '../hotkeys';
import { startPushRegistration } from '../nativeUnifiedPush';
import { pendingInvite } from '../pendingInvite';

type Mode = 'login' | 'register' | 'verify' | 'totp' | 'forgot' | 'reset' | 'pending_admin' | 'pending_approval';

/**
 * Desktop-only bar above the login card (#7): which instance you're signing into, quick-switch to
 * another saved instance (restarts the app), "add instance", and — when the active instance has no
 * token yet (mid-add) and others exist — "cancel" to drop it and return to a real instance. Never
 * shown on web/mobile or when there are no saved instances.
 */
function InstanceLoginBar() {
  const [adding, setAdding] = useState(false);
  const list = instances();
  const active = activeInstance();
  if (!multiInstanceEnabled() || list.length === 0) return null;

  async function pick(id: string) {
    if (id !== active?.id) {
      setActiveInstance(id);
      await restartApp();
    }
  }
  async function cancelAdd() {
    if (active) {
      removeInstance(active.id);
      await restartApp();
    }
  }
  const showCancel = !!active && active.token == null && list.length > 1;

  return (
    <div className="login-instances">
      {list.map((i) => (
        <button
          key={i.id}
          type="button"
          className={`login-inst-chip ${i.id === active?.id ? 'active' : ''}`}
          title={serverHost(i.apiUrl)}
          onClick={() => void pick(i.id)}
        >
          <span className="login-inst-dot">{(i.name || '?')[0]?.toUpperCase()}</span>
          <span className="login-inst-name">{i.name}</span>
        </button>
      ))}
      <button type="button" className="login-inst-add" title="Добавить инстанс" onClick={() => setAdding(true)}>
        <Icon name="plus" size={14} />
      </button>
      {showCancel && (
        <button type="button" className="login-inst-cancel" onClick={() => void cancelAdd()}>
          Отменить
        </button>
      )}
      {adding && <AddInstanceModal onClose={() => setAdding(false)} />}
    </div>
  );
}

/** Rough password-strength score (0–4) for the reset screen's meter. */
export function passwordStrength(pw: string): { score: number; label: string } {
  let s = 0;
  if (pw.length >= 6) s++;
  if (pw.length >= 10) s++;
  if (/[A-Z]/.test(pw) && /[a-z]/.test(pw)) s++;
  if (/\d/.test(pw) && /[^A-Za-z0-9]/.test(pw)) s++;
  const score = Math.min(s, 4);
  return { score, label: ['Слабый', 'Слабый', 'Средний', 'Хороший', 'Надёжный'][score] };
}

/** Six single-char boxes for the e-mail verification code, with auto-advance + backspace. */
function CodeInput({ value, onChange }: { value: string; onChange: (v: string) => void }) {
  const refs = useRef<(HTMLInputElement | null)[]>([]);
  const chars = Array.from({ length: 6 }, (_, i) => value[i] ?? '');

  function setChar(i: number, c: string) {
    const digit = c.replace(/\D/g, '').slice(-1);
    const next = chars.slice();
    next[i] = digit;
    onChange(next.join('').slice(0, 6));
    if (digit && i < 5) refs.current[i + 1]?.focus();
  }

  return (
    <div className="code-boxes">
      {chars.map((c, i) => (
        <input
          key={i}
          ref={(el) => (refs.current[i] = el)}
          className="code-box"
          inputMode="numeric"
          maxLength={1}
          value={c}
          autoFocus={i === 0}
          onChange={(e) => setChar(i, e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Backspace' && !chars[i] && i > 0) refs.current[i - 1]?.focus();
          }}
          onPaste={(e) => {
            // Paste the whole code into any box: pull the digits and spread them across the boxes.
            e.preventDefault();
            const digits = (e.clipboardData.getData('text') || '').replace(/\D/g, '').slice(0, 6);
            if (!digits) return;
            onChange(digits);
            refs.current[Math.min(digits.length, 5)]?.focus();
          }}
        />
      ))}
    </div>
  );
}

/** Отказ сервера «аккаунт ждёт одобрения администратора» (политика регистрации `approval`, #142). */
function isPendingApproval(err: unknown): boolean {
  return (err as { reason?: string }).reason === 'pending_approval';
}

export function Login({
  onAuthed,
  setupPending = false,
}: {
  onAuthed: () => Promise<void> | void;
  /** Сервер ещё не прошёл мастер установки (#142) — приложению тут делать нечего, подсказываем открыть браузер. */
  setupPending?: boolean;
}) {
  const setAuth = useStore((s) => s.setAuth);
  const [mode, setMode] = useState<Mode>('login');
  // Название/иконка инстанса и политика регистрации (#142). null — старый сервер без ручки: всё как раньше.
  const [inst, setInst] = useState<InstanceInfo | null>(null);
  // Код приглашения: из ссылки `?invite=` уже вписан; при политике `invite` без него не зарегистрироваться.
  const [inviteCode, setInviteCode] = useState(pendingInvite() ?? '');
  useEffect(() => {
    api
      .instance()
      .then(setInst)
      .catch(() => {});
  }, []);
  // Pre-fill the login identifier from the active instance's last successful login (#7, token-only:
  // no password is stored, only which account you used here).
  const [username, setUsername] = useState(activeInstance()?.lastLogin ?? '');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  // Second "repeat new password" box, used only on the reset screen, to catch typos before submit.
  const [confirmPassword, setConfirmPassword] = useState('');
  const [showPw, setShowPw] = useState(false);
  const [displayName, setDisplayName] = useState('');
  const [code, setCode] = useState('');
  const [challenge, setChallenge] = useState('');
  const [totpCode, setTotpCode] = useState('');
  const [useBackup, setUseBackup] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [info, setInfo] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  async function completeAuth(token: string, user: Parameters<typeof setAuth>[0]) {
    setToken(token);
    setAuth(user);
    // Cache profile + login on the active instance so the switcher shows an avatar/name and the next
    // login here pre-fills the identifier (#7).
    updateActiveInstance({
      userId: user.id,
      displayName: user.displayName,
      avatarUrl: user.avatarUrl ?? undefined,
      lastLogin: username || user.username,
    });
    startPushRegistration(); // Android: register this device for push now that we're authed (no-op elsewhere).
    await onAuthed();
  }

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    setInfo(null);
    try {
      if (mode === 'login') {
        try {
          const res = await api.login(username, password);
          if ('token' in res) {
            await completeAuth(res.token, res.user);
          } else {
            // 2FA on — go to the code step with the returned challenge.
            setChallenge(res.challenge);
            setTotpCode('');
            setUseBackup(false);
            setMode('totp');
            setInfo('Введите код из приложения-аутентификатора.');
          }
        } catch (err) {
          if (isPendingApproval(err)) {
            setMode('pending_approval');
          } else if ((err as Error).message === 'email_not_verified') {
            await api.resend(username).catch(() => {});
            setMode('verify');
            setInfo('Почта не подтверждена — отправили новый код.');
          } else throw err;
        }
      } else if (mode === 'totp') {
        const res = await api.loginTotp(challenge, totpCode);
        await completeAuth(res.token, res.user);
      } else if (mode === 'register') {
        const res = await api.register(username, email, password, displayName || undefined, inviteCode.trim() || undefined);
        if (res.status === 'pending_admin') {
          // No SMTP on this instance → no code to send. Admin approves from the panel.
          setMode('pending_admin');
        } else {
          setMode('verify');
          setInfo(`Код подтверждения отправлен на ${res.email}.`);
        }
      } else if (mode === 'forgot') {
        await api.forgotPassword(email);
        setCode('');
        setPassword('');
        setConfirmPassword('');
        setMode('reset');
        setInfo('Если аккаунт с такой почтой есть — мы отправили код для сброса.');
      } else if (mode === 'reset') {
        await api.resetPassword(email, code, password);
        setPassword('');
        setConfirmPassword('');
        setCode('');
        setMode('login');
        setInfo('Пароль обновлён — войдите с новым паролем.');
      } else {
        const res = await api.verify(username, code);
        await completeAuth(res.token, res.user);
      }
    } catch (err) {
      // Почта подтверждена, но аккаунт ещё ждёт админа — это не ошибка человека, а отдельный экран.
      if (isPendingApproval(err)) {
        setMode('pending_approval');
        return;
      }
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  }

  async function resend() {
    setBusy(true);
    setError(null);
    try {
      await api.resend(username);
      setInfo('Новый код отправлен.');
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  }

  const isLogin = mode === 'login';
  const isRegister = mode === 'register';
  const strength = passwordStrength(password);
  // Reset screen: passwords don't match yet (only flag once the confirm box has something typed).
  const pwMismatch = mode === 'reset' && confirmPassword.length > 0 && confirmPassword !== password;

  return (
    <div className="auth-wrap">
      <div className="auth-col">
        <div className="auth-brand">
          <div className="auth-badge">
            <Goose pose="head" size={50} />
          </div>
          <div className="auth-brand-name">GusVoice</div>
          {inst?.name && (
            <div className="auth-instance">
              {inst.iconUrl && <img src={inst.iconUrl} alt="" />}
              <span>{inst.name}</span>
            </div>
          )}
        </div>

        <InstanceLoginBar />

        {setupPending && (
          <div className="auth-card auth-notice">
            <div className="auth-title">Сервер ещё не настроен</div>
            <div className="auth-sub" style={{ marginBottom: 0 }}>
              Владелец только что его установил. Откройте адрес сервера в браузере и пройдите настройку — после этого
              сюда можно будет войти.
            </div>
          </div>
        )}

        <form className="auth-card" onSubmit={submit}>
          {mode === 'pending_approval' ? (
            <div style={{ textAlign: 'center' }}>
              <div className="auth-title">Ждём одобрения</div>
              <div className="auth-sub">
                Аккаунт создан. На этом сервере каждого нового участника одобряет администратор — как только он это
                сделает, входите обычным логином и паролем.
              </div>
              <button
                type="button"
                className="auth-cta"
                onClick={() => { setMode('login'); setError(null); setInfo(null); }}
              >
                Понятно, ко входу
              </button>
            </div>
          ) : mode === 'pending_admin' ? (
            <div style={{ textAlign: 'center' }}>
              <div className="auth-title">Почти готово</div>
              <div className="auth-sub">
                На этом сервере не настроена почта, поэтому отправить код подтверждения некуда. Ваш
                аккаунт создан и ожидает подтверждения администратором — как только он одобрит его в
                админ-панели, войдите обычным логином и паролем.
              </div>
              {error && <div className="error" style={{ marginBottom: 12 }}>{error}</div>}
              <button
                type="button"
                className="auth-cta"
                onClick={() => { setMode('login'); setError(null); setInfo(null); }}
              >
                Понятно, ко входу
              </button>
            </div>
          ) : mode === 'verify' ? (
            <div style={{ textAlign: 'center' }}>
              <div className="auth-title">Проверьте почту</div>
              <div className="auth-sub">Введите 6-значный код, отправленный на вашу почту.</div>
              <CodeInput value={code} onChange={setCode} />
              {info && <div className="muted" style={{ marginBottom: 12 }}>{info}</div>}
              {error && <div className="error" style={{ marginBottom: 12 }}>{error}</div>}
              <button type="submit" className="auth-cta" disabled={busy || code.length < 6}>
                {busy ? '…' : 'Подтвердить'}
              </button>
              <div className="auth-switch">
                Не пришёл код?{' '}
                <button type="button" onClick={resend} disabled={busy}>
                  Отправить снова
                </button>
              </div>
              <div style={{ marginTop: 10 }}>
                <button type="button" className="auth-link" style={{ color: 'var(--muted)' }} onClick={() => setMode('login')}>
                  ← Назад ко входу
                </button>
              </div>
            </div>
          ) : mode === 'totp' ? (
            <div style={{ textAlign: 'center' }}>
              <div className="auth-title">Двухфакторная защита</div>
              <div className="auth-sub">
                {useBackup ? 'Введите один из резервных кодов.' : 'Введите 6-значный код из приложения-аутентификатора.'}
              </div>
              {useBackup ? (
                <div className="auth-field" style={{ marginTop: 4 }}>
                  <span className="auth-ic">
                    <Icon name="lock" size={17} />
                  </span>
                  <input value={totpCode} onChange={(e) => setTotpCode(e.target.value)} placeholder="xxxx-xxxx" autoFocus />
                </div>
              ) : (
                <CodeInput value={totpCode} onChange={setTotpCode} />
              )}
              {info && <div className="muted" style={{ marginBottom: 12 }}>{info}</div>}
              {error && <div className="error" style={{ marginBottom: 12 }}>{error}</div>}
              <button
                type="submit"
                className="auth-cta"
                disabled={busy || (useBackup ? totpCode.trim().length < 4 : totpCode.length < 6)}
              >
                {busy ? '…' : 'Подтвердить'}
              </button>
              <div className="auth-switch">
                <button
                  type="button"
                  onClick={() => {
                    setUseBackup((v) => !v);
                    setTotpCode('');
                    setError(null);
                  }}
                >
                  {useBackup ? 'Код из приложения' : 'Использовать резервный код'}
                </button>
              </div>
              <div style={{ marginTop: 10 }}>
                <button
                  type="button"
                  className="auth-link"
                  style={{ color: 'var(--muted)' }}
                  onClick={() => {
                    setMode('login');
                    setError(null);
                    setInfo(null);
                  }}
                >
                  ← Назад ко входу
                </button>
              </div>
            </div>
          ) : mode === 'forgot' ? (
            <div style={{ textAlign: 'center' }}>
              <div className="auth-title">Сброс пароля</div>
              <div className="auth-sub">Введите почту аккаунта — пришлём код для сброса.</div>
              <div className="auth-field" style={{ marginTop: 4 }}>
                <span className="auth-ic">
                  <Icon name="mail" size={17} />
                </span>
                <input type="email" value={email} onChange={(e) => setEmail(e.target.value)} placeholder="you@example.com" autoFocus />
              </div>
              {info && <div className="muted" style={{ marginBottom: 12 }}>{info}</div>}
              {error && <div className="error" style={{ marginBottom: 12 }}>{error}</div>}
              <button type="submit" className="auth-cta" disabled={busy || !email.trim()}>
                {busy ? '…' : 'Отправить код'}
              </button>
              <div style={{ marginTop: 10 }}>
                <button type="button" className="auth-link" style={{ color: 'var(--muted)' }} onClick={() => { setMode('login'); setError(null); setInfo(null); }}>
                  ← Назад ко входу
                </button>
              </div>
            </div>
          ) : mode === 'reset' ? (
            <div style={{ textAlign: 'center' }}>
              <div className="auth-title">Новый пароль</div>
              <div className="auth-sub">Введите код из письма и придумайте новый пароль.</div>
              <CodeInput value={code} onChange={setCode} />
              <div className="auth-field" style={{ marginTop: 4 }}>
                <span className="auth-ic">
                  <Icon name="lock" size={17} />
                </span>
                <input
                  type={showPw ? 'text' : 'password'}
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                  placeholder="новый пароль"
                />
                <button type="button" className="auth-ic" style={{ background: 'none', padding: 0 }} title={showPw ? 'Скрыть' : 'Показать'} onClick={() => setShowPw((v) => !v)}>
                  <Icon name="eye" size={17} />
                </button>
              </div>
              {password && (
                <div className="pw-strength">
                  <div className="pw-bars">
                    {[0, 1, 2, 3].map((i) => (
                      <span key={i} className={`pw-bar${i < strength.score ? ` s${strength.score}` : ''}`} />
                    ))}
                  </div>
                  <span className="pw-strength-label">{strength.label}</span>
                </div>
              )}
              <div className="auth-field" style={{ marginTop: 8 }}>
                <span className="auth-ic">
                  <Icon name="lock" size={17} />
                </span>
                <input
                  type={showPw ? 'text' : 'password'}
                  value={confirmPassword}
                  onChange={(e) => setConfirmPassword(e.target.value)}
                  placeholder="повторите пароль"
                />
              </div>
              {pwMismatch && <div className="error" style={{ marginBottom: 12 }}>Пароли не совпадают</div>}
              {info && <div className="muted" style={{ marginBottom: 12 }}>{info}</div>}
              {error && <div className="error" style={{ marginBottom: 12 }}>{error}</div>}
              <button
                type="submit"
                className="auth-cta"
                disabled={busy || code.length < 6 || password.length < 6 || password !== confirmPassword}
              >
                {busy ? '…' : 'Сбросить пароль'}
              </button>
              <div className="auth-switch">
                Не пришёл код?{' '}
                <button type="button" onClick={() => setMode('forgot')} disabled={busy}>
                  Отправить снова
                </button>
              </div>
              <div style={{ marginTop: 10 }}>
                <button type="button" className="auth-link" style={{ color: 'var(--muted)' }} onClick={() => { setMode('login'); setError(null); setInfo(null); }}>
                  ← Назад ко входу
                </button>
              </div>
            </div>
          ) : (
            <>
              <div className="auth-title">{isLogin ? 'С возвращением' : 'Создать аккаунт'}</div>
              <div className="auth-sub">
                {isLogin
                  ? inviteCode
                    ? 'Вас пригласили на сервер. Войдите — или зарегистрируйтесь, код уже вписан.'
                    : 'Войдите, чтобы вернуться в голосовой канал'
                  : inst?.registration === 'approval'
                    ? 'После регистрации аккаунт одобрит администратор'
                    : inst?.registration === 'invite'
                      ? 'Регистрация на этом сервере — по коду приглашения'
                      : 'Пара секунд — и вы в деле'}
              </div>

              <div className="auth-label">{isLogin ? 'Имя пользователя или email' : 'Имя пользователя'}</div>
              <div className="auth-field">
                <span className="auth-ic">
                  <Icon name="user" size={17} />
                </span>
                <input value={username} onChange={(e) => setUsername(e.target.value)} autoFocus placeholder={isLogin ? 'username или email' : 'username'} />
              </div>

              {isRegister && (
                <>
                  <div className="auth-label">Email</div>
                  <div className="auth-field">
                    <span className="auth-ic">
                      <Icon name="mail" size={17} />
                    </span>
                    <input
                      type="email"
                      value={email}
                      onChange={(e) => setEmail(e.target.value)}
                      placeholder="you@example.com"
                    />
                  </div>

                  {(inst?.registration === 'invite' || inviteCode) && (
                    <>
                      <div className="auth-label">
                        Код приглашения{inst?.registration === 'invite' ? '' : ' (необязательно)'}
                      </div>
                      <div className="auth-field">
                        <span className="auth-ic">
                          <Icon name="link" size={17} />
                        </span>
                        <input value={inviteCode} onChange={(e) => setInviteCode(e.target.value)} placeholder="код от друга" />
                      </div>
                    </>
                  )}

                  <div className="auth-label">Отображаемое имя (необязательно)</div>
                  <div className="auth-field">
                    <span className="auth-ic">
                      <Icon name="user" size={17} />
                    </span>
                    <input value={displayName} onChange={(e) => setDisplayName(e.target.value)} placeholder="Как вас звать" />
                  </div>
                </>
              )}

              <div className="auth-label">Пароль</div>
              <div className="auth-field">
                <span className="auth-ic">
                  <Icon name="lock" size={17} />
                </span>
                <input
                  type={showPw ? 'text' : 'password'}
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                  placeholder="••••••••"
                />
                <button
                  type="button"
                  className="auth-ic"
                  style={{ background: 'none', padding: 0 }}
                  title={showPw ? 'Скрыть' : 'Показать'}
                  onClick={() => setShowPw((v) => !v)}
                >
                  <Icon name="eye" size={17} />
                </button>
              </div>

              {/* Password reset is for EXISTING users, so (unlike self-service registration) it must be
                  available on mobile too — hiding it left app users with no way to recover an account. */}
              {isLogin && (
                <div style={{ textAlign: 'right', margin: '-2px 0 10px' }}>
                  <button type="button" className="auth-link" onClick={() => { setMode('forgot'); setError(null); setInfo(null); }}>
                    Забыли пароль?
                  </button>
                </div>
              )}

              {info && <div className="muted" style={{ marginBottom: 12 }}>{info}</div>}
              {error && <div className="error" style={{ marginBottom: 12 }}>{error}</div>}

              <button type="submit" className="auth-cta" disabled={busy}>
                {busy ? '…' : isLogin ? 'Войти' : 'Создать аккаунт'}
              </button>

              {/* Android build is login-only (RuStore distribution): hide self-service
                  registration. New accounts are created via the web app. */}
              {!isMobile() && (
                <div className="auth-switch">
                  {isLogin ? 'Нет аккаунта?' : 'Уже есть аккаунт?'}{' '}
                  <button
                    type="button"
                    onClick={() => {
                      setMode(isLogin ? 'register' : 'login');
                      setError(null);
                      setInfo(null);
                    }}
                  >
                    {isLogin ? 'Регистрация' : 'Войти'}
                  </button>
                </div>
              )}

              {/* Mobile is invite-only (no self-service registration) — set expectations. */}
              {isMobile() && isLogin && (
                <div className="auth-invite-note">Вход по приглашению. Нет аккаунта — попросите ссылку у друга.</div>
              )}
            </>
          )}
        </form>
      </div>
    </div>
  );
}
