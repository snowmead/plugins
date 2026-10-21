#!/usr/bin/env bun
/* Screenshot a packed page with the local Chrome: desktop and phone, light and dark (kit/build/shot.ts).

     bun scripts/shot.ts page.preview.html [out dir]   # writes <name>-{desktop,phone}-{light,dark}.png

   Set CHROME to the browser binary when it is not in a usual place. Headless Chrome has no WebGPU, so vgpu
   figures show their fallback (or their error) here; they run in the artifact viewer. */
import { shotCli } from '../kit/build/shot';

await shotCli('bun scripts/shot.ts page.preview.html [out dir]');
