/* A skill's build dependencies. A fresh install (the plugin, npx skills, a plain copy) has no node_modules yet, so the
   first build that needs one installs them once, from the skill's pinned lockfile. */
import { existsSync } from 'node:fs';
import { join } from 'node:path';

const installed = new Set<string>();

/** Import a build dependency of the skill in `dir`. Resolved from the skill's own folder, not from the kit's, since the
    kit is shared and has no packages of its own. */
export async function need<T>(spec: string, dir: string): Promise<T> {
  // Looked for on disk, not by resolving: Bun remembers a failed resolution, and the folders it saw, for the rest of
  // the process, so a package installed after one would still not load.
  const pkg = spec.split('/').slice(0, spec.startsWith('@') ? 2 : 1).join('/');
  if (!existsSync(join(dir, 'node_modules', pkg, 'package.json')) && !installed.has(dir)) {
    installed.add(dir);
    console.log('  setup installing build dependencies (once)…');
    const r = Bun.spawnSync(['bun', 'install', '--production', '--frozen-lockfile'], { cwd: dir, stdout: 'ignore', stderr: 'pipe' });
    if (r.exitCode) { console.log(`  error \`bun install\` failed in ${dir}:\n${r.stderr.toString().trim()}`); process.exit(1); }
  }
  try { return await import(Bun.resolveSync(spec, dir)) as T; }
  catch { console.log(`  error ${spec} is missing. Run \`bun install\` in ${dir}.`); process.exit(1); }
}
