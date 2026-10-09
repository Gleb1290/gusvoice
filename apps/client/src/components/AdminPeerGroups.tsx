import { useEffect, useState } from 'react';
import type { AdminServer, FederationPeerGroup } from '@gusvoice/shared';
import { adminApi } from '../adminApi';
import { count } from '../plural';
import { InstanceBanModal } from './InstanceBanModal';
import { Toggle } from './Toggle';

/**
 * Выпадающие списки по инстансам во вкладках «Пользователи» и «Серверы» (#139, F2, план §4.1).
 *
 * 🔴 Всё, что здесь показано про соседа, — это КЕШ, и об этом сказано вслух: у каждой группы стоит
 * «обновлено 3 мин назад», а у недоступного соседа — предупреждение. Список без отметки свежести
 * выглядит как правда на сейчас, и держатель принимает по нему решения, которых не принял бы, зная,
 * что данным сутки.
 *
 * ⚠️ Группы появляются ТОЛЬКО когда федерация включена и связки есть. На обычном инстансе список
 * людей остаётся плоским: оборачивать его в «▾ этот инстанс» ради единственной группы — это шум,
 * который каждый держатель будет разворачивать снова и снова.
 */

/** Как назвать связку в заголовке группы: имя, иначе домен — и домен рядом всегда (§5.1.2). */
function titleOf(peer: FederationPeerGroup): string {
  return peer.name ?? peer.domain;
}

function PeerHeader({ peer, what }: { peer: FederationPeerGroup; what: string }) {
  return (
    <>
      <b>{titleOf(peer)}</b>
      <span className="muted"> · {peer.domain}</span>
      <span className="muted"> — доверенный ({what})</span>
      {/* Свежесть словами приходит с сервера: считать минуты в двух местах — значит однажды
          назвать один и тот же кеш по-разному. */}
      <span className={peer.reachable ? 'muted' : 'error'}> · {peer.reachable ? peer.freshness : `недоступен, ${peer.freshness}`}</span>
    </>
  );
}

/**
 * Аватар человека с соседнего инстанса.
 *
 * 🔴 Картинку готовит ХОСТ: клиент просит адрес в НАШЕМ хранилище и только потом показывает. Прямая
 * ссылка на чужой домен оставила бы там адрес каждого, кто открыл эту вкладку.
 * ⚠️ Запрос уходит только когда группа раскрыта (компонент вообще не смонтирован в свёрнутой): иначе
 * открытие вкладки тянуло бы сотни картинок разом.
 */
function PeerAvatar({ instanceId, user }: { instanceId: string; user: FederationPeerGroup['users'][number] }) {
  const [url, setUrl] = useState<string | null>(user.avatarUrl);

  useEffect(() => {
    if (url || !user.avatarHash) return;
    let alive = true;
    adminApi()
      .federationPeerAvatar(instanceId, user.userId)
      .then((res) => {
        if (alive) setUrl(res.url);
      })
      // Нет картинки или сосед лежит — покажем кружок с буквой, как у человека без аватара.
      .catch(() => {});
    return () => {
      alive = false;
    };
  }, [instanceId, user.userId, user.avatarHash, url]);

  if (url) return <img className="fed-peer-avatar" src={url} alt="" />;
  return <span className="fed-peer-avatar fed-peer-avatar-empty">{user.displayName.slice(0, 1).toUpperCase()}</span>;
}

export function PeerUsersGroup({ peer }: { peer: FederationPeerGroup }) {
  const [open, setOpen] = useState(false);
  /**
   * Кого запрещаем. Окно открывается ИЗ КАТАЛОГА соседа — то есть запретить можно и человека,
   * который к нам ни разу не заходил (§5.11: ключ запрета — глобальная личность, а не теневая
   * строка). Приложить сообщения тут неоткуда, и это честно: окно открыто из списка людей, а не
   * из переписки.
   */
  const [banning, setBanning] = useState<{ userId: string; username: string; displayName: string } | null>(null);
  const [reports, setReports] = useState<boolean | null>(null);
  const [contacts, setContacts] = useState<{ kind: string; label: string; value: string }[]>([]);

  // Возможности связки и контакты держателя — из сводки федерации: по ним окно решает, активна ли
  // галочка «Пожаловаться», и что показать, когда сосед жалоб не принимает.
  useEffect(() => {
    if (!open || reports !== null) return;
    adminApi()
      .federationOverview()
      .then((o) => {
        const link = o.links.find((l) => l.instanceId === peer.instanceId);
        setReports(!!link?.features.includes('reports'));
      })
      .catch(() => setReports(false));
    adminApi()
      .federationPeerContacts(peer.instanceId)
      .then((c) => setContacts(c.contacts))
      .catch(() => setContacts([]));
  }, [open, reports, peer.instanceId]);

  return (
    <section className="fed-group">
      <button type="button" className="fed-group-head" onClick={() => setOpen(!open)} aria-expanded={open}>
        <span className="fed-group-arrow">{open ? '▾' : '▸'}</span>
        <PeerHeader peer={peer} what={count(peer.users.length, 'человек', 'человека', 'человек')} />
      </button>
      {open && (
        <div className="fed-group-body">
          {peer.users.length === 0 ? (
            <p className="muted">Каталог пуст — либо у соседа никого нет, либо мы ещё ни разу не синхронизировались.</p>
          ) : (
            <ul className="fed-peer-list">
              {peer.users.map((u) => (
                <li key={u.userId}>
                  <PeerAvatar instanceId={peer.instanceId} user={u} />
                  <span>
                    {u.displayName} <span className="muted">@{u.username}</span>
                  </span>
                  {/* Запрет на инстанс — решение держателя, поэтому кнопка живёт здесь, а не в
                      меню ника на сервере: там банят на сервере, а тут закрывают весь инстанс. */}
                  <button
                    type="button"
                    className="link danger"
                    onClick={() => setBanning({ userId: u.userId, username: u.username, displayName: u.displayName })}
                  >
                    Запретить вход
                  </button>
                </li>
              ))}
            </ul>
          )}
        </div>
      )}
      {banning && (
        <InstanceBanModal
          instanceId={peer.instanceId}
          instanceName={peer.name ?? peer.domain}
          user={banning}
          reports={reports === true}
          contacts={contacts}
          onClose={() => setBanning(null)}
          onDone={() => setBanning(null)}
        />
      )}
    </section>
  );
}

export function PeerServersGroup({ peer }: { peer: FederationPeerGroup }) {
  const [open, setOpen] = useState(false);
  return (
    <section className="fed-group">
      <button type="button" className="fed-group-head" onClick={() => setOpen(!open)} aria-expanded={open}>
        <span className="fed-group-arrow">{open ? '▾' : '▸'}</span>
        <PeerHeader peer={peer} what={count(peer.servers.length, 'сервер', 'сервера', 'серверов')} />
      </button>
      {open && (
        <div className="fed-group-body">
          <p className="muted">
            Только те серверы, где держатель того инстанса поставил галочку федеративного доступа. Отсюда — только
            просмотр: вступают в них по ссылке-приглашению.
          </p>
          {peer.servers.length === 0 ? (
            <p className="muted">Открытых серверов нет.</p>
          ) : (
            <ul className="fed-peer-list">
              {peer.servers.map((s) => (
                <li key={s.serverId}>
                  <span>{s.name}</span>
                  <span className="muted"> · участников {s.members}</span>
                </li>
              ))}
            </ul>
          )}
        </div>
      )}
    </section>
  );
}

/**
 * Галочка федеративного доступа у нашего сервера и исключения по связкам (§5.3, требования 17 и 32).
 *
 * Галочка открывает сервер ВСЕМ связкам сразу; список ниже — кому именно не открывать. Так и описано
 * в плане: «для всех связок сразу, выключается по связке».
 */
export function ServerFederationCell({
  server,
  peers,
  onChanged,
}: {
  server: AdminServer;
  peers: FederationPeerGroup[];
  onChanged: (enabled: boolean, exclusions: string[]) => void;
}) {
  const [busy, setBusy] = useState(false);
  const [open, setOpen] = useState(false);
  const enabled = server.federatedAccess ?? false;
  const exclusions = server.federationExclusions ?? [];

  async function save(nextEnabled: boolean, nextExclusions: string[]) {
    setBusy(true);
    try {
      const res = await adminApi().adminSetServerFederation(server.id, nextEnabled, nextExclusions);
      onChanged(res.federatedAccess, res.federationExclusions);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="fed-access">
      <Toggle checked={enabled} onChange={() => void save(!enabled, exclusions)} title="Разрешить федеративный доступ" />
      {enabled && peers.length > 0 && (
        <>
          <button type="button" className="link" onClick={() => setOpen(!open)} disabled={busy}>
            {exclusions.length === 0 ? 'для всех связок' : `кроме ${exclusions.length}`} {open ? '▾' : '▸'}
          </button>
          {open && (
            <ul className="fed-access-list">
              {peers.map((p) => {
                const excluded = exclusions.includes(p.instanceId);
                return (
                  <li key={p.instanceId}>
                    <label>
                      <input
                        type="checkbox"
                        checked={!excluded}
                        disabled={busy}
                        onChange={() =>
                          void save(
                            enabled,
                            excluded
                              ? exclusions.filter((i) => i !== p.instanceId)
                              : [...exclusions, p.instanceId],
                          )
                        }
                      />{' '}
                      {titleOf(p)}
                    </label>
                  </li>
                );
              })}
            </ul>
          )}
        </>
      )}
    </div>
  );
}
