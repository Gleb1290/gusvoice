import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { it } from 'node:test';
import { runInNewContext } from 'node:vm';
import ts from 'typescript';
import { photoCompressible } from './attachRules';
import * as rules from './autoDownloadRules';
import { GROUP_ITEMS, type SettingsSnapshot } from './settingsChanged';

function mutated(from: string, to: string): typeof rules {
  const source = readFileSync(new URL('./autoDownloadRules.ts', import.meta.url), 'utf8');
  assert.ok(source.includes(from), 'точка мутации найдена');
  const module = { exports: {} as Record<string, unknown> };
  runInNewContext(ts.transpileModule(source.replace(from, to), { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText,
    { module, exports: module.exports, require: (id: string) => { assert.equal(id, './attachRules'); return { photoCompressible }; } });
  return module.exports as typeof rules;
}

it('файлы и голосовые не заглушаются автозагрузкой, а выключатель действует только на свою пару', () => {
  const s = rules.acceptAutoDownload({ photo: { dm: false } });
  for (const source of ['dm', 'group', 'channel'] as const) {
    assert.equal(rules.shouldAutoLoad('file', 99999999, source, s), true);
    assert.equal(rules.shouldAutoLoad('voice', 99999999, source, s), true);
  }
  assert.equal(rules.shouldAutoLoad('photo', 1, 'dm', s), false);
  assert.equal(rules.shouldAutoLoad('photo', 1, 'group', s), true);
  assert.equal(rules.shouldAutoLoad('video', 1, 'dm', s), true);
  assert.equal(rules.shouldAutoLoad('photo', 1, null, { ...s, photo: { dm: false, group: false, channel: false } }), true);
  const mutant = mutated("if (kind === 'file' || kind === 'voice') return true;", "if (kind === 'file') return true;");
  assert.throws(() => mutant.shouldAutoLoad('voice', 1, 'dm', s), /Cannot read properties/,
    'мутант начинает читать несуществующий переключатель голосового вместо безусловного допуска');
  const noSourceDefault = mutated('if (!source) return true;', 'if (!source) return false;');
  assert.throws(() => assert.equal(noSourceDefault.shouldAutoLoad('photo', 1, null, s), true), assert.AssertionError,
    'мутант показывает заглушку у отложенного вложения без источника');
});

it('границы 10 МБ включительны, saveData ограничивает фото и видео отдельно', () => {
  const s = rules.acceptAutoDownload({});
  const mb = 1024 * 1024;
  assert.equal(rules.shouldAutoLoad('photo', 10 * mb, 'dm', s), true);
  assert.equal(rules.shouldAutoLoad('photo', 10 * mb + 1, 'dm', s), false);
  assert.equal(rules.shouldAutoLoad('photo', rules.SAVE_DATA_PHOTO_BYTES, 'dm', s, true), true);
  assert.equal(rules.shouldAutoLoad('photo', rules.SAVE_DATA_PHOTO_BYTES + 1, 'dm', s, true), false);
  assert.equal(rules.shouldAutoLoad('video', rules.SAVE_DATA_VIDEO_BYTES, 'dm', s, true), true);
  assert.equal(rules.shouldAutoLoad('video', rules.SAVE_DATA_VIDEO_BYTES + 1, 'dm', s, true), false);
  assert.equal(rules.shouldAutoplay('gif', s), true);
  assert.equal(rules.shouldAutoplay('video', { ...s, autoplayVideo: true }), true);
  assert.equal(rules.shouldAutoplay('video', { ...s, autoplayVideo: true }, true), false);
  const mutant = mutated('bytes <= (saveData ? Math.min(s.photoLimitMb * MB, SAVE_DATA_PHOTO_BYTES) : s.photoLimitMb * MB)', 'bytes < (saveData ? Math.min(s.photoLimitMb * MB, SAVE_DATA_PHOTO_BYTES) : s.photoLimitMb * MB)');
  assert.notEqual(mutant.shouldAutoLoad('photo', 10 * mb, 'dm', s), true, 'мутант с исключительной границей теряет точный лимит');
  const noSaveLimit = mutated('Math.min(s.photoLimitMb * MB, SAVE_DATA_PHOTO_BYTES)', 's.photoLimitMb * MB');
  assert.throws(() => assert.equal(noSaveLimit.shouldAutoLoad('photo', rules.SAVE_DATA_PHOTO_BYTES + 1, 'dm', s, true), false), assert.AssertionError,
    'мутант игнорирует потолок экономии трафика для фото');
  const saveAutoplay = mutated('if (saveData) return false;', 'if (false) return false;');
  assert.throws(() => assert.equal(saveAutoplay.shouldAutoplay('video', { ...s, autoplayVideo: true }, true), false), assert.AssertionError,
    'мутант запускает видео даже при включённой экономии трафика');
});

it('видео и кружки включены по умолчанию, а кружок отдельно уважает autoplayRound и saveData', () => {
  // Настройка кружка независима от GIF: иначе выключенный GIF неожиданно останавливает видеосообщения.
  const check = (api: typeof rules) => {
    assert.equal(api.AUTO_DOWNLOAD_DEFAULTS.autoplayVideo, true);
    assert.equal(api.AUTO_DOWNLOAD_DEFAULTS.autoplayRound, true);
    assert.equal(api.acceptAutoDownload({}).autoplayRound, true);
    assert.equal(api.acceptAutoDownload({ autoplayRound: false }).autoplayRound, false);
    assert.equal(api.acceptAutoDownload({ autoplayRound: 'false' }).autoplayRound, true);
    assert.equal(api.shouldAutoplayRound({ ...api.AUTO_DOWNLOAD_DEFAULTS, autoplayRound: false, autoplayGif: true }, false), false);
    assert.equal(api.shouldAutoplayRound({ ...api.AUTO_DOWNLOAD_DEFAULTS, autoplayRound: true, autoplayGif: false }, false), true);
    assert.equal(api.shouldAutoplayRound(api.AUTO_DOWNLOAD_DEFAULTS, true), false);
  };
  check(rules);
  check(mutated('return !saveData && s.autoplayRound;', 'return !saveData && s.autoplayRound;'));
  assert.throws(() => check(mutated('return !saveData && s.autoplayRound;', 'return !saveData && s.autoplayGif;')), assert.AssertionError,
    'мутант использует настройку GIF вместо отдельного выключателя кружков');
});

it('битое поле получает заводское значение, соседние сохранены; ближайшая ступень и приоритет определения типа верны', () => {
  const accepted = rules.acceptAutoDownload({ photo: { dm: false, group: 'false' }, videoLimitMb: '40', autoplayGif: false, autoplayVideo: true });
  assert.equal(accepted.photo.dm, false); assert.equal(accepted.photo.group, true);
  assert.equal(accepted.videoLimitMb, 50); assert.equal(accepted.autoplayGif, false); assert.equal(accepted.autoplayVideo, true);
  assert.equal(rules.snapLimit(37, 10), 36); assert.equal(rules.snapLimit(38, 10), 38);
  assert.equal(rules.mediaKindOf({ contentType: 'image/gif', asFile: true, gif: true, waveform: [1] }), 'voice');
  assert.equal(rules.mediaKindOf({ contentType: 'image/gif', asFile: true, gif: true }), 'file');
  assert.equal(rules.mediaKindOf({ contentType: 'image/gif', gif: true }), 'gif');
  assert.equal(rules.mediaKindOf({ contentType: 'image/png' }), 'photo');
  const badFallback = mutated('photo: bySource(r.photo, d.photo),', 'photo: d.photo,');
  assert.throws(() => assert.equal(badFallback.acceptAutoDownload({ photo: { dm: false } }).photo.dm, false), assert.AssertionError,
    'мутант сбрасывает валидный выбор вместе с битым соседним полем');
  const wrongTie = mutated('Math.abs(s - n) < Math.abs(best - n)', 'Math.abs(s - n) <= Math.abs(best - n)');
  assert.throws(() => assert.equal(wrongTie.snapLimit(37, 10), 36), assert.AssertionError,
    'мутант меняет сохранённое значение на соседнюю ступень при равном расстоянии');
});

it('«Изменено» замечает один выключенный источник и старые снимки читаются как заводские', () => {
  const autodlMark = GROUP_ITEMS['set-g-autodl']![0]!;
  const base = { autoDownload: rules.AUTO_DOWNLOAD_DEFAULTS } as SettingsSnapshot;
  const changed = { autoDownload: { ...rules.AUTO_DOWNLOAD_DEFAULTS, photo: { ...rules.AUTO_DOWNLOAD_DEFAULTS.photo, dm: false } } } as SettingsSnapshot;
  assert.notDeepEqual(autodlMark(changed), autodlMark(base));
  assert.deepEqual(autodlMark({} as SettingsSnapshot), autodlMark({ ...base, autoDownload: undefined }));
});
