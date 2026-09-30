// Снять трейс всех процессов WebView2 через CDP браузерного уровня.
// node trace.mjs <порт> <секунд> <имя>  → <имя>.json (формат Chrome trace)
import fs from 'node:fs';

const port = process.argv[2] || '9223';
const secs = Number(process.argv[3] || 20);
const name = process.argv[4] || 'trace';

const ver = await (await fetch(`http://127.0.0.1:${port}/json/version`)).json();
const ws = new WebSocket(ver.webSocketDebuggerUrl);
await new Promise((r, j) => { ws.onopen = r; ws.onerror = j; });

let id = 0;
const waiters = new Map();
const events = [];
let done;
const finished = new Promise((r) => { done = r; });
ws.onmessage = (m) => {
  const msg = JSON.parse(m.data);
  if (msg.id && waiters.has(msg.id)) { waiters.get(msg.id)(msg); waiters.delete(msg.id); return; }
  if (msg.method === 'Tracing.dataCollected') events.push(...msg.params.value);
  if (msg.method === 'Tracing.tracingComplete') done();
};
const send = (method, params = {}) => new Promise((r) => { const i = ++id; waiters.set(i, r); ws.send(JSON.stringify({ id: i, method, params })); });

const categories = [
  '-*', 'toplevel', 'devtools.timeline', 'disabled-by-default-devtools.timeline',
  'disabled-by-default-devtools.timeline.frame', 'blink', 'blink.animations', 'cc', 'viz', 'gpu', 'media',
  'webrtc', 'audio', 'v8.execute', 'disabled-by-default-v8.cpu_profiler', 'benchmark', 'renderer.scheduler',
  'disabled-by-default-devtools.timeline.stack', 'loading', 'ipc', 'mojom', 'input', 'latencyInfo',
];
const r = await send('Tracing.start', {
  transferMode: 'ReportEvents',
  traceConfig: { recordMode: 'recordContinuously', includedCategories: categories, excludedCategories: ['*'] },
});
if (r.error) { console.log('start error', JSON.stringify(r.error)); process.exit(1); }
console.log(`tracing ${secs}s…`);
await new Promise((res) => setTimeout(res, secs * 1000));
await send('Tracing.end');
await Promise.race([finished, new Promise((res) => setTimeout(res, 60000))]);
fs.writeFileSync(`${name}.json`, JSON.stringify({ traceEvents: events }));
console.log(`saved ${name}.json, ${events.length} events`);
process.exit(0);
