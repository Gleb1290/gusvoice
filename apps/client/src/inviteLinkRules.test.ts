import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import { describe, it } from 'node:test';
import ts from 'typescript';
import { inviteCodeFromPath, inviteLink, isBrokenInvitePath, parseInviteParam, stripInviteParam } from './inviteLinkRules.js';

describe('ссылки приглашения веб-клиента', () => {
  it('код длиной ровно 4 и 64 символа принимается, соседние границы отвергаются', () => {
    // Ловит ошибку на границах формата кода, которым обмениваются мастер и регистрация.
    assert.equal(parseInviteParam('?invite=Ab12'), 'Ab12');
    assert.equal(parseInviteParam(`?invite=${'a'.repeat(64)}`), 'a'.repeat(64));
    assert.equal(parseInviteParam('?invite=abc'), null);
    assert.equal(parseInviteParam(`?invite=${'a'.repeat(65)}`), null);
  });

  it('пробелы вокруг кода обрезаются, а знаки пунктуации отвергаются', () => {
    // Ловит как отказ скопированному коду, так и пропуск чужого текста внутрь API.
    assert.equal(parseInviteParam('?invite=%20Ab12%20'), 'Ab12');
    assert.equal(parseInviteParam('?invite=Ab-12'), null);
  });

  it('удаление invite сохраняет остальные параметры и удаляет все повторы', () => {
    // Ловит утечку кода в историю адреса после автоматического входа.
    assert.equal(stripInviteParam('?x=1&invite=Ab12&invite=Cd34&y=2'), '?x=1&y=2');
    assert.equal(stripInviteParam('?invite=Ab12'), '');
  });

  it('сборка ссылки убирает лишние слеши и кодирует код', () => {
    // Ловит двойной слеш и повреждение специальных символов при копировании ссылки.
    assert.equal(inviteLink('https://voice.example///', 'A B'), 'https://voice.example/?invite=A%20B');
  });

  it('путь принимает только сегмент /i/ с теми же границами кода', () => {
    // Ловит расхождение двух дверей одного приглашения: query и публичной страницы.
    assert.equal(inviteCodeFromPath('/i/Ab12'), 'Ab12');
    assert.equal(inviteCodeFromPath('/x/Ab12'), null);
    assert.equal(inviteCodeFromPath('/i/abc'), null);
  });

  it('битый процент в пути даёт broken-link вместо URIError, а percent-код принимается', () => {
    // Ссылка из чужого чата может быть обрезана или испорчена; она не должна валить весь экран входа.
    for (const path of ['/i/%', '/i/%E0%A4', '/i/abc', '/i/']) {
      assert.doesNotThrow(() => inviteCodeFromPath(path), `разбор ${path} не должен бросать`);
      assert.equal(inviteCodeFromPath(path), null, `${path} не содержит пригодного кода`);
      assert.equal(isBrokenInvitePath(path), true, `${path} явно распознаётся как битое приглашение`);
    }
    assert.equal(inviteCodeFromPath('/i/Ab%31%32'), 'Ab12', 'валидная percent-форма декодируется');
    for (const path of ['/i/Ab12', '/x/%', '/i', '/']) assert.equal(isBrokenInvitePath(path), false, `${path} не помечается битым приглашением`);

    const pathSource = readFileSync(new URL('./inviteLinkRules.ts', import.meta.url), 'utf8').replace(/\r\n/g, '\n');
    const changed = pathSource.replace('  } catch {\n    return null;\n  }', '  } catch {\n    throw new URIError("broken escape");\n  }');
    assert.notEqual(changed, pathSource, 'реальный модуль содержит обработку URIError');
    const mod = { exports: {} as Record<string, unknown> };
    runInNewContext(ts.transpileModule(changed, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText,
      { module: mod, exports: mod.exports, URLSearchParams, URIError });
    const mutant = mod.exports as typeof import('./inviteLinkRules.js');
    assert.throws(() => assert.doesNotThrow(() => mutant.inviteCodeFromPath('/i/%'), 'битый путь остаётся безопасным'), assert.AssertionError,
      'мутант без безопасного отказа обязан провалить контракт');
  });
});
