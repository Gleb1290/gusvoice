import type { AdminServer, AdminUser, FederationDirectoryView } from '@gusvoice/shared';
import { useEffect, useState } from 'react';
import { api } from '../api';
import { tabListKeyDown, useDialogChrome } from '../dialogChrome';
import { toast, toastError } from '../toast';
import { Icon } from './Icon';
import { FederationPanel } from './FederationPanel';
import { InstanceSettingsPanel } from './InstanceSettingsForms';
import { PeerServersGroup, PeerUsersGroup, ServerFederationCell } from './AdminPeerGroups';
import { SmtpForm } from './SmtpForm';
import { Toggle } from './Toggle';
import { guestAtLines, guestAtSummary } from '../guestAtMark';
import { confirmAction } from '../confirm';
import { ADMIN_SECTIONS, adminSectionLabel, adminSectionOf, type AdminSectionKey } from '../adminNav';
import { pushBackHandler } from '../androidBack';

const ADMIN_TABS: AdminSectionKey[] = ADMIN_SECTIONS.map((s) => s.key);

export function AdminPanel({ onClose }: { onClose: () => void }) {
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
      const [u, s] = await Promise.all([api.adminUsers(), api.adminServers()]);
      setUsers(u);
      setServers(s);
      // Каталоги соседей читаем отдельно и не роняем ими вкладку: список СВОИХ людей не должен
      // зависеть от того, доступна ли федерация.
      api
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
      const upd = await api.adminSetUserHidden(u.id, !u.hiddenFromPeers);
      setUsers((list) => list.map((x) => (x.id === upd.id ? upd : x)));
      toast('success', upd.hiddenFromPeers ? 'Скрыт от соседей' : 'Виден соседям');
    } catch (e) {
      toastError((e as Error).message);
    }
  }

  async function toggleCreate(u: AdminUser) {
    try {
      const upd = await api.adminSetCreateServers(u.id, !u.canCreateServers);
      setUsers((list) => list.map((x) => (x.id === upd.id ? upd : x)));
    } catch (e) {
      toastError(e);
    }
  }

  // Manual approval — the fallback for instances without SMTP (no e-mail code can be delivered), and the
  // approval itself under the `approval` registration policy (#142): one click makes the account usable.
  async function verifyUser(u: AdminUser) {
    try {
      const upd = await api.adminVerifyUser(u.id);
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
      await api.adminDeleteUser(u.id);
      setUsers((list) => list.filter((x) => x.id !== u.id));
      toast('success', 'Аккаунт удалён', `@${u.username}`);
    } catch (e) {
      toastError(e);
    }
  }

  return (
    <div className="modal-overlay" onClick={onClose}>
      <div
        className={`modal admin rail-modal admin-rail${picked ? ' picked' : ''}`}
        onClick={(e) => e.stopPropagation()}
        ref={dialogRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby="admin-title"
        tabIndex={-1}
      >
        {/* Рельс разделов — тот же приём, что в настройках (#153): у каждого раздела появилась
            строка пояснения, которой в строке вкладок помещаться было негде. */}
        <div className="set-rail">
          <div className="set-rail-title">
            <span>Админ-панель</span>
            {/* Крестик виден только на телефоне: там список разделов — отдельный экран, и другой
                кнопки закрытия на нём нет (на десктопе она в шапке раздела справа). */}
            <button type="button" className="icon-close" title="Закрыть" aria-label="Закрыть" onClick={onClose}>
              <Icon name="close" size={18} />
            </button>
          </div>
          <div
            className="set-rail-list"
            role="tablist"
            aria-label="Разделы админ-панели"
            aria-orientation="vertical"
            onKeyDown={onTabsKey}
          >
            {ADMIN_SECTIONS.map((s) => (
              <button
                key={s.key}
                type="button"
                role="tab"
                id={`admin-tab-${s.key}`}
                aria-selected={tab === s.key}
                aria-controls="admin-panel-body"
                tabIndex={tab === s.key ? 0 : -1}
                className={`set-rail-item${tab === s.key ? ' active' : ''}`}
                onClick={() => {
                  setTab(s.key);
                  setPicked(true);
                }}
              >
                <Icon name={s.icon} size={16} />
                <span>
                  {adminSectionLabel(s, { users: loading ? undefined : users.length, servers: loading ? undefined : servers.length })}
                </span>
              </button>
            ))}
          </div>
        </div>

        <div className="set-main">
          <div className="set-head">
            <button type="button" className="set-back" onClick={() => setPicked(false)} aria-label="К разделам">
              <Icon name="chevron-left" size={18} />
            </button>
            <div className="set-head-text">
              <h2 id="admin-title">{currentSection.label}</h2>
              <div className="set-head-sub">{currentSection.sub}</div>
            </div>
            {currentSection.refreshable && (
              <button type="button" className="link refresh" onClick={load}>
                ⟳ обновить
              </button>
            )}
            <button type="button" className="icon-close" title="Закрыть" aria-label="Закрыть" onClick={onClose}>
              <Icon name="close" size={18} />
            </button>
          </div>

        {error && (
          <div className="error" role="alert">
            {error}
          </div>
        )}

        {tab === 'instance' ? (
          <div className="admin-scroll" id="admin-panel-body" role="tabpanel" aria-labelledby="admin-tab-instance">
            <InstanceSettingsPanel />
          </div>
        ) : tab === 'federation' ? (
          <div className="admin-scroll" id="admin-panel-body" role="tabpanel" aria-labelledby="admin-tab-federation">
            <FederationPanel />
          </div>
        ) : tab === 'smtp' ? (
          <SmtpTab />
        ) : tab === 'economy' ? (
          <EconomyTab />
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
        </div>
      </div>
    </div>
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
function EconomyTab() {
  const [minutes, setMinutes] = useState('');
  const [data, setData] = useState<Awaited<ReturnType<typeof api.adminEconomy>> | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    let alive = true;
    api
      .adminEconomy()
      .then((r) => {
        if (!alive) return;
        setData(r);
        setMinutes(String(r.avatarPriceMinutes));
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
      await api.adminSetEconomy(v);
      toast('success', 'Цена сохранена');
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
        <div className="muted" style={{ fontSize: 12, marginTop: 8 }}>
          ⚠️ Аренда — 30 дней с покупки, повторная покупка продлевает. Размер файла и число кадров
          ограничены отдельно и цене не подчиняются: именно они и защищают диск.
        </div>
      </div>
    </div>
  );
}
