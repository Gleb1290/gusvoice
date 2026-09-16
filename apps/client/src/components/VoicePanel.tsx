import { useMaybeRoomContext } from '@livekit/components-react';
import { ConnectionQuality, type Room } from 'livekit-client';
import { useEffect, useState } from 'react';
import { playSound } from '../sounds';
import { useStore } from '../store';
import { Icon } from './Icon';
import { VoiceControls } from './VoiceControls';

const QUALITY: Record<string, { label: string; cls: string }> = {
  [ConnectionQuality.Excellent]: { label: 'отличное', cls: 'good' },
  [ConnectionQuality.Good]: { label: 'хорошее', cls: 'ok' },
  [ConnectionQuality.Poor]: { label: 'слабое', cls: 'bad' },
  [ConnectionQuality.Lost]: { label: 'потеряно', cls: 'bad' },
  [ConnectionQuality.Unknown]: { label: '—', cls: 'ok' },
};

// Threshold colours, matching ConnectionView (green good / accent so-so / danger bad).
const rttColor = (v?: number) => (v == null ? undefined : v < 60 ? 'var(--green)' : v < 150 ? 'var(--accent)' : 'var(--danger)');
const lossColor = (v?: number) => (v == null ? undefined : v < 1 ? 'var(--green)' : v < 5 ? 'var(--accent)' : 'var(--danger)');
const jitterColor = (v?: number) => (v == null ? undefined : v < 30 ? 'var(--green)' : v < 60 ? 'var(--accent)' : 'var(--danger)');
// Sub-millisecond values (LAN pings, tiny jitter) round to a bare "0 мс" — show a decimal instead.
const fmtMs = (v?: number) => (v == null ? '—' : v < 10 ? `${v.toFixed(1)} мс` : `${Math.round(v)} мс`);

type SelfStats = { quality: string; rtt?: number; loss?: number; jitter?: number; up?: number };
type Hist = { rtt: number[]; loss: number[]; jitter: number[]; up: number[] };
type ConnState = { cur: SelfStats; hist: Hist };

const SPARK_W = 64;
const SPARK_H = 16;
/** Tiny sparkline polyline points from a metric's rolling history (null if too few samples). */
function miniSpark(vals: number[]): string | null {
  if (vals.length < 2) return null;
  const min = Math.min(...vals);
  const max = Math.max(...vals);
  const range = max - min || 1;
  return vals
    .map((v, i) => {
      const x = (i / (vals.length - 1)) * SPARK_W;
      const y = SPARK_H - 2 - ((v - min) / range) * (SPARK_H - 4);
      return `${x.toFixed(1)},${y.toFixed(1)}`;
    })
    .join(' ');
}

type StatRow = {
  type?: string;
  kind?: string;
  currentRoundTripTime?: number;
  totalRoundTripTime?: number;
  responsesReceived?: number;
  nominated?: boolean;
  state?: string;
  bytesSent?: number;
  packetsLost?: number;
  packetsReceived?: number;
  jitter?: number;
  timestamp: number;
};

type PcGetter = { getStats?: () => Promise<RTCStatsReport> };

/**
 * Full unfiltered stats reports from LiveKit's subscriber + publisher PeerConnections. A track-scoped
 * `getRTCStatsReport()` runs through LiveKit's filterStats, which keeps only that track's rtp stats and
 * DROPS connection-level ones — so `candidate-pair` (→ RTT) is missing. Reading the PCs directly gets the
 * whole report. Internal SDK access (livekit-client is pinned at 2.20.0); guarded, degrades to empty.
 */
async function engineReports(room: Room): Promise<{ sub?: RTCStatsReport; pub?: RTCStatsReport }> {
  const mgr = (room as unknown as { engine?: { pcManager?: { subscriber?: PcGetter; publisher?: PcGetter } } }).engine
    ?.pcManager;
  const get = async (t?: PcGetter) => {
    try {
      return t?.getStats ? await t.getStats() : undefined;
    } catch {
      return undefined;
    }
  };
  return { sub: await get(mgr?.subscriber), pub: await get(mgr?.publisher) };
}

/**
 * Poll MY connection to the SFU every 2s while connected: quality (localParticipant.connectionQuality),
 * ping (ICE candidate-pair RTT), upload bitrate (mic outbound-rtp), and download loss + jitter (a
 * subscribed remote audio track's inbound-rtp — the receive path, available whenever someone else is in
 * the channel). Null when not connected. Feeds the styled hover popover in VoicePanel.
 */
function useSelfConnStats(room: Room | undefined, connected: boolean): ConnState | null {
  const [state, setState] = useState<ConnState | null>(null);
  useEffect(() => {
    if (!room || !connected) {
      setState(null);
      return;
    }
    const lp = room.localParticipant;
    const hist: Hist = { rtt: [], loss: [], jitter: [], up: [] };
    const push = (arr: number[], v?: number) => {
      if (v == null) return;
      arr.push(v);
      if (arr.length > 30) arr.shift();
    };
    let stopped = false;
    let prevBytes = 0;
    let prevTs = 0;
    let lastRtt: number | undefined;
    const tick = async () => {
      try {
        const cur: SelfStats = { quality: lp.connectionQuality };
        const { sub, pub } = await engineReports(room);
        // RTT — nominated/succeeded ICE candidate-pair; prefer the instantaneous RTT, fall back to the
        // session average, and hold the last good value so a momentary 0-sample doesn't blank the readout.
        let r: number | undefined;
        for (const rep of [pub, sub]) {
          rep?.forEach((raw) => {
            const st = raw as unknown as StatRow;
            if (st.type !== 'candidate-pair' || !(st.nominated || st.state === 'succeeded')) return;
            const inst = st.currentRoundTripTime != null && st.currentRoundTripTime > 0 ? st.currentRoundTripTime : undefined;
            const avg =
              st.totalRoundTripTime != null && st.responsesReceived ? st.totalRoundTripTime / st.responsesReceived : undefined;
            const val = inst ?? avg;
            if (val != null && val > 0) r = val;
          });
        }
        if (r != null) lastRtt = r * 1000;
        cur.rtt = lastRtt;
        // Download loss (cumulative %) + jitter (worst) — remote inbound audio on the subscriber PC.
        let lost = 0;
        let recv = 0;
        let jit: number | undefined;
        sub?.forEach((raw) => {
          const st = raw as unknown as StatRow;
          if (st.type === 'inbound-rtp' && st.kind === 'audio') {
            if (st.packetsLost != null) lost += st.packetsLost;
            if (st.packetsReceived != null) recv += st.packetsReceived;
            if (st.jitter != null) jit = Math.max(jit ?? 0, st.jitter * 1000);
          }
        });
        if (recv + lost > 0) cur.loss = (lost / (recv + lost)) * 100;
        if (jit != null) cur.jitter = jit;
        // Upload bitrate — my outbound audio (mic + native stream audio) on the publisher PC.
        let bytes = 0;
        let ts = 0;
        pub?.forEach((raw) => {
          const st = raw as unknown as StatRow;
          if (st.type === 'outbound-rtp' && st.kind === 'audio' && st.bytesSent != null) {
            bytes += st.bytesSent;
            ts = Math.max(ts, st.timestamp);
          }
        });
        if (ts && prevTs && bytes >= prevBytes) {
          const dt = (ts - prevTs) / 1000;
          if (dt > 0) cur.up = Math.max(0, ((bytes - prevBytes) * 8) / dt / 1000);
        }
        prevBytes = bytes;
        prevTs = ts;
        push(hist.rtt, cur.rtt);
        push(hist.loss, cur.loss);
        push(hist.jitter, cur.jitter);
        push(hist.up, cur.up);
        if (!stopped) {
          setState({
            cur,
            hist: { rtt: [...hist.rtt], loss: [...hist.loss], jitter: [...hist.jitter], up: [...hist.up] },
          });
        }
      } catch {
        /* stats momentarily unavailable */
      }
    };
    void tick();
    const iv = setInterval(() => void tick(), 2000);
    return () => {
      stopped = true;
      clearInterval(iv);
    };
  }, [room, connected]);
  return state;
}

/** One compact metric row: label + coloured mini sparkline of its history + colour-coded value. */
function statRow(label: string, value: string, color: string | undefined, points: string | null) {
  return (
    <div className="vp-stat-row" key={label}>
      <span className="vp-stat-lbl">{label}</span>
      <svg className="vp-stat-spark" viewBox={`0 0 ${SPARK_W} ${SPARK_H}`} preserveAspectRatio="none" aria-hidden="true">
        {points && (
          <polyline
            points={points}
            fill="none"
            stroke={color ?? 'var(--muted-2)'}
            strokeWidth="1.5"
            strokeLinecap="round"
            strokeLinejoin="round"
          />
        )}
      </svg>
      <span className="vp-stat-val" style={color ? { color } : undefined}>
        {value}
      </span>
    </div>
  );
}

/**
 * Discord-style "voice connected" panel that sits directly above the SelfVoiceBar at the bottom of
 * the sidebar while you're in a voice channel. Shows the connection state + channel/server and a
 * disconnect button, with the screen-share / quality controls in an action row below. Rendered inside
 * VoiceConnection's RoomContext (MainLayout wraps the sidebar), so VoiceControls works here. Mic /
 * deafen / settings stay in the SelfVoiceBar below — exactly like Discord's account panel.
 */
export function VoicePanel() {
  const voice = useStore((s) => s.voice);
  const voiceState = useStore((s) => s.voiceState);
  const leaveVoice = useStore((s) => s.leaveVoice);
  const bootstrap = useStore((s) => s.bootstrap);
  const servers = useStore((s) => s.servers);
  const currentServerId = useStore((s) => s.currentServerId);
  const room = useMaybeRoomContext();
  const connStats = useSelfConnStats(room, voiceState === 'connected');
  if (!voice) return null;

  const ch = bootstrap?.channels.find((c) => c.id === voice.channelId);
  const channelName = ch?.name ?? 'Голосовой канал';
  // Server name only when the voice channel belongs to the server we're currently looking at.
  const serverName = ch ? (servers.find((s) => s.id === currentServerId)?.name ?? '') : '';
  const connected = voiceState === 'connected';

  return (
    <div className="voice-panel">
      <div className="vp-status">
        <span className={`vp-sig ${connected ? 'ok' : 'warn'}`}>
          <Icon name="signal" size={18} />
        </span>
        <div className="vp-meta">
          <span className={`vp-state ${connected ? 'ok' : 'warn'}`}>
            {connected ? 'Голосовая связь подключена' : voiceState === 'reconnecting' ? 'Переподключение…' : 'Подключение…'}
          </span>
          <span className="vp-where">
            {channelName}
            {serverName ? <span className="vp-server"> / {serverName}</span> : null}
          </span>
        </div>
        <button
          type="button"
          className="vp-leave"
          title="Отключиться"
          onClick={() => {
            playSound('leave', voice.channelId);
            leaveVoice();
          }}
        >
          <Icon name="leave" size={18} />
        </button>
        {connected && connStats && (
          <div className="vp-stats" role="tooltip">
            <div className="vp-stats-head">
              <span className="vp-stats-title">соединение</span>
              <span className={`ci-pill ${QUALITY[connStats.cur.quality]?.cls ?? 'ok'}`}>
                <span className="ci-dot" />
                {QUALITY[connStats.cur.quality]?.label ?? '—'}
              </span>
            </div>
            {statRow('Пинг', fmtMs(connStats.cur.rtt), rttColor(connStats.cur.rtt), miniSpark(connStats.hist.rtt))}
            {statRow('Потери', connStats.cur.loss != null ? `${connStats.cur.loss.toFixed(1)}%` : '—', lossColor(connStats.cur.loss), miniSpark(connStats.hist.loss))}
            {statRow('Джиттер', fmtMs(connStats.cur.jitter), jitterColor(connStats.cur.jitter), miniSpark(connStats.hist.jitter))}
            {statRow('Отдача', connStats.cur.up != null ? `${Math.round(connStats.cur.up)} кбит/с` : '—', undefined, miniSpark(connStats.hist.up))}
          </div>
        )}
      </div>
      <div className="vp-actions">
        <VoiceControls screenOnly wide />
      </div>
    </div>
  );
}
