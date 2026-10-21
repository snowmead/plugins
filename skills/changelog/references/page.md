# Set up, or change the page

## Set up

Once per repository, in the chat with the person who wants it.

1. **Config.** Write `.claude/changelog.json` at the checkout's top ([format.md](format.md#config)): the
   product's `name`; `repo` from `git remote get-url origin`; `timezone`, the team's IANA zone (ask; the machine's is
   `bun -e 'console.log(Intl.DateTimeFormat().resolvedOptions().timeZone)'`); `slack.channel`, the channel ID to post
   in (find it with the Slack connector's channel search, or `null` for no post); and `workflows`, the file names in
   `.github/workflows/` of the CI and review workflows to count, if there are any.
2. **Page.** `bun ${CLAUDE_SKILL_DIR}/scripts/build.ts --out <work>/changelog`, then publish
   `<work>/changelog.artifact.html` with the Artifact tool: `icon` `changelog`, a one-sentence `description`, `files`
   the map the build printed, and `capabilities` `{"db": {"rules": [{"path": "", "read": "view", "write":
   "admin"}]}}` (everyone the page is shared with reads; only its editors write). Load the `artifact-design` and
   `artifact-capabilities` skills first when the session has them; their contract wins where this file differs.
3. **Link.** Put the page's link in the config as `page`, rebuild, and publish the same file again with the new
   `files` map (leave `capabilities` out so the database stays): copied entry links now carry the page's own address.
4. Ask the user to commit `.claude/changelog.json`, so every run and every teammate finds the same page. Then run,
   as SKILL.md says.

## Change the page

Edit `runtime/`, run `bun run test` in this skill's folder, build with `--entries` and look at the shots. Then
`read` the artifact at the config's `page` and publish the built file with the Artifact tool, that `url` and the
`files` map the build printed. Leave `capabilities` out so the database and its rules stay.

The page keeps these promises:

- No sound plays before the reader's first click or key press. The speaker button mutes; the choice stays in the
  browser. Sounds pause while the tab is hidden.
- A sound only answers what the reader just did: opening an entry, going back, copying a link, the speaker button.
  Hovering, scrolling, loading, the first click and a new entry stay silent, as on thinkr's and guided-review's pages.
- The sounds are the kit's short ticks at the kit's levels. Do not add louder or longer ones for this page.
