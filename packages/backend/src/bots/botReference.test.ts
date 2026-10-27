import assert from 'node:assert/strict';
import { it } from 'node:test';
import { BOT_METHOD_SPECS, BOT_EVENT_SPECS } from './botSpec.js';
import { document, loadPure, read, reference, referenceSource, replaceOnce, texts, type Reference } from './botReference.harness.js';

it('R307 тексты обоих языков полностью покрывают настоящий документ', () => {
  assert.deepEqual(Array.from(reference().botTextErrors(document(), texts())), []);
});
for (const lang of ['en', 'ru'] as const) it(`R307 отсутствие обязательного текста ${lang} обнаруживается адресно`, () => {
  const t = texts(); delete t[lang]['method.getMe.summary'];
  assert.equal(reference().botTextErrors(document(), t).some(e => e.startsWith(`text.${lang}.json:`) && e.includes('method.getMe.summary')), true);
});
it('R307 ключ только в одном языке и нестроковое значение не проходят проверку', () => {
  const t = texts(); t.en['method.getMe.notes'] = 'Only one language'; delete t.ru['method.getMe.notes'];
  const errors = reference().botTextErrors(document(), t);
  assert.equal(errors.some(e => e.includes('text.ru.json:') && e.includes('method.getMe.notes')), true);
  for (const value of [42, null, ['text', 42], {}]) {
    const next = texts(); next.en['method.getMe.summary'] = value as never;
    assert.equal(reference().botTextErrors(document(), next).some(e => e.includes('method.getMe.summary') && e.includes('не строка')), true);
  }
  const valid = texts(); valid.en['method.getMe.summary'] = ['First line', 'Second line'];
  assert.deepEqual(Array.from(reference().botTextErrors(document(), valid)), []);
});
function extraKeys(r = reference()) {
  const t = texts();
  for (const lang of ['en', 'ru'] as const) { t[lang]['param.*.not_a_parameter'] = 'Unused'; t[lang]['method.noSuchMethod.summary'] = 'Unknown'; }
  const errors = r.botTextErrors(document(), t);
  assert.equal(errors.filter(e => e.includes('лишний ключ')).length, 4, 'R307_TEXT_EXTRA: лишние и неиспользуемые wildcard-ключи запрещены');
}
it('R307 лишний метод и неиспользованный wildcard не маскируют забытое удаление текста', () => extraKeys());
it('R307 общий param.*.chat_id покрывает методы без индивидуальной копии текста', () => {
  const t = texts();
  for (const lang of ['en', 'ru'] as const) {
    t[lang]['param.*.chat_id'] = 'Target chat';
    for (const key of Object.keys(t[lang])) if (/^param\.[^.]+\.chat_id$/.test(key) && key !== 'param.*.chat_id') delete t[lang][key];
  }
  assert.deepEqual(Array.from(reference().botTextErrors(document(), t)), []);
});
function section(text: string, name: string) { return text.split(`#### ${name}\n`)[1]?.split('\n#### ')[0] ?? ''; }
function required(r = reference()) {
  const rendered = section(r.renderBotReference(document(), 'en', texts().en), 'sendMessage');
  assert.equal(rendered.includes('| **`chat_id`** |'), true, 'R307_REFERENCE_REQUIRED: обязательный параметр выделен');
  assert.equal(rendered.includes('| `text` |'), true, 'текст необязателен — сообщение может состоять из файла');
}
for (const lang of ['en', 'ru'] as const) it(`R307 справочник ${lang} содержит каждый метод и событие, результат детерминирован`, () => {
  const r = reference(), doc = document(), t = texts()[lang];
  const full = r.renderBotReference(doc, lang, t), llm = r.renderBotReferenceLlm(doc, texts().en);
  assert.equal(full, r.renderBotReference(doc, lang, t)); assert.equal(llm, r.renderBotReferenceLlm(doc, texts().en));
  // Имя — с начала строки: pinChatMessage не должно совпадать внутри unpinChatMessage.
  for (const method of BOT_METHOD_SPECS) { assert.equal(full.split(`#### ${method.name}\n`).length - 1, 1); assert.equal(llm.split(`\n${method.name}(`).length - 1, 1); }
  for (const event of BOT_EVENT_SPECS) { assert.equal(full.includes(`| \`${event.type}\` |`), true); assert.equal(llm.includes(`\n${event.type}:`), true); }
});
it('R307 параметры обязательности, multipart files[0] и диапазон getUpdates печатаются из схемы', () => {
  required(); const r = reference(), t = texts();
  const full = r.renderBotReference(document(), 'en', t.en), llm = r.renderBotReferenceLlm(document(), t.en);
  assert.match(section(full, 'sendMessage'), /\| `files\[0\]` \|[^\n]*multipart only/);
  assert.match(section(full, 'getUpdates'), /\| `limit` \|[^\n]*1–100/);
  assert.match(llm, /getUpdates\([^\n]*limit\?: int 1–100/);
});
it('R307 вставка справочника идемпотентна и сохраняет ручные абзацы вокруг', () => {
  const r = reference(), input = `manual top\n${r.REF_BEGIN}\nold\n${r.REF_END}\nmanual bottom`;
  const result = r.spliceBotReference(input, 'new\nreference');
  assert.equal(result, `manual top\n${r.REF_BEGIN}\n\nnew\nreference\n\n${r.REF_END}\nmanual bottom`);
  assert.equal(r.spliceBotReference(result, 'new\nreference'), result);
});
for (const kind of ['нет обоих', 'нет начала', 'нет конца', 'обратный порядок', 'две пары'] as const) it(`R307 повреждённые маркеры: ${kind} отвергаются`, () => {
  const r = reference(), a = r.REF_BEGIN, b = r.REF_END;
  const input = { 'нет обоих': 'plain', 'нет начала': b, 'нет конца': a, 'обратный порядок': `${b}\n${a}`, 'две пары': `${a}\n${b}\n${a}\n${b}` }[kind];
  assert.throws(() => r.spliceBotReference(input, 'block'), /ровно одна пара маркеров/);
});
it('R307 публичные пути включают схему и английский плейбук, внутренний план не опубликован', () => {
  const paths = read('.gitea/sanitize/public-paths.txt').split('\n').map(s => s.trim()).filter(s => s && !s.startsWith('#'));
  const covers = (name: string) => paths.some(p => p.endsWith('/') ? name.startsWith(p) : name === p);
  for (const name of ['docs/bot-api/openapi.json', 'docs/bot-api/text.en.json', 'docs/bot-api/text.ru.json', 'docs/bots-playbook.md']) assert.equal(covers(name), true, name);
  assert.equal(covers('docs/bots-plan.md'), false);
  const llm = read('docs/bots-llm.md'); assert.match(llm, /openapi\.json/); assert.doesNotMatch(llm, /stage 1/i);
  assert.equal(llm.includes(reference().REF_BEGIN), true);
});
it('R307 контрфакт: игнорирование второго языка обнаруживается отсутствием RU-диагностики', () => {
  const check = (r: Reference) => { const t = texts(); delete t.ru['method.getMe.summary'];
    assert.equal(r.botTextErrors(document(), t).some(e => e.startsWith('text.ru.json:') && e.includes('method.getMe.summary')), true, 'R307_TEXT_RU: обязательный RU-текст проверяется'); };
  check(reference());
  assert.throws(() => check(loadPure<Reference>(replaceOnce(referenceSource, 'return errors;', "return errors.filter(e => !e.startsWith('text.ru.json:'));"))),
    e => e instanceof assert.AssertionError && e.message.startsWith('R307_TEXT_RU:') && e.actual === false && e.expected === true);
});
it('R307 контрфакт: разрешение лишних ключей не проходит контракт текстов', () => {
  extraKeys();
  assert.throws(() => extraKeys(loadPure<Reference>(replaceOnce(referenceSource, 'if (!used.has(k)) errors.push', 'if (false) errors.push'))),
    e => e instanceof assert.AssertionError && e.message.startsWith('R307_TEXT_EXTRA:') && e.actual === 0 && e.expected === 4);
});
it('R307 контрфакт: потеря выделения обязательности не проходит справочник', () => {
  required();
  assert.throws(() => required(loadPure<Reference>(replaceOnce(referenceSource, 'const name = r.has(p) ?', 'const name = false ?'))),
    e => e instanceof assert.AssertionError && e.message.startsWith('R307_REFERENCE_REQUIRED:') && e.actual === false && e.expected === true);
});
