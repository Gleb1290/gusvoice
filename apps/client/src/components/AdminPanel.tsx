import type { AdminServer, AdminUser } from '@gusvoice/shared';
import { useEffect, useState } from 'react';
import { api } from '../api';
import { tabListKeyDown, useDialogChrome } from '../dialogChrome';
import { toast, toastError } from '../toast';
import { Icon } from './Icon';
import { InstanceSettingsPanel } from './InstanceSettingsForms';
import { SmtpForm } from './SmtpForm';
import { Toggle } from './Toggle';

type AdminTab = 'users' | 'servers' | 'instance' | 'smtp' | 'economy';
const ADMIN_TABS: AdminTab[] = ['users', 'servers', 'instance', 'smtp', 'economy'];

export function AdminPanel({ onClose }: { onClose: () => void }) {
  const [tab, setTab] = useState<AdminTab>('users');
  const [users, setUsers] = useState<AdminUser[]>([]);
  const [servers, setServers] = useState<AdminServer[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const dialogRef = useDialogChrome<HTMLDivElement>(onClose);
  const onTabsKey = tabListKeyDown(ADMIN_TABS, tab, setTab, (k) => `admin-tab-${k}`);

  async function load() {
    setLoading(true);
    setError(null);
    try {
      const [u, s] = await Promise.all([api.adminUsers(), api.adminServers()]);
      setUsers(u);
      setServers(s);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    load();
  }, []);

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
    if (
      !window.confirm(
        `Удалить аккаунт @${u.username}? Логин и почта освободятся, сообщения останутся с подписью «Удалённый пользователь». Действие необратимо.`,
      )
    )
      return;
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
        className="modal admin"
        onClick={(e) => e.stopPropagation()}
        ref={dialogRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby="admin-title"
        tabIndex={-1}
      >
        <div className="admin-head">
          <h2 id="admin-title">Админ-панель</h2>
          <button type="button" className="icon-close" title="Закрыть" aria-label="Закрыть" onClick={onClose}>
            <Icon name="close" size={18} />
          </button>
        </div>

        <div className="admin-tabs">
          {/* «обновить» sits in the same row but is NOT a tab, so the tablist wraps only the three tabs.
              display:contents keeps them direct flex children of .admin-tabs — no visual change. */}
          <div role="tablist" aria-label="Разделы админ-панели" style={{ display: 'contents' }} onKeyDown={onTabsKey}>
            <button
              type="button"
              role="tab"
              id="admin-tab-users"
              aria-selected={tab === 'users'}
              aria-controls="admin-panel-body"
              tabIndex={tab === 'users' ? 0 : -1}
              className={tab === 'users' ? 'active' : ''}
              onClick={() => setTab('users')}
            >
              Пользователи ({users.length})
            </button>
            <button
              type="button"
              role="tab"
              id="admin-tab-servers"
              aria-selected={tab === 'servers'}
              aria-controls="admin-panel-body"
              tabIndex={tab === 'servers' ? 0 : -1}
              className={tab === 'servers' ? 'active' : ''}
              onClick={() => setTab('servers')}
            >
              Серверы ({servers.length})
            </button>
            <button
              type="button"
              role="tab"
              id="admin-tab-instance"
              aria-selected={tab === 'instance'}
              aria-controls="admin-panel-body"
              tabIndex={tab === 'instance' ? 0 : -1}
              className={tab === 'instance' ? 'active' : ''}
              onClick={() => setTab('instance')}
            >
              Инстанс
            </button>
            <button
              type="button"
              role="tab"
              id="admin-tab-smtp"
              aria-selected={tab === 'smtp'}
              aria-controls="admin-panel-body"
              tabIndex={tab === 'smtp' ? 0 : -1}
              className={tab === 'smtp' ? 'active' : ''}
              onClick={() => setTab('smtp')}
            >
              Почта
            </button>
            <button
              type="button"
              role="tab"
              id="admin-tab-economy"
              aria-selected={tab === 'economy'}
              aria-controls="admin-panel-body"
              tabIndex={tab === 'economy' ? 0 : -1}
              className={tab === 'economy' ? 'active' : ''}
              onClick={() => setTab('economy')}
            >
              Экономика
            </button>
          </div>
          {tab !== 'smtp' && tab !== 'economy' && tab !== 'instance' && (
            <button type="button" className="link refresh" onClick={load}>
              ⟳ обновить
            </button>
          )}
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
            <table className="admin-table">
              <thead>
                <tr>
                  <th>Пользователь</th>
                  <th>Email</th>
                  <th>Подтв.</th>
                  <th>Создание серверов</th>
                  <th>Роль</th>
                  <th></th>
                </tr>
              </thead>
              <tbody>
                {users.map((u) => (
                  <tr key={u.id}>
                    <td>
                      {u.displayName} <span className="muted">@{u.username}</span>
                    </td>
                    <td className="muted">{u.email || '—'}</td>
                    <td>
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
                    <td>
                      {u.superAdmin ? (
                        <span className="muted">всегда</span>
                      ) : (
                        <Toggle checked={u.canCreateServers} onChange={() => toggleCreate(u)} title="Создание серверов" />
                      )}
                    </td>
                    <td>{u.superAdmin ? <span className="badge">super-admin</span> : 'user'}</td>
                    <td>
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
          </div>
        ) : (
          <div className="admin-scroll" id="admin-panel-body" role="tabpanel" aria-labelledby={`admin-tab-${tab}`}>
            <table className="admin-table">
              <thead>
                <tr>
                  <th>Сервер</th>
                  <th>Владелец</th>
                  <th>Каналы</th>
                  <th>Голосовых</th>
                  <th>Участников</th>
                </tr>
              </thead>
              <tbody>
                {servers.map((s) => (
                  <tr key={s.id}>
                    <td>{s.name}</td>
                    <td className="muted">@{s.ownerUsername || s.ownerId}</td>
                    <td>{s.channels}</td>
                    <td>{s.voiceChannels}</td>
                    <td>{s.members}</td>
                  </tr>
                ))}
                {servers.length === 0 && (
                  <tr>
                    <td colSpan={5} className="muted">
                      Пока нет серверов
                    </td>
                  </tr>
                )}
              </tbody>
            </table>
          </div>
        )}
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
