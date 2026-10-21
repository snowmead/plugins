/* The page's config and the changelog's own small helpers; the shared ones come from the kit (kit/web/). */
import type { PageConfig } from './types';

/** When the runtime started, for the boot timing the tests read (performance measure "changelog:boot"). */
export const T0 = performance.now();
export const CFG: PageConfig = window.CHANGELOG ?? { name: 'Changelog', url: '' };

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
export const fmtDate = (d: string) => { const [y, m, day] = d.split('-').map(Number); return `${MONTHS[m - 1]} ${day}, ${y}`; };
export const fmtN = (n: number) => Number(n).toLocaleString('en-US');
export const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;
/** "America/Toronto" as a reader says it: "Toronto time". */
export const tzName = (tz: string) => (tz.includes('/') ? `${tz.split('/').pop()!.replace(/_/g, ' ')} time` : tz);
/** An entry's link: the page's own link when known, else wherever it is open now. */
export const linkFor = (date: string) => (CFG.url.startsWith('https://') ? CFG.url : location.href.split('#')[0]) + '#' + date;

