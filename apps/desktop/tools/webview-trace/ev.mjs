// node ev.mjs <port> <urlSubstr> <file.js|expr>
import fs from 'node:fs';
const [port, urlPart, src] = process.argv.slice(2);
const expr = fs.existsSync(src) ? fs.readFileSync(src, 'utf8') : src;
const list = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json();
const page = list.find((p) => p.type === 'page' && (urlPart === 'main' ? p.url.endsWith('localhost/') : p.url.includes(urlPart)));
const ws = new WebSocket(page.webSocketDebuggerUrl);
await new Promise((r, j) => { ws.onopen = r; ws.onerror = j; });
ws.onmessage = (m) => { const msg = JSON.parse(m.data); if (msg.id === 1) { const r = msg.result?.result; console.log(msg.result?.exceptionDetails ? 'EXC ' + JSON.stringify(msg.result.exceptionDetails).slice(0, 800) : (typeof r?.value === 'string' ? r.value : JSON.stringify(r?.value ?? r, null, 1))); process.exit(0); } };
ws.send(JSON.stringify({ id: 1, method: 'Runtime.evaluate', params: { expression: expr, awaitPromise: true, returnByValue: true } }));
setTimeout(() => { console.log('TIMEOUT'); process.exit(1); }, 20000);
