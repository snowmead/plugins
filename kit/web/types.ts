/* Types the kit's runtime and build helpers share. */

/** The kit's sounds (kit/sounds.json). Each names what the reader did, not where: a page plays the same sound for
    the same kind of act. */
export type SoundName =
  | 'nav'       // the page moves to another place or view: a contents click, a chapter key, an entry opened or left
  | 'step'      // a figure or a sequence moves one step
  | 'select'    // something is picked, ticked or copied
  | 'deselect'  // something is cleared or unticked
  | 'reveal'    // a panel or an answer opens, or something new shows
  | 'toggle'    // a switch, a tab, a layout, the sound button
  | 'send'      // something leaves the page, or a self-check is right
  | 'hover';    // a mouse moves onto a control, far under the rest
export type Sounds = Partial<Record<SoundName, { uri: string; db: number }>>;

/** The theme the viewer picked, or the system's. */
export type ThemeType = 'light' | 'dark' | 'system';

declare global {
  interface Window {
    /** What the build hands the kit's runtime (kit/build/page.ts runtime). */
    KIT?: { sounds: Sounds };
    webkitAudioContext?: typeof AudioContext;
  }
}
