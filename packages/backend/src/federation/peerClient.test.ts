import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { proveDomain } from './peerClient.js';
import type { SafeResponse } from '../safeFetch.js';

const rootKey = Buffer.from('same-root-key').toString('base64url');
const response = (url: string, body: unknown, status = 200): SafeResponse => ({
  url, status, contentType: 'application/json', body: typeof body === 'string' ? body : JSON.stringify(body),
});
const wireDocument = (apiBase: string) => ({
  instance_id: 'copied-id', name: 'Victim', icon_hash: null, domain: 'victim.com',
  client_origin: 'https://victim.com', api_base: apiBase, protocol: { min: 1, max: 1 },
  features: [], app_version: null, root_key: rootKey, keys: [],
});

describe('доказательство домена через веб-клиент', () => {
  it('скопированный публичный rootKey не доказывает визитку с другим api_base', async () => {
    // Ловит захват чужого домена самозванцем, который скопировал публичный корневой ключ владельца.
    const calls: string[] = [];
    const result = await proveDomain(
      { domain: 'victim.com', apiBase: 'https://evil.example', rootKey },
      async (req) => {
        calls.push(req.url);
        if (calls.length === 1) return response(req.url, { apiUrl: 'https://api.victim.com' });
        return response(req.url, wireDocument('https://api.victim.com'));
      },
    );
    assert.equal(result.ok, false);
    if (!result.ok) {
      assert.equal(result.problem, 'domain-unproven');
      assert.match(result.detail ?? '', /указывает на api\.victim\.com/);
    }
    assert.deepEqual(calls, [
      'https://victim.com/config.json',
      'https://api.victim.com/api/fed/v1/instance',
    ]);
  });

  it('честный config.json с тем же API доказывает домен одним запросом', async () => {
    // Ловит чрезмерный отказ обычной раскладке с разными веб- и API-хостами.
    const calls: string[] = [];
    const result = await proveDomain(
      { domain: 'victim.com', apiBase: 'https://api.victim.com', rootKey },
      async (req) => { calls.push(req.url); return response(req.url, { apiUrl: 'https://api.victim.com' }); },
    );
    assert.deepEqual(result, { ok: true, value: true });
    assert.deepEqual(calls, ['https://victim.com/config.json']);
  });
});
