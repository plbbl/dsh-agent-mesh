# Agent Mesh visual direction

## Visual thesis

Agent Mesh is a capability inside DSH, not a destination. Its only visible footprint is
the existing model seat at the right end of DSH's composer. The seat reads as two quiet
choices — `harness · model` — and inherits DSH typography, spacing, semantic colors,
focus treatment, and menu behavior. There is no sidebar item, overlay, dashboard, or
second message input.

## First-principles interaction

1. The user is already choosing “what answers this turn”; harness and model belong in
   that same decision, beside the send control.
2. Discovery is an implementation detail. The menu shows only detected local routes and
   native model names; it never exposes raw files, keys, cookies, or a setup wizard.
   A no-turn health check marks missing auth or invalid configuration unavailable before
   selection, while stale native sessions recover without a repair button.
3. One DSH session remains one visible conversation. A switch changes the selected
   provider/model through DSH's existing session API; the host maps that choice to a
   durable native harness session.
4. Cross-agent messaging is a transport/tool capability. It stays out of the primary
   surface until a future DSH-native transcript affordance can explain it without
   competing with the composer. DSH itself participates through `ctx.agents` and
   `Agent.followup()`, so “DSH as a harness” is a real in-process route rather than
   another model selector entry or a recursively spawned CLI.
5. Routing is a policy behind one `自动路由` model entry. The selector does not grow a
   panel builder: a routine task is one producer, while explicit panel/aggregate intent
   or an objective risk threshold enables bounded fan-out and blind evaluation.

## Component rules

- Chinese-first labels; the DSH locale service supplies English translations.
- One compact trigger for the harness and one for the model, separated by a small dot.
- The popover opens upward from the original model slot and is bounded for narrow
  windows; no layout shift in the composer.
- The harness menu answers “which executor?”; the model menu answers “which native
  configuration?”; the current choice is marked with a check.
- No model-count badges, live polling, cards, images, custom fonts, or decorative status
  animations.
- `prefers-reduced-motion` disables the only transition, and focus remains keyboard
  visible.

## Design tokens

The client consumes DSH semantic aliases first and falls back to restrained values for
headless previews: primary text `#1b1e25`, secondary text `#6f7785`, faint text
`#9ba2ad`, raised surface `rgba(80, 98, 140, .08)`, accent `#4778ea`, 1px low-contrast
border, 9–12px radius, and the host menu shadow. No asset or font download is added.

## Performance budget

- one slot-rendered React subtree; no independent root or polling loop
- model directory loading uses DSH's existing store/cache and is triggered only when the
  seat is available or opened
- the selector reuses DSH's model directory; one short-lived, value-free credential preflight is added only for native routes that explicitly declare `apiKeyEnv`
- local discovery and durable event writes remain host-side; token deltas are live-only
- background diagnostics are cached and no-turn; provider-specific probes are never
  repeated per token or per render
- bounded handoff context (`24,000` characters) and bounded native event persistence
- automatic routes cap calls at 5, branches at 3, and deadlines at 10 minutes; branches
  run concurrently, while evaluator passes are sequential and position-swappable
- client bundle remains a small esbuild output with React externalized

## QA states

Verify: native-only providers, detected local harnesses, a harness with multiple native
models, unavailable/empty discovery, failed model loading, keyboard escape/outside-click,
narrow viewport, reduced motion, model selection persistence, and removal of the plugin
restoring DSH's original model seat.
