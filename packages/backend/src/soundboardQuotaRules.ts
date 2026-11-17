import { z } from 'zod';
import { SOUNDBOARD_MAX_CLIPS } from './soundboardRules.js';

export const DEFAULT_SOUNDBOARD_PER_USER_LIMIT = 5;
export const soundboardLimit = z.number().int().min(0).max(2_147_483_647);

export const soundboardSettingsSchema = z.object({
  mode: z.enum(['off', 'all', 'selected']),
  serverIds: z.array(z.string().min(1)),
  legacyLimit: soundboardLimit,
});

export type SoundboardSettings = z.infer<typeof soundboardSettingsSchema>;

export const DEFAULT_SOUNDBOARD_SETTINGS: SoundboardSettings = {
  mode: 'off',
  serverIds: [],
  legacyLimit: SOUNDBOARD_MAX_CLIPS,
};

export function usesPersonalSoundboardQuota(settings: SoundboardSettings, serverId: string): boolean {
  return settings.mode === 'all' || (settings.mode === 'selected' && settings.serverIds.includes(serverId));
}

export function projectSoundboard(
  perUserLimit: number,
  editors: ReadonlySet<string>,
  countByAuthor: ReadonlyMap<string | null, number>,
): { eligibleEditors: number; clipCount: number; projectedClipCount: number } {
  let clipCount = 0;
  for (const count of countByAuthor.values()) clipCount += count;

  let projectedClipCount = clipCount;
  for (const editorId of editors) {
    projectedClipCount += Math.max(0, perUserLimit - (countByAuthor.get(editorId) ?? 0));
  }

  return { eligibleEditors: editors.size, clipCount, projectedClipCount };
}
