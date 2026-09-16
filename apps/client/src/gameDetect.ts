// Local game detection (issue #40, Phase 1A — desktop, no Steam login). The DESKTOP shell enumerates
// running windows/exe names natively (apps_enum.rs `list_apps`/`foreground_exe`); this module turns that
// raw exe list into "what game are you playing" by matching against a CURATED allowlist (games.json).
//
// Why an allowlist and not "any process": we only ever want to surface real games — matching arbitrary
// processes would broadcast nonsense like "Playing chrome.exe". The catalog is easy to grow (games.json).
//
// Pure + dependency-free on purpose (only the JSON import) so it's trivially testable off-DOM.
import catalog from './games.json';

export type DetectedGame = { exe: string; name: string; appId?: number };

type CatalogEntry = { name: string; appId?: number };
// Keys in games.json are already lowercase exe basenames; we normalise lookups to match.
const CATALOG = catalog as Record<string, CatalogEntry>;

/** Reduce a full path or bare exe to a lowercase basename: "C:\\Games\\Dota2.exe" → "dota2.exe". */
export function exeBasename(pathOrName: string): string {
  const cleaned = pathOrName.trim().replace(/[/\\]+$/, '');
  const base = cleaned.split(/[/\\]/).pop() ?? cleaned;
  return base.toLowerCase();
}

/**
 * Match a list of running executables (full paths or bare names, any case) against the curated
 * catalog and return the game to show as activity, or null if none is a known game.
 *
 * When several known games are running we keep the FIRST match in input order — callers that know the
 * focused app should pass it first (foreground-first) so the active game wins; otherwise it's simply
 * deterministic.
 */
export function matchRunningGame(exes: readonly string[]): DetectedGame | null {
  for (const raw of exes) {
    const exe = exeBasename(raw);
    const hit = CATALOG[exe];
    if (hit) return { exe, name: hit.name, appId: hit.appId };
  }
  return null;
}

/** True if `exe` (path or bare name, any case) is a known game. */
export function isKnownGame(exe: string): boolean {
  return exeBasename(exe) in CATALOG;
}

/** Number of catalog entries — handy for guards/tests. */
export function catalogSize(): number {
  return Object.keys(CATALOG).length;
}
