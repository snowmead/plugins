// The review rules (REVIEW.md, or the skill's rules.md) cut into their
// second-level sections, so each stage's prompt carries the sections that
// stage reads and no more.

export interface Rules {
  /** The whole file. */
  text: string
  /** The sections named, each with its heading, in the file's order; the whole file when it has none of them. */
  pick(names: readonly string[]): string
}

export function parseRules(text: string): Rules {
  const sections: { name: string; text: string }[] = []
  let fence = false
  let current: { name: string; lines: string[] } | null = null
  const close = () => {
    if (current) sections.push({ name: current.name, text: current.lines.join('\n').trim() })
  }
  for (const line of text.split('\n')) {
    if (/^(```|~~~)/.test(line)) fence = !fence
    const heading = !fence && /^## +(.+?)\s*#*\s*$/.exec(line)
    if (heading) {
      close()
      current = { name: heading[1]!.toLowerCase(), lines: [line] }
    } else if (current) current.lines.push(line)
  }
  close()
  return {
    text,
    pick(names) {
      const wanted = names.map((n) => n.toLowerCase())
      const found = sections.filter((s) => wanted.includes(s.name))
      return found.length ? found.map((s) => s.text).join('\n\n') : text.trim()
    },
  }
}

// The sections each stage reads.
export const SECTIONS = {
  finder: ['Read before judging', 'Segments', 'Never report', 'Severity', 'Evidence'],
  skeptic: ['Read before judging', 'Segments', 'Never report', 'Severity', 'Evidence'],
  followup: ['Later reviews'],
  editor: ['Never report', 'Severity', 'Later reviews', 'Summary'],
  sweepEditor: ['Never report', 'Severity'],
} as const
