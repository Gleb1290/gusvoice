import { counterfact } from '../../shared/test/counterfacts.js';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { it } from 'node:test';
import { runInNewContext } from 'node:vm';
import ts from 'typescript';
import * as shared from '@gusvoice/shared';

const read = (file: string) => readFileSync(new URL(`./${file}`, import.meta.url), 'utf8').replace(/\r\n/g, '\n');
const serializeSource = read('serialize.ts');

function serialization(raw = serializeSource) {
  const blocked = (id: string) => new Proxy({}, { get: (_target, key) => {
    if (key === '__esModule') return true;
    return () => assert.fail(`неожиданная граница serialize ${id}.${String(key)}`);
  } });
  const deps: Record<string, unknown> = {
    '@gusvoice/shared': shared, './auth.js': blocked('auth'), './superAdminRules.js': blocked('superAdminRules'),
    './env.js': { env: {} }, './linkThreats.js': { dangerousLinksOf: () => [] },
  };
  for (const id of ['./federation/instanceLabels.js', './statusRules.js', './shopRules.js', './callRules.js', './lastSeenRules.js']) deps[id] = blocked(id);
  const module = { exports: {} as typeof import('./serialize.js') };
  // Полный serialize с закрытым перечнем импортов; ни env, ни другие подсистемы не загружаются.
  runInNewContext(ts.transpileModule(raw, { compilerOptions: {
    module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022,
  } }).outputText, { module, exports: module.exports,
    require(id: string) { assert.ok(Object.hasOwn(deps, id), `описана граница serialize ${id}`); return deps[id]; },
  });
  return module.exports;
}
const at = new Date('2026-10-19T10:00:00Z');
const message = { id: 'message', channelId: 'channel', content: '@Роль', createdAt: at, editedAt: null,
  author: { id: 'author', username: 'author', displayName: 'Автор', avatarUrl: null, createdAt: at } };
function dto(raw = serializeSource) {
  const serialize = serialization(raw);
  for (const mentionRoles of [undefined, null, []]) {
    const result = serialize.serializeMessage({ ...message, mentionRoles });
    assert.equal(Object.hasOwn(result, 'mentionRoles'), false, 'R266 DTO: пустое ролевое поле отсутствует, прежняя форма сохранена');
    assert.equal(result.content, '@Роль'); assert.equal(result.author.id, 'author');
  }
  const result = serialize.serializeMessage({ ...message, mentionRoles: ['role-a', 'role-b'] });
  assert.deepEqual([...(result.mentionRoles ?? [])], ['role-a', 'role-b'], 'R266 DTO: непустые сохранённые id доходят без потери');
  assert.equal(result.createdAt, at.toISOString());
}
// Класс ошибки: необязательное поле превращается в обязательный пустой массив либо теряется на выдаче.
it('R266 настоящий serializeMessage выдаёт mentionRoles только для непустого сохранённого списка', () => dto());
it('R266 мутанты лишнего пустого поля и потери непустого поля пойманы на настоящем DTO после original-first', () => {
  const anchor = '...(m.mentionRoles?.length ? { mentionRoles: m.mentionRoles } : {}),';
  for (const [replacement, marker] of [
    ['mentionRoles: m.mentionRoles ?? [],', 'R266 DTO: пустое ролевое поле отсутствует'],
    ['', 'R266 DTO: непустые сохранённые id доходят без потери'],
  ]) {
    dto();
    counterfact(() => {
    assert.equal(serializeSource.split(anchor).length - 1, 1);
    assert.throws(() => dto(serializeSource.replace(anchor, replacement)),
      e => e instanceof assert.AssertionError && e.message.startsWith(marker));
    });
  }
});
