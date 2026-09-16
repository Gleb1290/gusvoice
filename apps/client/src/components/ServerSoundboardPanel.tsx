import { useEffect, useRef, useState } from 'react';
import { api, type SoundboardClip } from '../api';
import { nameFromFileName, SOUNDBOARD_NAME_MAX } from '../soundboardPick';
import { playClip } from '../sounds';
import { toast, toastError } from '../toast';
import { Icon } from './Icon';

/**
 * Управление саундбордом сервера (#21): залить сэмпл, послушать, удалить.
 *
 * 🔴 Право — `MANAGE_SOUNDBOARD`, СВОЁ, не то, что у звуков событий (требование к фиче). Звук
 * уведомления человек слышит по случаю, а сэмпл саундборда кто угодно проигрывает всему каналу по
 * своему желанию: разная мера доверия. Поэтому у панели и своя вкладка настроек — держатель только
 * этого права до вкладки «Звуки» не допущен и иначе сюда бы не попал.
 *
 * 🔴 Длительность проверяется ЗДЕСЬ, потому что сервер звук не декодирует: по байтам её не узнать,
 * тихий моно-MP3 на низком битрейте укладывает минуты в наш размер. Ограничение держится на доверии
 * к держателю права — но обходит его тот, кто и так может залить в канал что угодно, поэтому цена
 * обхода нулевая. Разбор целиком — в `soundboardRules.ts` на бэкенде.
 *
 * ⚠️ Пределы приезжают ОТ СЕРВЕРА, а не повторены здесь числами: иначе две стороны разошлись бы при
 * первой же правке, а разъехавшийся предел читается как каприз, а не как ошибка.
 */
export function ServerSoundboardPanel({ serverId }: { serverId: string }) {
  const [clips, setClips] = useState<SoundboardClip[]>([]);
  const [limits, setLimits] = useState<{
    max: number;
    maxBytes: number;
    maxSeconds: number;
    defaultPriceCoins: number;
    maxPriceCoins: number;
  } | null>(null);
  const [name, setName] = useState('');
  /**
   * 🔴 Выбранный, но ещё НЕ залитый файл (порядок перевёрнут по запросу 05.09: сначала файл,
   * потом имя). Раньше «Выбрать файл» был заперт до ввода названия — то есть имя требовалось
   * придумать раньше, чем сделан выбор. А выбирают так: лезут в папку с ворохом записей, слушают,
   * останавливаются на одной — и уже ПОТОМ придумывают подпись кнопке.
   */
  const [picked, setPicked] = useState<File | null>(null);
  /** Цена для СЛЕДУЮЩЕЙ заливки. Пусто — звук пойдёт по общей цене каталога. */
  const [price, setPrice] = useState('');
  const [busy, setBusy] = useState(false);
  const input = useRef<HTMLInputElement | null>(null);

  useEffect(() => {
    let alive = true;
    api
      .listSoundboard(serverId)
      .then((r) => {
        if (!alive) return;
        setClips(r.clips);
        setLimits({
          max: r.max,
          maxBytes: r.maxBytes,
          maxSeconds: r.maxSeconds,
          defaultPriceCoins: r.defaultPriceCoins,
          maxPriceCoins: r.maxPriceCoins,
        });
      })
      .catch((e) => alive && toastError(e));
    return () => {
      alive = false;
    };
  }, [serverId]);

  /**
   * Длительность файла до отправки.
   *
   * ⚠️ Через `<audio>` и объектную ссылку, а не декодированием в Web Audio: декодер держит весь
   * звук в памяти распакованным, а нам нужно ровно одно число. Не получилось прочитать —
   * пропускаем (`null`): отказ по неопределённой причине хуже, чем сэмпл на секунду длиннее.
   */
  function durationOf(file: File): Promise<number | null> {
    return new Promise((resolve) => {
      const url = URL.createObjectURL(file);
      const el = new Audio();
      const done = (v: number | null) => {
        URL.revokeObjectURL(url);
        resolve(v);
      };
      el.onloadedmetadata = () => done(Number.isFinite(el.duration) ? el.duration : null);
      el.onerror = () => done(null);
      el.src = url;
    });
  }

  /**
   * Файл выбран. Проверяем ЗДЕСЬ, а не при заливке: про негодный файл честнее сказать сразу, а не
   * после того, как человек придумал ему название.
   */
  async function pick(file: File) {
    if (limits && file.size > limits.maxBytes) {
      return toastError(new Error(`файл больше ${Math.round(limits.maxBytes / 1024)} КБ`));
    }
    const secs = await durationOf(file);
    if (limits && secs !== null && secs > limits.maxSeconds) {
      return toastError(new Error(`звук длиннее ${limits.maxSeconds} с — саундборд для коротких`));
    }
    setPicked(file);
    // Имя файла — заготовка подписи, а не решение: поле обычное и правится.
    setName((cur) => (cur.trim() ? cur : nameFromFileName(file.name)));
  }

  async function upload(file: File) {
    const trimmed = name.replace(/\s+/g, ' ').trim();
    if (!trimmed) return toastError(new Error('сначала придумайте название кнопки'));
    setBusy(true);
    try {
      const wanted = price.trim() === '' ? null : Number(price);
      await api.uploadSoundboardClip(serverId, trimmed, file, wanted);
      // ⚠️ Перечитываем список, а не дописываем ответ заливки: ответ несёт только id/имя/ссылку, и
      // строка нового звука до перезахода показывала цену как `undefined`.
      setClips((await api.listSoundboard(serverId)).clips);
      setName('');
      setPrice('');
      setPicked(null);
      toast('success', 'Звук добавлен');
    } catch (e) {
      toastError(e);
    } finally {
      setBusy(false);
      if (input.current) input.current.value = '';
    }
  }

  /**
   * Поменять цену звука.
   *
   * ⚠️ Пустое поле — это `null`, «вернуть на общую», а НЕ ноль. Ноль означает «даром», и владелец
   * должен уметь поставить его осознанно, а не стиранием поля.
   */
  async function savePrice(clip: SoundboardClip, text: string) {
    const wanted = text.trim() === '' ? null : Math.floor(Number(text));
    if (wanted !== null && (!Number.isFinite(wanted) || wanted < 0)) {
      return toastError(new Error('цена — целое число монет, от нуля'));
    }
    if (wanted === clip.ownPriceCoins) return;
    try {
      await api.setSoundboardPrice(serverId, clip.id, wanted);
      const r = await api.listSoundboard(serverId);
      setClips(r.clips);
    } catch (e) {
      toastError(e);
    }
  }

  async function remove(clip: SoundboardClip) {
    setBusy(true);
    try {
      await api.deleteSoundboardClip(serverId, clip.id);
      setClips((v) => v.filter((c) => c.id !== clip.id));
    } catch (e) {
      toastError(e);
    } finally {
      setBusy(false);
    }
  }

  const full = !!limits && clips.length >= limits.max;

  return (
    <div className="settings-pane sbp">
      <div className="sbp-title">Саундборд</div>
      <div className="muted" style={{ fontSize: 12 }}>
        Короткие звуки, которые любой участник может проиграть всем в голосовом канале. Выстрел
        стоит монет — этим он себя и сдерживает.
        {limits &&
          ` До ${limits.max} звуков, не длиннее ${limits.maxSeconds} с и ${Math.round(limits.maxBytes / 1024)} КБ.`}
      </div>

      {/* 🔴 Порядок: СНАЧАЛА файл, ПОТОМ имя (запрос 05.09). Пока файл не выбран, в строке
          вообще нет полей — придумывать подпись до выбора нечему. */}
      <div className="sbp-add">
        <input
          ref={input}
          type="file"
          accept="audio/*"
          hidden
          onChange={(e) => {
            const f = e.target.files?.[0];
            // ⚠️ Сбрасываем значение поля: без этого повторный выбор ТОГО ЖЕ файла не даёт события,
            // и «отменил, выбрал снова» выглядит как будто кнопка сломалась.
            e.target.value = '';
            if (f) void pick(f);
          }}
        />
        {!picked ? (
          <button
            type="button"
            className="seg-mini"
            disabled={busy || full}
            onClick={() => input.current?.click()}
          >
            <Icon name="plus" size={14} /> Выбрать файл
          </button>
        ) : (
          <>
            <input
              type="text"
              placeholder="Название кнопки"
              maxLength={SOUNDBOARD_NAME_MAX}
              value={name}
              disabled={busy}
              autoFocus
              onChange={(e) => setName(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter' && name.trim() && !busy) void upload(picked);
              }}
            />
            <input
              type="number"
              className="sbp-price-input"
              placeholder={limits ? `${limits.defaultPriceCoins} мон` : 'мон'}
              title="Цена выстрела в монетах. Пусто — общая цена каталога."
              min={0}
              max={limits?.maxPriceCoins}
              value={price}
              disabled={busy}
              onChange={(e) => setPrice(e.target.value)}
            />
            <button
              type="button"
              className="seg-mini"
              disabled={busy || !name.trim()}
              onClick={() => void upload(picked)}
            >
              <Icon name="plus" size={14} /> Добавить
            </button>
            <button
              type="button"
              className="sound-icon-btn"
              title="Выбрать другой файл"
              disabled={busy}
              onClick={() => {
                setPicked(null);
                setName('');
              }}
            >
              <Icon name="close" size={14} />
            </button>
          </>
        )}
      </div>
      {/* Видно, ЧТО выбрано: иначе после выбора из вороха записей не отличить одну от другой. */}
      {picked && (
        <div className="muted" style={{ fontSize: 12, marginTop: -6 }}>
          Файл: {picked.name}
        </div>
      )}
      {/* Отдельной строкой, а не отключённой кнопкой молча: «почему не жмётся» должно быть написано. */}
      {full && <div className="muted" style={{ fontSize: 12 }}>Больше не поместится — удалите лишние.</div>}

      {clips.length === 0 ? (
        <div className="muted" style={{ fontSize: 12 }}>Пока пусто.</div>
      ) : (
        <div className="sound-rows">
          {clips.map((c) => (
            <div className="sound-row" key={c.id}>
              <span className="sound-row-label">{c.name}</span>
              {/* 🔴 Цена В МОНЕТАХ (решение 04.09). Остальной прайс живёт в минутах сидения,
                  чтобы сдвиг ставки его не переоценивал, — но эти цены ставят руками и по одному
                  звуку, глядя на балансы людей, и там минуты только мешают.
                  Рядом справочно минуты — чтобы видеть, во что цена обходится сегодня. */}
              <input
                type="number"
                className="sbp-price-input"
                defaultValue={c.ownPriceCoins ?? ''}
                placeholder={limits ? String(limits.defaultPriceCoins) : ''}
                title="Цена выстрела в монетах. Пусто — общая цена каталога."
                min={0}
                max={limits?.maxPriceCoins}
                disabled={busy}
                onBlur={(e) => void savePrice(c, e.target.value)}
              />
              <span className="sbp-price-coins">≈ {c.priceMinutes} мин</span>
              {/* Прослушать — локально и только себе: это проверка «тот ли файл залил», а не выстрел,
                  и уж точно не повод разбудить весь канал. */}
              <button type="button" className="sound-icon-btn" title="Послушать себе" onClick={() => playClip(c.url)}>
                <Icon name="volume" size={14} />
              </button>
              <button
                type="button"
                className="sound-icon-btn danger"
                title="Удалить"
                disabled={busy}
                onClick={() => void remove(c)}
              >
                <Icon name="trash" size={14} />
              </button>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
