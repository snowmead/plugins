/* The text of one changelog entry. Copy this file into the run's work folder and rewrite every value.

   Facts come only from the PR digests and stats.json: keep every number as the PR states it, and write "not stated"
   sooner than guess. Plain sentences, one idea each, in the words of the people who use the product. This example is
   a made-up day of a webhook service, "Relay": two pull requests, two themes.

   `bun scripts/entry.ts` imports this file and calls the default export with the scene builder. The type imports
   below only help an editor; they vanish when the file runs, so a copy elsewhere still works. */
import type { EntryInput } from '../runtime/types';
import type { Svg as SvgType } from '../scripts/scenes';

export default ({ Svg }: { Svg: typeof SvgType }): EntryInput => {
  function sceneRetries() {
    const g = new Svg('retries', 250, 'A delivery that timed out was marked failed after one post before; now it is posted again after 30 seconds, 1 minute and 2 minutes, and delivered on the fourth post');
    g.text(14, 22, 'A delivery times out during the receiver\'s deploy', 0, 'sc-text');
    g.text(14, 58, 'before', 0.2);
    g.dot(110, 54, 's1', 0.3); g.cross(138, 54, 0.6);
    g.text(160, 58, 'failed after one post', 0.8);
    g.text(14, 108, 'after', 1.2);
    const xs = [110, 200, 290, 380];
    const at = ['0', '+30 s', '+1 min', '+2 min'];
    xs.forEach((x, i) => {
      if (i) g.line(xs[i - 1] + 8, 104, x - 8, 104, 1.1 + i * 0.4);
      g.dot(x, 104, i < 3 ? 's2' : 's1', 1.3 + i * 0.4);
      g.text(x, 130, at[i], 1.4 + i * 0.4, 'sc-sub', 'middle');
    });
    g.chip(334, 142, 92, 22, 'delivered', 3.0);
    g.text(14, 192, 'Up to six posts in about 15 minutes, each with ±20% jitter.', 3.3);
    g.text(14, 214, 'A 404 or another 4xx still fails at once: a retry would not help.', 3.7);
    return g.scene('A timeout now gets up to five more posts, 30 seconds to 8 minutes apart, before the delivery fails.');
  }

  function sceneEndpoint() {
    const g = new Svg('endpoint', 200, 'The endpoint page now counts deliveries in four states, with retrying as a new one between pending and failed');
    g.text(14, 22, 'The endpoint page, deliveries by state', 0, 'sc-text');
    g.node(14, 40, 118, 52, 'Pending', '3', 0.3);
    g.node(146, 40, 118, 52, 'Retrying', '2, next in 1 min', 0.6, true);
    g.node(278, 40, 118, 52, 'Delivered', '1,204', 0.9);
    g.node(410, 40, 116, 52, 'Failed', '1', 1.2);
    g.edge('M132 66 L146 66', 0.5); g.edge('M264 66 L278 66', 0.8);
    g.text(14, 130, 'Retrying is new: it shows when the next post is due.', 1.6);
    g.text(14, 152, 'Failed deliveries keep their last status code and attempt count.', 2.0);
    return g.scene('A delivery waiting for its next post shows as Retrying, with the time it is due.');
  }

  return {
    title: 'A webhook that times out is now retried, and you can see it waiting',
    summary: 'Two pull requests merged. A delivery that times out or gets a 5xx is posted again for about 15 minutes before '
      + 'it fails, and the endpoint page shows deliveries that are waiting for their next post.',
    // One to five themes, one per area. The first theme's scene leads the entry in the feed; sum is its one line there.
    themes: [
      {
        key: 'retries', kicker: 'Deliveries', prs: [42],
        title: 'A delivery that times out is posted again for 15 minutes',
        sum: 'Timeouts, network errors, 408, 429 and 5xx answers are retried up to five times with backoff; other 4xx answers still fail at once.',
        paras: [
          'A delivery used to be posted once, so a receiver that was down for a deploy lost the event for good. #42 retries the '
            + 'failures that may pass later: a timeout, a network error, a 408, a 429 or a 5xx.',
          'The delay doubles from 30 seconds, with ±20% jitter so endpoints that fail together are not retried together. The '
            + 'sixth failed post fails for good. Receivers should make their handlers idempotent: a retry can bring an event twice.',
        ],
        scene: sceneRetries(),
      },
      {
        key: 'endpoint', kicker: 'Endpoints', prs: [44],
        title: 'The endpoint page shows deliveries waiting for a retry',
        sum: 'A new Retrying count sits between Pending and Failed, with the time the next post is due.',
        paras: [
          '#44 adds Retrying to the endpoint page\'s delivery counts. Each retrying delivery shows its attempt number and when the '
            + 'next post is due, so an operator can tell a slow receiver from a broken one.',
        ],
        scene: sceneEndpoint(),
      },
    ],
    // "Things to check": what a teammate must do or watch after pulling (migrations, resets, flaky tests, slow CI).
    watch: [
      'Run the migrations after pulling: #42 adds attempts and next_attempt_at to deliveries.',
      'The delivery worker now reads next_attempt_at; restart it after you migrate.',
    ],
    // Optional: the review's score out of 5 and its one-line verdict, verbatim, when the repository's reviews give one.
    scores: {
      42: [5, 'No findings; the retry decision matches the docs and the tests.'],
      44: [4, 'One nit: the next-post time could show seconds under a minute.'],
    },
    // Optional: shorter titles for the PR table. Leave a PR out to keep its GitHub title.
    titles: {},
    // The Slack post: entry.ts adds the title line, the link, the window, the PR count and the Watch label.
    slack: {
      intro: 'Here is what merged since the last entry',
      lines: [
        [':repeat:', 'A delivery that times out or gets a 5xx is posted again for about 15 minutes before it fails.'],
        [':hourglass_flowing_sand:', 'The endpoint page shows deliveries waiting for their next post, and when it is due.'],
      ],
      watch: 'run the migrations and restart the delivery worker.',
    },
  };
};
