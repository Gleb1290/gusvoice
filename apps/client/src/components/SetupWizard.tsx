import type { AuthResponse, RegistrationPolicy } from '@gusvoice/shared';
import { Room } from 'livekit-client';
import { type ReactNode, useEffect, useState } from 'react';
import { api } from '../api';
import { RELEASES_URL } from '../config';
import { inviteLink } from '../inviteLinkRules';
import { toastError } from '../toast';
import { useStore } from '../store';
import { Goose } from './Goose';
import { Icon } from './Icon';
import { InstanceIconPicker, RegistrationPolicyPicker } from './InstanceSettingsForms';
import { passwordStrength } from './Login';
import { SmtpForm } from './SmtpForm';

/**
 * Мастер первичной настройки инстанса (О2 плана открытия кода, #142). Только веб.
 *
 * Фаза `admin` — до входа: код установки из консоли → супер-админ (сразу входит).
 * Фаза `configure` — супер-админ, созданный мастером: инстанс → почта → регистрация → первый сервер → готово.
 * Каждый шаг можно пропустить; всё меняется потом в админ-панели. Решения — `docs/open-source-plan.md` §3.1.1.
 */

/** Код установки как его печатает `install.sh`: 12 знаков группами по 4, без путающихся символов. */
function formatSetupCode(raw: string): string {
  const clean = raw.toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 12);
  return clean.match(/.{1,4}/g)?.join('-') ?? '';
}

function SetupShell({ children, wide = false }: { children: ReactNode; wide?: boolean }) {
  return (
    <div className="auth-wrap">
      <div className={`auth-col${wide ? ' setup-col' : ''}`}>
        <div className="auth-brand">
          <div className="auth-badge">
            <Goose pose="head" size={50} />
          </div>
          <div className="auth-brand-name">GusVoice</div>
        </div>
        {children}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------------------------------
// Фаза 1: код установки и супер-админ

export function SetupAdminWizard({
  tokenConfigured,
  onAdminCreated,
}: {
  tokenConfigured: boolean;
  onAdminCreated: (res: AuthResponse) => Promise<void> | void;
}) {
  const [step, setStep] = useState<'code' | 'admin'>('code');
  const [code, setCode] = useState('');
  const [username, setUsername] = useState('');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [confirm, setConfirm] = useState('');
  const [showPw, setShowPw] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const strength = passwordStrength(password);
  const mismatch = confirm.length > 0 && confirm !== password;

  async function submitCode(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await api.setupCheckToken(code);
      setStep('admin');
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  }

  async function submitAdmin(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const res = await api.setupAdmin({ token: code, username: username.trim(), email: email.trim(), password });
      await onAdminCreated(res);
    } catch (err) {
      setError((err as Error).message);
      setBusy(false);
    }
  }

  if (!tokenConfigured) {
    return (
      <SetupShell>
        <div className="auth-card">
          <div className="auth-title">Сервер ещё не настроен</div>
          <div className="auth-sub">
            Настройку открывает код установки, но в файле <code>.env</code> этого сервера его нет. Запустите
            установщик заново (<code>./install.sh</code>) — он напечатает адрес и код. Или задайте{' '}
            <code>SETUP_TOKEN</code> в <code>.env</code> и перезапустите стек.
          </div>
        </div>
      </SetupShell>
    );
  }

  return (
    <SetupShell>
      {step === 'code' ? (
        <form className="auth-card" onSubmit={submitCode}>
          <div className="setup-eyebrow">Первый запуск</div>
          <div className="auth-title">Настроим ваш сервер</div>
          <div className="auth-sub">
            Введите код установки — установщик напечатал его в консоли сервера в самом конце. Код защищает
            свежий сервер: без него настройку не откроет никто посторонний.
          </div>
          <div className="auth-label">Код установки</div>
          <div className="auth-field">
            <span className="auth-ic">
              <Icon name="lock" size={17} />
            </span>
            <input
              className="setup-code-input"
              value={code}
              onChange={(e) => setCode(formatSetupCode(e.target.value))}
              placeholder="XXXX-XXXX-XXXX"
              autoComplete="off"
              spellCheck={false}
              autoFocus
            />
          </div>
          {error && <div className="error" style={{ marginBottom: 12 }}>{error}</div>}
          <button type="submit" className="auth-cta" disabled={busy || code.replace(/-/g, '').length < 12}>
            {busy ? '…' : 'Продолжить'}
          </button>
        </form>
      ) : (
        <form className="auth-card" onSubmit={submitAdmin}>
          <div className="setup-eyebrow">Шаг 1 · Главный администратор</div>
          <div className="auth-title">Ваш аккаунт</div>
          <div className="auth-sub">
            Это супер-админ сервера: видит админ-панель, одобряет регистрации, создаёт серверы. Почту подтверждать
            не нужно — войдёте сразу.
          </div>
          <div className="auth-label">Имя пользователя</div>
          <div className="auth-field">
            <span className="auth-ic">
              <Icon name="user" size={17} />
            </span>
            <input value={username} onChange={(e) => setUsername(e.target.value)} placeholder="username" autoFocus />
          </div>
          <div className="auth-label">Email</div>
          <div className="auth-field">
            <span className="auth-ic">
              <Icon name="mail" size={17} />
            </span>
            <input type="email" value={email} onChange={(e) => setEmail(e.target.value)} placeholder="you@example.com" />
          </div>
          <div className="auth-label">Пароль</div>
          <div className="auth-field">
            <span className="auth-ic">
              <Icon name="lock" size={17} />
            </span>
            <input
              type={showPw ? 'text' : 'password'}
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              placeholder="минимум 8 символов"
              autoComplete="new-password"
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
              value={confirm}
              onChange={(e) => setConfirm(e.target.value)}
              placeholder="повторите пароль"
              autoComplete="new-password"
            />
          </div>
          {mismatch && <div className="error" style={{ marginBottom: 12 }}>Пароли не совпадают</div>}
          {error && <div className="error" style={{ marginBottom: 12 }}>{error}</div>}
          <button
            type="submit"
            className="auth-cta"
            disabled={busy || username.trim().length < 3 || !email.trim() || password.length < 8 || password !== confirm}
          >
            {busy ? '…' : 'Создать и войти'}
          </button>
          <div style={{ marginTop: 12, textAlign: 'center' }}>
            <button type="button" className="auth-link" style={{ color: 'var(--muted)' }} onClick={() => setStep('code')}>
              ← Другой код
            </button>
          </div>
        </form>
      )}
    </SetupShell>
  );
}

// ---------------------------------------------------------------------------------------------------
// Фаза 2: настройка инстанса супер-админом

const STEPS = [
  { key: 'instance', label: 'Инстанс' },
  { key: 'mail', label: 'Почта' },
  { key: 'registration', label: 'Регистрация' },
  { key: 'server', label: 'Сервер' },
  { key: 'done', label: 'Готово' },
] as const;
type StepKey = (typeof STEPS)[number]['key'];

type VoiceResult =
  | { state: 'idle' }
  | { state: 'running' }
  | { state: 'ok'; transport: 'udp' | 'tcp' | 'relay' | null }
  | { state: 'fail'; message: string };

/** Какой транспорт выбрал браузер — из статистики соединения (внутренности LiveKit, поэтому всё под защитой). */
async function selectedTransport(room: Room): Promise<'udp' | 'tcp' | 'relay' | null> {
  try {
    const pcm = (room.engine as unknown as {
      pcManager?: { subscriber?: { getStats?: () => Promise<RTCStatsReport> }; publisher?: { getStats?: () => Promise<RTCStatsReport> } };
    }).pcManager;
    const report = await (pcm?.subscriber ?? pcm?.publisher)?.getStats?.();
    if (!report) return null;
    let localId: string | undefined;
    report.forEach((s) => {
      const r = s as { type: string; state?: string; nominated?: boolean; selected?: boolean; localCandidateId?: string };
      if (r.type === 'candidate-pair' && r.state === 'succeeded' && (r.nominated || r.selected)) localId = r.localCandidateId;
    });
    if (!localId) return null;
    const local = report.get(localId) as { candidateType?: string; protocol?: string } | undefined;
    if (local?.candidateType === 'relay') return 'relay';
    return local?.protocol === 'tcp' ? 'tcp' : local?.protocol === 'udp' ? 'udp' : null;
  } catch {
    return null;
  }
}

async function runVoiceTest(): Promise<VoiceResult> {
  const { url, token } = await api.setupVoiceTest();
  const room = new Room();
  try {
    await Promise.race([
      room.connect(url, token, { autoSubscribe: false }),
      new Promise((_, reject) => setTimeout(() => reject(new Error('timeout')), 20_000)),
    ]);
    return { state: 'ok', transport: await selectedTransport(room) };
  } catch (err) {
    return { state: 'fail', message: (err as Error).message };
  } finally {
    void room.disconnect();
  }
}

export function SetupConfigureWizard({ onFinished }: { onFinished: () => Promise<void> | void }) {
  const me = useStore((s) => s.user);
  const [step, setStep] = useState<StepKey>('instance');
  const [busy, setBusy] = useState(false);

  // Инстанс
  const [name, setName] = useState('');
  const [iconUrl, setIconUrl] = useState<string | null>(null);
  // Почта и регистрация
  const [smtpConfigured, setSmtpConfigured] = useState(false);
  const [policy, setPolicy] = useState<RegistrationPolicy>('approval');
  // Первый сервер
  const [serverName, setServerName] = useState('');
  const [invite, setInvite] = useState<{ server: string; code: string } | null>(null);
  const [copied, setCopied] = useState(false);
  // Готово
  const [voice, setVoice] = useState<VoiceResult>({ state: 'idle' });
  const [feed, setFeed] = useState<{ version: string } | null | undefined>(undefined);

  useEffect(() => {
    api
      .adminInstance()
      .then((s) => {
        setName(s.name ?? '');
        setIconUrl(s.iconUrl);
        setSmtpConfigured(s.smtpConfigured);
      })
      .catch(() => {});
    api
      .latestDownload()
      .then((d) => setFeed({ version: d.version }))
      .catch(() => setFeed(null));
  }, []);

  const index = STEPS.findIndex((s) => s.key === step);
  const go = (k: StepKey) => setStep(k);
  const next = () => setStep(STEPS[Math.min(index + 1, STEPS.length - 1)].key);
  const back = () => setStep(STEPS[Math.max(index - 1, 0)].key);

  async function saveAndNext(action: () => Promise<unknown>) {
    setBusy(true);
    try {
      await action();
      next();
    } catch (e) {
      toastError(e);
    } finally {
      setBusy(false);
    }
  }

  async function finish() {
    setBusy(true);
    try {
      await api.setupComplete();
      await onFinished();
    } catch (e) {
      toastError(e);
      setBusy(false);
    }
  }

  async function createServer() {
    setBusy(true);
    try {
      const boot = await api.createServer(serverName.trim());
      const inv = await api.createInvite(boot.server.id, { expiresInMinutes: null, maxUses: null });
      setInvite({ server: boot.server.name, code: inv.code });
    } catch (e) {
      toastError(e, 'Не удалось создать сервер');
    } finally {
      setBusy(false);
    }
  }

  const link = invite ? inviteLink(window.location.origin, invite.code) : '';

  return (
    <SetupShell wide>
      <div className="auth-card setup-card">
        <div className="setup-head">
          <ol className="setup-steps" aria-label="Шаги настройки">
            {STEPS.map((s, i) => (
              <li key={s.key} className={i < index ? 'done' : i === index ? 'current' : ''} aria-current={i === index ? 'step' : undefined}>
                <span className="setup-step-dot">{i < index ? <Icon name="check" size={12} /> : i + 1}</span>
                <span className="setup-step-label">{s.label}</span>
              </li>
            ))}
          </ol>
        </div>

        {step === 'instance' && (
          <section className="setup-body">
            <div className="auth-title">Как назовём ваш сервер?</div>
            <div className="auth-sub">
              Название и иконку увидят все, кто заходит: на экране входа и в приложениях. Поменять можно в любой момент.
            </div>
            <label className="field">
              <span>Название</span>
              <input value={name} maxLength={64} onChange={(e) => setName(e.target.value)} placeholder="Например, Гнездо" autoFocus />
            </label>
            <InstanceIconPicker iconUrl={iconUrl} name={name} onChange={setIconUrl} />
            <div className="setup-foot">
              <span />
              <button
                type="button"
                className="auth-cta setup-next"
                disabled={busy}
                onClick={() => void saveAndNext(() => api.adminSetInstance({ name: name.trim() || null }))}
              >
                Далее
              </button>
            </div>
          </section>
        )}

        {step === 'mail' && (
          <section className="setup-body">
            <div className="auth-title">Почта для кодов подтверждения</div>
            <div className="auth-sub">
              С почтой новички получают код на email и подтверждают его сами. Без почты каждую регистрацию подтверждаете вы
              в админ-панели — для компании друзей это нормально. Нужны данные SMTP вашего почтового ящика или сервиса.
            </div>
            <SmtpForm intro={false} testToDefault={me?.email ?? ''} onSaved={setSmtpConfigured} />
            <div className="setup-foot">
              <button type="button" className="link" onClick={back}>
                ← Назад
              </button>
              <button type="button" className="auth-cta setup-next" onClick={next}>
                {smtpConfigured ? 'Далее' : 'Пропустить'}
              </button>
            </div>
          </section>
        )}

        {step === 'registration' && (
          <section className="setup-body">
            <div className="auth-title">Кто может создать аккаунт?</div>
            <div className="auth-sub">Решите, насколько сервер открыт. Выбор меняется в админ-панели во вкладке «Инстанс».</div>
            <RegistrationPolicyPicker value={policy} onChange={setPolicy} smtpConfigured={smtpConfigured} />
            <div className="setup-foot">
              <button type="button" className="link" onClick={back}>
                ← Назад
              </button>
              <button
                type="button"
                className="auth-cta setup-next"
                disabled={busy}
                onClick={() => void saveAndNext(() => api.adminSetInstance({ registration: policy }))}
              >
                Далее
              </button>
            </div>
          </section>
        )}

        {step === 'server' && (
          <section className="setup-body">
            <div className="auth-title">Первый сервер</div>
            <div className="auth-sub">
              Сервер — место, где живут каналы: текстовые и голосовые. Создадим первый и сразу сделаем ссылку, по которой
              друзья зайдут к вам.
            </div>
            {invite ? (
              <div className="setup-invite">
                <div className="setup-invite-title">
                  <Icon name="check" size={16} /> Сервер «{invite.server}» создан
                </div>
                <div className="muted" style={{ fontSize: 13 }}>
                  Отправьте друзьям эту ссылку. Кто без аккаунта — зарегистрируется с уже вписанным кодом, у кого аккаунт
                  есть — сразу попадёт на сервер.
                </div>
                <div className="setup-invite-link">
                  <code>{link}</code>
                  <button
                    type="button"
                    className="settings-action"
                    onClick={() => {
                      void navigator.clipboard
                        .writeText(link)
                        .then(() => setCopied(true))
                        .catch(() => toastError(new Error('Не удалось скопировать — выделите ссылку вручную')));
                    }}
                  >
                    <Icon name={copied ? 'check' : 'copy'} size={14} /> {copied ? 'Скопировано' : 'Копировать'}
                  </button>
                </div>
                <div className="muted" style={{ fontSize: 12 }}>
                  Код приглашения: <code>{invite.code}</code>. Ссылка бессрочная — удалить её можно в настройках сервера.
                </div>
              </div>
            ) : (
              <>
                <label className="field">
                  <span>Название сервера</span>
                  <input value={serverName} maxLength={80} onChange={(e) => setServerName(e.target.value)} placeholder="Например, Наша компания" autoFocus />
                </label>
                <button
                  type="button"
                  className="settings-action"
                  style={{ alignSelf: 'flex-start' }}
                  disabled={busy || !serverName.trim()}
                  onClick={() => void createServer()}
                >
                  {busy ? 'Создаём…' : 'Создать сервер и ссылку'}
                </button>
              </>
            )}
            <div className="setup-foot">
              <button type="button" className="link" onClick={back}>
                ← Назад
              </button>
              <button type="button" className="auth-cta setup-next" onClick={next}>
                {invite ? 'Далее' : 'Пропустить'}
              </button>
            </div>
          </section>
        )}

        {step === 'done' && (
          <section className="setup-body">
            <div className="auth-title">Почти всё</div>
            <div className="auth-sub">Проверим голос и подскажем, где что лежит.</div>

            <div className="setup-check">
              <div className="setup-check-head">
                <Icon name="mic" size={18} />
                <div>
                  <div className="setup-check-title">Проверка голоса</div>
                  <div className="muted setup-check-text">
                    Браузер подключится к серверу голоса так же, как это сделает любой участник. Если порты для звука закрыты —
                    скажем, какие открыть.
                  </div>
                </div>
              </div>
              {voice.state === 'ok' && (
                <div className={`setup-check-result ${voice.transport === 'tcp' || voice.transport === 'relay' ? 'warn' : 'ok'}`}>
                  {voice.transport === 'tcp' || voice.transport === 'relay'
                    ? 'Голос работает, но через запасной путь (TCP 7881). Откройте ещё 7882/UDP — звук станет стабильнее.'
                    : 'Голос работает: браузер подключился к серверу голоса.'}
                </div>
              )}
              {voice.state === 'fail' && (
                // Две разные поломки: не отвечает сам адрес сервера голоса (DNS, прокси, сертификат) — или адрес
                // жив, но не проходят медиа-порты. LiveKit различает их в тексте ошибки («signal» против «pc»).
                <div className="setup-check-result fail">
                  {/signal/i.test(voice.message) ? (
                    <>
                      Сервер голоса не отвечает по адресу <code>lk.{window.location.hostname.replace(/^voice\./, '')}</code>.
                      Проверьте, что эта запись DNS указывает на сервер и что прокси (Caddy или ваш) пропускает WebSocket.
                    </>
                  ) : (
                    <>
                      Адрес сервера голоса отвечает, но звук не проходит. Откройте снаружи порты <b>7881/TCP</b> и{' '}
                      <b>7882/UDP</b> — в облаке в группе безопасности, дома пробросом на роутере.
                    </>
                  )}
                  <span className="muted"> ({voice.message})</span>
                </div>
              )}
              <button
                type="button"
                className="settings-action"
                disabled={voice.state === 'running'}
                onClick={() => {
                  setVoice({ state: 'running' });
                  void runVoiceTest()
                    .then(setVoice)
                    .catch((e) => setVoice({ state: 'fail', message: (e as Error).message }));
                }}
              >
                {voice.state === 'running' ? 'Подключаемся…' : voice.state === 'idle' ? 'Проверить голос' : 'Проверить ещё раз'}
              </button>
            </div>

            <div className="setup-check">
              <div className="setup-check-head">
                <Icon name="download" size={18} />
                <div>
                  <div className="setup-check-title">Приложения</div>
                  <div className="muted setup-check-text">
                    Для Windows и Android. При первом запуске впишите адрес <code>{window.location.host}</code>.
                  </div>
                </div>
              </div>
              <div className="setup-links">
                {feed ? (
                  <a className="dl-btn" href={api.downloadWindowsUrl()}>
                    Windows · v{feed.version}
                  </a>
                ) : (
                  <a className="dl-btn" href={RELEASES_URL} target="_blank" rel="noreferrer">
                    Windows и Android
                  </a>
                )}
              </div>
            </div>

            <div className="setup-check">
              <div className="setup-check-head">
                <Icon name="settings" size={18} />
                <div>
                  <div className="setup-check-title">Где что поменять потом</div>
                  <div className="muted setup-check-text">
                    Значок замка в левой колонке, над вашим аватаром → <b>Админ-панель</b>: «Инстанс» (название, иконка,
                    регистрация), «Почта», «Пользователи» (одобрение новичков). На телефоне — в профиле.
                  </div>
                </div>
              </div>
            </div>

            <div className="setup-foot">
              <button type="button" className="link" onClick={() => go('server')}>
                ← Назад
              </button>
              <button type="button" className="auth-cta setup-next" disabled={busy} onClick={() => void finish()}>
                {busy ? '…' : 'Открыть GusVoice'}
              </button>
            </div>
          </section>
        )}
      </div>
      {step !== 'done' && (
        <div className="setup-skip">
          <button
            type="button"
            className="auth-link"
            style={{ color: 'var(--muted)' }}
            disabled={busy}
            onClick={() => {
              if (window.confirm('Пропустить настройку? Всё это можно сделать потом в админ-панели.')) void finish();
            }}
          >
            Пропустить настройку
          </button>
        </div>
      )}
    </SetupShell>
  );
}
