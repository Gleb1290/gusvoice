import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { it } from 'node:test';
import * as folderRules from '../../../../packages/shared/src/dmFolders';
import { React, load, sourceOf, icon, noop, environment, click, mutate } from './R171.phoneHarness';
import type * as AndroidBack from '../androidBack';

const source = sourceOf('DmFolderSettings');
const backSource = readFileSync(new URL('../androidBack.ts', import.meta.url), 'utf8');
type Editor = React.ComponentType<{ editing: { id: null; draft: {
  title: string; emoticon: null; flags: number; include: string[]; exclude: string[];
} }; onDone: () => void }>;

async function check(picking: 'include' | 'exclude' | null, raw = source) {
  await environment(async (host, render) => {
    let done = 0;
    const back = load<typeof AndroidBack>(backSource, {
      './hotkeys': { isAndroid: () => true }, './store': { useStore: { getState: () => ({}) } },
    }, { KeyboardEvent: window.KeyboardEvent });
    const { FolderEditor } = load<{ FolderEditor: Editor }>(raw + '\nexport { FolderEditor };', {
      '@gusvoice/shared': folderRules, '../androidBack': back,
      '../confirm': { confirmAction: async () => false }, '../convSyncRules': { serverGroups: () => false },
      '../dmListRules': { dmMuteOf: () => null, muteActive: () => false },
      '../dmRowRules': { matchDmName: () => false }, '../dmFolders': { useDmFolders: noop },
      '../peerName': { usePeerName: () => (_id: string, fallback: string) => fallback,
        dmPeerLabel: () => 'dmtest_a' },
      '../store': { useStore: (select: (s: any) => unknown) => select({ dms: [], serverFeatures: [] }) },
      '../toast': { toastError: noop }, './Avatar': { Avatar: () => React.createElement('i') },
      './DmFolderBar': { takeFolderEditRequest: () => null }, './Icon': { Icon: icon },
    });
    await render(React.createElement(FolderEditor, { editing: { id: null,
      draft: { title: 'Папка', emoticon: null, flags: 0, include: [], exclude: [] } }, onDone: () => done++ }));
    if (picking) {
      await click(host, picking === 'include' ? '.dmf-add' : '.dmf-add:last-of-type');
      assert.equal(!!host.querySelector('.sheet-search'), true, 'открыт выбор бесед');
      assert.equal(host.querySelector('.dmf-head strong')?.textContent, picking === 'include' ? 'Добавить беседы' : 'Исключить беседы', 'открыт именно выбранный вид включения или исключения');
      await React.act(async () => assert.equal(back.stepBack(), true));
      assert.equal(done, 0, 'первая Назад не покидает редактор');
      assert.equal(!!host.querySelector('.sheet-search'), false, 'выбор закрыт');
      assert.equal(!!host.querySelector('input[placeholder="Название папки"]'), true, 'редактор снова видим');
    }
    await React.act(async () => assert.equal(back.stepBack(), true));
    assert.equal(done, 1, 'следующая Назад возвращает к списку папок один раз');
    await render(null);
    assert.equal(back.stepBack(), false, 'unmount снимает перехватчик');
    assert.equal(done, 1);
  });
}

for (const picking of ['include', 'exclude', null] as const) it(`R179 Назад ${picking ? `из выбора ${picking === 'include' ? 'включённых' : 'исключённых'} бесед` : 'из редактора без выбора'} идёт ровно на один уровень`, async () => {
  // Ошибка глубины теряет редактирование папки; cleanup не должен оставлять невидимый обработчик.
  await check(picking);
});
it('R179 немедленный выход из редактора вместо сброса выбора обнаруживается системной Назад', async () => {
  // Оригинал и контрфакт исполняют настоящие FolderEditor и стек androidBack.
  await check('include');
  const broken = mutate(source, 'if (picking) setPicking(null);\n        else onDone();', 'onDone();');
  await assert.rejects(() => check('include', broken), assert.AssertionError);
});
