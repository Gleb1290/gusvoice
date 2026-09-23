import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { instanceDocumentOriginProblem, negotiateProtocol, parseInstanceDocument } from './protocol.js';

const document = (extra: Record<string, unknown> = {}) => ({
  instance_id: 'instance',
  name: 'Гуси',
  icon_hash: 'abc123',
  domain: 'voice.example',
  client_origin: 'https://voice.example',
  api_base: 'https://api.example',
  protocol: { min: 1, max: 1 },
  features: ['link'],
  app_version: '1.0.0',
  root_key: 'root',
  keys: [],
  ...extra,
});

describe('разбор визитки федеративного инстанса', () => {
  it('javascript-адрес клиента отвергает визитку целиком', () => {
    // Ловит исполнение адреса соседа через href на публичной странице приглашения.
    assert.equal(parseInstanceDocument(document({ client_origin: 'javascript:alert(1)' })), null);
  });

  it('путь адреса клиента отбрасывается до безопасного origin', () => {
    // Ловит сборку ссылок приложения поверх навязанного соседом пути.
    assert.equal(parseInstanceDocument(document({ client_origin: 'https://voice.example/sneaky/path?x=1' }))?.clientOrigin, 'https://voice.example');
  });

  it('учётные данные в адресе API отвергают визитку', () => {
    // Ловит маскировку реального назначения подписанного запроса через userinfo URL.
    assert.equal(parseInstanceDocument(document({ api_base: 'https://trusted.example@evil.example' })), null);
  });

  it('негодное имя становится пустым, но не роняет визитку', () => {
    // Ловит отказ связи из-за показываемого текста, который можно безопасно заменить доменом.
    assert.equal(parseInstanceDocument(document({ name: 'x'.repeat(41) }))?.name, null);
    assert.equal(parseInstanceDocument(document({ name: 'good\u202ebad' }))?.name, null);
    assert.equal(parseInstanceDocument(document({ name: 'x'.repeat(40) }))?.name, 'x'.repeat(40));
  });

  it('домен со схемой отвергается, а хост с портом принимается', () => {
    // Ловит двойную схему при доказательстве домена и запрет законного нестандартного порта.
    assert.equal(parseInstanceDocument(document({ domain: 'https://voice.example' })), null);
    assert.equal(parseInstanceDocument(document({ domain: 'voice.example:8443' }))?.domain, 'voice.example:8443');
  });
});

describe('согласованность адреса визитки', () => {
  it('точный хост API и эквивалентный регистр принимаются', () => {
    // Ловит ложный разрыв связки из-за регистра DNS-имени.
    assert.equal(instanceDocumentOriginProblem({ domain: 'voice.example', apiBase: 'https://API.Example' }, 'https://api.example/api/fed/v1/instance'), null);
  });

  it('разные хосты API отвергаются даже при похожих доменных суффиксах', () => {
    // Ловит доверие соседнему сайту общей публичной зоны вроде duckdns.org.
    assert.equal(instanceDocumentOriginProblem({ domain: 'a.duckdns.org', apiBase: 'https://evil.duckdns.org' }, 'https://api.a.example'), 'api-base-mismatch');
  });

  it('порт является частью личности хоста', () => {
    // Ловит подмену сервиса на другом порту той же машины.
    assert.equal(instanceDocumentOriginProblem({ domain: 'voice.example', apiBase: 'https://api.example:8443' }, 'https://api.example'), 'api-base-mismatch');
    assert.equal(instanceDocumentOriginProblem({ domain: 'voice.example', apiBase: 'https://api.example:8443' }, 'https://api.example:8443/x'), null);
  });

  it('запасной путь через доказанный домен разрешает отдельный API-хост', () => {
    // Ловит поломку совместимости старых config.json без явного api_base.
    assert.equal(instanceDocumentOriginProblem({ domain: 'voice.example:8443', apiBase: 'https://api.example' }, 'https://voice.example:8443/api/fed/v1/instance'), null);
  });

  it('пересечение диапазонов выбирает старшую общую версию, а разрыв даёт null', () => {
    // Ловит разговор на неподдерживаемой версии вместо явного отказа совместимости.
    assert.equal(negotiateProtocol({ min: 1, max: 3 }, { min: 2, max: 4 }), 3);
    assert.equal(negotiateProtocol({ min: 1, max: 2 }, { min: 3, max: 4 }), null);
  });
});
