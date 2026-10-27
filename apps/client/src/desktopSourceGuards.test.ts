import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { describe, it } from 'node:test';

const rust = readFileSync(new URL('../../desktop/src-tauri/src/lib.rs', import.meta.url), 'utf8');
const installer = readFileSync(new URL('../../desktop/src-tauri/installer-hooks.nsh', import.meta.url), 'utf8');
const audioCapture = readFileSync(new URL('../../desktop/src-tauri/src/audio_capture.rs', import.meta.url), 'utf8');
const occlusion = readFileSync(new URL('../../desktop/src-tauri/src/occlusion.rs', import.meta.url), 'utf8');
const diag = readFileSync(new URL('../../desktop/src-tauri/src/diag.rs', import.meta.url), 'utf8');
const peerConnection = readFileSync(new URL('../../desktop/vendor/libwebrtc/src/peer_connection.rs', import.meta.url), 'utf8');
const nvidiaEncoder = readFileSync(new URL('../../desktop/vendor/webrtc-sys/src/nvidia/h264_encoder_impl.cpp', import.meta.url), 'utf8');
const screenshare = readFileSync(new URL('../../desktop/src-tauri/src/screenshare.rs', import.meta.url), 'utf8');

describe('стражи исходников оболочки', () => {
  it('мобильная точка входа относится непосредственно к run и встречается один раз', () => {
    // Ловит серый экран APK: корректный атрибут над случайной функцией компилируется, но run не экспортируется.
    const lines = rust.split(/\r?\n/);
    const marker = '#[cfg_attr(mobile, tauri::mobile_entry_point)]';
    const positions = lines.flatMap((line, index) => line.trim() === marker ? [index] : []);
    assert.deepEqual(positions.length, 1);
    const next = lines
      .slice(positions[0]! + 1)
      .map((line) => line.trim())
      .find((line) => line.length > 0 && !line.startsWith('//'));
    assert.equal(next, 'pub fn run() {');
  });

  it('NSIS-схема запускает настоящий бинарник и не содержит неизвестных переменных', () => {
    // Ловит установщик, который молча записывает буквальный `$EXECUTABLE` и ломает gusvoice:// после установки.
    const code = installer
      .split(/\r?\n/)
      .map((line) => line.replace(/;.*/, ''))
      .join('\n');
    const variables = [...code.matchAll(/\$(?:\{([A-Z0-9_]+)\}|([A-Z][A-Z0-9_]*))/g)]
      .map((match) => match[1] ?? match[2]);
    assert.deepEqual([...new Set(variables)].sort(), ['INSTDIR', 'MAINBINARYNAME']);
    assert.match(
      code,
      /WriteRegStr HKCU "Software\\Classes\\gusvoice\\shell\\open\\command" "" '\"\$INSTDIR\\\$\{MAINBINARYNAME\}\.exe\" "%1"'/,
    );
  });

  it('аудио показа копится по 40 мс и не отправляется раньше полного куска', () => {
    // Ловит возврат четырёх IPC-вызовов на каждые 40 мс звука.
    assert.match(audioCapture, /const BATCH_MS:\s*usize\s*=\s*40;/);
    assert.match(audioCapture, /const BATCH_SAMPLES:[^=]*=\s*SAMPLE_RATE as usize \/ 1000 \* BATCH_MS \* CHANNELS as usize;/);
    assert.match(audioCapture, /if batch\.len\(\) < BATCH_SAMPLES\s*\{\s*return;/);
  });

  it('границы нашего окна берутся через DWM с запасным GetWindowRect', () => {
    // Ловит 98-процентное «почти перекрытие» развёрнутого окна из-за невидимой рамки Windows.
    assert.match(occlusion, /const DWMWA_EXTENDED_FRAME_BOUNDS:\s*u32\s*=\s*9;/);
    const visible = occlusion.match(/unsafe fn visible_rect[\s\S]*?\n\}/)?.[0] ?? '';
    assert.match(visible, /DwmGetWindowAttribute/);
    assert.match(visible, /GetWindowRect/);
    const covered = occlusion.match(/unsafe fn covered_by_foreground[\s\S]*?\n\}/)?.[0] ?? '';
    assert.match(covered, /visible_rect\(ours\)/);
  });

  it('снимок диагностики асинхронный и уводит тяжёлый сбор в spawn_blocking', () => {
    // Ловит блокировку event loop оболочки раз в 15 секунд.
    assert.match(diag, /pub async fn gv_diag_snapshot\(\)[\s\S]*?spawn_blocking\(snapshot\)/);
  });

  it('скрытие, трей и второй экземпляр обновляют видимость до show/hide', () => {
    // Ловит отрисовку спрятанного окна и неразмороженное окно после возврата из трея.
    const hide = rust.match(/fn gv_window_hide[\s\S]*?\n\}/)?.[0] ?? '';
    assert.match(hide, /if window\.label\(\) == "main"[\s\S]*?set_main_webview_shown\(&window, false\)/);
    const show = rust.match(/fn show_main[\s\S]*?\n\s*\}/)?.[0] ?? '';
    assert.ok(show.indexOf('set_main_webview_shown(&w, true)') < show.indexOf('w.show()'));
    const second = rust.match(/single_instance::init[\s\S]*?builder = builder/)?.[0] ?? '';
    assert.ok(second.indexOf('set_main_webview_shown(&w, true)') < second.indexOf('w.show()'));
  });

  it('нативный список приложений сохраняет default с иконками и передаёт false перечислителю', () => {
    // Ловит инверсию параметра, от которой пикер остаётся без иконок, а фон снова извлекает PNG.
    const fn = rust.match(/async fn gv_list_apps[\s\S]*?\n\}/)?.[0] ?? '';
    assert.match(fn, /icons\.unwrap_or\(true\)/);
    assert.match(fn, /apps_enum::list_apps\(with_icons\)/);
  });

  it('per-layer PLI применяется только к Answer и при отказе остаётся исходный SDP', () => {
    // Ловит правку offer и отказ всего соединения вместо безопасного fallback.
    assert.match(peerConnection, /sdp_type\(\) == SdpType::Answer/);
    const patchAt = peerConnection.indexOf('add_per_layer_pli(&original)');
    const fallbackAt = peerConnection.indexOf('set_remote_description(desc).await', patchAt);
    assert.ok(patchAt >= 0 && fallbackAt > patchAt);
  });

  it('нижний слой без 30 fps не получает кадр задержки NVENC', () => {
    // Ловит секундную пульсацию экономного слоя из-за буфера кодировщика.
    assert.match(nvidiaEncoder, /output_delay\s*=\s*codec_\.maxFramerate\s*>=\s*30\s*\?\s*1\s*:\s*0/);
  });

  it('dynacast включается только для CPU с несколькими слоями через общее правило', () => {
    // CPU + один слой даёт чёрное окно; инверсия GPU-пути возвращает пульсацию PLI.
    // Не ищем старое inline-выражение: важны новое правило И настоящий вызов из start.
    const production = screenshare.replace(/\r\n/g, '\n').split('\n#[cfg(test)]')[0]!;
    const callMarker = 'R313 start передаёт gpu_planned и настоящий layers в share_dynacast';
    const ruleMarker = 'R313 правило dynacast требует CPU и несколько слоёв';
    function check(source: string) {
      const code = source.replace(/\/\/[^\n]*/g, '');
      const start = code.match(/pub async fn start\b[\s\S]*?\n\}/)?.[0] ?? '';
      const assignments = [...start.matchAll(/\broom_opts\.dynacast\s*=\s*([^;]+);/g)];
      assert.equal(assignments.length === 1
        && assignments[0]![1]!.replace(/\s/g, '') === 'share_dynacast(gpu_planned,layers)', true, callMarker);
      const rule = code.match(/pub fn share_dynacast\s*\([^)]*\)\s*->\s*bool\s*\{([^}]*)\}/)?.[1] ?? '';
      assert.equal(rule.replace(/\s/g, '') === '!gpu_planned&&layers', true, ruleMarker);
    }
    check(production);
    for (const [from, to, marker] of [
      ['share_dynacast(gpu_planned, layers)', 'share_dynacast(!gpu_planned, layers)', callMarker],
      ['share_dynacast(gpu_planned, layers)', 'share_dynacast(gpu_planned, true)', callMarker],
      ['!gpu_planned && layers', 'gpu_planned && layers', ruleMarker],
      ['!gpu_planned && layers', '!gpu_planned', ruleMarker],
      ['!gpu_planned && layers', '!gpu_planned || layers', ruleMarker],
    ] as const) {
      assert.equal(production.split(from).length - 1, 1, 'R313 единственный production-якорь контрфакта');
      assert.throws(() => check(production.replace(from, to)), error => error instanceof assert.AssertionError
        && error.message.startsWith(marker) && error.operator === 'strictEqual' && error.actual === false && error.expected === true,
      `R313 контрфакт ${to} падает на адресном контракте`);
    }
  });
});
