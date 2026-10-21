#!/usr/bin/env bun
/* Screenshot a built guide with the local Chrome: desktop and phone, light and dark (kit/build/shot.ts).

     bun scripts/shot.ts guide.preview.html [out dir]   # writes <name>-{desktop,phone}-{light,dark}.png

   Set CHROME to the browser binary when it is not in a usual place. Each shot is 2400 px tall: the overview and
   the first chapters, with their code, which loads from jsDelivr (so the shots need the network). */
import { shotCli } from '../kit/build/shot';

await shotCli('bun scripts/shot.ts guide.preview.html [out dir]');
