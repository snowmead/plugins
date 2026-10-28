# vgpu: a fragment shader over the stage

From `templates/explain.html`. An `effect` is a WGSL fragment shader; vgpu supplies the vertex stage and `uv` (0,0 top left).

```ts
const { gpu, surface, effect, frameLoop, target } = await fig.vgpu();
const fx = effect(gpu, /* wgsl */ `
  struct Params { lo: vec4f, hi: vec4f, width: f32, height: f32, pad0: f32, pad1: f32 }
  @group(0) @binding(0) var<uniform> params: Params;
  @fragment fn fs_main(@location(0) uv: vec2f) -> @location(0) vec4f {
    let g = length(uv - 0.5) * 4.0;
    return vec4f(mix(params.hi.rgb, params.lo.rgb, clamp(g, 0.0, 1.0)), 1.0);
  }`, { set: { params: { lo: fig.color('bg'), hi: fig.color('c1'), width: 1, height: 1, pad0: 0, pad1: 0 } } });
await fx.compile(target(gpu, { size: [1, 1] }));   // WGSL errors reject here, not silently in the loop
const surf = surface(gpu, fig.canvas(), { dpr: [1, 2] });   // after compile: on an error the fallback still has the canvas
// a still field: draw a frame only when something changed (an animated one sets time and draws every frame)
let dirty = true;
fig.onTheme(() => { fx.set({ params: { lo: fig.color('bg'), hi: fig.color('c1') } }); dirty = true; });
surf.onResize(({ width, height }) => { fx.set({ params: { width, height } }); dirty = true; });
let loop: { stop(): void } | null = null;
const start = () => { loop ??= frameLoop(gpu, (f) => { if (dirty) { dirty = false; f.pass(surf, fx); } }); };
fig.onVisible((on) => { if (on) start(); else { loop?.stop(); loop = null; } });
start(); // setup runs a screen ahead: draw now, so the figure is ready when it scrolls in
```

- Uniform structs follow WGSL alignment: `vec4f` fields first, scalars after, padded to 16 bytes.
- Contour lines: `abs(fract(g - 0.5) - 0.5) / fwidth(g)`.
- Wrap the setup in `try` and draw a Canvas 2D fallback in `catch` when the figure must work without WebGPU. Make the
  `surface` after `compile`: a canvas bound to WebGPU gives no 2D context, so the fallback would have nothing to draw on.
- Headless Chrome runs WebGPU on most Macs; when a shot shows the fallback or an error, check the shader with `target()` and `color.read()`.
