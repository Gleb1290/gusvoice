import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import type { Plugin } from 'vite';

function integrity(source: string | Uint8Array): string {
  return 'sha256-' + createHash('sha256').update(source).digest('base64');
}

export function offlineShell(): Plugin {
  return {
    name: 'gusvoice-offline-shell',
    apply: 'build',
    generateBundle: {
      order: 'post',
      handler(_, bundle) {
        const html = bundle['index.html'];
        if (html?.type !== 'asset') return;

        const workerPath = fileURLToPath(new URL('./offlineWorker.js', import.meta.url));
        this.addWatchFile(workerPath);
        const worker = readFileSync(workerPath, 'utf8');
        const gatePath = '/gv-gate-worklet.js';
        const gateFile = fileURLToPath(new URL('./public' + gatePath, import.meta.url));
        this.addWatchFile(gateFile);
        const assets = [{ path: gatePath, kind: 'gate', integrity: integrity(readFileSync(gateFile)) }];
        for (const file of Object.values(bundle)) {
          if (!file.fileName.startsWith('assets/')) continue;
          // Vite переименовывает ?url-ассеты, а одинаковые RNNoise wasm может объединить.
          const isRnnoiseAsset = file.type === 'asset' && file.originalFileNames.some((name) =>
            /(?:^|\/)@sapphi-red\/web-noise-suppressor\/dist\/(?:rnnoise(?:_simd)?\.wasm|rnnoise\/workletProcessor\.js)$/.test(name));
          let kind: string;
          if (isRnnoiseAsset) kind = file.fileName.endsWith('.wasm') ? 'wasm' : 'worklet';
          else if (file.fileName.endsWith('.js')) kind = 'script';
          else if (file.fileName.endsWith('.css')) kind = 'style';
          else continue;
          assets.push({
            path: '/' + file.fileName,
            kind,
            integrity: integrity(file.type === 'chunk' ? file.code : file.source),
          });
        }
        assets.sort((a, b) => a.path.localeCompare(b.path));
        const manifest = { html: integrity(html.source), assets };
        const version = createHash('sha256').update(JSON.stringify(manifest)).update(worker).digest('hex');
        this.emitFile({
          type: 'asset',
          fileName: 'sw.js',
          source: `const shell = ${JSON.stringify({ version, ...manifest })};\n${worker}`,
        });
      },
    },
  };
}
