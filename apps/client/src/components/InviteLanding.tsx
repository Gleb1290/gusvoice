import { useEffect, useState } from 'react';
import { api } from '../api';
import { config, RELEASES_URL } from '../config';
import { Goose } from './Goose';
import { Icon } from './Icon';

/**
 * Страница `https://<хост>/i/<код>` — куда приводит клик по ссылке в мессенджере (#139, F4, §4.2.2).
 *
 * 🔴 Первое, что делает страница, — пробует отдать ссылку УЖЕ УСТАНОВЛЕННОМУ приложению через схему
 * `gusvoice://`. Прямо открыть приложение по `https://`-ссылке нельзя ни на Windows (схемы `https`
 * привязываются только к MSIX-пакетам, у нас NSIS), ни на Android для чужих доменов (App Links
 * требуют перечислить домены при сборке, а домены инстансов друзей нам заранее неизвестны).
 * Поэтому промежуточная страница — не костыль, а единственный работающий путь; так делают Discord и
 * Zoom.
 *
 * 🔴 Запасные варианты появляются ЧЕРЕЗ ПАУЗУ, а не сразу. Показать их немедленно значило бы
 * перебить успешный переход в приложение: человек уже видит своё окно, а во вкладке под ним
 * предлагают что-то скачать.
 *
 * ⚠️ Поле «введите свой инстанс» здесь НЕ появится никогда: это открытый редирект и готовая
 * фишинговая форма. Предлагаются только ДОВЕРЕННЫЕ инстансы этого хоста — их список он отдаёт сам.
 */

const SHOW_FALLBACK_MS = 2000;

/**
 * Кнопку «у меня аккаунт на другом инстансе» строим ТОЛЬКО для `https://`-адреса (аудит 19.09,
 * F-11). Адрес клиента соседа приходит из его визитки; бэкенд теперь принимает лишь http(s), но
 * страница — последний рубеж перед `href`, и `javascript:` здесь не должен появиться ни при какой
 * версии бэкенда. `http://` тоже мимо: вход на чужой инстанс без шифрования — не то, куда мы ведём.
 */
function httpsOrigin(value: string): string | null {
  try {
    const url = new URL(value);
    return url.protocol === 'https:' ? url.origin : null;
  } catch {
    return null;
  }
}

export function InviteLanding({ code, onHere }: { code: string; onHere: () => void }) {
  const [peers, setPeers] = useState<{ name: string; clientOrigin: string }[]>([]);
  const [showFallback, setShowFallback] = useState(false);
  const link = `${window.location.origin}/i/${code}`;

  useEffect(() => {
    // Пробуем отдать ссылку приложению. `location.href` на чужую схему безопасен: не откроется —
    // браузер просто ничего не сделает (и, в худшем случае, один раз спросит разрешение).
    try {
      window.location.href = `gusvoice://join?invite=${encodeURIComponent(link)}`;
    } catch {
      /* схема не зарегистрирована — остаются запасные варианты ниже */
    }
    const t = window.setTimeout(() => setShowFallback(true), SHOW_FALLBACK_MS);
    return () => window.clearTimeout(t);
  }, [link]);

  useEffect(() => {
    let alive = true;
    api
      .inviteOpen(code)
      .then(
        (r) =>
          alive &&
          setPeers(
            r.peers
              .map((p) => ({ name: p.name, clientOrigin: httpsOrigin(p.clientOrigin) ?? '' }))
              .filter((p) => p.clientOrigin.length > 0),
          ),
      )
      .catch(() => {
        /* код не наш или федерации нет — останутся «скачать» и «у меня аккаунт здесь» */
      });
    return () => {
      alive = false;
    };
  }, [code]);

  return (
    <div className="il-wrap">
      <div className="il-card">
        <Goose pose="head" size={52} />
        <h1 className="il-title">Открываем GusVoice…</h1>
        <p className="il-sub">
          Если приложение установлено, приглашение откроется в нём. Ничего не произошло — выберите, как продолжить.
        </p>

        {showFallback && (
          <div className="il-actions">
            <button type="button" onClick={() => (window.location.href = `gusvoice://join?invite=${encodeURIComponent(link)}`)}>
              <Icon name="play" size={16} /> Открыть в приложении
            </button>
            <button type="button" className="il-secondary" onClick={onHere}>
              У меня аккаунт здесь
            </button>
            <a className="il-link" href={RELEASES_URL} target="_blank" rel="noreferrer">
              Скачать GusVoice
            </a>
          </div>
        )}

        {showFallback && peers.length > 0 && (
          <div className="il-peers">
            <div className="settings-group-label">У вас аккаунт на другом инстансе?</div>
            <p className="il-peers-hint">
              Откроется веб-клиент вашего инстанса — вход будет там, у себя дома, а не на этом сайте.
            </p>
            <div className="il-peer-list">
              {peers.map((p) => (
                <a
                  key={p.clientOrigin}
                  className="il-peer"
                  href={`${p.clientOrigin}/join?invite=${encodeURIComponent(link)}`}
                  rel="noreferrer"
                >
                  <Icon name="globe" size={14} /> {p.name}
                </a>
              ))}
            </div>
          </div>
        )}

        {/* Сам адрес — на случай, когда не сработало ничего: его можно скопировать и вставить в
            приложении руками, и это всегда работает. */}
        {showFallback && (
          <div className="il-raw">
            <span className="muted">Ссылка целиком:</span> <code>{link}</code>
          </div>
        )}
      </div>
      <div className="il-host muted">{config.apiUrl ? new URL(config.apiUrl).host.replace(/^api\./, '') : ''}</div>
    </div>
  );
}
