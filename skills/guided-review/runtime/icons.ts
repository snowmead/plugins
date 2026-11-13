/* The guide's own icons, in the kit's stroke (kit/web/icons.ts). Plain strings with no page state, so build.ts writes
   them into the bar as well as the runtime draws them. */

/** A bell: answers not read yet. */
export const BELL = '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">'
  + '<path d="M4 6.5a4 4 0 0 1 8 0c0 3 .9 4.4 1.5 5h-11C3.1 10.9 4 9.5 4 6.5Z"/><path d="M6.5 13.5a1.5 1.5 0 0 0 3 0"/></svg>';

/** A speech bubble: comments. */
export const COMMENT = '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">'
  + '<path d="M14 10a1.3 1.3 0 0 1-1.3 1.3H4.7L2 14V3.3A1.3 1.3 0 0 1 3.3 2h9.4A1.3 1.3 0 0 1 14 3.3z"/></svg>';

/** A window with a column at its left, filled while the column shows: the chapter text, or the file tree. */
export const PANEL = '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">'
  + '<rect x="2" y="2.5" width="12" height="11" rx="1.5"/><path d="M6 2.5v11"/>'
  + '<rect class="gr-panel-fill" x="2.75" y="3.25" width="2.5" height="9.5" rx=".75" fill="currentColor" stroke="none" opacity=".35"/></svg>';

/** A painter's palette: the colors code is drawn in. */
export const PALETTE = '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">'
  + '<path d="M8 1.75a6.25 6.25 0 0 0 0 12.5c.85 0 1.4-.55 1.4-1.3 0-.4-.15-.7-.4-1-.25-.3-.4-.6-.4-1 0-.75.6-1.3 1.4-1.3h1.6a2.65 2.65 0 0 0 2.65-2.65C14.25 4.15 11.45 1.75 8 1.75Z"/>'
  + '<g fill="currentColor" stroke="none"><circle cx="4.6" cy="7.6" r=".9"/><circle cx="6" cy="4.6" r=".9"/><circle cx="9.3" cy="4.2" r=".9"/><circle cx="11.6" cy="6.4" r=".9"/></g></svg>';
