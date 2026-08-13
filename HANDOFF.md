# DroneScript — state of the project

Written 2026-08-12. For whoever picks this up next.

## What this is

A compiler from a C-like language to PneumaticCraft: Repressurized drone
programs, plus a browser editor. You write source, you get JSON, you paste it
into the in-game Programmer's pastebin screen with **Load code from clipboard**.
No network or Pastebin account is involved — the mod reads the system clipboard.

The owner plays **FTB NeoTech (Minecraft 1.20.4)**. That is the primary target
and the default.

Roughly 8,600 lines across a compiler package and a web package, in six commits.
`npm test` runs 91 tests; `npm run typecheck` is clean.

## Status, honestly

Everything below is verified **only** by the test suite and by the compiler's own
verifier. **Nothing has ever been imported into a running Minecraft instance.**

That distinction has already cost one full rebuild. The compiler originally
targeted MC 1.21.1 because the initial research assumed FTB NeoTech was on it,
and nobody checked. Every test passed, the verifier was green, and the first
real import failed instantly with *"Invalid formatted Pastebin or JSON."* — the
pack is 1.20.4, whose mod predates the codec rewrite and uses a completely
different serialization.

So: **the single most valuable thing you can do is get a real program in and out
of the game.** Ask the owner to build a two-piece program by hand in the
Programmer, click **Save code to clipboard**, and paste the result. Diff that
against what the compiler emits for the same program. Until that happens, treat
the 1.20.4 encoding as carefully-transcribed but unconfirmed.

## The target, and why it dominates the design

Read this section before changing anything in `layout/`, `verify/` or `emit/`.
These are properties of the game, all verified against mod source, and each one
is load-bearing.

**Linking is positional, exact, and untolerant.** The game reconstructs a
program's entire structure from widget coordinates — `updatePuzzleConnections`
indexes widgets by exact `(x, y)` and looks up neighbours. Two widgets that land
on connecting coordinates *are* connected, whether or not you meant it. There is
no snapping on import.

**Failure is silent.** On 1.20.6+, a codec parse error imports an *empty*
program and writes one line to the log; the player sees nothing wrong. On
1.20.4, a malformed document throws and shows a generic toast. Neither tells you
which field was wrong. This is why the verifier exists.

**A label has no step input.** Flow can never fall into a label from above; a
label is reachable only by jumping. So any block with more than one predecessor
must carry a label, and *every* inbound edge must then be explicit. This makes
fall-through the scarce resource that linearization is built to conserve.

**A condition widget carries two targets.** Its last parameter row holds a text
widget on the whitelist side (jump when true) and another on the blacklist side
(jump when false); an empty side falls through. Writing a target costs one text
widget; a jump costs two (jump + text). This is why `&&` chains emit no jumps at
all. The mod rejects a condition that sets both sides *and* has a widget below.

**Chain end means return or restart.** Running off the bottom of a chain pops
the jump-back stack — returning from a `jump_sub` or a `for_each_*` — or, when
the stack is empty, restarts at the `start` widget. `return` and a top-level
`while (true)` therefore cost nothing: `while (true) { wait(20); }` is three
widgets total.

**Recursion is impossible.** `jump_sub` return uses a per-widget one-shot flag,
so a function cannot be on the stack twice. Nested calls are fine (there is a
real 100-deep `Deque`). The compiler rejects call-graph cycles with the cycle
printed. This is what makes per-function argument variables sound.

**Arithmetic is one widget.** `coordinate_operator` folds an entire chain of
operands at once — whitelist chain added, blacklist chain subtracted — so
`a + b - c + 5` is one widget with four coordinate parameters. Its first
whitelist operand seeds the result **unmasked**; only later operands respect the
axis mask. That asymmetry is why ints are kept with y = z = 0.

**Duplicate label names are resolved at random.** The game collects every
matching label and picks one. The compiler owns the label namespace and the
verifier asserts uniqueness.

**Every widget except a comment costs a Programming Puzzle piece**, parameters
included. That is why the optimizer is not cosmetic.

## Two formats

The mod rewrote serialization in 1.20.6. Both are supported, chosen by
`target` (`BuildOptions.target`, and a selector in the toolbar).

| Target | Minecraft | Mod | Shape |
| --- | --- | --- | --- |
| `1.20.4` (default) | 1.20.1–1.20.4 | 7.0.x | NBT rendered as JSON, type tag on every value |
| `1.21` | 1.21.1 | 8.x | Codec JSON with a `version` field |

**1.21**: `{"version":3,"widgets":[{"type":"pneumaticcraft:goto","pos":{"x":0,"y":11}}]}`.
Fields group under `inv` / `cond` / `dig_place` / `drone_cond`. Omitting
`version` makes the importer guess the 1.12-era format and mangle everything.

**1.20.4**: `{"pneumaticcraft:progWidgets":{"type":9,"value":[…]}}`. Widget
identity is `name` with the mod namespace *stripped*; `x`/`y` are top level;
field groups are flat; enums are ordinals; side masks become one boolean per
uppercase direction name (`"UP"`); block positions are `{X,Y,Z}` compounds.
Import runs `JsonToNBTConverter`, which calls `getAsJsonObject()` on every
value — so a single bare number anywhere throws. A test asserts that invariant
over the whole document.

Widget **geometry is identical** in both (30 wide, 22 per parameter row, halved
in program space), so layout, linking, verification and piece counts are shared.
Only the final encoding differs.

## Architecture

```
source
  → lexer, parser            hand-written; Pratt expressions; recovers at ; and }
  → lowering                 AST → CFG-IR, with widget ops already built
  → linearize                CFG → chains of widgets, labels assigned
  → layout/place             exact coordinates, plus a record of intended links
  → emit (per target)        JSON
  → verify                   re-derive the graph and compare against intent
```

`packages/compiler/src/`

| Path | What it holds |
| --- | --- |
| `spec/widgets.ts` | **The single source of truth.** All 61 widget types + 9 area shapes, each naming its Java class for re-auditing. Field names follow the 1.21 codecs. |
| `spec/builtins.ts` | 44 builtin functions (14 of them sensors); how call arguments and options map onto parameter rows and fields. |
| `spec/targets.ts` | The two targets and their metadata. |
| `lexer.ts`, `parser.ts`, `ast.ts` | Front end. Scope sigils (`#`, `%`, `$`) stay attached to names. |
| `sema/consteval.ts` | Compile-time values: `area()`, `filter()`, `fluid()`, constant folding. |
| `sema/values.ts` | Variable scopes and the `$`-prefixed built-ins. |
| `lower/lower.ts` | The big one. Statements, expressions, destination-passing conditions, functions, inlining. |
| `ir/ir.ts` | CFG blocks; conditional terminators name *both* successors. |
| `layout/linearize.ts` | Trace formation, label assignment, the chain-end optimizations. |
| `layout/place.ts` | Coordinates + the intent graph. |
| `verify/relink.ts` | Port of `updatePuzzleConnections`. |
| `verify/graphcheck.ts` | Intent vs reality, duplicate labels, missing targets. |
| `emit/emit.ts` | 1.21 codec JSON. |
| `emit/emitV2.ts` | 1.20.4 NBT-JSON; maps canonical field paths onto the older names. |

`packages/web/` is Svelte 5 + Vite + Monaco. The compiler runs in a web worker.
Monaco's completions and hover text are generated from `spec/builtins.ts`, so the
editor cannot offer something the compiler would reject. The preview renders
placed widgets with links derived by the same `relink` pass the verifier uses.

## The verifier is the point

`layout` records what it *meant* to connect. `verify/relink.ts` independently
re-derives what the game *will* connect, from coordinates alone, the same way
`updatePuzzleConnections` does. `graphcheck` compares them and refuses to emit on
any mismatch.

This is the only defence against a failure mode that is otherwise invisible, and
it has already earned its place: it caught that chained parameter widgets link to
*each other*, not just to their owner, which the first intent model missed.

**If you change layout or geometry, do not weaken this.** A test that constructs
a deliberately-sabotaged layout and expects an `unintended-link` is in
`test/layout.test.ts`.

## The language

Types are `int` and `coord`. Every runtime variable in a drone program is a block
position, so an `int` is one with its value in x. Areas and filters are *not*
runtime values — they are parameter widgets physically attached to a user — so
they are compile-time constants, declared `const`, and re-emitted at each use
site. Two widgets can never share one parameter widget; the optimizer must never
try to dedupe them.

There are **no runtime booleans**. Conditions only exist as branching, so they
may appear only in `if` / `while` / `for`, and lower by destination passing:
`lowerCondition(expr, ifTrue, ifFalse)`. `!` swaps the destinations; `&&` and
`||` thread them. The game has only `=`, `>=`, `<=`, so `>`, `<` and `!=` are
rewritten by swapping branch targets — free, because a condition names both.

Functions lower to a label plus `jump_sub`, with per-function argument and return
variables. Called exactly once, they are inlined instead (a subroutine costs four
widgets of overhead that a single call site does not need).

## Deliberate limitations

These are not bugs. Each has a reason worth preserving.

- **`.y` and `.z` cannot be read into an `int`.** The coordinate operator cannot
  move a value between axes. Comparisons on those axes work fine (the axis mask
  handles it), and constant component assignment works. Reading them into a
  scalar does not.
- **`break` inside `foreach` is rejected.** The `for_each_*` widgets drive their
  own iteration through the jump-back stack; leaving early has unverified
  semantics.
- **`emitRedstone` takes a constant.** The mod parses that text parameter with
  `NumberUtils.toInt`; there is no variable form.
- **No modulo.** No widget does it.
- **Inlining only at one call site.** Beyond that, whether inlining wins depends
  on body size, which is not measured yet. See below.
- **Some settings are 1.21-only** — `digSide`, `randomize`, and the whole
  `computer_control` widget. Selecting 1.20.4 reports these rather than dropping
  them silently.

## Where to go next

1. **Verify against a real game.** Described above. Everything else is lower
   value until this is done.
2. **A decompiler.** JSON → source. Was scoped out of v1. It would also serve as
   a second check on the emitter.
3. **Inlining by body size.** Currently inlines at exactly one call site. The
   real tradeoff is `N × body` against `body + 2 + 2N`, so a small body called
   twice or three times should also inline. Needs the lowered body's widget
   count, which means lowering the routine before deciding.
4. **A Programmable Controller target flag.** Seven widget types are rejected by
   the Controller (`controllerBlacklisted` in the spec table, already recorded).
   Nothing uses it yet.
5. **Source-to-widget highlighting.** `WidgetNode.origin` exists for this and is
   currently unused; the preview could highlight the source span of a clicked
   widget.

## Traps

- **Verify the pack's Minecraft version before trusting any mod branch.** This
  is the mistake that cost a rebuild.
- **WebFetch summarises Java rather than quoting it**, which is not good enough
  for transcribing field names — it will paraphrase a codec and you will believe
  it. Download sources and read them: the GitHub tree API plus
  `raw.githubusercontent.com` works fine.
- **Piece counts in `test/examples.test.ts` are pinned.** A change there is
  either an optimisation win worth recording or a regression worth explaining.
  Do not just update the number.
- **The spec table is generated by hand from Java source.** Each entry names its
  class. If you touch it, re-check against the branch that matches the target.

## Running it

```bash
npm install          # npm workspaces; pnpm is not available on this machine
npm test             # 91 tests
npm run typecheck    # tsc + svelte-check
npm run dev          # editor on localhost:5173
npm run build        # static site into packages/web/dist
```

`INSPECT=1 npx vitest run test/inspect.test.ts` inside `packages/compiler` dumps
the compiled examples with positions and fields — the quickest way to see what
the compiler actually produced.

Deployment is Cloudflare Pages; `wrangler.jsonc` points at the build output.
There is no server side.
