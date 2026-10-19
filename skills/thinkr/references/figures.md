# Figures

A figure is the reason a section exists. Choose it before you write the text.

| The section explains… | Draw | Make it move |
|---|---|---|
| How data moves between parts | A sequence diagram: one lane per part, one arrow per message, the data on the arrow | Steps, one message in focus each; arrows draw in |
| How a thing changes state | A state diagram, the event on each arrow | Steps through one real run |
| How parts fit together | Boxes and arrows grouped by owner | Steps that focus one part at a time |
| A change to a screen | Wireframes before and after, changed parts in color | Steps that swap before and after |
| Numbers, a trend, a comparison | A chart (Observable Plot or d3) | A control for the value that matters |
| A value over a plane: a field, a loss surface, a heat map | A vgpu shader | A control on the parameter, or time |
| An order of work | A timeline, one lane per part | Bars build in |

## The element

```html
<t-figure id="flow" alt="What it shows, for screen readers" ratio="16/9" min-width="560">
  <svg viewBox="0 0 640 290" role="img">…</svg>      <!-- static content, or nothing when a script draws -->
  <t-control name="lr" label="Learning rate" min="0.02" max="0.24" step="0.005" value="0.08"></t-control>
  <t-step>First message.</t-step>
  <t-step>Second message.</t-step>
  <figcaption><b>Lead with the action.</b> Then say what to notice.</figcaption>
</t-figure>
```

| Attribute or child | Use |
|---|---|
| `id`, `alt`, `<figcaption>` | Required. |
| `ratio="16/9"` or `height="20rem"` | A fixed stage for canvases and shaders. Without it, the stage takes its content's height. |
| `min-width="560"` | The diagram keeps this width and scrolls sideways on phones. Use it when labels would shrink below 11 px. |
| `interval="2600"` | Milliseconds per step when the reader presses Play. |
| `<t-control type="range\|select\|toggle">` | `range`: `min max step value unit`. `select`: `options="a\|b\|c" value`. `toggle`: `checked`. |
| `<t-step>` | Adds Back / Play / Next, the step text and dots. Inline HTML is fine. |

## Steps and motion without a script

Put these on parts of an inline SVG (usually `<g>` groups):

| Attribute | Effect |
|---|---|
| `data-show="2"`, `"2-3"`, `"2+"`, `"1,3"` | The part shows only at those steps. |
| `data-focus="2"` | The part dims at the other steps. Combine with `data-show`. |
| `data-draw` | On a `path`, `line`, `rect` or `circle`: the stroke draws itself when it appears. |
| `data-in` | The part rises in, staggered, the first time the figure is seen. |

Motion never hides content: a frozen frame shows the finished figure. Reduced motion turns it all off.

SVG rules: one `viewBox`, colors from `var(--fg)`, `var(--muted-fg)`, `var(--border)`, `var(--cN)`; every shape has a
`fill`. `.t-stage svg text` is `--fg` by default; color a label with `style="fill: var(--c3)"` (an attribute loses to
the stylesheet) or `class="muted"`. Text at 11.5 px or more in viewBox units, at a 640-wide viewBox.

## Scripted figures (TypeScript)

```html
<script type="ts">
  import type { Fig } from '../runtime/types';   // types only; build.ts strips it

  thinkr.figure('#chart', async (fig: Fig) => {
    const Plot = await fig.load('plot');
    const draw = () => fig.stage.replaceChildren(Plot.plot({ width: fig.size.width, marks: [/* … */] }));
    draw();
    fig.onResize(draw);
    fig.onTheme(draw);
    fig.onControl(draw);
  });
</script>
```

Setup runs once, a full screen before the figure scrolls in, so it is drawn by the time the reader gets there. A
setup that throws shows a short error in the stage. Redraw on every `onControl` call with no debounce; if a draw is
too slow for that, make the draw cheaper rather than delaying it.

| Member | Gives you |
|---|---|
| `stage`, `size`, `canvas()` | The element to draw in (`position: relative`), its CSS size, a canvas that fills it |
| `controls`, `onControl(cb)` | Control values by name; `cb(controls, changedName)` |
| `step`, `steps`, `onStep(cb)`, `goTo(n)` | Stepper state, from 1 |
| `visible`, `onVisible(cb)`, `loop(fn)` | `loop` is rAF that runs only on screen: `fn(seconds, dt)`, returns stop |
| `tokens()`, `onTheme(cb)` | Theme colors as `rgba()` strings, plus `dark`, `font`, `mono` |
| `color(name)` | A token or any CSS color as `[r, g, b, a]` floats for a shader uniform |
| `anim(el, keyframes, opts)`, `motion()` | motion's `animate()` with the page spring; `motion()` resolves the module (or null) |
| `load(name)` | `motion`, `vgpu`, `d3`, `plot` (Plot loads d3 first), or `npm:pkg@x.y.z` (pinned). The build sees which ones a page loads and preloads them, so this usually resolves at once. |
| `vgpu()` | vgpu with WebGPU started: `{ gpu, surface, effect, frameLoop, target, compute, storage, … }`. One device for the page, requested at load. |
| `reducedMotion`, `fail(err)` | Snap to end states when true; show an error in the stage |

Rules: colors from tokens, redrawn in `onTheme`; labels as HTML or SVG over a canvas, never baked into pixels; lay
out in CSS pixels from `fig.size`; pause work off screen; check the figure at 390 px.

## vgpu: a fragment shader over the stage

From `templates/explain.html`. An `effect` is a WGSL fragment shader; vgpu supplies the vertex stage and `uv` (0,0 top left).

```ts
const { gpu, surface, effect, frameLoop, target } = await fig.vgpu();
const surf = surface(gpu, fig.canvas(), { dpr: [1, 2] });
const fx = effect(gpu, /* wgsl */ `
  struct Params { lo: vec4f, hi: vec4f, width: f32, height: f32, pad0: f32, pad1: f32 }
  @group(0) @binding(0) var<uniform> params: Params;
  @fragment fn fs_main(@location(0) uv: vec2f) -> @location(0) vec4f {
    let g = length(uv - 0.5) * 4.0;
    return vec4f(mix(params.hi.rgb, params.lo.rgb, clamp(g, 0.0, 1.0)), 1.0);
  }`, { set: { params: { lo: fig.color('bg'), hi: fig.color('c1'), width: 1, height: 1, pad0: 0, pad1: 0 } } });
await fx.compile(target(gpu, { size: [1, 1] }));   // WGSL errors reject here, not silently in the loop
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
- Wrap the setup in `try` and draw a Canvas 2D fallback in `catch` when the figure must work without WebGPU.
- Headless Chrome runs WebGPU on most Macs; when a shot shows the fallback or an error, check the shader with `target()` and `color.read()`.

## motion in scripts

`fig.anim(el, { pathLength: [0, 1] }, { type: 'tween', duration: 0.8 })` draws a path; `{ x: [0, -6, 6, 0] }` shakes;
`{ scale: [0.6, 1] }` pops. The default is a short spring. Animate transforms and strokes, not opacity from 0.
