import { inviteLinkFor, parseInviteInput, type Invite, type InvitePreviewView, type InviteScopeView } from '@gusvoice/shared';
import { useEffect, useRef, useState } from 'react';
import { api } from '../api';
import { useFederationEnabled } from '../federationClient';
import { inviteScopeHint } from '../inviteScopeHint';
import { activeInstance, activeInstanceId } from '../config';
import {
  GuestJoinError,
  acceptInviteAtHome,
  homeInvitePreview,
  joinAsGuest,
  openInstance,
} from '../guestJoin';
import { setPendingOpen } from '../pendingOpen';
import { domainFromInput, instanceLabel, inviteActionLabel, inviteCheck, refusalOrMessage, refusalText } from '../inviteCheckRules';
import { toast, toastError } from '../toast';
import { Icon } from './Icon';

/** Create a new server (gated to super-admin / can_create_servers). */
export function CreateServerModal({ onClose, onCreated }: { onClose: () => void; onCreated: (serverId: string) => void }) {
  const [name, setName] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    if (!name.trim()) return;
    setBusy(true);
    setError(null);
    try {
      const b = await api.createServer(name.trim());
      onCreated(b.server.id);
      onClose();
    } catch (err) {
      setError((err as Error).message);
      setBusy(false);
    }
  }

  return (
    <div className="modal-overlay" onClick={onClose}>
      <form className="modal create-channel" onClick={(e) => e.stopPropagation()} onSubmit={submit}>
        <div className="admin-head">
          <h2>Новый сервер</h2>
          <button type="button" className="icon-close" title="Закрыть" onClick={onClose}>
            <Icon name="close" size={18} />
          </button>
        </div>
        <label className="field">
          Название
          <input value={name} onChange={(e) => setName(e.target.value)} autoFocus placeholder="Мой сервер" maxLength={80} />
        </label>
        {error && <div className="error">{error}</div>}
        <div className="modal-actions">
          <button type="button" className="link" onClick={onClose}>
            Отмена
          </button>
          <button type="submit" disabled={busy || !name.trim()}>
            {busy ? '…' : 'Создать'}
          </button>
        </div>
      </form>
    </div>
  );
}

/**
 * Войти по приглашению (#139, F4, план §4.2.1).
 *
 * Поле принимает И ссылку, И короткий код: человеку прислали то, что прислали, и заставлять его
 * выковыривать код из ссылки — работа, которую машина делает лучше.
 *
 * 🔴 **Проверку делает СВОЙ инстанс, а не клиент.** До нажатия «Войти» к чужому инстансу мы не
 * ходим вовсе: иначе его держатель узнавал бы адрес каждого, кто просто посмотрел ссылку и
 * передумал. Карточка, которую видит человек, — пересказ дома (`InvitePreviewView`).
 *
 * ⚠️ **Без федерации окно ведёт себя ровно как раньше** — поле, кнопка, отказ текстом. Маршрута
 * проверки на выключенном инстансе нет вовсе (404), и спрашивать его значило бы показывать
 * поломку там, где её нет.
 */
export function JoinServerModal({
  onClose,
  onJoined,
  initial,
}: {
  onClose: () => void;
  onJoined: (serverId: string) => void;
  /** Ссылка, по которой окно и открылось (клик в мессенджере, §4.2.2). Проверка пойдёт сразу. */
  initial?: string;
}) {
  const [code, setCode] = useState(initial ?? '');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [view, setView] = useState<InvitePreviewView | null>(null);
  const [checking, setChecking] = useState(false);
  const fed = useFederationEnabled();
  const parsed = parseInviteInput(code);
  // Номер проверки: ответ на прошлый ввод, догнавший нас после следующего, иначе показал бы карточку
  // не того сервера — человек в этот момент уже вставил другую ссылку.
  const round = useRef(0);

  useEffect(() => {
    if (!fed || !parseInviteInput(code)) {
      round.current += 1;
      setView(null);
      setChecking(false);
      return;
    }
    const mine = ++round.current;
    setChecking(true);
    // Задержка: ссылку вставляют целиком, но код набирают руками, и проверять каждую букву значило
    // бы гонять инстанс запросами ради заведомо неполного кода.
    const t = window.setTimeout(() => {
      // У ДОМА, а не у активной записи: стоя гостем у соседа, `api` спросил бы соседа, а тот гостям
      // проверку не делает (403) — и окно скатывалось в «invalid invite» (#205).
      homeInvitePreview(code.trim())
        .then((v) => {
          if (round.current === mine) setView(v);
        })
        .catch(() => {
          // Не вышло спросить дом — не беда: остаётся обычный путь по коду, он тут же ниже.
          if (round.current === mine) setView(null);
        })
        .finally(() => {
          if (round.current === mine) setChecking(false);
        });
    }, 400);
    return () => window.clearTimeout(t);
  }, [code, fed]);

  // Домен из вставленной ссылки — запасное имя чужого инстанса: при «нет связки» название взять
  // негде, а домен человек видит своими глазами и его же перескажет своему держателю.
  const pastedDomain = domainFromInput(code);
  const check = view ? inviteCheck(view, pastedDomain) : null;

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    const c = parsed?.code ?? code.trim();
    if (!c) return;
    setBusy(true);
    setError(null);
    /**
     * Открыть сервер в записи `target`. Намерение «открыть именно этот сервер» записываем ДО перехода,
     * как делает рейл (`RailGroups`): без него переход кончался пустым «Выбери сервер» (пробная сборка
     * 23.09). Запись уже активна — переходить некуда (`switchInstance` ничего не сделает, а намерение
     * повисло бы до следующего запуска): просто открываем сервер здесь.
     */
    async function goTo(target: string, serverId: string | null) {
      if (target === activeInstanceId()) {
        onClose();
        if (serverId) onJoined(serverId);
        return;
      }
      if (serverId) setPendingOpen({ instanceId: target, serverId });
      onClose();
      await openInstance(target);
    }
    try {
      // Сервер соседа — гостевой путь: дом ручается, хост заводит сессию, дальше обычное вступление.
      if (view?.instance && check?.action === 'join' && view.scope === 'peer') {
        const res = await joinAsGuest(view);
        await goTo(res.instanceId, res.serverId || null);
        return;
      }
      /**
       * 🔴 «Уже участник» — ещё не значит, что на ЭТОМ устройстве есть гостевая запись: вступил из
       * браузера, а ссылку открыл в приложении (пробная сборка 23.09). Раньше такой случай проваливался
       * ниже, в `acceptInvite` ДОМА, и дом честно отвечал «invalid invite» на чужой код. Записи нет —
       * тот же гостевой путь, что при первом вступлении: хост пускает уже вступившего без вопросов.
       *
       * ⚠️ Всегда через `joinAsGuest`, даже когда запись есть: у неё может не быть токена или он мёртв.
       * «Выйти» на другом устройстве завершает гостевую сессию у хоста (F-23), а хост гасит сессии
       * человека разом — запись в этом приложении остаётся с чужим мёртвым токеном. Переход в неё кончался
       * молчаливым возвратом домой (пробная сборка 23.09). `joinAsGuest` проверит токен вступлением
       * (уже вступившего хост просто пускает) и при отказе заведёт сессию заново — за человека ручается дом.
       * Сначала сессия, потом закрытие окна: отказ хоста должен остаться в окне словами.
       */
      if (view?.instance && check?.action === 'open' && view.scope === 'peer') {
        const res = await joinAsGuest(view);
        await goTo(res.instanceId, view.server?.serverId ?? (res.serverId || null));
        return;
      }
      // Ссылка на сервер САМОГО дома, а стоим гостем у соседа (#205): вступаем у дома и идём домой.
      // `api.acceptInvite` отправил бы код соседу — «invalid invite» и засчитанный промах.
      if (view?.scope === 'local' && activeInstance()?.guestOf) {
        const res = await acceptInviteAtHome(c);
        await goTo(res.instanceId, res.serverId || null);
        return;
      }
      const b = await api.acceptInvite(c);
      onJoined(b.server.id);
      onClose();
    } catch (err) {
      /**
       * 🔴 Отказ хоста приходит СВОИМ кодом, а не `GuestJoinError`: гость, уже стоящий на чужом
       * инстансе, входит на его сервер обычным путём (`acceptInvite`), и бессрочная ссылка
       * возвращалась ему красным «federation.invite_no_expiry» (приёмка 18.09). Текст для неё был
       * написан с самого начала — не хватало ровно этой строки.
       */
      setError(
        err instanceof GuestJoinError
          ? refusalText(err.code, instanceLabel(view?.instance ?? null, pastedDomain))
          : refusalOrMessage(err, instanceLabel(view?.instance ?? null, pastedDomain)),
      );
      setBusy(false);
    }
  }

  const expiryText = (at: number | null) =>
    at === null
      ? 'ссылка бессрочная'
      : `ссылка до ${new Date(at).toLocaleString('ru-RU', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' })}`;

  return (
    <div className="modal-overlay" onClick={onClose}>
      <form className="modal create-channel" onClick={(e) => e.stopPropagation()} onSubmit={submit}>
        <div className="admin-head">
          <h2>Войти по приглашению</h2>
          <button type="button" className="icon-close" title="Закрыть" onClick={onClose}>
            <Icon name="close" size={18} />
          </button>
        </div>
        <label className="field">
          {fed ? 'Ссылка или код приглашения' : 'Код приглашения'}
          <input
            value={code}
            // Отказ относится к ТОЙ ссылке: правишь поле — старое объяснение под ним уже врёт.
            onChange={(e) => {
              setCode(e.target.value);
              setError(null);
            }}
            autoFocus
            placeholder={fed ? 'https://voice.example.org/i/aB3xK9mz' : 'например, aB3xK9mz'}
            spellCheck={false}
          />
        </label>

        {checking && <div className="muted inv-checking">Проверяем ссылку…</div>}

        {check?.card && view?.server && (
          <div className="inv-card">
            <span className="inv-card-icon">{view.server.name[0]?.toUpperCase()}</span>
            <span className="inv-card-meta">
              <span className="inv-card-name">{view.server.name}</span>
              <span className="inv-card-sub">
                {view.server.members} {plural(view.server.members, 'участник', 'участника', 'участников')} ·{' '}
                {expiryText(view.server.expiresAt)}
              </span>
              {view.instance && (
                <span className="inv-card-inst">
                  <Icon name="globe" size={12} /> инстанс «{instanceLabel(view.instance, pastedDomain) ?? view.instance.domain}» ·{' '}
                  {view.instance.domain}
                </span>
              )}
            </span>
          </div>
        )}

        {check?.informer && view?.instance && (
          <div className="inv-informer">
            Это сервер на другом инстансе. Вы войдёте со своим ником и аватаркой, а переписку и голос этого сервера
            хранит инстанс «{instanceLabel(view.instance, pastedDomain) ?? view.instance.domain}».
          </div>
        )}

        {check?.problem && <div className="inv-problem">{check.problem}</div>}

        {check?.contacts && view && view.contacts.length > 0 && (
          <div className="inv-contacts">
            <div className="settings-group-label">Связаться</div>
            <ul>
              {view.contacts.map((c) => (
                <li key={`${c.kind}:${c.value}`}>
                  <span className="muted">{c.label}</span> {c.value}
                </li>
              ))}
            </ul>
          </div>
        )}

        {error && <div className="error">{error}</div>}
        <div className="modal-actions">
          <button type="button" className="link" onClick={onClose}>
            Отмена
          </button>
          {/* «Понятно» закрывает окно, «Повторить» спрашивает дом заново — обе кнопки не отправляют
              форму, потому что отправлять нечего: войти по этой ссылке сейчас нельзя. */}
          {check && (check.action === 'ok' || check.action === 'retry') ? (
            <button
              type="button"
              onClick={() => {
                if (check.action === 'ok') onClose();
                else {
                  setView(null);
                  const again = code;
                  setCode('');
                  setTimeout(() => setCode(again), 0);
                }
              }}
            >
              {inviteActionLabel(check.action)}
            </button>
          ) : (
            <button type="submit" disabled={busy || checking || !code.trim()}>
              {busy ? '…' : inviteActionLabel(check?.action ?? 'join')}
            </button>
          )}
        </div>
      </form>
    </div>
  );
}

/** Склонение по числу — «1 участник», «2 участника», «5 участников». */
function plural(n: number, one: string, few: string, many: string): string {
  const mod10 = n % 10;
  const mod100 = n % 100;
  if (mod10 === 1 && mod100 !== 11) return one;
  if (mod10 >= 2 && mod10 <= 4 && (mod100 < 12 || mod100 > 14)) return few;
  return many;
}

const INVITE_EXPIRY: { label: string; value: number | null }[] = [
  { label: '30 мин', value: 30 },
  { label: '1 час', value: 60 },
  { label: '1 день', value: 1440 },
  { label: '7 дней', value: 10080 },
  { label: 'Никогда', value: null },
];
const INVITE_USES: { label: string; value: number | null }[] = [
  { label: '1', value: 1 },
  { label: '5', value: 5 },
  { label: '10', value: 10 },
  { label: '25', value: 25 },
  { label: '∞', value: null },
];

/** Create + manage invites: pick expiry/max-uses, generate a code, and list/revoke active invites. */
export function InviteCodeModal({ serverId, onClose }: { serverId: string; onClose: () => void }) {
  const [list, setList] = useState<Invite[]>([]);
  const [expiry, setExpiry] = useState<number | null>(1440);
  const [maxUses, setMaxUses] = useState<number | null>(null);
  const [busy, setBusy] = useState(false);
  const [copied, setCopied] = useState<string | null>(null);
  const [scope, setScope] = useState<InviteScopeView | null>(null);

  useEffect(() => {
    let cancelled = false;
    api
      .listInvites(serverId)
      .then((r) => !cancelled && setList(r))
      .catch(() => {});
    // Где сработает ссылка — спрашиваем ОДИН раз при открытии: ни срок, ни число использований на
    // это не влияют, влияет только сам сервер и связки инстанса.
    api
      .inviteScope(serverId)
      .then((r) => !cancelled && setScope(r))
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [serverId]);

  async function create() {
    setBusy(true);
    try {
      const inv = await api.createInvite(serverId, { expiresInMinutes: expiry, maxUses });
      setList((l) => [inv, ...l.filter((i) => i.code !== inv.code)]);
      await copy(inv.code);
    } catch (e) {
      toastError(e);
    } finally {
      setBusy(false);
    }
  }

  async function revoke(code: string) {
    try {
      await api.deleteInvite(code);
      setList((l) => l.filter((i) => i.code !== code));
    } catch (e) {
      toastError(e);
    }
  }

  /** Полная ссылка `/i/<код>`: адрес в ней говорит клиенту друга, чей это инстанс (§4.2). */
  const linkFor = (code: string) => (scope?.clientOrigin ? inviteLinkFor(scope.clientOrigin, code) : code);

  async function copy(code: string) {
    try {
      // 🔴 Копируем ССЫЛКУ, а не голый код: код без адреса означает «свой инстанс», и человек с
      // другого инстанса по нему просто не найдёт, куда идти.
      await navigator.clipboard.writeText(linkFor(code));
      setCopied(code);
      toast('info', 'Ссылка-приглашение скопирована');
      setTimeout(() => setCopied((c) => (c === code ? null : c)), 1600);
    } catch {
      /* clipboard blocked — user can select manually */
    }
  }

  const fmtExpiry = (iso: string | null) =>
    iso ? `до ${new Date(iso).toLocaleString('ru-RU', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' })}` : 'бессрочно';

  const Seg = ({ value, onChange, opts }: { value: number | null; onChange: (v: number | null) => void; opts: { label: string; value: number | null }[] }) => (
    <div className="seg">
      {opts.map((o) => (
        <button key={o.label} type="button" className={value === o.value ? 'on' : ''} onClick={() => onChange(o.value)}>
          {o.label}
        </button>
      ))}
    </div>
  );

  return (
    <div className="modal-overlay" onClick={onClose}>
      <div className="modal create-channel" onClick={(e) => e.stopPropagation()}>
        <div className="admin-head">
          <h2>Пригласить на сервер</h2>
          <button type="button" className="icon-close" title="Закрыть" onClick={onClose}>
            <Icon name="close" size={18} />
          </button>
        </div>

        <label className="settings-row col">
          <span>Срок действия</span>
          <Seg value={expiry} onChange={setExpiry} opts={INVITE_EXPIRY} />
        </label>
        <label className="settings-row col">
          <span>Макс. использований</span>
          <Seg value={maxUses} onChange={setMaxUses} opts={INVITE_USES} />
        </label>
        {/* 🔴 Подсказка меняется вместе со сроком (требование 13): бессрочная ссылка не работает для
            чужих, и узнать об этом надо ДО отправки другу, а не от друга. */}
        {inviteScopeHint(scope, expiry) && <div className="inv-scope">{inviteScopeHint(scope, expiry)}</div>}
        <button type="button" onClick={() => void create()} disabled={busy} style={{ alignSelf: 'flex-start' }}>
          {busy ? '…' : 'Создать приглашение'}
        </button>

        {list.length > 0 && (
          <>
            <div className="settings-group-label">Активные приглашения</div>
            <ul className="invite-list">
              {list.map((i) => (
                <li key={i.code} className="invite-row">
                  <div className="invite-row-meta">
                    <span className="invite-row-code">{linkFor(i.code)}</span>
                    <span className="invite-row-sub">
                      {fmtExpiry(i.expiresAt)} · {i.uses}/{i.maxUses ?? '∞'}
                    </span>
                  </div>
                  <button type="button" className="invite-copy" title="Скопировать" onClick={() => void copy(i.code)}>
                    <Icon name={copied === i.code ? 'check' : 'copy'} size={16} />
                  </button>
                  <button type="button" className="invite-revoke" onClick={() => void revoke(i.code)}>
                    Отозвать
                  </button>
                </li>
              ))}
            </ul>
          </>
        )}

        <div className="modal-actions">
          <button type="button" onClick={onClose}>
            Готово
          </button>
        </div>
      </div>
    </div>
  );
}
