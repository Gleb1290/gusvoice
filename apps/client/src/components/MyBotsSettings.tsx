import { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import {
  BOT_ABOUT_MAX,
  BOT_DESCRIPTION_MAX,
  botUsernameError,
  botsEnabled,
  type BotInfo,
  type BotTokenResponse,
  type MyBotsResponse,
  type UpdateBotBody,
} from '@gusvoice/shared';
import { pushBackHandler } from '../androidBack';
import { api } from '../api';
import {
  BOT_DOCS_URL,
  BOT_TAG_TEXT,
  BOT_TAG_TITLE,
  botAccessLabel,
  botCreateBlock,
  botDeliveryRows,
  botStateLine,
  botsUnsupported,
} from '../botRules';
import { confirmAction } from '../confirm';
import { useDialogChrome } from '../dialogChrome';
import { useStore } from '../store';
import { toast, toastError } from '../toast';
import { Avatar } from './Avatar';
import { Icon } from './Icon';
import { Toggle } from './Toggle';

/**
 * Раздел настроек «Мои боты» (#229, этап 1 `docs/bots-plan.md`) — по Telegram @BotFather, только кнопками, а не командами:
 * список своих ботов, «Создать бота» (имя, ник `…bot`, описание), карточка бота (аватар, имя, описание, «о боте», «Доступен
 * всем», перевыпуск токена, удаление) и окно с токеном — ОДИН раз после создания и перевыпуска (на сервере только хеш).
 * Старый сервер без ботов отвечает 404 — раздел так и говорит, а не падает.
 *
 * Слово — «токен» (решение владельца 26.10, как у Telegram @BotFather): его же спросит программа бота; рядом всегда
 * пояснение бытовыми словами — «это пароль бота».
 */

type View = { kind: 'list' } | { kind: 'create' } | { kind: 'bot'; id: string };

export function MyBotsSettings({ onClose }: { onClose: () => void }) {
  const [data, setData] = useState<MyBotsResponse | null>(null);
  const [unsupported, setUnsupported] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [view, setView] = useState<View>({ kind: 'list' });
  const [fresh, setFresh] = useState<BotTokenResponse | null>(null);

  const load = () =>
    api
      .myBots()
      .then((r) => {
        setData(r);
        setLoadError(null);
      })
      .catch((e: unknown) => {
        if (botsUnsupported(e)) setUnsupported(true);
        else setLoadError(e instanceof Error ? e.message : String(e));
      });
  useEffect(() => {
    void load();
  }, []);
  // Системная «назад» (Android): из карточки бота и формы создания — к списку, а не закрытие настроек.
  const inner = view.kind !== 'list';
  useEffect(() => {
    if (!inner) return;
    return pushBackHandler(() => {
      setView({ kind: 'list' });
      return true;
    });
  }, [inner]);

  const putBot = (b: BotInfo) => setData((d) => (d ? { ...d, bots: d.bots.some((x) => x.id === b.id) ? d.bots.map((x) => (x.id === b.id ? b : x)) : [...d.bots, b] } : d));
  const openChat = (botId: string) => {
    onClose();
    void useStore.getState().openDmWith(botId).catch(toastError);
  };

  const tokenDialog = fresh && (
    <BotTokenDialog
      fresh={fresh}
      onClose={() => setFresh(null)}
      onOpenChat={() => {
        const id = fresh.bot.id;
        setFresh(null);
        openChat(id);
      }}
    />
  );

  if (unsupported) {
    return (
      <div className="settings-pane">
        <div className="settings-group-label" id="set-g-bots">
          Мои боты
        </div>
        <div className="muted dmf-about">Этот сервер пока не поддерживает ботов — их добавят с обновлением сервера.</div>
      </div>
    );
  }

  const current = view.kind === 'bot' ? data?.bots.find((b) => b.id === view.id) : undefined;
  if (view.kind === 'bot' && current) {
    return (
      <>
        <BotEditor
          bot={current}
          instanceOn={botsEnabled(data)}
          onBack={() => setView({ kind: 'list' })}
          onChanged={putBot}
          onToken={setFresh}
          onOpenChat={() => openChat(current.id)}
          onDeleted={() => {
            setData((d) => (d ? { ...d, bots: d.bots.filter((x) => x.id !== current.id) } : d));
            setView({ kind: 'list' });
          }}
        />
        {tokenDialog}
      </>
    );
  }
  if (view.kind === 'create') {
    return (
      <BotCreateForm
        onBack={() => setView({ kind: 'list' })}
        onCreated={(r) => {
          putBot(r.bot);
          setFresh(r);
          setView({ kind: 'bot', id: r.bot.id });
        }}
      />
    );
  }

  const block = data ? botCreateBlock(data) : null;
  return (
    <div className="settings-pane">
      <div className="settings-group-label" id="set-g-bots">
        Мои боты
      </div>
      <div className="muted dmf-about">
        Бот — помощник, которым управляет ваша программа: присылает уведомления, отвечает на команды. Пишут ему в личные
        сообщения, как человеку.
      </div>
      {loadError && (
        <div className="error" role="alert">
          {loadError}
        </div>
      )}
      {!data && !loadError && <div className="muted dmf-about">Загрузка…</div>}
      {data?.bots.map((b) => {
        const st = botStateLine(b, botsEnabled(data));
        return (
          <button key={b.id} type="button" className="dmf-row bot-row" onClick={() => setView({ kind: 'bot', id: b.id })}>
            <Avatar url={b.avatarUrl} name={b.displayName || b.username} size={40} />
            <span className="dmf-main">
              <span className="dmf-title">{b.displayName || b.username}</span>
              <span className="dmf-sub">
                @{b.username} · {botAccessLabel(b.public)}
              </span>
              {st && <span className={`dmf-sub bot-state ${st.tone}`}>{st.text}</span>}
            </span>
            <Icon name="chevron-right" size={18} />
          </button>
        );
      })}
      {data && data.bots.length === 0 && <div className="muted dmf-about">Ботов пока нет.</div>}
      {data &&
        (block ? (
          <div className="muted dmf-about bot-block" role="note">
            {block}
          </div>
        ) : (
          <div className="sec-actions">
            <button type="button" className="primary" onClick={() => setView({ kind: 'create' })}>
              <Icon name="plus" size={16} /> Создать бота
            </button>
          </div>
        ))}
      <BotDocsLinks />
      {tokenDialog}
    </div>
  );
}

/**
 * Ссылки под списком и в карточке: инструкция для людей (`BOT_DOCS_URL`) и «Справка для нейронки» — `llms.txt` СВОЕГО
 * инстанса (та версия Bot API, что на нём стоит; `api.botLlmsUrl`). Подмена `api` без неё (тесты) — второй ссылки нет.
 */
function BotDocsLinks() {
  const llms = typeof api.botLlmsUrl === 'function' ? api.botLlmsUrl() : null;
  if (!BOT_DOCS_URL && !llms) return null;
  return (
    <div className="bot-docs">
      {BOT_DOCS_URL && (
        <a className="link" href={BOT_DOCS_URL} target="_blank" rel="noreferrer">
          Как написать своего бота
        </a>
      )}
      {llms && (
        <a className="link" href={llms} target="_blank" rel="noreferrer" title="Вставьте этот файл в чат с нейросетью — она напишет бота по нему">
          Справка для нейронки
        </a>
      )}
    </div>
  );
}

function BackRow({ label, onBack }: { label: string; onBack: () => void }) {
  return (
    <div className="dmf-head">
      <button type="button" className="head-icon" title="Назад" aria-label="Назад" onClick={onBack}>
        <Icon name="chevron-left" size={18} />
      </button>
      <span>{label}</span>
    </div>
  );
}

function BotCreateForm({ onBack, onCreated }: { onBack: () => void; onCreated: (r: BotTokenResponse) => void }) {
  const [name, setName] = useState('');
  const [username, setUsername] = useState('');
  const [description, setDescription] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // Ошибку ника показываем сразу при вводе, но не на пустом поле — «3–32 символа» до первой буквы только пугает.
  const nickError = username ? botUsernameError(username) : null;

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    if (!username || nickError) return;
    setBusy(true);
    setError(null);
    try {
      onCreated(
        await api.createBot({
          username,
          ...(name.trim() ? { displayName: name.trim() } : {}),
          ...(description.trim() ? { description: description.trim() } : {}),
        }),
      );
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      setBusy(false);
    }
  }

  return (
    <form className="settings-pane" onSubmit={submit}>
      <BackRow label="Новый бот" onBack={onBack} />
      <label className="field">
        Имя
        <input value={name} maxLength={32} placeholder="Например, Сторож сервера" onChange={(e) => setName(e.target.value)} autoFocus />
      </label>
      <label className="field">
        Ник
        <input
          value={username}
          maxLength={32}
          placeholder="watch_bot"
          autoCapitalize="none"
          autoCorrect="off"
          spellCheck={false}
          aria-invalid={!!nickError || undefined}
          onChange={(e) => setUsername(e.target.value.trim())}
        />
        {nickError ? (
          <span className="error">{nickError}</span>
        ) : (
          <span className="muted bot-hint">Латиница, цифры и _, в конце — bot. По нику бота находят в поиске.</span>
        )}
      </label>
      <label className="field">
        Описание
        <textarea
          value={description}
          maxLength={BOT_DESCRIPTION_MAX}
          rows={3}
          placeholder="Что умеет бот — это увидят в пустой беседе с ним"
          onChange={(e) => setDescription(e.target.value)}
        />
      </label>
      {error && (
        <div className="error" role="alert">
          {error}
        </div>
      )}
      <div className="sec-actions">
        <button type="button" onClick={onBack} disabled={busy}>
          Отмена
        </button>
        <button type="submit" className="primary" disabled={busy || !username || !!nickError}>
          {busy ? 'Создаём…' : 'Создать бота'}
        </button>
      </div>
    </form>
  );
}

function BotEditor({
  bot,
  onBack,
  onChanged,
  onToken,
  onOpenChat,
  onDeleted,
  instanceOn,
}: {
  bot: BotInfo;
  /** Боты включены на сервере (`MyBotsResponse.enabled`; нет поля — включены). */
  instanceOn: boolean;
  onBack: () => void;
  onChanged: (b: BotInfo) => void;
  onToken: (r: BotTokenResponse) => void;
  onOpenChat: () => void;
  onDeleted: () => void;
}) {
  const [name, setName] = useState(bot.displayName ?? '');
  const [description, setDescription] = useState(bot.description);
  const [about, setAbout] = useState(bot.about);
  const [busy, setBusy] = useState(false);
  const fileRef = useRef<HTMLInputElement>(null);
  const label = bot.displayName || bot.username;
  const st = botStateLine(bot, instanceOn);

  const run = async (fn: () => Promise<void>) => {
    setBusy(true);
    try {
      await fn();
    } catch (e) {
      toastError(e);
    } finally {
      setBusy(false);
    }
  };
  /** Ответ `PATCH` — бот целиком; сервер ответил иначе (204) — накладываем правку сами. */
  const patch = (body: UpdateBotBody) =>
    run(async () => {
      const r = await api.updateBot(bot.id, body);
      onChanged(r && typeof r === 'object' && 'id' in r ? r : { ...bot, ...body, displayName: body.displayName !== undefined ? body.displayName : bot.displayName });
    });

  const dirty = (name.trim() || null) !== bot.displayName || description !== bot.description || about !== bot.about;
  const save = () =>
    patch({
      ...((name.trim() || null) !== bot.displayName ? { displayName: name.trim() || null } : {}),
      ...(description !== bot.description ? { description } : {}),
      ...(about !== bot.about ? { about } : {}),
    }).then(() => toast('success', 'Бот сохранён'));

  const regenerate = async () => {
    const ok = await confirmAction({
      title: `Новый токен для «${label}»?`,
      body: 'Старый токен перестанет работать сразу — программе бота нужно будет вписать новый.',
      tone: 'danger',
      icon: 'lock',
      confirmLabel: 'Перевыпустить',
    });
    if (ok) await run(async () => onToken(await api.regenerateBotToken(bot.id)));
  };
  const remove = async () => {
    const ok = await confirmAction({
      title: `Удалить бота «${label}»?`,
      body: 'Бот перестанет работать, его токен погаснет. Сообщения, которые он уже написал, останутся в беседах.',
      tone: 'danger',
      confirmLabel: 'Удалить бота',
    });
    if (ok)
      await run(async () => {
        await api.deleteBot(bot.id);
        onDeleted();
      });
  };
  /** «Серверы» (#231): владелец снимает бота с сервера — `DELETE /bots/:id/servers/:serverId`. */
  const leaveServer = async (srv: { id: string; name: string }) => {
    const ok = await confirmAction({
      title: `Убрать «${label}» с сервера «${srv.name}»?`,
      body: 'Бот перестанет видеть каналы этого сервера, его роль там удалится. Вернуть его сможет админ сервера.',
      tone: 'danger',
      confirmLabel: 'Убрать',
    });
    if (ok)
      await run(async () => {
        await api.removeMyBotFromServer(bot.id, srv.id);
        onChanged({ ...bot, servers: (bot.servers ?? []).filter((x) => x.id !== srv.id) });
      });
  };
  const upload = (file: File) =>
    run(async () => {
      if (!['image/png', 'image/jpeg', 'image/webp', 'image/gif'].includes(file.type)) throw new Error('Нужен PNG, JPEG, WEBP или GIF');
      onChanged(await api.uploadBotAvatar(bot.id, file));
    });

  return (
    <div className="settings-pane bot-editor">
      <BackRow label={label} onBack={onBack} />
      <div className="webhook-ava">
        <Avatar url={bot.avatarUrl} name={label} size={64} />
        <div className="bot-ava-side">
          <span className="dmf-title">
            {label}{' '}
            <span className="bot-tag" title={BOT_TAG_TITLE}>
              {BOT_TAG_TEXT}
            </span>
          </span>
          <span className="dmf-sub">@{bot.username}</span>
          <div className="webhook-ava-actions">
            <button type="button" className="link" disabled={busy} onClick={() => fileRef.current?.click()}>
              Загрузить аватар
            </button>
          </div>
        </div>
        <input
          ref={fileRef}
          type="file"
          accept="image/png,image/jpeg,image/webp,image/gif"
          hidden
          onChange={(e) => {
            const f = e.target.files?.[0];
            if (f) void upload(f);
            e.target.value = '';
          }}
        />
      </div>
      {st && (
        <div className={`bot-state ${st.tone}`} role="status">
          {st.text}
        </div>
      )}

      <label className="field">
        Имя
        <input value={name} maxLength={32} placeholder={bot.username} onChange={(e) => setName(e.target.value)} />
      </label>
      <label className="field">
        Описание
        <textarea value={description} maxLength={BOT_DESCRIPTION_MAX} rows={3} onChange={(e) => setDescription(e.target.value)} />
        <span className="muted bot-hint">Видно в пустой беседе с ботом — что он умеет и с чего начать.</span>
      </label>
      <label className="field">
        О боте
        <input value={about} maxLength={BOT_ABOUT_MAX} onChange={(e) => setAbout(e.target.value)} />
        <span className="muted bot-hint">Одна строка в профиле бота.</span>
      </label>
      <div className="sec-actions">
        <button type="button" className="primary" disabled={busy || !dirty} onClick={() => void save()}>
          Сохранить
        </button>
      </div>

      <div className="settings-group-label dmf-gap">Кто может писать боту</div>
      <div className="bot-toggle-row">
        <span className="dmf-main">
          <span className="dmf-title" id={`bot-pub-${bot.id}`}>
            Доступен всем
          </span>
          <span className="dmf-sub">
            {bot.public ? 'Бота находят в поиске, писать ему может любой.' : 'Писать боту можете только вы.'}
          </span>
        </span>
        <Toggle checked={bot.public} disabled={busy} labelledBy={`bot-pub-${bot.id}`} onChange={(v) => void patch({ public: v })} />
      </div>

      {/* Серверы (#231): где стоит бот. Нет поля — старый сервер без ботов на серверах, блока нет. */}
      {bot.servers && (
        <>
          <div className="settings-group-label dmf-gap">Серверы</div>
          {bot.servers.length === 0 ? (
            <div className="muted dmf-about">
              Бот пока ни на одном сервере. Добавить его может админ сервера в «Настройки сервера → Интеграции»
              (приватного — только вы).
            </div>
          ) : (
            <ul className="bans-list bot-servers">
              {bot.servers.map((srv) => (
                <li key={srv.id} className="ban-row">
                  <div className="ban-meta">
                    <div className="ban-name">{srv.name}</div>
                  </div>
                  <button type="button" className="danger-text" disabled={busy} onClick={() => void leaveServer(srv)}>
                    Убрать
                  </button>
                </li>
              ))}
            </ul>
          )}
        </>
      )}

      {/* Доставка событий (26.10): адрес, последняя ошибка со временем, «выключена после сбоев» — или опрос/WS без адреса. */}
      <div className="settings-group-label dmf-gap">Доставка событий</div>
      <dl className="bot-delivery">
        {botDeliveryRows(bot.webhook).map((r) => (
          <div key={r.label} className="bot-delivery-row">
            <dt className="muted">{r.label}</dt>
            <dd className={r.tone ? `bot-state ${r.tone}` : undefined} title={r.title}>
              {r.value}
            </dd>
          </div>
        ))}
      </dl>

      <div className="settings-group-label dmf-gap">Токен и беседа</div>
      <div className="muted dmf-about">
        Токен бота — это пароль, по которому его программа входит в GusVoice. Он показывается один раз; потеряли или токен утёк —
        перевыпустите.
      </div>
      <div className="sec-actions bot-actions">
        <button type="button" onClick={onOpenChat}>
          <Icon name="mail" size={16} /> Открыть беседу
        </button>
        <button type="button" disabled={busy} onClick={() => void regenerate()}>
          Перевыпустить токен
        </button>
        <button type="button" className="danger" disabled={busy} onClick={() => void remove()}>
          Удалить бота
        </button>
      </div>
      <BotDocsLinks />
    </div>
  );
}

/** Окно с токеном — один раз, после создания и перевыпуска. Закрыли — токен больше не увидеть (на сервере только хеш). */
function BotTokenDialog({ fresh, onClose, onOpenChat }: { fresh: BotTokenResponse; onClose: () => void; onOpenChat: () => void }) {
  const ref = useDialogChrome(onClose);
  const [copied, setCopied] = useState(false);
  useEffect(
    () =>
      pushBackHandler(() => {
        onClose();
        return true;
      }),
    [],
  );
  const label = fresh.bot.displayName || fresh.bot.username;
  const copy = () =>
    void navigator.clipboard
      ?.writeText(fresh.token)
      .then(() => {
        setCopied(true);
        toast('success', 'Токен скопирован');
      })
      .catch(() => toast('error', 'Не удалось скопировать — выделите токен и скопируйте вручную'));
  // В `body`, а не внутри окна настроек: там подложка ложилась бы только на правую часть окна.
  return createPortal(
    <div className="modal-overlay" onClick={onClose}>
      <div
        ref={ref}
        className="modal create-channel bot-token-modal"
        role="dialog"
        aria-modal="true"
        aria-labelledby="bot-token-title"
        tabIndex={-1}
        onClick={(e) => e.stopPropagation()}
        // Esc закрывает только это окно: `preventDefault` — знак окну настроек под ним не закрываться (`useDialogChrome`).
        onKeyDown={(e) => {
          if (e.key !== 'Escape') return;
          e.preventDefault();
          onClose();
        }}
      >
        <div className="admin-head">
          <h2 id="bot-token-title">Токен бота</h2>
          <button type="button" className="icon-close" title="Закрыть" onClick={onClose}>
            <Icon name="close" size={18} />
          </button>
        </div>
        <div className="bot-token-warn" role="note">
          <Icon name="lock" size={16} />
          <span>
            Токен — это пароль бота «{label}»: кто его знает, пишет от имени бота. Никому не показывайте. Мы покажем его
            только сейчас, один раз.
          </span>
        </div>
        <div className="webhook-url">
          <input
            readOnly
            value={fresh.token}
            onFocus={(e) => e.currentTarget.select()}
            aria-label="Токен бота"
            spellCheck={false}
          />
          <button type="button" onClick={copy}>
            {copied ? 'Скопировано' : 'Скопировать'}
          </button>
        </div>
        <div className="muted bot-hint">Впишите токен в программу бота (заголовок Authorization: Bot &lt;токен&gt;).</div>
        <div className="modal-actions">
          <button type="button" className="link" onClick={onClose}>
            Готово
          </button>
          <button type="button" onClick={onOpenChat}>
            Открыть беседу
          </button>
        </div>
      </div>
    </div>,
    document.body,
  );
}
