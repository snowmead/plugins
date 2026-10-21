/* The page's data and the guide's own small helpers; the shared ones come from the kit (kit/web/). */
import type { PageData } from './types';

/** When the runtime started, for the boot timing the tests read (performance measure "gr:boot"). */
export const T0 = performance.now();
export const D: PageData = JSON.parse(document.getElementById('gr-data')!.textContent!);

/** Split a path into its file name and the folder before it. */
export const split = (path: string): [string, string] => { const name = path.split('/').pop()!; return [name, path.slice(0, path.length - name.length)]; };
export const stat = (a: number, d: number) => `${a ? `<span class="add-n">+${a}</span>` : ''}${d ? `<span class="del-n">−${d}</span>` : ''}${!a && !d ? '<span>0</span>' : ''}`;
