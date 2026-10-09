import { confirmWithOption } from './confirm';

/**
 * G77 (#211): предупреждение перед открытием вложения системным приложением — как у Telegram Desktop.
 * Источник правил: репозиторий `telegramdesktop/tdesktop`, `Telegram/SourceFiles/data/data_document_resolver.cpp`
 * (`LaunchWithWarning`, `LauncherWouldWarn`), `Telegram/SourceFiles/core/mime_type.cpp` (`DetectNameType`,
 * `IsIpRevealingPath`), тексты — `lng_launch_exe_warning` / `lng_launch_other_warning` / `lng_launch_svg_warning`.
 * Код Telegram не переносился: тут своя запись тех же правил по спискам расширений.
 *
 * Правила: исполняемое — всегда спрашиваем («Запустить»); неизвестное расширение (и файл без расширения) — спрашиваем
 * («Открыть»); известное безобидное (картинки, видео, звук, документы, архивы…) — не спрашиваем; открывающее сетевой
 * ресурс при просмотре (svg, html, плейлисты…) — одно общее предупреждение про адрес. Галочка «Больше не спрашивать для
 * .ext» запоминает расширение на устройстве; для «раскрывает адрес» — общее отключение.
 * Открывается только в приложении Android (ACTION_VIEW, `fileActions.openAttachmentFile`): на вебе и десктопе файл
 * лишь скачивается, а сохранение Telegram не оговаривает.
 */

export type LaunchKind = 'exe' | 'other' | 'ip' | 'safe';

const words = (s: string): Set<string> => new Set(s.split(/\s+/).filter(Boolean));

/** Исполняемое и сценарии: объединение списков Telegram для Windows, macOS и Linux + пакеты Android. */
const EXECUTABLE = words(`
ad ade adp ahk app application appref-ms asp aspx asx bas bat bin cab cdxml cer cfg cgi chi chm cmd cnt com conf cpl
crt csh der diagcab dll drv eml exe fxp gadget grp hlp hpj hta htt inf ini ins inx isp isu its jar jnlp job js jse jsp
ksh lexe library-ms lnk local lua mad maf mag mam manifest maq mar mas mat mau mav maw mcf mda mdb mde mdt mdw mdz
mht mhtml mjs mmc mof msc msg msh msh1 msh2 msh1xml msh2xml mshxml msi msp mst ops osd paf pcd phar php php3 php4
php5 php7 phps php-s pht phtml pif pl plg pm pod prf prg ps1 ps2 ps1xml ps2xml psc1 psc2 psd1 psm1 pssc pst py py3
pyc pyd pyi pyo pyw pyzw pyz rb reg rgs scf scr sct search-ms settingcontent-ms sh shb shs slk sys swf t tmp u3p url
vb vbe vbp vbs vbscript vdx vsmacros vsd vsdm vsdx vss vssm vssx vst vstm vstx vsw vsx vtx website wlua ws wsc wsf wsh
xbap xll xlsb xlsm xnk xs
applescript action command osx workflow terminal caction mpkg pkg scpt scptd xhtm webarchive
deb desktop out pet pup rpm run shar slp zsh
apk xapk apks aab
`);

/** Известное безобидное: картинки, видео, звук, документы, архивы, исходники и прочее (списки Telegram). */
const BENIGN = words(`
afdesign ai avif bmp dng gif heic icns ico jfif jpeg jpg jpg-large jxl nef png png-large psd qoi raw sketch tga tif
tiff webp
3g2 3gp 3gpp aep avi flv h264 m4s mkv mov mp4 mpeg mpg ogv srt tgs tgv vob webm wmv
aac ac3 aif amr caf cda cue flac m4a m4b mid midi mp3 ogg opus wav wma
pdf doc docx ppt pptx pps ppsx xls xlsx txt rtf odt ods odp csv text log tl tex diag ps ost djvu epub mobi cbr cbz fb2
prc ris pem p7b wpd key
7z arj bz2 gz rar tar xz z zip zst
tdesktop-theme tdesktop-palette tgios-theme attheme
c cc cpp cxx h m mm swift cs ts class java css ninja cmake patch diff plist gyp gitignore strings asoundrc torrent csr
json xaml md keylayout sql sln xib mk dmg img iso vcd pdb eot ics ips ipa core mem pcap ovpn part pcapng dmp pkpass dat
zxp crash file bak gbr plain dlc fon fnt otf ttc ttf gpx db rss cur
`);

/** Открытие которых может выдать адрес человека владельцу файла (тянут ресурсы по сети). */
const IP_REVEALING = words('htm html svg m4v m3u m3u8 xhtml xml kml kmz xspf wpl');

/** Расширение имени в нижнем регистре без точки; нет точки после последнего разделителя — пустая строка. */
export function fileExtension(name: string): string {
  const base = name.slice(Math.max(name.lastIndexOf('/'), name.lastIndexOf('\\')) + 1);
  const dot = base.lastIndexOf('.');
  return dot < 0 ? '' : base.slice(dot + 1).toLowerCase();
}

/** Какое предупреждение нужно файлу с таким именем (без учёта «больше не спрашивать»). */
export function launchKind(name: string): LaunchKind {
  const ext = fileExtension(name);
  if (!ext) return 'other';
  if (EXECUTABLE.has(ext)) return 'exe';
  if (IP_REVEALING.has(ext)) return 'ip';
  return BENIGN.has(ext) ? 'safe' : 'other';
}

const TRUSTED_KEY = 'gv_launch_trusted';
const IP_OFF_KEY = 'gv_launch_ip_off';

function readTrusted(): string[] {
  try {
    const v: unknown = JSON.parse(localStorage.getItem(TRUSTED_KEY) || '[]');
    return Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : [];
  } catch {
    return [];
  }
}

/** Нужно ли спрашивать сейчас: учтены «больше не спрашивать» для расширения и общий выключатель про адрес. */
export function needsLaunchWarning(name: string): boolean {
  const kind = launchKind(name);
  if (kind === 'safe') return false;
  if (kind === 'ip') return localStorage.getItem(IP_OFF_KEY) !== '1';
  const ext = fileExtension(name);
  return !(ext && readTrusted().includes(ext));
}

/** Текст окна под вид предупреждения и имя файла (`ext` — без точки). */
export function launchWarningText(kind: Exclude<LaunchKind, 'safe'>, ext: string): { title: string; body: string; confirmLabel: string } {
  const dotted = ext ? `.${ext}` : '';
  if (kind === 'exe') {
    return {
      title: 'Запустить файл?',
      body: `У файла расширение ${dotted}. Он может навредить устройству. Запустить его?`,
      confirmLabel: 'Запустить',
    };
  }
  if (kind === 'ip') {
    return {
      title: 'Открыть файл?',
      body: 'Открытие этого файла может раскрыть ваш IP-адрес его автору. Продолжить?',
      confirmLabel: 'Открыть',
    };
  }
  return {
    title: 'Открыть файл?',
    body: ext ? `У файла расширение ${dotted}. Открыть его?` : 'У файла нет расширения. Открыть его?',
    confirmLabel: 'Открыть',
  };
}

/**
 * Спросить, открывать ли файл. `true` — можно открывать (спрашивать не нужно или человек согласился). Галочку
 * запоминаем только при согласии. Опасное (`exe`) — тон `danger`: Enter не подтверждает, фокус на «Отмене».
 */
export async function confirmLaunch(name: string): Promise<boolean> {
  if (!needsLaunchWarning(name)) return true;
  const kind = launchKind(name) as Exclude<LaunchKind, 'safe'>;
  const ext = fileExtension(name);
  const text = launchWarningText(kind, ext);
  const r = await confirmWithOption({
    ...text,
    tone: kind === 'exe' ? 'danger' : 'neutral',
    // Окно про запуск чужого файла, не про удаление: предупреждающий значок вместо корзины `danger` (`ConfirmSpec.icon`).
    icon: 'alert-circle',
    option: { label: kind === 'ip' ? 'Больше не спрашивать' : ext ? `Больше не спрашивать для .${ext}` : 'Больше не спрашивать', checked: false },
  });
  if (!r) return false;
  if (r.option) {
    try {
      if (kind === 'ip') localStorage.setItem(IP_OFF_KEY, '1');
      else if (ext) localStorage.setItem(TRUSTED_KEY, JSON.stringify([...new Set([...readTrusted(), ext])]));
    } catch {
      /* память заполнена — просто спросим в следующий раз */
    }
  }
  return true;
}
