import {
  AVATAR_RENTAL_DAYS,
  AVATAR_RENTAL_MAX_DAYS,
  AVATAR_RENTAL_MAX_DAYS_LIMIT,
  AVATAR_RENTAL_MAX_DAYS_MIN,
  BOT_PER_USER_LIMIT_MAX,
  botsEnabled,
  pluralDays,
  type AdminBotInfo,
  type BotCreators,
  type BotSettings,
  type AdminServer,
  type AdminUser,
  type FederationDirectoryView,
} from '@gusvoice/shared';
import { useEffect, useState } from 'react';
import type { Api } from '../api';
import { adminApi } from '../adminApi';
import { instances } from '../config';
import { useStore } from '../store';
import { tabListKeyDown, useDialogChrome } from '../dialogChrome';
import { toast, toastError } from '../toast';
import { Icon } from './Icon';
import { DmReports } from './DmReports';
import { FederationPanel } from './FederationPanel';
import { InstanceSettingsPanel } from './InstanceSettingsForms';
import { PeerServersGroup, PeerUsersGroup, ServerFederationCell } from './AdminPeerGroups';
import { SmtpForm } from './SmtpForm';
import { RailItem, SettingsHead, SettingsRail, SettingsWindow } from './SettingsShell';
import { Toggle } from './Toggle';
import { guestAtLines, guestAtSummary } from '../guestAtMark';
import { confirmAction } from '../confirm';
import { ADMIN_SECTIONS, adminSectionLabel, adminSectionOf, type AdminSectionKey } from '../adminNav';
import { pushBackHandler } from '../androidBack';

const ADMIN_TABS: AdminSectionKey[] = ADMIN_SECTIONS.map((s) => s.key);

export function AdminPanel({ onClose }: { onClose: () => void }) {
  // Открыта для дома из гостей (`adminApi.ts`) — в шапке чей это инстанс, чтобы не спутать с тем, где стоишь.
  const homeId = useStore((s) => s.adminInstanceId);
  const homeName = homeId ? instances().find((i) => i.id === homeId)?.name ?? null : null;
  const [tab, setTab] = useState<AdminSectionKey>('users');
  // Телефон: сперва список разделов, тап — экран раздела (тот же list→detail, что в настройках).
  const [picked, setPicked] = useState(false);
  const [users, setUsers] = useState<AdminUser[]>([]);
  const [servers, setServers] = useState<AdminServer[]>([]);
  // Каталоги соседей (F2). `null` — ещё не читали; `enabled: false` — федерация выключена, и тогда
  // вкладки выглядят ровно как раньше, без разговоров про соседей.
  const [fed, setFed] = useState<FederationDirectoryView | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const dialogRef = useDialogChrome<HTMLDivElement>(onClose);
  const onTabsKey = tabListKeyDown(ADMIN_TABS, tab, setTab, (k) => `admin-tab-${k}`);
  const currentSection = adminSectionOf(tab);
  // Федеративные части вкладок показываем только когда федерация включена И связки есть: иначе это
  // колонки и заголовки про то, чего у держателя нет.
  const fedOn = (fed?.enabled ?? false) && (fed?.peers.length ?? 0) > 0;

  async function load() {
    setLoading(true);
    setError(null);
    try {
      const [u, s] = await Promise.all([adminApi().adminUsers(), adminApi().adminServers()]);
      setUsers(u);
      setServers(s);
      // Каталоги соседей читаем отдельно и не роняем ими вкладку: список СВОИХ людей не должен
      // зависеть от того, доступна ли федерация.
      adminApi()
        .federationDirectory()
        .then(setFed)
        .catch(() => setFed({ enabled: false, peers: [] }));
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    load();
  }, []);

  /**
   * Системная «назад» на телефоне: из раздела — к списку разделов, и только потом закрытие окна.
   * Без этого один жест закрывал окно целиком (найдено на живом устройстве).
   */
  useEffect(() => {
    if (!picked) return;
    return pushBackHandler(() => {
      setPicked(false);
      return true;
    });
  }, [picked]);


  async function toggleHidden(u: AdminUser) {
    try {
      const upd = await adminApi().adminSetUserHidden(u.id, !u.hiddenFromPeers);
      setUsers((list) => list.map((x) => (x.id === upd.id ? upd : x)));
      toast('success', upd.hiddenFromPeers ? 'Скрыт от соседей' : 'Виден соседям');
    } catch (e) {
      toastError((e as Error).message);
    }
  }

  async function toggleCreate(u: AdminUser) {
    try {
      const upd = await adminApi().adminSetCreateServers(u.id, !u.canCreateServers);
      setUsers((list) => list.map((x) => (x.id === upd.id ? upd : x)));
    } catch (e) {
      toastError(e);
    }
  }

  // Manual approval — the fallback for instances without SMTP (no e-mail code can be delivered), and the
  // approval itself under the `approval` registration policy (#142): one click makes the account usable.
  async function verifyUser(u: AdminUser) {
    try {
      const upd = await adminApi().adminVerifyUser(u.id);
      setUsers((list) => list.map((x) => (x.id === upd.id ? upd : x)));
      toast('success', 'Пользователь подтверждён', `@${upd.username} теперь может войти.`);
    } catch (e) {
      toastError(e);
    }
  }

  // Delete a user — mainly for "stuck" accounts (registered with a bogus e-mail, can't log in, but
  // the username/email stay taken). Irreversible; confirmed first.
  async function deleteUser(u: AdminUser) {
    const ok = await confirmAction({
      title: `Удалить аккаунт @${u.username}?`,
      body: 'Логин и почта освободятся, сообщения останутся с подписью «Удалённый пользователь». Отменить это нельзя.',
      tone: 'danger',
      confirmLabel: 'Удалить аккаунт',
      // Набрать логин: это чужой аккаунт и обратной дороги нет.
      requireText: u.username,
    });
    if (!ok) return;
    try {
      await adminApi().adminDeleteUser(u.id);
      setUsers((list) => list.filter((x) => x.id !== u.id));
      toast('success', 'Аккаунт удалён', `@${u.username}`);
    } catch (e) {
      toastError(e);
    }
  }

  return (
    <SettingsWindow
      variant="admin"
      picked={picked}
      onClose={onClose}
      titleId="admin-title"
      dialogRef={dialogRef}
      // Рельс разделов — тот же приём, что в настройках (#153): у каждого раздела появилась строка пояснения, которой
      // в строке вкладок помещаться было негде.
      rail={
        <SettingsRail
          title={homeName ? `Админ-панель · ${homeName}` : 'Админ-панель'}
          label="Разделы админ-панели"
          onClose={onClose}
          onListKeyDown={onTabsKey}
        >
          {ADMIN_SECTIONS.map((s) => (
            <RailItem
              key={s.key}
              id={`admin-tab-${s.key}`}
              aria-controls="admin-panel-body"
              tabIndex={tab === s.key ? 0 : -1}
              icon={s.icon}
              label={adminSectionLabel(s, { users: loading ? undefined : users.length, servers: loading ? undefined : servers.length })}
              active={tab === s.key}
              onClick={() => {
                setTab(s.key);
                setPicked(true);
              }}
            />
          ))}
        </SettingsRail>
      }
    >
        <SettingsHead
          title={currentSection.label}
          titleId="admin-title"
          sub={currentSection.sub}
          actions={
            currentSection.refreshable && (
              <button type="button" className="link refresh" onClick={load}>
                ⟳ обновить
              </button>
            )
          }
          onBack={() => setPicked(false)}
          onClose={onClose}
        />

        {error && (
          <div className="error" role="alert">
            {error}
          </div>
        )}

        {tab === 'instance' ? (
          <div className="admin-scroll" id="admin-panel-body" role="tabpanel" aria-labelledby="admin-tab-instance">
            <InstanceSettingsPanel />
          </div>
        ) : tab === 'reports' ? (
          <div className="admin-scroll" id="admin-panel-body" role="tabpanel" aria-labelledby="admin-tab-reports">
            <DmReports />
          </div>
        ) : tab === 'federation' ? (
          <div className="admin-scroll" id="admin-panel-body" role="tabpanel" aria-labelledby="admin-tab-federation">
            <FederationPanel />
          </div>
        ) : tab === 'smtp' ? (
          <SmtpTab />
        ) : tab === 'economy' ? (
          <EconomyTab />
        ) : tab === 'bots' ? (
          <BotsTab />
        ) : loading ? (
          <div className="muted" role="status">
            Загрузка…
          </div>
        ) : tab === 'users' ? (
          <div className="admin-scroll" id="admin-panel-body" role="tabpanel" aria-labelledby={`admin-tab-${tab}`}>
            {/* Заголовок группы «этот инстанс» появляется только вместе с соседями: без них он был бы
                лишней строкой над единственным списком. */}
            {fedOn && <div className="fed-group-self">Этот инстанс ({users.length})</div>}
            <table className="admin-table">
              <thead>
                <tr>
                  <th>Пользователь</th>
                  <th>Email</th>
                  <th>Подтв.</th>
                  <th>Создание серверов</th>
                  {fedOn && <th title="Виден ли человек в каталоге, который отдаётся связанным инстансам">Виден соседям</th>}
                  <th>Роль</th>
                  <th></th>
                </tr>
              </thead>
              <tbody>
                {users.map((u) => (
                  <tr key={u.id}>
                    <td className="cell-name">
                      {u.displayName} <span className="muted">@{u.username}</span>
                    </td>
                    <td className="muted" data-label="Email">
                      {u.email || '—'}
                    </td>
                    <td data-label="Подтв.">
                      {u.verified && u.approved !== false ? (
                        '✓'
                      ) : (
                        <button
                          type="button"
                          className="link"
                          onClick={() => verifyUser(u)}
                          title={u.verified ? 'Почта подтверждена, аккаунт ждёт вашего одобрения' : 'Подтвердить аккаунт вручную'}
                        >
                          {u.verified ? 'Одобрить' : 'Подтвердить'}
                        </button>
                      )}
                    </td>
                    <td data-label="Создание серверов">
                      {u.superAdmin ? (
                        <span className="muted">всегда</span>
                      ) : (
                        <Toggle checked={u.canCreateServers} onChange={() => toggleCreate(u)} title="Создание серверов" />
                      )}
                    </td>
                    {fedOn && (
                      <td data-label="Виден соседям">
                        {/* Скрытие убирает человека только из каталога: уже вошедшего к соседу по ссылке
                            оно не выгоняет — там он остаётся обычным участником (§5.2.1). */}
                        <Toggle
                          checked={!u.hiddenFromPeers}
                          onChange={() => toggleHidden(u)}
                          title="Виден соседям в каталоге"
                        />
                        {/* 🔴 Отметка «скрыт, но виден» (требование 14): без неё переключатель врёт
                            держателю — говорит «не видно», хотя на серверах соседа человек виден
                            всем. Клик ведёт во вкладку «Федерация», где видны сами связки. */}
                        {guestAtSummary(u.guestAt) && (
                          <button
                            type="button"
                            className="link gm-mark"
                            title={guestAtLines(u.guestAt).join('\n')}
                            onClick={() => setTab('federation')}
                          >
                            <Icon name="eye" size={12} /> {guestAtSummary(u.guestAt)}
                          </button>
                        )}
                      </td>
                    )}
                    <td data-label="Роль">{u.superAdmin ? <span className="badge">super-admin</span> : 'user'}</td>
                    <td className="cell-act">
                      {!u.superAdmin && (
                        <button type="button" className="link admin-del" onClick={() => deleteUser(u)} title="Удалить аккаунт">
                          Удалить
                        </button>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
            {fed?.peers.map((peer) => (
              <PeerUsersGroup key={peer.instanceId} peer={peer} />
            ))}
          </div>
        ) : (
          <div className="admin-scroll" id="admin-panel-body" role="tabpanel" aria-labelledby={`admin-tab-${tab}`}>
            {fedOn && <div className="fed-group-self">Этот инстанс ({servers.length})</div>}
            <table className="admin-table">
              <thead>
                <tr>
                  <th>Сервер</th>
                  <th>Владелец</th>
                  <th>Каналы</th>
                  <th>Голосовых</th>
                  <th>Участников</th>
                  {fedOn && (
                    <th title="Видят ли сервер связанные инстансы и можно ли приглашать на него людей оттуда">
                      Федеративный доступ
                    </th>
                  )}
                </tr>
              </thead>
              <tbody>
                {servers.map((s) => (
                  <tr key={s.id}>
                    <td className="cell-name">{s.name}</td>
                    <td className="muted" data-label="Владелец">
                      @{s.ownerUsername || s.ownerId}
                    </td>
                    <td data-label="Каналы">{s.channels}</td>
                    <td data-label="Голосовых">{s.voiceChannels}</td>
                    <td data-label="Участников">{s.members}</td>
                    {fedOn && (
                      <td data-label="Федеративный доступ">
                        <ServerFederationCell
                          server={s}
                          peers={fed?.peers ?? []}
                          onChanged={(federatedAccess, federationExclusions) =>
                            setServers((list) =>
                              list.map((x) => (x.id === s.id ? { ...x, federatedAccess, federationExclusions } : x)),
                            )
                          }
                        />
                      </td>
                    )}
                  </tr>
                ))}
                {servers.length === 0 && (
                  <tr>
                    <td colSpan={fedOn ? 6 : 5} className="muted">
                      Пока нет серверов
                    </td>
                  </tr>
                )}
              </tbody>
            </table>
            {fed?.peers.map((peer) => (
              <PeerServersGroup key={peer.instanceId} peer={peer} />
            ))}
          </div>
        )}
    </SettingsWindow>
  );
}

// SMTP во вкладке админки; сама форма — `SmtpForm.tsx` (её же показывает мастер установки, #142).
function SmtpTab() {
  return (
    <div className="admin-scroll" id="admin-panel-body" role="tabpanel" aria-labelledby="admin-tab-smtp">
      <SmtpForm />
    </div>
  );
}

/**
 * Инстанс-ручки экономики. Сейчас одна — цена анимированного аватара.
 *
 * 🔴 **Здесь, а не в настройках сервера** (решение 02.09). Аватар единственная награда,
 * которая расходует хранилище и трафик ПОСТОЯННО — мегабайтный файл отдаётся каждому зрителю, — а
 * платит за это держатель инстанса. Остальной прайс остаётся у владельца сервера: это его валюта.
 *
 * 🔴 **Цена в МИНУТАХ сидения.** Минуты значат одно и то же на любом сервере, монеты — нет: у
 * каждого своя ставка. Держатель называет цену в человеческом времени, сервер переводит её сам.
 */
/**
 * Раздел «Боты» (#229, этап 1 `docs/bots-plan.md`): кто может создавать ботов, лимит на человека, доставка на внутренние
 * адреса (выкл по умолчанию — защита от SSRF) и все боты инстанса с владельцами: выключить / включить, удалить.
 * ⚠️ Живёт в этом файле, а не отдельным модулем: тест `AvatarRentalLimit.test.ts` держит закрытый перечень импортов панели.
 * Старый сервер без ботов отвечает 404 — раздел так и говорит.
 */
const BOT_CREATOR_CARDS: { value: BotCreators; title: string; text: string }[] = [
  { value: 'all', title: 'Все', text: 'Любой человек на этом инстансе может создать себе ботов — в пределах лимита ниже.' },
  { value: 'approved', title: 'Только одобренные', text: 'Только люди, чей аккаунт одобрил администратор.' },
  { value: 'admin', title: 'Только администратор', text: 'Создавать ботов можете только вы.' },
];

function BotsTab() {
  const [settings, setSettings] = useState<BotSettings | null>(null);
  const [bots, setBots] = useState<AdminBotInfo[] | null>(null);
  const [limit, setLimit] = useState('');
  const [unsupported, setUnsupported] = useState(false);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    let alive = true;
    const gone = (e: unknown) => {
      if (!alive) return;
      if ((e as { status?: number } | null)?.status === 404) setUnsupported(true);
      else toastError(e);
    };
    adminApi()
      .adminBotSettings()
      .then((r) => {
        if (!alive) return;
        setSettings(r);
        setLimit(String(r.perUserLimit));
      })
      .catch(gone);
    adminApi()
      .adminBots()
      .then((r) => {
        if (alive) setBots(r);
      })
      .catch(gone);
    return () => {
      alive = false;
    };
  }, []);

  async function save(patch: Partial<BotSettings>) {
    setBusy(true);
    try {
      const r = await adminApi().adminSetBotSettings(patch);
      const next = r && typeof r === 'object' && 'creators' in r ? r : settings && { ...settings, ...patch };
      setSettings(next);
      if (next) setLimit(String(next.perUserLimit));
      toast('success', 'Сохранено');
    } catch (e) {
      toastError(e);
    } finally {
      setBusy(false);
    }
  }

  /**
   * Главный тумблер «Боты на этом сервере» (владелец 26.10: включается здесь, а не в `.env`). Выключение сразу гасит всех
   * ботов (токены не принимаются, события не копятся) — при живых ботах спрашивает, фокус на «Отмене». Включение — без вопроса.
   * Старый сервер без поля `enabled` — как включено (`botsEnabled`).
   */
  async function toggleEnabled(on: boolean) {
    if (!on && bots && bots.length > 0) {
      const ok = await confirmAction({
        title: 'Выключить ботов на этом сервере?',
        body:
          `Все боты (${bots.length}) сразу перестанут работать: их токены не будут приниматься, события для них не будут ` +
          'копиться. Сами боты, их настройки и токены сохранятся — включите снова, и они продолжат работу.',
        tone: 'danger',
        // Это не удаление — значок предупреждения, а не корзины (`ConfirmHost` по умолчанию у danger рисует корзину).
        icon: 'alert-circle',
        confirmLabel: 'Выключить',
      });
      if (!ok) return;
    }
    await save({ enabled: on });
  }

  async function toggleInternal(on: boolean) {
    if (on) {
      const ok = await confirmAction({
        title: 'Разрешить доставку на внутренние адреса?',
        body:
          'Тогда сервер будет слать события ботов и на адреса вашей локальной сети и самого сервера. Владелец бота сможет ' +
          'так достучаться до внутренних служб, которые снаружи закрыты (атака SSRF). Включайте, только если всем ' +
          'создателям ботов доверяете как себе.',
        tone: 'danger',
        // Риск безопасности, а не удаление — щит, а не корзина.
        icon: 'shield',
        confirmLabel: 'Разрешить',
      });
      if (!ok) return;
    }
    await save({ allowInternalWebhooks: on });
  }

  async function setDisabled(b: AdminBotInfo, disabled: boolean) {
    if (disabled) {
      const ok = await confirmAction({
        title: `Выключить бота @${b.username}?`,
        body: 'Его токен перестанет приниматься, пока вы не включите бота обратно. Владелец увидит пометку «Выключен администратором».',
        confirmLabel: 'Выключить',
      });
      if (!ok) return;
    }
    try {
      await adminApi().adminSetBotDisabled(b.id, disabled);
      const at = disabled ? new Date().toISOString() : null;
      setBots((list) => list && list.map((x) => (x.id === b.id ? { ...x, disabledAt: at } : x)));
    } catch (e) {
      toastError(e);
    }
  }

  async function remove(b: AdminBotInfo) {
    const ok = await confirmAction({
      title: `Удалить бота @${b.username}?`,
      body: 'Бот исчезнет у владельца, его токен погаснет. Сообщения, которые он уже написал, останутся в беседах.',
      tone: 'danger',
      confirmLabel: 'Удалить бота',
    });
    if (!ok) return;
    try {
      await adminApi().adminDeleteBot(b.id);
      setBots((list) => list && list.filter((x) => x.id !== b.id));
    } catch (e) {
      toastError(e);
    }
  }

  if (unsupported) {
    return (
      <div className="admin-scroll" id="admin-panel-body" role="tabpanel" aria-labelledby="admin-tab-bots">
        <div className="muted">Этот сервер пока не поддерживает ботов — их добавят с обновлением сервера.</div>
      </div>
    );
  }

  const limitNum = /^\d+$/.test(limit.trim()) ? Number(limit.trim()) : NaN;
  const limitOk = Number.isInteger(limitNum) && limitNum >= 0 && limitNum <= BOT_PER_USER_LIMIT_MAX;
  // Пока настройка грузится — как включено (таблица ботов не пишет «не работает» раньше времени).
  const on = settings ? botsEnabled(settings) : true;

  return (
    <div className="admin-scroll" id="admin-panel-body" role="tabpanel" aria-labelledby="admin-tab-bots">
      {!settings ? (
        <div className="muted" role="status">
          Загрузка…
        </div>
      ) : (
        <div className="smtp-form">
          <div className="admin-bot-toggle admin-bots-main">
            <span className="admin-bot-toggle-text">
              <span id="admin-bots-enabled" className="admin-bots-main-title">
                Боты на этом сервере
              </span>
              <span className="muted">
                {on
                  ? 'Включены: люди создают ботов по правилам ниже, боты получают сообщения и отвечают. Выключение сразу гасит всех ботов — токены перестают приниматься, события не копятся.'
                  : 'Выключены: токены ботов не принимаются, события для них не копятся, создать бота нельзя. Включается только здесь — в файле .env ничего править не нужно.'}
              </span>
            </span>
            <Toggle checked={on} disabled={busy} labelledBy="admin-bots-enabled" onChange={(v) => void toggleEnabled(v)} />
          </div>
          <hr className="smtp-sep" />
          <div className={`admin-bots-rest${on ? '' : ' admin-bots-off'}`} aria-disabled={on ? undefined : true}>
          <div className="field">
            <span>Кто может создавать ботов</span>
          </div>
          <div className="reg-policy" role="radiogroup" aria-label="Кто может создавать ботов">
            {BOT_CREATOR_CARDS.map((c) => (
              <label key={c.value} className={`reg-card${settings.creators === c.value ? ' selected' : ''}`}>
                <input
                  type="radio"
                  name="bot-creators"
                  value={c.value}
                  checked={settings.creators === c.value}
                  disabled={busy || !on}
                  onChange={() => void save({ creators: c.value })}
                />
                <span className="reg-card-dot" aria-hidden="true" />
                <span className="reg-card-body">
                  <span className="reg-card-title">{c.title}</span>
                  <span className="reg-card-text">{c.text}</span>
                </span>
              </label>
            ))}
          </div>
          <hr className="smtp-sep" />
          <label className="field">
            <span>Сколько ботов может быть у одного человека (до {BOT_PER_USER_LIMIT_MAX})</span>
            <input
              inputMode="numeric"
              value={limit}
              disabled={!on}
              onChange={(e) => setLimit(e.target.value)}
              aria-invalid={!limitOk || undefined}
            />
          </label>
          {!limitOk && <div className="error">Целое число от 0 до {BOT_PER_USER_LIMIT_MAX}</div>}
          <div className="muted" style={{ fontSize: 12 }}>
            Вас как администратора лимит не ограничивает. 0 — новых ботов никто, кроме вас, не создаст.
          </div>
          <div className="smtp-actions">
            <button
              type="button"
              className="auth-cta"
              disabled={busy || !on || !limitOk || limitNum === settings.perUserLimit}
              onClick={() => void save({ perUserLimit: limitNum })}
            >
              Сохранить лимит
            </button>
          </div>
          <hr className="smtp-sep" />
          <div className="admin-bot-toggle">
            <span className="admin-bot-toggle-text">
              <span id="admin-bots-internal">Разрешить доставку на внутренние адреса</span>
              <span className="muted">
                Обычно выключено. Включённая доставка пускает события ботов на адреса локальной сети — владелец бота
                сможет достучаться до закрытых служб в ней (атака SSRF). Сам сервер (127.0.0.1, ::1) закрыт всегда.
              </span>
            </span>
            <Toggle
              checked={settings.allowInternalWebhooks}
              disabled={busy || !on}
              labelledBy="admin-bots-internal"
              onChange={(v) => void toggleInternal(v)}
            />
          </div>
          </div>
        </div>
      )}

      <div className="cat-name admin-bots-title">Все боты{bots ? ` (${bots.length})` : ''}</div>
      {!bots ? (
        <div className="muted" role="status">
          Загрузка…
        </div>
      ) : (
        <table className="admin-table">
          <thead>
            <tr>
              <th>Бот и владелец</th>
              <th>Кто пишет</th>
              <th>Состояние</th>
              <th></th>
            </tr>
          </thead>
          <tbody>
            {bots.map((b) => (
              <tr key={b.id}>
                <td className="cell-name">
                  {b.displayName || b.username} <span className="muted">@{b.username}</span>
                  <div className="muted admin-bot-owner">владелец @{b.owner.username}</div>
                </td>
                <td data-label="Кто пишет">{b.public ? 'Все' : 'Только владелец'}</td>
                <td data-label="Состояние">
                  {b.disabledAt ? (
                    <span className="error">Выключен</span>
                  ) : !on ? (
                    <span className="muted">Не работает: боты выключены</span>
                  ) : b.webhook?.disabledAt ? (
                    <span className="muted">Доставка выключена после сбоев</span>
                  ) : (
                    'Работает'
                  )}
                </td>
                <td className="cell-act">
                  <button type="button" className="link" onClick={() => void setDisabled(b, !b.disabledAt)}>
                    {b.disabledAt ? 'Включить' : 'Выключить'}
                  </button>{' '}
                  <button type="button" className="link admin-del" onClick={() => void remove(b)} title="Удалить бота">
                    Удалить
                  </button>
                </td>
              </tr>
            ))}
            {bots.length === 0 && (
              <tr>
                <td colSpan={4} className="muted">
                  Ботов на инстансе пока нет.
                </td>
              </tr>
            )}
          </tbody>
        </table>
      )}
    </div>
  );
}

function EconomyTab() {
  const [minutes, setMinutes] = useState('');
  const [rentalDays, setRentalDays] = useState(String(AVATAR_RENTAL_MAX_DAYS));
  const [data, setData] = useState<Awaited<ReturnType<Api['adminEconomy']>> | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    let alive = true;
    adminApi()
      .adminEconomy()
      .then((r) => {
        if (!alive) return;
        setData(r);
        setMinutes(String(r.avatarPriceMinutes));
        setRentalDays(String(r.avatarRentalMaxDays ?? AVATAR_RENTAL_MAX_DAYS));
      })
      .catch((e) => alive && toastError(e));
    return () => {
      alive = false;
    };
  }, []);

  async function save() {
    const v = Math.floor(Number(minutes));
    if (!Number.isFinite(v) || v < 0) return toastError(new Error('цена — целое число минут, от нуля'));
    setBusy(true);
    try {
      await adminApi().adminSetEconomy({ avatarPriceMinutes: v });
      toast('success', 'Цена сохранена');
    } catch (e) {
      toastError(e);
    } finally {
      setBusy(false);
    }
  }

  const rentalMin = data?.rentalMaxDaysMin ?? AVATAR_RENTAL_MAX_DAYS_MIN;
  const rentalLimit = data?.rentalMaxDaysLimit ?? AVATAR_RENTAL_MAX_DAYS_LIMIT;

  /** Потолок аренды (#228). Границы проверяет и сервер; здесь — чтобы отказ был виден до отправки. */
  async function saveRental() {
    const v = Number(rentalDays);
    if (!Number.isInteger(v) || v < rentalMin || v > rentalLimit) {
      return toastError(new Error(`потолок аренды — целое число дней от ${rentalMin} до ${rentalLimit}`));
    }
    setBusy(true);
    try {
      await adminApi().adminSetEconomy({ avatarRentalMaxDays: v });
      toast('success', 'Потолок аренды сохранён');
    } catch (e) {
      toastError(e);
    } finally {
      setBusy(false);
    }
  }

  const st = data?.stats;
  const want = Number(minutes);
  /**
   * 🔴 **Справа от поля — ДНИ НАКОПЛЕНИЯ, а не часы сидения** (запрос 02.09). «Двадцать
   * часов» человеку ничего не говорит: он не знает, сколько сидит средний участник. «Одиннадцать
   * дней» — говорит сразу.
   *
   * ⚠️ Две цифры, а не одна усреднённая: гусь даёт больше половины дохода, но требует КЛИКА.
   * «Только сидение» — верхняя граница срока, «с гусями» — нижняя. Правда между ними, и показать
   * обе честнее, чем выбрать за держателя.
   */
  const daysSit = st && st.avgEarnMinutes > 0 && Number.isFinite(want) ? want / st.avgEarnMinutes : null;
  const daysGoose =
    st && st.avgEarnMinutes + st.avgGooseMinutes > 0 && Number.isFinite(want)
      ? want / (st.avgEarnMinutes + st.avgGooseMinutes)
      : null;
  const fmt = (d: number | null) => (d === null ? '—' : d < 1 ? 'меньше дня' : `${Math.round(d * 10) / 10} дн.`);

  return (
    <div className="admin-scroll" id="admin-panel-body" role="tabpanel" aria-labelledby="admin-tab-economy">
      <div className="settings-pane">
        <div className="cat-name">Что происходит в голосовых каналах</div>
        {!st ? (
          <div className="muted" role="status">Загрузка…</div>
        ) : st.userDays === 0 ? (
          <div className="muted" style={{ fontSize: 12 }}>
            За последние {st.windowDays} дней присутствия не записано. Сбор статистики включается
            переменной <code>ECONOMY_STATS_ENABLED</code>.
          </div>
        ) : (
          <>
            <div className="muted" style={{ fontSize: 12 }}>
              За последние {st.windowDays} дней по всему инстансу.
            </div>
            <div className="eco-stats">
              <div><b>{st.people}</b><span>человек сидели</span></div>
              <div><b>{st.hours}</b><span>часов всего</span></div>
              <div><b>{st.userDays}</b><span>человеко-дней</span></div>
              <div><b>{Math.round(st.avgSitMinutes / 6) / 10}</b><span>часов в активный день</span></div>
              <div><b>{st.avgEarnMinutes}</b><span>минут прайса за день сидением</span></div>
              <div><b>{st.avgGooseMinutes}</b><span>минут прайса добавил гусь</span></div>
            </div>
            {/* ⚠️ Подписываем прямо: это ОЦЕНКА по УМОЛЧАНИЯМ, а не факт. Ставка, компания и
                затухание у каждого сервера свои, а статистика одна на инстанс. Числа в подписи
                обязаны совпадать с `REF` в economyStats.ts — там же разбор, почему это важно. */}
            <div className="muted" style={{ fontSize: 11.5, marginTop: 6 }}>
              Оценка по умолчаниям сервера (одиночка 25 %, вдвоём 100 %, трое и больше 150 %,
              затухание вдвое каждые 2 часа, потолок 800 монет в день). У серверов свои ползунки —
              числа сдвинутся, порядок останется. Гусь — не оценка, а факт: сколько его реально
              наклацали за это окно.
            </div>
          </>
        )}
      </div>

      <div className="settings-pane">
        <div className="cat-name">Анимированный аватар</div>
        <div className="muted" style={{ fontSize: 12 }}>
          Цена задаётся здесь, а не в настройках сервера: анимация расходует хранилище и трафик
          постоянно, и платит за них держатель инстанса. Указывается в <b>минутах в голосовом канале</b> —
          каждый сервер переводит их в свои монеты по своей ставке.
        </div>
        <div className="sbp-add" style={{ marginTop: 10 }}>
          <input
            type="number"
            className="sbp-price-input"
            min={0}
            max={data?.maxMinutes}
            value={minutes}
            disabled={busy}
            onChange={(e) => setMinutes(e.target.value)}
          />
          <span className="muted" style={{ fontSize: 12 }}>
            минут · копить <b>{fmt(daysSit)}</b> сидением, <b>{fmt(daysGoose)}</b> с гусями
          </span>
          <button type="button" className="seg-mini" disabled={busy} onClick={() => void save()}>
            Сохранить
          </button>
        </div>
        <div className="sbp-add" style={{ marginTop: 14 }}>
          <span style={{ fontSize: 13 }}>Аренда движущегося аватара: не больше</span>
          <input
            type="number"
            className="sbp-price-input"
            aria-label="Потолок аренды аватара, дней вперёд"
            min={rentalMin}
            max={rentalLimit}
            value={rentalDays}
            disabled={busy}
            onChange={(e) => setRentalDays(e.target.value)}
          />
          <span style={{ fontSize: 13 }}>дней вперёд</span>
          <button type="button" className="seg-mini" disabled={busy} onClick={() => void saveRental()}>
            Сохранить
          </button>
        </div>
        <div className="muted" style={{ fontSize: 12, marginTop: 6 }}>
          Одна покупка даёт {pluralDays(AVATAR_RENTAL_DAYS)}. Это предел, на сколько вперёд человек может оплатить
          аренду: докупить можно, пока оплачено не больше чем потолок минус {pluralDays(AVATAR_RENTAL_DAYS)}. От {rentalMin}
          до {rentalLimit} дней, по умолчанию {AVATAR_RENTAL_MAX_DAYS}. Если уменьшить потолок, уже оплаченное не
          пропадает — просто нельзя докупить, пока остаток не станет меньше.
        </div>
        <div className="muted" style={{ fontSize: 12, marginTop: 8 }}>
          ⚠️ Аренда — 30 дней с покупки, повторная покупка продлевает. Размер файла и число кадров
          ограничены отдельно и цене не подчиняются: именно они и защищают диск.
        </div>
      </div>
    </div>
  );
}
