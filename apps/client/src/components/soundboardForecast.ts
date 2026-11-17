export type SoundboardScope = 'off' | 'all' | 'selected';
export interface SoundboardForecastServer { id: string; clipCount: number; projectedClipCount: number }
export function soundboardScopeIncludes(mode: SoundboardScope, ids: string[], id: string): boolean {
  return mode === 'all' || (mode === 'selected' && ids.includes(id));
}
export function soundboardForecast(servers: SoundboardForecastServer[], mode: SoundboardScope, ids: string[]): number {
  return servers.reduce((sum, server) => sum + (soundboardScopeIncludes(mode, ids, server.id) ? server.projectedClipCount : server.clipCount), 0);
}
