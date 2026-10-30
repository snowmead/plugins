/* The libraries, from the pinned jsDelivr URLs build.ts writes into the page (runtime/libs.json). build.ts also
   preloads their whole import graphs from the head, so by the time the first card mounts the bytes are usually
   here. A failed import leaves the page readable: cards fall back to plain diff text, the tree to a list. Diagrams
   need no library here: build.ts draws them (runtime/diagrams.ts). */
import type { PierreDiffs, PierreTrees } from './types';
import { D } from './dom';

export const libs: Promise<{ diffs: PierreDiffs | null; trees: PierreTrees | null }> = Promise.allSettled([
  import(D.libs.diffs) as Promise<PierreDiffs>,
  import(D.libs.trees) as Promise<PierreTrees>,
]).then(([d, t]) => {
  const diffs = d.status === 'fulfilled' ? d.value : null;
  try {
    diffs?.setCustomExtension('lock', 'toml');
    diffs?.setCustomExtension('justfile', 'just');
  } catch { /* highlighting falls back to plain text */ }
  if (d.status === 'rejected') console.warn('guide: @pierre/diffs did not load; showing plain diffs');
  return { diffs, trees: t.status === 'fulfilled' ? t.value : null };
});
