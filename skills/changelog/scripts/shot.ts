#!/usr/bin/env bun
/* Screenshot the built changelog page with the local Chrome: desktop and phone, light and dark (kit/build/shot.ts).

     bun scripts/shot.ts changelog.preview.html [out dir]              # the feed: changelog-{desktop,phone}-{light,dark}.png
     bun scripts/shot.ts 'changelog.preview.html#2026-10-20' [out dir] # one entry: changelog-2026-10-20-….png

   Set CHROME to the browser binary when it is not in a usual place. Each shot is 2400 px tall, taken once the
   scenes have played to rest. */
import { shotCli } from '../kit/build/shot';

await shotCli('bun scripts/shot.ts changelog.preview.html[#date] [out dir]');
