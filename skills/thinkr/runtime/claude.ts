/* Send to Claude, as a design's dock (Send feedback, Approve design) and its spec (Build) use it: one handle on the
   viewer's comments capability for the whole page. A send posts a comment thread anchored on an element, which wakes
   the Claude session that watches the page. Where the viewer cannot send (no capability, a view-only share, no
   session), `on` is false and the caller copies its text for the chat instead. */
import type { CanSendToClaude, CommentsCap } from './types';

/** How a send ended: sent, or why not. `failed` turns sending off, so the next press copies the text instead. */
export type Sent = 'sent' | 'consent' | 'rate' | 'failed';

let cap: CommentsCap | null = null;
let state: CanSendToClaude = 'off';
let started = false;

const refresh = async () => { state = cap ? await cap.canSendToClaude().catch(() => 'off' as const) : 'off'; };

/** Asks the viewer for the comments capability once, and asks again whether sending is on each time the page shows. */
export function startClaude() {
  if (started) return;
  started = true;
  void (async () => {
    cap = (await window.claude?.use('comments').catch(() => null)) ?? null;
    await refresh();
  })();
  document.addEventListener('visibilitychange', () => { if (!document.hidden) void refresh(); });
}

export const claude = {
  /** Whether a press can send now. Read it inside the click: when it is false, copy in the same click, while the
      clipboard still allows it. */
  get on() { return state === 'available' && !!cap; },
  async send(anchorEl: Element, text: string): Promise<Sent> {
    try {
      await cap!.sendToClaude({ anchor: await cap!.anchorFor(anchorEl), text });
      return 'sent';
    } catch (err) {
      const code = (err as { code?: string })?.code;
      if (code === 'consent_required') return 'consent';
      if (code === 'rate_limited') return 'rate';
      state = 'off';
      return 'failed';
    }
  },
};
