/* The Spec view, on a design that has its specs: what will happen once it is built, at a glance, as build.ts
   rendered it from <page>.spec.md (scripts/spec.ts). A Design | Spec switch in the bar swaps the page for the spec in
   the same reading column, with its own "On this page"; the dock and Changes belong to the design and step aside.
   Each view keeps where the reader was. #spec, or a link to one of the spec's headings, opens on it. Copy agent spec
   copies the other spec, <page>.agent-spec.md as written: the complete one an agent builds from, which the page does
   not show. Build asks Claude to start the build: it sends "Build: <title> (vN)" with Send to Claude, anchored on the
   spec's title, and the session hands the agent spec to a fresh agent (references/spec.md). Where the viewer cannot
   send, it copies the same text for the chat. */
import { copyText, h } from '../kit/web/dom';
import { ICON } from '../kit/web/icons';
import { sound } from '../kit/web/sound';
import { toast } from '../kit/web/toast';
import { createToc } from './toc';
import { claude, startClaude } from './claude';

type View = 'design' | 'spec';
interface SpecOptions {
  spec: HTMLElement; agentSpec: string; layout: HTMLElement; end: HTMLElement; badge: HTMLElement;
  /** Callouts, tables, code and links, made the way the design's are. */
  decorate(root: HTMLElement): void;
}

export function createSpec({ spec, agentSpec, layout, end, badge, decorate }: SpecOptions) {
  const view = h('div', { class: 't-layout t-spec-layout', id: 't-spec-view', hidden: true });
  layout.after(view);
  view.append(spec);
  spec.hidden = false; // the view hides it now
  decorate(spec);
  const copy = h('button', { class: 'k-btn is-sm t-spec-copy', type: 'button', title: 'Copy the complete spec an agent builds from, as Markdown', 'data-uncommentable': '' },
    h('span', { class: 't-spec-icon', html: ICON.copy }), 'Copy agent spec');
  copy.addEventListener('click', () => copyText(agentSpec).then(
    () => { toast('Agent spec copied. Give it to an agent as its whole prompt.'); sound.play('select'); },
    () => toast('Copy failed. The agent spec is agent-spec.md beside this page.'),
  ));
  const build = h('button', { class: 'k-btn is-sm is-primary t-spec-build', type: 'button', title: 'Ask Claude to start building from the agent spec', 'data-uncommentable': '' }, 'Build');
  const version = spec.dataset.version;
  const title = spec.querySelector('h1');
  const request = `Build: ${title?.textContent?.trim() || document.title} (v${version})\n\nStart building from the agent spec for version ${version} of the design, agent-spec.md beside this page.`;
  startClaude();
  build.addEventListener('click', () => {
    if (!claude.on) // copy in the click, while the clipboard still allows it
      return void copyText('# ' + request).then(
        () => { toast('Copied. Paste it in your chat with Claude to start the build.'); sound.play('send'); },
        () => toast('Copy failed. Tell Claude in the chat to build the spec.'),
      );
    build.disabled = true;
    toast('Sending…');
    void claude.send(title ?? spec, request).then((result) => {
      if (result === 'sent') {
        build.textContent = 'Build sent';
        sound.play('send');
        return toast('Sent. Claude will start the build and reply in the comment thread.');
      }
      build.disabled = false;
      toast(result === 'consent' ? 'Not sent. Allow comments from this page to start the build.'
        : result === 'rate' ? 'Too many sends. Wait a moment and try again.'
        : 'Could not reach Claude. Press Build again to copy the request instead.');
    });
  });
  spec.prepend(h('div', { class: 't-eyebrow' }, h('span', { class: 'k-badge' }, 'Spec'), h('span', {}, `For version ${version} of the design`), h('span', { class: 't-spec-actions' }, copy, build)));
  createToc(view, spec, [], new Set());

  const tab = (name: View, label: string) => h('button', { type: 'button', role: 'tab', 'aria-selected': String(name === 'design'), 'aria-controls': name === 'design' ? 't-design-view' : 't-spec-view' }, label);
  const tabs = { design: tab('design', 'Design'), spec: tab('spec', 'Spec') };
  end.prepend(h('div', { class: 'k-seg is-sm t-views', role: 'tablist', 'aria-label': 'View', 'data-uncommentable': '' }, tabs.design, tabs.spec));
  layout.id ||= 't-design-view';

  const kept: Record<View, number> = { design: 0, spec: 0 };
  let on: View = 'design';
  function show(next: View, quiet = false) {
    if (next === on) return;
    if (!quiet) kept[on] = scrollY; // at load the page is at its top, and reading scrollY would lay it out early
    on = next;
    const isSpec = next === 'spec';
    layout.hidden = isSpec;
    view.hidden = !isSpec;
    document.documentElement.classList.toggle('t-in-spec', isSpec);
    for (const [name, b] of Object.entries(tabs)) b.setAttribute('aria-selected', String(name === next));
    badge.textContent = isSpec ? 'Spec' : 'Design';
    if (quiet) return; // opened from a link at load: the page is at its top, and the hash stays
    scrollTo(0, kept[next]);
    dispatchEvent(new Event('scroll')); // the bar and "On this page" follow the view, even when the page did not move
    try { history.replaceState(null, '', isSpec ? '#spec' : location.pathname + location.search); } catch { /* the viewer may refuse */ }
    sound.play('toggle');
  }
  tabs.design.addEventListener('click', () => show('design'));
  tabs.spec.addEventListener('click', () => show('spec'));

  const hash = decodeURIComponent(location.hash.slice(1));
  const target = hash ? document.getElementById(hash) : null;
  if (hash === 'spec' || (target && spec.contains(target))) {
    show('spec', true);
    if (target && target !== spec) requestAnimationFrame(() => target.scrollIntoView());
  }
}
