import { useEffect, useState } from 'react';
import type { FederationOverview, FederationLinkRow, FederationSwitchPatch, FederationSwitchView } from '@gusvoice/shared';
import type { Api } from '../api';
import { adminApi } from '../adminApi';
import { useStore } from '../store';
import { FederationReports } from './FederationReports';
import { FederationAudit } from './FederationAudit';
import { Toggle } from './Toggle';
import { count } from '../plural';
import { formatBytes, gigabytesToBytes } from '../byteSize';
import { toast, toastError } from '../toast';
import { alertDialog, confirmAction } from '../confirm';
import { FED_BACKUP_NOTE, neighborNameHint, overviewAfterError, SWITCH_REFUSAL_TEXT, switchSourceHint } from '../fedOverview';

/**
 * Вкладка «Федерация» в админ-панели (#139, F1, план §4.1.1).
 *
 * Показывает две вещи: кто МЫ такие в глазах соседей (личность, отпечаток ключа, название) и что с
 * каждой связкой. Всё остальное отсюда же и делается: создать код, вставить чужой, подтвердить
 * заявку, приостановить, разорвать.
 *
 * 🔴 Отпечаток ключа показывается целиком и с кнопкой копирования: это то, что держатели сверяют
 * между собой голосом, когда что-то пошло не так. Обрезанный «4F2A…» для сверки не годится.
 */

/** Человеческие названия состояний: «pending» ничего не говорит тому, кто просто держит инстанс. */
const STATE_TEXT: Record<string, { label: string; hint: string }> = {
  requested: { label: 'заявка отправлена', hint: 'ждём, пока держатель того инстанса подтвердит' },
  pending: { label: 'ждёт вашего решения', hint: 'к вам пришла заявка — подтвердите, если ждали её' },
  active: { label: 'работает', hint: 'связка установлена, события ходят в обе стороны' },
  paused: { label: 'на паузе', hint: 'вы приостановили обмен; события копятся и уедут после снятия' },
  blocked: { label: 'разорвана', hint: 'связь прекращена вами; чтобы вернуть — нужна новая связка' },
  /**
   * 🔴 Ключ мог смениться у ЛЮБОЙ из сторон — карточка этого не знает, и до 23.09 она у сменившего ключ
   * говорила «ключ соседа сменился» (прогон F-20 на стенде). Поэтому здесь обе дороги: кто что делает.
   */
  'trust-lost': {
    label: 'доверие потеряно',
    hint:
      'ключ сменился у одной из сторон. Сменили вы — нажмите «Создать код перепривязки» и передайте код держателю соседа. ' +
      'Сменил сосед — вставьте его код в поле ниже и нажмите «Перепривязать»',
  },
};

function stateOf(state: string) {
  return STATE_TEXT[state] ?? { label: state, hint: 'состояние от более новой версии' };
}

function copy(text: string, what: string) {
  navigator.clipboard
    .writeText(text)
    .then(() => toast('success', `${what} скопирован`))
    .catch(() => toastError('Не удалось скопировать — выделите и скопируйте вручную'));
}

/**
 * Отказы заведения связки, которым нужен человеческий текст: держатель по ним решает, ЧТО делать
 * дальше, а голый код («rebind-code») этого не говорит. Остальные коды показываются как есть.
 */
const LINK_PROBLEM_TEXT: Record<string, string> = {
  'rebind-code': 'Это код перепривязки. Вставьте его на карточке той связки, у которой сменился ключ, — не сюда.',
  'not-rebind-code': 'Это обычный код связки, а здесь нужен код перепривязки: сосед создаёт его на карточке связки с вами.',
  'host-mismatch': 'Новый ключ отвечает с другого адреса, чем прежний. Это не перепривязка: заведите новую связку обычным кодом.',
  'same-identity': 'У соседа по этому адресу прежний ключ — перепривязывать нечего.',
  'revoked-identity':
    'Ключ этого соседа числится отозванным: его держатель сообщал о краже. Сверьте отпечаток голосом и попросите код с новой личности.',
  'domain-taken': 'Домен из визитки соседа уже занят — вашим инстансом или другой связкой. Двум инстансам с одним доменом здесь не место.',
  'domain-unproven':
    'Домен из визитки соседа не подтверждён: его веб-клиент по этому адресу не отвечает на /config.json или называет другой API. Причина словами — в журнале федерации.',
};

export function FederationPanel() {
  const [data, setData] = useState<FederationOverview | null>(null);
  // Тумблеры (#224). `null` — сервер старше тумблера (404): включается только в `.env`, вкладка говорит по-старому.
  const [sw, setSw] = useState<FederationSwitchView | null>(null);
  const [loading, setLoading] = useState(true);
  const [code, setCode] = useState('');
  const [issued, setIssued] = useState<string | null>(null);
  const [name, setName] = useState('');
  const [busy, setBusy] = useState(false);
  /** Черновики предела по связкам: поле пустое — держатель ничего не менял, и кнопка неактивна. */
  const [quotaDraft, setQuotaDraft] = useState<Record<string, string>>({});
  /** Код перепривязки — свой у каждой карточки: он относится к ОДНОЙ связке, и общего поля у него нет. */
  const [rebindDraft, setRebindDraft] = useState<Record<string, string>>({});
  const [rebindOpen, setRebindOpen] = useState<Record<string, boolean>>({});
  /** Черновик темы ntfy: пока не сохранили, поле принадлежит человеку, а не ответу сервера. */
  const [topic, setTopic] = useState('');
  const [topicTouched, setTopicTouched] = useState(false);
  /**
   * Название с вкладки «Инстанс» — ради подсказки под названием для соседей (#204): это два разных поля. Не узнали
   * (старый бэкенд, сеть) — подсказки просто нет.
   */
  const [localName, setLocalName] = useState<string | null>(null);
  useEffect(() => {
    adminApi()
      .adminInstance()
      .then((r) => setLocalName(r.name))
      .catch(() => {});
  }, []);

  /**
   * `quiet` — перечитать НЕ показывая «Загружаем…».
   *
   * 🔴 Обновление по событию обязано быть тихим: заслонять уже нарисованную вкладку заглушкой
   * из-за того, что сосед нажал кнопку, — значит мигать экраном у человека, который в этот момент
   * читает отпечаток или копирует код.
   * ⚠️ И молчать об ошибке тоже: фоновое перечитывание, упавшее из-за моргнувшей сети, не повод
   * показывать красное поверх верных данных. Человек всё равно нажмёт кнопку, и там ошибка придёт.
   */
  async function load(quiet = false) {
    if (!quiet) setLoading(true);
    // Тумблеры читаются рядом с обзором и отвечают и при выключенной федерации (#224); ошибка — просто без тумблеров.
    const switchRead = Promise.resolve()
      .then(() => adminApi().federationSwitch())
      .then(setSw)
      .catch(() => setSw(null));
    try {
      const next = await adminApi().federationOverview();
      setData(next);
      setName((prev) => (quiet && prev !== (data?.instance?.name ?? '') ? prev : next.instance?.name ?? ''));
    } catch (e) {
      // 404 — маршрутов федерации на сервере нет: она выключена, и это не сбой (`fedOverview.ts`).
      const off = overviewAfterError((e as { status?: number }).status);
      if (off) setData(off);
      else if (!quiet) toastError(e instanceof Error ? e.message : 'Не удалось прочитать состояние федерации');
    } finally {
      await switchRead;
      if (!quiet) setLoading(false);
    }
  }

  /**
   * Переключить федерацию или ЛС между инстансами (#224) — без перезапуска сервера. Выключение федерации спрашивает: соседи
   * сразу перестают получать ответы, хотя связки, ключ и пароль остаются и повторное включение вернёт ту же личность.
   */
  async function flip(patch: FederationSwitchPatch) {
    if (patch.enabled === false) {
      const ok = await confirmAction({
        title: 'Выключить федерацию?',
        body:
          'Соседи перестанут получать ответы от вашего инстанса, гости с других инстансов не смогут войти, переписка с ' +
          'людьми соседей встанет. Связки, ключ и настройки сохранятся: включите снова — всё вернётся как было.',
        tone: 'danger',
        confirmLabel: 'Выключить',
      });
      if (!ok) return;
    }
    setBusy(true);
    try {
      setSw(await adminApi().federationSetSwitch(patch));
      await load(true);
    } catch (e) {
      const raw = e instanceof Error ? e.message : '';
      toastError(SWITCH_REFUSAL_TEXT[raw] ?? (raw || 'Не получилось переключить'));
    } finally {
      setBusy(false);
    }
  }

  useEffect(() => {
    void load();
  }, []);

  /**
   * Связки изменились у СЕРВЕРА — перечитать (#139, F1). Повод: сосед прислал заявку, подтвердил
   * нашу, поставил на паузу или разорвал.
   *
   * 🔴 Ради первого случая это и сделано: держатель, выдавший код, сидит на этой вкладке и ждёт,
   * когда появится «Подтвердить». Раньше он этого не дожидался — заявка приходила на сервер, а
   * экран оставался прежним, пока человек не нажмёт F5.
   *
   * Первый проход пропускаем: `load()` выше уже сходил, и без пропуска открытие вкладки стоило бы
   * двух запросов подряд.
   */
  const federationRev = useStore((s) => s.federationRev);
  useEffect(() => {
    if (federationRev === 0) return;
    void load(true);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [federationRev]);

  async function act(what: () => Promise<unknown>, done: string) {
    setBusy(true);
    try {
      await what();
      toast('success', done);
      await load();
    } catch (e) {
      const raw = e instanceof Error ? e.message : '';
      toastError(LINK_PROBLEM_TEXT[raw] ?? (raw || 'Не получилось'));
    } finally {
      setBusy(false);
    }
  }

  /**
   * Сменить ключ инстанса. Необратимо: новая личность, все связки — «доверие потеряно», гости соседей
   * заморожены. Набрать фразу — пауза, как у удаления сервера: одно лишнее движение стоит всех связок.
   */
  async function revokeKey() {
    const ok = await confirmAction({
      title: 'Сменить ключ инстанса?',
      body:
        'Только если ключ украден или утёк. У инстанса будет новая личность и новый отпечаток. Все связки перейдут в ' +
        '«доверие потеряно», соседям уйдёт отзыв старого ключа, гости с их инстансов будут заморожены и выйдут. ' +
        'Вернуть связку: на её карточке «Создать код перепривязки» → передать код держателю соседа → он вставит его у ' +
        'себя. Отменить смену нельзя.',
      tone: 'danger',
      confirmLabel: 'Сменить ключ',
      requireText: 'сменить ключ',
      requireTextWhat: 'фразу «сменить ключ»',
    });
    if (!ok) return;
    await act(async () => {
      const res = await adminApi().federationRevokeKey();
      await alertDialog(
        'Ключ сменён',
        `Новый отпечаток: ${res.newFingerprint}. Отзыв получили соседей: ${res.notified}` +
          (res.unreachable > 0 ? `, не ответили: ${res.unreachable} — им сообщите сами` : '') +
          '. Теперь на карточке каждой связки создайте код перепривязки и передайте держателю соседа.',
      );
    }, 'Ключ инстанса сменён');
  }

  if (loading) return <div className="admin-body">Загружаем…</div>;

  // Тумблеры (#224) — вверху вкладки в любом состоянии: и выключенной, и с ошибкой ключа, и рабочей.
  const fedHint = sw ? switchSourceHint(sw.source) : null;
  const dmHint = sw ? switchSourceHint(sw.dmSource) : null;
  const switchBlock = sw && (
    <section className="fed-switch">
      <label className="fed-row">
        <span>Федерация</span>
        <Toggle
          checked={sw.enabled}
          disabled={busy || sw.source === 'env'}
          onChange={(v) => void flip({ enabled: v })}
          title="Связь с другими инстансами GusVoice"
        />
      </label>
      {fedHint && <p className="muted">{fedHint}</p>}
      <label className="fed-row">
        <span>Личные сообщения с другими инстансами</span>
        <Toggle
          checked={sw.dmEnabled}
          disabled={busy || !sw.enabled || sw.dmSource === 'env'}
          onChange={(v) => void flip({ dmEnabled: v })}
          title={sw.enabled ? 'Переписка с людьми на связанных инстансах' : 'Сначала включите федерацию'}
        />
      </label>
      {dmHint && <p className="muted">{dmHint}</p>}
      {!sw.enabled && <p className="muted">Переписка с людьми других инстансов включается после федерации.</p>}
      <p className="muted">{FED_BACKUP_NOTE}</p>
    </section>
  );
  if (!data) return <div className="admin-body">Состояние федерации недоступно.</div>;

  // Федерация выключена целиком — объясняем, что это не поломка, и как включить.
  if (data.status === 'off' && sw) {
    return (
      <div className="admin-body fed-panel">
        <h3>Федерация выключена</h3>
        <p className="muted">
          Федерация связывает ваш инстанс с другими инстансами GusVoice: люди ходят в гости на серверы соседей и
          переписываются. Пока она выключена, ваш инстанс не отдаёт наружу ничего и не принимает запросы соседей.
        </p>
        {switchBlock}
      </div>
    );
  }
  if (data.status === 'off') {
    return (
      <div className="admin-body fed-panel">
        <h3>Федерация выключена</h3>
        <p className="muted">
          Связка с другими инстансами GusVoice не включена на этом сервере. Пока она выключена, ваш инстанс не
          отдаёт наружу ничего и не принимает запросы соседей.
        </p>
        <p className="muted">
          Включается в файле <code>.env</code>: <code>FEDERATION_ENABLED=true</code>, затем перезапуск коробки. Нужен
          ещё пароль к ключу инстанса <code>FEDERATION_KEY_PASSPHRASE</code>: установщик новых коробок ставит его сам,
          а у коробки, обновлённой со старой версии, его может не быть — тогда впишите длинную случайную строку
          (например, из <code>openssl rand -hex 32</code>) и храните её вместе с каталогом <code>fed-keys</code>:
          пароль и ключ — пара.
        </p>
      </div>
    );
  }

  if (data.status === 'key-error') {
    return (
      <div className="admin-body fed-panel">
        <h3>Ключ инстанса не открылся</h3>
        <p className="error">{data.problem}</p>
        {sw?.source === 'panel' ? (
          <p className="muted">
            Остальной GusVoice работает как обычно — не поднялась только федерация. Ключ лежит в папке <code>fed-keys</code>,
            пароль к нему — в базе: они пара, одно без другого бесполезно.
          </p>
        ) : (
          <p className="muted">
            Остальной GusVoice работает как обычно — не поднялась только федерация. Ключ лежит в каталоге{' '}
            <code>fed-keys</code> рядом с <code>.env</code>, и открывается паролем оттуда же: файл и пароль — пара,
            одно без другого бесполезно.
          </p>
        )}
        {switchBlock}
      </div>
    );
  }

  const links = data.links ?? [];
  const alerts = data.alerts ?? [];
  // По СОХРАНЁННОМУ имени, а не по черновику в поле: подсказка про то, что соседи видят сейчас.
  const nameHint = neighborNameHint(localName, data.instance?.name);
  const alertCfg = data.alertSettings ?? { ntfyTopic: '', email: true, linkDownAfterMinutes: 30 };
  return (
    <div className="admin-body fed-panel">
      {/* 🔴 Баннер ПЕРВЫМ на вкладке, до всего остального: федерация ломается тихо, и держатель
          заходит сюда именно тогда, когда что-то не работает. Поводы, прокрученные вниз, он бы
          увидел последними — после того, как перебрал бы связки руками. */}
      {alerts.length > 0 && (
        <section className="fed-alerts">
          {alerts.map((a) => (
            <div key={`${a.kind}:${a.instanceId ?? ''}`} className="error fed-alert">
              <b>{a.title}</b>
              <div>{a.body}</div>
            </div>
          ))}
        </section>
      )}
      {switchBlock}
      <section className="fed-self">
        <h3>Этот инстанс</h3>
        <label className="fed-row">
          <span>Название</span>
          <input value={name} onChange={(e) => setName(e.target.value)} maxLength={40} placeholder="Например, Гусиный дом" />
          <button
            type="button"
            disabled={busy || name === (data.instance?.name ?? '')}
            onClick={() => act(() => adminApi().federationSetName(name.trim()), 'Название сохранено')}
          >
            Сохранить
          </button>
        </label>
        <p className="muted">Пусто — соседи увидят домен. Название видят люди на других инстансах.</p>
        {nameHint && <p className="muted">{nameHint}</p>}

        <div className="fed-row">
          <span>Отпечаток ключа</span>
          <code className="fed-fingerprint">{data.instance?.fingerprint}</code>
          <button type="button" onClick={() => copy(data.instance?.fingerprint ?? '', 'Отпечаток')}>
            Копировать
          </button>
        </div>
        <p className="muted">
          Это «печать» вашего инстанса. По ней соседи узнают именно вас, а не того, кто занял ваш домен.
        </p>

        <div className="fed-row">
          <span>Аварийная пауза</span>
          <button
            type="button"
            className={data.paused ? 'danger-text' : ''}
            disabled={busy}
            onClick={() =>
              act(() => adminApi().federationPause(!data.paused), data.paused ? 'Федерация возобновлена' : 'Федерация приостановлена')
            }
          >
            {data.paused ? 'Возобновить федерацию' : 'Приостановить всю федерацию'}
          </button>
        </div>
        {data.paused && (
          <p className="error">
            Вся федерация на паузе: соседи получают понятный отказ, исходящие события копятся и уедут после снятия.
          </p>
        )}

        {/* «Ключ скомпрометирован» (§5.1.3). До 23.09 маршрут был, а кнопки не было (прогон F-20 на
            стенде): держатель с украденным ключом не мог сменить его сам. */}
        <div className="fed-row">
          <span>Ключ украден или утёк</span>
          <button type="button" className="danger-text" disabled={busy} onClick={() => void revokeKey()}>
            Ключ скомпрометирован
          </button>
        </div>
      </section>

      {/* Оповещения: где узнавать о поломках, не заходя сюда. Письмо идёт на адрес держателя
          (`ADMIN_EMAIL` или почта супер-админа), пуш — в тему ntfy, если она заведена. */}
      <section className="fed-alert-settings">
        <h3>Оповещения</h3>
        <p className="muted">
          Связка легла, ключ подписи истекает, сосед требует другую версию, всплеск отказов подписи, потеря доверия,
          жалоба на вашего человека — обо всём этом инстанс скажет сам.
        </p>
        <label className="fed-row">
          <span>Письма держателю</span>
          <Toggle
            checked={alertCfg.email}
            onChange={() => act(() => adminApi().federationSetAlerts({ email: !alertCfg.email }), 'Сохранено')}
            title="Письма об оповещениях"
          />
        </label>
        <label className="fed-row">
          <span>Тема ntfy</span>
          <input
            value={topicTouched ? topic : alertCfg.ntfyTopic}
            onChange={(e) => {
              setTopicTouched(true);
              setTopic(e.target.value);
            }}
            maxLength={200}
            placeholder="например, gusvoice-alerts"
          />
          <button
            type="button"
            disabled={busy || !topicTouched || topic === alertCfg.ntfyTopic}
            onClick={() =>
              act(async () => {
                await adminApi().federationSetAlerts({ ntfyTopic: topic.trim() });
                setTopicTouched(false);
              }, 'Тема сохранена')
            }
          >
            Сохранить
          </button>
        </label>
        <p className="muted">Пусто — пушей нет. Тему надо подписать в приложении ntfy на телефоне.</p>
        {/* Подпись КОРОТКАЯ: на телефоне (411 px) «Считать связку упавшей через … минут молчания» не
            помещалось в строку, и хвост уезжал под поле отдельной строкой — фраза читалась рваной. */}
        <label className="fed-row">
          <span>Считать упавшей через</span>
          <input
            type="number"
            min={1}
            max={1440}
            defaultValue={alertCfg.linkDownAfterMinutes}
            onBlur={(e) => {
              const v = Number(e.target.value);
              if (!Number.isFinite(v) || v === alertCfg.linkDownAfterMinutes) return;
              void act(() => adminApi().federationSetAlerts({ linkDownAfterMinutes: v }), 'Порог сохранён');
            }}
          />
          <span className="muted">мин. молчания</span>
        </label>
      </section>

      <section className="fed-links">
        <h3>Связки ({links.length})</h3>

        <div className="fed-row">
          <button
            type="button"
            disabled={busy}
            onClick={() =>
              act(async () => {
                const res = await adminApi().federationIssueCode();
                setIssued(res.code);
              }, 'Код создан')
            }
          >
            Создать код связки
          </button>
          <input
            value={code}
            onChange={(e) => setCode(e.target.value)}
            placeholder="Вставьте код, который вам передали"
            className="fed-code-input"
          />
          <button
            type="button"
            disabled={busy || code.trim().length === 0}
            onClick={() =>
              act(async () => {
                await adminApi().federationLink(code.trim());
                setCode('');
              }, 'Заявка отправлена — ждём подтверждения на той стороне')
            }
          >
            Связаться
          </button>
        </div>

        {issued && (
          <div className="fed-issued">
            <p>
              Передайте этот код держателю другого инстанса <b>вне приложения</b> — в мессенджере, голосом или лично.
              Код действует сутки и сработает один раз.
            </p>
            <code className="fed-code">{issued}</code>
            <button type="button" onClick={() => copy(issued, 'Код')}>
              Копировать код
            </button>
          </div>
        )}

        {links.length === 0 && <p className="muted">Связок пока нет.</p>}

        {links.map((link: FederationLinkRow) => {
          const st = stateOf(link.state);
          /**
           * Название у соседа может быть не задано — тогда его имя И ЕСТЬ домен, и вторая строка
           * с тем же доменом («voice.example.org · voice.example.org») выглядит поломкой. Пустую
           * строку считаем отсутствующим именем наравне с `null`: держатель мог стереть поле.
           */
          const title = link.name?.trim() || null;
          return (
            <article key={link.instanceId} className="fed-link">
              <header>
                <b>{title ?? link.domain}</b>
                {title && <span className="muted"> · {link.domain}</span>}
                <span className={`fed-state fed-state-${link.state}`}>{st.label}</span>
              </header>
              <p className="muted">{st.hint}</p>
              <p className="fed-metrics muted">
                {link.queued > 0 ? `в очереди: ${link.queued}` : 'очередь пуста'}
                {' · '}
                {link.lastSeenAt
                  ? `последний ответ: ${new Date(link.lastSeenAt).toLocaleString('ru-RU')}`
                  : 'ещё не отвечал'}
                {/* Расхождение часов показываем ТОЛЬКО когда оно есть: иначе «0 с» висит у всех и
                    перестаёт замечаться, а именно оно объясняет необъяснимые отказы подписи. */}
                {link.clockSkewMs !== null && Math.abs(link.clockSkewMs) > 1000
                  ? ` · часы расходятся на ${Math.round(link.clockSkewMs / 1000)} с`
                  : ''}
              </p>
              {/* Блок «Синхронизация» (§4.1.1): по нему держатель понимает, свежие ли списки людей и
                  серверов соседа — и почему несвежие, если что-то не так. */}
              {link.sync && link.sync.length > 0 && (
                <div className="fed-sync">
                  {link.sync.map((row) => (
                    <p key={row.kind} className="muted">
                      <b>{row.kind === 'directory' ? 'Каталог людей' : 'Серверы'}:</b> в кеше {row.entries}
                      {row.lastFullAt
                        ? ` · полная сверка ${new Date(row.lastFullAt).toLocaleString('ru-RU')}`
                        : ' · полной сверки ещё не было'}
                      {row.lastDeltaAt ? ` · обновлено ${new Date(row.lastDeltaAt).toLocaleString('ru-RU')}` : ''}
                      {/* Заказанная сверка — не ошибка: так система говорит «я знаю, что могла
                          пропустить изменение, и проверю целиком». */}
                      {row.needsFull ? ' · заказана внеочередная сверка' : ''}
                      {row.failures > 0 ? (
                        <span className="error">
                          {' '}
                          · не удаётся {count(row.failures, 'раз', 'раза', 'раз')} подряд
                          {row.problem ? `: ${row.problem}` : ''}
                        </span>
                      ) : null}
                    </p>
                  ))}
                </div>
              )}
              {/* Файлы гостей лежат в НАШЕМ хранилище (§5.10, требование 30). Держатель видит, кто
                  сколько занял, и меняет предел здесь же: до 18.09 счётчик считался, отказ по
                  пределу работал, а увидеть и поднять предел было негде — только через базу. */}
              {link.quota && (
                <p className="fed-metrics muted">
                  <b>Файлы гостей:</b> занято {formatBytes(link.quota.used)}
                  {link.quota.limit > 0 ? ` из ${formatBytes(link.quota.limit)}` : ' · предел не стоит'}
                  {' · '}
                  <input
                    className="fed-quota-input"
                    value={quotaDraft[link.instanceId] ?? ''}
                    onChange={(e) => setQuotaDraft((d) => ({ ...d, [link.instanceId]: e.target.value }))}
                    placeholder={link.quota.limit > 0 ? String(Math.round((link.quota.limit / 1024 ** 3) * 10) / 10) : '0'}
                    title="Предел в гигабайтах; 0 — без предела"
                    inputMode="decimal"
                    size={4}
                  />{' '}
                  ГБ{' '}
                  <button
                    type="button"
                    disabled={busy || gigabytesToBytes(quotaDraft[link.instanceId] ?? '') === null}
                    onClick={() =>
                      act(
                        () => adminApi().federationSetQuota(link.instanceId, { bytes: gigabytesToBytes(quotaDraft[link.instanceId] ?? '') ?? 0 }),
                        'Предел изменён',
                      )
                    }
                  >
                    Сохранить предел
                  </button>{' '}
                  {/* Учёт односторонний (`guestQuota.ts`): удаление сообщения места не возвращает,
                      поэтому «обнулить» — не костыль, а штатный шаг после разбора хранилища. */}
                  <button
                    type="button"
                    disabled={busy || link.quota.used === 0}
                    title="Счётчик занятого растёт при загрузке и не уменьшается при удалении"
                    onClick={() => act(() => adminApi().federationSetQuota(link.instanceId, { reset: true }), 'Счётчик обнулён')}
                  >
                    Обнулить счётчик
                  </button>
                </p>
              )}
              <div className="fed-link-actions">
                {link.state === 'pending' && (
                  <button
                    type="button"
                    disabled={busy}
                    onClick={() => act(() => adminApi().federationConfirm(link.instanceId), 'Связка подтверждена')}
                  >
                    Подтвердить
                  </button>
                )}
                {link.state === 'active' && (
                  <button type="button" disabled={busy} onClick={() => act(() => adminApi().federationLinkAction(link.instanceId, 'pause'), 'Связка на паузе')}>
                    Приостановить
                  </button>
                )}
                {link.state === 'paused' && (
                  <button type="button" disabled={busy} onClick={() => act(() => adminApi().federationLinkAction(link.instanceId, 'resume'), 'Связка возобновлена')}>
                    Возобновить
                  </button>
                )}
                {link.state === 'trust-lost' && (
                  <button
                    type="button"
                    disabled={busy}
                    onClick={() =>
                      act(async () => {
                        const res = await adminApi().federationRebindCode(link.instanceId);
                        setIssued(res.code);
                      }, 'Код перепривязки создан')
                    }
                  >
                    Создать код перепривязки
                  </button>
                )}
                {link.state === 'active' && (
                  <button
                    type="button"
                    disabled={busy}
                    title="Полная сверка каталога и списка серверов прямо сейчас"
                    onClick={() =>
                      act(async () => {
                        let res: Awaited<ReturnType<Api['federationSyncNow']>>;
                        try {
                          res = await adminApi().federationSyncNow(link.instanceId);
                        } catch (err) {
                          // Отказы кнопки — не поломка, а «подождите» или «не с этой связкой» (#196 п. 9, #197 п. 7).
                          const text = String((err as Error).message ?? err);
                          const known: Record<string, string> = {
                            'sync-busy': 'Прежняя сверка ещё идёт — подождите минуту и нажмите снова',
                            'sync-not-active': 'Сверка бывает только у рабочей связки: снимите паузу или перепривяжите её',
                            'sync-paused': 'Федерация на аварийной паузе — снимите её, и сверка пойдёт',
                            'sync-timeout': 'Сверка не уложилась в 45 секунд и доделывается в фоне — загляните позже',
                          };
                          const hit = Object.keys(known).find((k) => text.includes(k));
                          if (hit) throw new Error(known[hit] ?? text);
                          throw err;
                        }
                        // Отказ показываем словами соседа, а не «не получилось»: «ответ 503» и
                        // «ответ не разобрался» лечатся совершенно по-разному.
                        if (!res.directory.ok || !res.servers.ok) {
                          throw new Error(res.directory.problem ?? res.servers.problem ?? 'сверка не удалась');
                        }
                      }, 'Сверка прошла')
                    }
                  >
                    Синхронизировать сейчас
                  </button>
                )}
                {link.state !== 'blocked' && (
                  <button
                    type="button"
                    className="danger-text"
                    disabled={busy}
                    onClick={() => act(() => adminApi().federationLinkAction(link.instanceId, 'block'), 'Связка разорвана')}
                  >
                    Разорвать
                  </button>
                )}
                {(link.state === 'active' || link.state === 'paused') && !rebindOpen[link.instanceId] && (
                  <button
                    type="button"
                    className="link"
                    disabled={busy}
                    onClick={() => setRebindOpen((m) => ({ ...m, [link.instanceId]: true }))}
                  >
                    Сосед сменил ключ?
                  </button>
                )}
              </div>
              {/* 🔴 Код перепривязки вставляется ЗДЕСЬ, на карточке связки, а не в общее поле «Связаться»:
                  какую связку переносить, решает этот клик, а не то, что написано внутри кода (аудит
                  19.09, F-01). Общее поле такие коды не принимает вовсе. */}
              {(link.state === 'trust-lost' || rebindOpen[link.instanceId]) && (
                <div className="fed-row">
                  <input
                    value={rebindDraft[link.instanceId] ?? ''}
                    onChange={(e) => setRebindDraft((m) => ({ ...m, [link.instanceId]: e.target.value }))}
                    placeholder="Код перепривязки от держателя этого инстанса"
                    className="fed-code-input"
                  />
                  <button
                    type="button"
                    disabled={busy || (rebindDraft[link.instanceId] ?? '').trim().length === 0}
                    title="Связка, её гости и их история переедут на новый ключ соседа. Сверьте код с держателем голосом или лично."
                    onClick={() =>
                      act(async () => {
                        await adminApi().federationRebind(link.instanceId, (rebindDraft[link.instanceId] ?? '').trim());
                        setRebindDraft((m) => ({ ...m, [link.instanceId]: '' }));
                        setRebindOpen((m) => ({ ...m, [link.instanceId]: false }));
                      }, 'Связка перепривязана к новому ключу')
                    }
                  >
                    Перепривязать
                  </button>
                </div>
              )}
            </article>
          );
        })}
      </section>
      {/* Жалобы и запреты — отдельным блоком под связками: они про ЛЮДЕЙ, а связки про инстансы,
          и мешать одно с другим значило бы прятать письмо держателю среди технических строк. */}
      <FederationReports />
      {/* Журнал — последним: он про то, что уже случилось, а не про то, что надо решить. */}
      <FederationAudit />
    </div>
  );
}
