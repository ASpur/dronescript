# DroneScript

A compiler that turns a C-like language into drone programs for
[PneumaticCraft: Repressurized](https://github.com/TeamPneumatic/pnc-repressurized),
so you can write a program in a text editor instead of dragging puzzle pieces
around the in-game Programmer.

Two mod versions are supported, chosen with the version selector in the toolbar:

| Target | Minecraft | Mod | Format |
| --- | --- | --- | --- |
| **1.20.4** (default) | 1.20.1 – 1.20.4 | 7.0.x | NBT rendered as JSON with type tags |
| 1.21 | 1.21.1 | 8.x | Codec JSON with a `version` field |

**FTB NeoTech runs Minecraft 1.20.4**, so leave the default alone for that pack.
The mod rewrote its serialization for 1.20.6, and the two formats are not
interchangeable — pasting the wrong one gives "Invalid formatted Pastebin or
JSON." in the Programmer. Widget geometry is identical in both, so a program's
layout and puzzle-piece count do not change when you switch.

```c
const pit = area(<100, 40, 100>, <115, 60, 115>);
const dropOff = area(<98, 64, 98>);
const junk = filter("minecraft:cobblestone");

void unload() {
  goto(dropOff);
  exportItems(dropOff, {sides: ["up"]});
}

while (true) {
  if (drone.pressure() <= 1) {
    unload();
    halt;
  }

  dig(pit, {except: junk, order: "highToLow"});

  if (drone.items() >= 64) {
    unload();
  }

  wait(20);
}
```

## Getting a program into the game

1. Compile, and copy the JSON.
2. In game, open a Programmer and click the pastebin button.
3. Choose **Load code from clipboard**, then close the pastebin screen.

No Pastebin account or network access is involved — the mod reads the system
clipboard directly.

## The language

**Types.** `int` and `coord`. Every runtime variable in a drone program is a
block position, so an `int` is one of those with its value in the x component.
Areas, item filters and fluid filters are not runtime values at all — they are
parameter widgets physically attached to whatever uses them — so they are
compile-time constants, declared with `const` and re-emitted at each use.

```c
const quarry = area(<0, 60, 0>, <15, 64, 15>, {shape: "box"});
const ores = filter("minecraft:iron_ore");
const water = fluid("minecraft:water");
```

**Variables.** A bare name is local to the drone. `#name` is shared across your
drones, `%name` is shared server-wide, and `$name` is one the game provides:
`$drone_pos`, `$controller_pos`, `$owner_pos`, `$deploy_pos`, `$owner_look`.

**Control flow.** `if` / `else`, `while`, `for`, `break`, `continue`, `return`,
and `halt` (which is the suicide widget). `foreach (spot in someArea)` compiles
to the game's own iteration widget, as does `foreach (item in items(filter))`.

**Functions.** Declared `void` or `int`, called by name. They compile to a label
and a jump-sub widget. A drone has no call stack for arguments, so each function
gets its own variables — which is sound precisely because **recursion is
rejected**: the game's jump-back mechanism cannot express it, and the compiler
reports the cycle rather than emitting something that misbehaves in world.

**Conditions.** There are no boolean values, only branching, so a condition may
only appear in `if`, `while` or `for`. Sensors read the world
(`itemsIn`, `blocksIn`, `redstoneAt`, `lightAt`, `pressureAt`, `rfAt`,
`entitiesIn`, `liquidIn`) or the drone itself (`drone.pressure()`,
`drone.items()`, `drone.rf()`, `drone.liquid()`, `drone.entities()`,
`drone.upgrades()`). Assign a sensor to a variable to measure it instead of
branching on it.

The game only offers `=`, `>=` and `<=`; the compiler rewrites `>`, `<` and `!=`
into those by swapping the branch targets, which costs nothing.

## Why the output looks the way it does

Every widget except a comment costs a Programming Puzzle piece, so the compiler
works to emit fewer of them. Three properties of the target do most of the work:

- **A condition widget carries both a true target and a false target.** Writing a
  target into the widget costs one text widget; a jump costs two. So a chain of
  `&&` emits no jump widgets at all.
- **A label cannot be fallen into** — only jumped to. Any block reachable by two
  paths therefore needs a label and explicit edges, which makes fall-through the
  thing worth arranging, and the compiler forms traces to maximise it.
- **Running off the end of a chain** returns from a subroutine, or restarts the
  program at the start widget. So `return`, and a top-level `while (true)`, need
  no widgets at all: `while (true) { wait(20); }` compiles to exactly three.

Arithmetic is the same story: the coordinate operator widget folds a whole chain
of operands at once, so `a + b - c + 5` is one widget with four coordinate
parameters rather than three separate operations.

## Correctness

The game reconstructs a program's structure purely from widget coordinates, with
no tolerance — two widgets that land on connecting positions *are* connected,
whether or not that was intended. And a malformed import fails silently: the mod
loads an empty program and writes one line to the log.

So layout records what it meant to connect, and
[`verify/relink.ts`](packages/compiler/src/verify/relink.ts) reimplements the
mod's `updatePuzzleConnections` to derive the graph the game will actually see.
Every compile checks one against the other, and refuses to emit on a mismatch.
That is what catches accidental adjacency, duplicate labels (which the game
resolves by picking one at random), and jumps to labels that do not exist.

## Development

```bash
npm install
npm test        # compiler unit, golden and example tests
npm run dev     # the editor at http://localhost:5173
npm run build   # static site into packages/web/dist
```

- `packages/compiler` — the compiler, pure TypeScript with no DOM dependencies.
  [`src/spec/widgets.ts`](packages/compiler/src/spec/widgets.ts) is the single
  source of truth: all 61 widget types transcribed from the mod source, with the
  Java class named on each entry so it can be re-audited upstream. It drives the
  emitter, the verifier, the builtin signatures and the editor's completions.
  Field names there follow the 1.21 codecs;
  [`src/emit/emitV2.ts`](packages/compiler/src/emit/emitV2.ts) maps them onto the
  older NBT names and flattens the groups that version keeps flat.
- `packages/web` — Svelte + Vite + Monaco. The compiler runs in a web worker.
- `examples/` — programs that double as integration tests, with their piece
  counts pinned so an optimisation win or regression shows up in the diff.

## License

[GNU General Public License v3.0](LICENSE).

The puzzle-piece textures in
[`packages/web/src/assets/progwidgets/`](packages/web/src/assets/progwidgets/)
are from
[PneumaticCraft: Repressurized](https://github.com/TeamPneumatic/pnc-repressurized)
by TeamPneumatic, itself GPLv3 — which is why this project is too. See
[NOTICE.md](packages/web/src/assets/progwidgets/NOTICE.md) there for the exact
provenance.
