import { useRoomContext } from '@livekit/components-react';
import { Track } from 'livekit-client';
import { useEffect, useRef, useState } from 'react';
import { gvScreenShareStats } from '../nativeScreenShare';
import { encWindow, formatLayerTargets, formatShareCfg, type EncCounters } from '../streamDebugRules';
import { Icon } from './Icon';

/**
 * Live encoder numbers for MY own stream — what «стрим лагает» actually looks like from the sending
 * side. Two fields answer most of it and are why this panel exists:
 *   • «Ограничение» — cpu / bandwidth / нет: encoder vs uplink, otherwise pure guesswork.
 *   • «Энкодер» — NVENC vs a software fallback (OpenH264/libvpx). A good GPU means nothing if the
 *     stream is being encoded in software.
 *
 * Two sources, because a stream can be published two ways: the DESKTOP path publishes from Rust as a
 * companion participant, and the browser can't see those PeerConnection stats at all — that side comes
 * from the shell over `gv_screen_share_stats`. The WEB path (getDisplayMedia) is read from the local
 * publication's own stats report.
 */
type Raw = {
  native: boolean;
  width: number;
  height: number;
  fps: number;
  bytesSent: number;
  atMs: number;
  targetBitrate: number;
  /**
   * Оценка канала САМИМ WebRTC, бит/с. Не скорость провода: WebRTC мерит канал по задержкам пакетов и
   * из этой оценки раздаёт биты слоям. 26.09 полный слой получал 3,5 Мбит/с из 12,9 на гигабитной
   * локалке — эта строка отвечает, застрял оценщик или бюджет ушёл другим слоям. 0 — нет данных.
   */
  bwe: number;
  /** Цели слоёв, `f 3.5 · h 2.5 · q 0.15`; пусто — один поток или нет данных. */
  layerTargets: string;
  /** Путь кадра нативного показа: `gpu`/`cpu` и почему не `gpu`. Пусто — веб или старая оболочка. */
  pipeline: string;
  /** Сервер и подсказка оценщику: «локалка 1 мс, пол 15.5 Мбит/с» / «интернет 24 мс». Пусто — нет данных. */
  server: string;
  limit: string;
  limitCpuS: number;
  limitBwS: number;
  resChanges: number;
  encoder: string;
  codec: string;
  framesEncoded: number;
  keyFrames: number;
  nack: number;
  pli: number;
  rttMs: number;
  fractionLost: number;
  packetsLost: number;
  // ─── «Чёрный ящик» (06.10, #207) ───
  /** Сумма QP основного слоя (накопительно) — средний QP за секунду считается разностью. 0 — не знаем. */
  qpSum: number;
  /** Сколько байт кодировщик ДОЛЖЕН был выдать по своей цели (накопительно). 0 — не знаем. */
  encBytesTarget: number;
  /** Задержка проверок ICE, мс — у нативного показа `rttMs` всегда 1, этой верить. 0 — нет данных. */
  iceRttMs: number;
  /** С чем показ запущен на самом деле (только нативный): «2560×1440 · 30 к/с · 7.0 Мбит/с · Чёткость…». */
  shareCfg: string;
};

const LIMIT_RU: Record<string, string> = {
  none: 'нет',
  cpu: 'процессор',
  bandwidth: 'канал',
  other: 'другое',
};

/** Strip the `video/` prefix WebRTC puts on mime types — «H264» reads better than «video/H264». */
const codecName = (mime: string) => mime.replace(/^video\//i, '') || '—';

async function sampleNative(): Promise<Raw | null> {
  const s = await gvScreenShareStats();
  if (!s) return null;
  return {
    native: true,
    width: s.width,
    height: s.height,
    fps: s.fps,
    bytesSent: s.bytes_sent,
    atMs: s.at_ms || Date.now(),
    targetBitrate: s.target_bitrate,
    bwe: s.bwe_bps ?? 0,
    pipeline: s.pipeline
      ? `${s.pipeline === 'gpu' ? 'видеокарта' : 'через процессор'}${s.pipeline_note ? ` — ${s.pipeline_note}` : ''}`
      : '',
    server:
      s.server_rtt_ms === undefined || s.server_rtt_ms === 0
        ? ''
        : s.server_rtt_ms < 0
          ? 'не достучались'
          : `${(s.bwe_min_bps ?? 0) > 0 ? 'локалка' : 'интернет'} ${s.server_rtt_ms.toFixed(1)} мс${
              (s.bwe_min_bps ?? 0) > 0 ? `, пол ${((s.bwe_min_bps ?? 0) / 1e6).toFixed(1)} Мбит/с` : ''
            }`,
    layerTargets: formatLayerTargets(
      (s.layers ?? []).map((l) => ({ rid: l.rid, active: l.active, bps: l.target_bitrate ?? 0 })),
    ),
    limit: s.limit_reason || 'none',
    limitCpuS: s.limit_cpu_s,
    limitBwS: s.limit_bandwidth_s,
    resChanges: s.resolution_changes,
    encoder: s.encoder,
    codec: codecName(s.codec),
    framesEncoded: s.frames_encoded,
    keyFrames: s.key_frames,
    nack: s.nack,
    pli: s.pli,
    rttMs: s.rtt_ms,
    fractionLost: s.fraction_lost,
    packetsLost: s.packets_lost,
    qpSum: s.qp_sum ?? 0,
    encBytesTarget: s.encoded_bytes_target ?? 0,
    iceRttMs: s.ice_rtt_ms ?? 0,
    shareCfg: formatShareCfg({
      width: s.cfg_width,
      height: s.cfg_height,
      fps: s.cfg_fps,
      bitrate: s.cfg_bitrate,
      mode: s.mode,
      maxQuality: s.max_quality,
      layers: s.layers_on,
      keyframeScale: s.keyframe_scale,
    }),
  };
}

async function sampleWeb(report: RTCStatsReport | undefined): Promise<Raw | null> {
  if (!report) return null;
  // remote-inbound-rtp only appears once the receiver has reported back — default those to 0.
  const out: Partial<Raw> = {
    native: false,
    rttMs: 0,
    fractionLost: 0,
    packetsLost: 0,
    bwe: 0,
    layerTargets: '',
    pipeline: '',
    server: '',
    qpSum: 0,
    encBytesTarget: 0,
    iceRttMs: 0,
    shareCfg: '',
  };
  const layers: { rid: string; active: boolean; bps: number }[] = [];
  let codecId = '';
  const codecs = new Map<string, string>();
  // Основной слой — САМЫЙ КРУПНЫЙ (06.10): раньше в строки попадал последний из отчёта, какой придётся.
  let bestArea = -1;
  report.forEach((r: Record<string, unknown> & { type: string; id: string }) => {
    if (r.type === 'outbound-rtp' && r.kind === 'video') {
      const d = r as unknown as Record<string, number & string>;
      const active = (r as unknown as { active?: boolean }).active !== false;
      layers.push({ rid: String(d.rid ?? ''), active, bps: Number(d.targetBitrate) || 0 });
      const area = (Number(d.frameWidth) || 0) * (Number(d.frameHeight) || 0);
      if (area < bestArea) return;
      bestArea = area;
      out.qpSum = Number(d.qpSum) || 0;
      out.encBytesTarget = Number(d.totalEncodedBytesTarget) || 0;
      out.width = Number(d.frameWidth) || 0;
      out.height = Number(d.frameHeight) || 0;
      out.fps = Number(d.framesPerSecond) || 0;
      out.bytesSent = Number(d.bytesSent) || 0;
      out.atMs = Number(d.timestamp) || Date.now();
      out.targetBitrate = Number(d.targetBitrate) || 0;
      out.limit = String(d.qualityLimitationReason ?? 'none');
      out.resChanges = Number(d.qualityLimitationResolutionChanges) || 0;
      out.encoder = String(d.encoderImplementation ?? '');
      out.framesEncoded = Number(d.framesEncoded) || 0;
      out.keyFrames = Number(d.keyFramesEncoded) || 0;
      out.nack = Number(d.nackCount) || 0;
      out.pli = Number(d.pliCount) || 0;
      const dur = (r as unknown as { qualityLimitationDurations?: Record<string, number> })
        .qualityLimitationDurations;
      out.limitCpuS = dur?.cpu ?? 0;
      out.limitBwS = dur?.bandwidth ?? 0;
      codecId = String(d.codecId ?? '');
    } else if (r.type === 'remote-inbound-rtp' && r.kind === 'video') {
      const d = r as unknown as Record<string, number>;
      out.rttMs = (Number(d.roundTripTime) || 0) * 1000;
      out.fractionLost = Number(d.fractionLost) || 0;
      out.packetsLost = Number(d.packetsLost) || 0;
    } else if (r.type === 'codec') {
      codecs.set(r.id, String((r as unknown as { mimeType?: string }).mimeType ?? ''));
    } else if (r.type === 'candidate-pair' && (r as unknown as { nominated?: boolean }).nominated) {
      const bwe = Number((r as unknown as { availableOutgoingBitrate?: number }).availableOutgoingBitrate) || 0;
      out.bwe = Math.max(out.bwe ?? 0, bwe);
      const rtt = Number((r as unknown as { currentRoundTripTime?: number }).currentRoundTripTime) || 0;
      if (rtt > 0) out.iceRttMs = rtt * 1000;
    }
  });
  if (out.width === undefined) return null;
  out.layerTargets = formatLayerTargets(layers);
  out.codec = codecName(codecs.get(codecId) ?? '');
  return out as Raw;
}

export function StreamDebugPanel({ native, onClose }: { native: boolean; onClose: () => void }) {
  const room = useRoomContext();
  const [cur, setCur] = useState<Raw | null>(null);
  // Окно в секунду между замерами (06.10): факт, цель кодировщика и средний QP — разностью счётчиков.
  const [win, setWin] = useState<{ qp: number | null; kbps: number; encKbps: number | null } | null>(null);
  const prev = useRef<EncCounters | null>(null);

  useEffect(() => {
    let alive = true;
    const tick = async () => {
      const next = native
        ? await sampleNative()
        : await sampleWeb(
            await room.localParticipant.getTrackPublication(Track.Source.ScreenShare)?.track?.getRTCStatsReport(),
          );
      if (!alive) return;
      setCur(next);
      if (next) {
        // Bitrate is a delta: consecutive byte counters over the time between the two reports.
        const c: EncCounters = {
          atMs: next.atMs,
          frames: next.framesEncoded,
          qpSum: next.qpSum,
          bytesSent: next.bytesSent,
          encBytesTarget: next.encBytesTarget,
        };
        const w = encWindow(prev.current, c);
        if (w) setWin(w);
        prev.current = c;
      }
    };
    void tick();
    const id = window.setInterval(() => void tick(), 1000);
    return () => {
      alive = false;
      window.clearInterval(id);
    };
  }, [native, room]);

  const limited = cur && cur.limit !== 'none' && cur.limit !== '';
  const kbps = win?.kbps ?? 0;
  const rows: [string, string, boolean?][] = cur
    ? [
        ['Источник', native ? 'нативный (десктоп)' : 'браузер (getDisplayMedia)'],
        ...(cur.shareCfg ? ([['Показ', cur.shareCfg]] as [string, string][]) : []),
        ...(cur.pipeline ? ([['Путь кадра', cur.pipeline]] as [string, string][]) : []),
        ['Кодек', cur.codec],
        ['Энкодер', cur.encoder || '—'],
        ['Разрешение', cur.width ? `${cur.width}×${cur.height}` : '—'],
        ['Кадров/с', cur.fps ? cur.fps.toFixed(1) : '—'],
        // Цель против факта (06.10): «цель WebRTC» — сколько распределитель отдал слою, «кодировщик» —
        // сколько тот должен был выдать по своей цели за секунду. Факт ≪ цели — на экране статика.
        [
          'Битрейт',
          `${(kbps / 1000).toFixed(2)} Мбит/с${cur.targetBitrate ? ` · цель ${(cur.targetBitrate / 1e6).toFixed(2)}` : ''}${
            win?.encKbps !== null && win?.encKbps !== undefined ? ` · кодировщик ${(win.encKbps / 1000).toFixed(2)}` : ''
          }`,
        ],
        // QP: 20–30 — чёткий текст, 40+ — мыло, 51 — предел H.264.
        ['QP (среднее за секунду)', win?.qp !== null && win?.qp !== undefined ? win.qp.toFixed(1) : '—', (win?.qp ?? 0) >= 38],
        ['Канал по оценке WebRTC', cur.bwe ? `${(cur.bwe / 1e6).toFixed(1)} Мбит/с` : '—'],
        ...(cur.server ? ([['Сервер', cur.server]] as [string, string][]) : []),
        ...(cur.layerTargets ? ([['Цели слоёв, Мбит/с', cur.layerTargets]] as [string, string][]) : []),
        ['Ограничение', LIMIT_RU[cur.limit] ?? cur.limit, !!limited],
        ['Из-за процессора', `${cur.limitCpuS.toFixed(1)} с`, cur.limitCpuS > 1],
        ['Из-за канала', `${cur.limitBwS.toFixed(1)} с`, cur.limitBwS > 1],
        ['Смен разрешения', String(cur.resChanges), cur.resChanges > 0],
        // По проверкам ICE (06.10): отчёт получателя у нативного показа всегда говорит «1 мс».
        ['Пинг до сервера', cur.iceRttMs || cur.rttMs ? `${Math.round(cur.iceRttMs || cur.rttMs)} мс` : '—'],
        ['Потери', `${(cur.fractionLost * 100).toFixed(1)}% (${cur.packetsLost} пакетов)`, cur.fractionLost > 0.02],
        ['Кадров закодировано', `${cur.framesEncoded} (ключевых ${cur.keyFrames})`],
        ['Запросы пересылки', `NACK ${cur.nack} · PLI ${cur.pli}`],
      ]
    : [];

  return (
    <div className="stream-debug" role="dialog" aria-label="Отладка стрима">
      <div className="sd-head">
        <b>Отладка стрима</b>
        <button type="button" className="icon-close" title="Закрыть" aria-label="Закрыть" onClick={onClose}>
          <Icon name="close" size={14} />
        </button>
      </div>
      {!cur ? (
        <div className="muted sd-empty">
          {native
            ? 'Нативный модуль ещё не отдал статистику — подожди пару секунд после старта показа.'
            : 'Статистика недоступна: стрим публикуется не этой вкладкой.'}
        </div>
      ) : (
        <>
          <div className="sd-rows">
            {rows.map(([k, v, warn]) => (
              <div className={`sd-row ${warn ? 'warn' : ''}`} key={k}>
                <span>{k}</span>
                <b>{v}</b>
              </div>
            ))}
          </div>
          <div className="muted sd-hint">
            {limited
              ? cur.limit === 'cpu'
                ? 'Кодировщик не успевает: снизь разрешение/кадры или проверь, что стрим кодирует видеокарта (строка «Энкодер»).'
                : 'Не хватает исходящего канала: снизь битрейт или разрешение.'
              : 'Ограничений нет — кодировщик и канал справляются.'}
          </div>
        </>
      )}
    </div>
  );
}
