/**
 * Reference-sheet content, and the documentation strings Monaco shares.
 *
 * Function docs are derived from the compiler's own builtin table, so the sheet
 * can never advertise a function or option the compiler does not accept. Only
 * syntax, compile-time values, special variables and limitations are written by
 * hand, because they live in the parser and const-evaluator rather than a table.
 */

import {
  AREA_TYPES,
  BUILTINS,
  DIRECTIONS,
  KEYWORDS,
  SPECIAL_VARIABLES,
  SPECIAL_VARIABLE_PREFIXES,
} from "@dronescript/compiler";
import type { BuiltinSpec } from "@dronescript/compiler";

export interface OptionDoc {
  /** As written in source: `maxActions`, `only`, `exceptArea`. */
  readonly name: string;
  /** Human-readable type or the enum values, e.g. `item filter`, `filled | hollow`. */
  readonly type: string;
  /** What the option does, straight from the builtin table. */
  readonly doc: string;
}

export interface PositionalDoc {
  /** As it reads in the signature: the type for builtins, a name for `area()`. */
  readonly label: string;
  readonly type: string;
  readonly required: boolean;
  /** What this input does, when the type alone does not say. */
  readonly doc?: string;
  /** A slot the widget table never reads, so whatever is passed is discarded. */
  readonly ignored?: boolean;
}

export interface FunctionDoc {
  readonly name: string;
  /** Unique across the sheet: sensors repeat a name once per subject. */
  readonly key: string;
  /** Sensors: what the first argument measures. */
  readonly subject?: "drone" | "area";
  readonly signature: string;
  readonly summary: string;
  /** Condition widgets: usable in `if`/`while`/`for`, or assigned to measure. */
  readonly sensor: boolean;
  /** Arguments passed by position, in call order. */
  readonly positional: readonly PositionalDoc[];
  /** Filter/area options that become parameter widgets (`only`, `exceptArea`). */
  readonly parameters: readonly OptionDoc[];
  /** Scalar options that become widget fields (`order`, `maxActions`). */
  readonly options: readonly OptionDoc[];
}

export function docFor(builtin: BuiltinSpec): FunctionDoc {
  // Bindings carry the argument index they read, and the order in the table is
  // not always that order — so place each one by index rather than by position.
  const byIndex: PositionalDoc[] = [];
  for (const p of builtin.params) {
    if (p.from.kind !== "arg" || p.side !== "whitelist") continue;
    byIndex[p.from.index] = {
      label: p.type,
      type: p.type.replace("_", " "),
      required: p.required === true,
      doc: p.doc,
    };
  }
  const positional = Array.from(byIndex, (slot) =>
    slot ?? { label: "_", type: "ignored", required: false, ignored: true },
  );
  // A drone-subject sensor's subject is positional, but binds no parameter row.
  if (builtin.subject === "drone") {
    positional.unshift({ label: "drone", type: "the drone itself", required: true });
  }

  const parameters = builtin.params.flatMap((p) =>
    p.from.kind === "option"
      ? [{ name: p.from.name, type: p.type.replace("_", " "), doc: p.doc ?? "" }]
      : [],
  );
  const options = builtin.fields.map((field) => ({
    name: field.option,
    type:
      field.values?.join(" | ") ??
      (field.kind === "direction" || field.kind === "sides"
        ? DIRECTIONS.join(" | ")
        : field.kind),
    doc: field.doc,
  }));
  return {
    name: builtin.name,
    key: builtin.subject ? `${builtin.name}(${builtin.subject})` : builtin.name,
    subject: builtin.subject,
    signature: signatureFrom(builtin.name, positional, parameters.length + options.length > 0),
    summary: builtin.summary,
    sensor: builtin.condition !== undefined,
    positional,
    parameters,
    options,
  };
}

function signatureFrom(
  name: string,
  positional: readonly PositionalDoc[],
  hasNamedOptions: boolean,
): string {
  // `{options}` appears only when there is at least one named option to put in
  // it — a signature must never advertise settings the compiler would reject.
  const labels = positional.map((p) => p.label);
  if (hasNamedOptions) labels.push("{options}");
  return `${name}(${labels.join(", ")})`;
}

export function signatureOf(builtin: BuiltinSpec): string {
  return docFor(builtin).signature;
}

/** Markdown documentation for anything with a reference entry. */
export function docMarkdown(doc: FunctionDoc): string {
  const lines = [doc.summary, ""];

  if (doc.positional.length > 0) {
    lines.push("**Inputs** — passed by position");
    for (const p of doc.positional) {
      lines.push(
        p.ignored
          ? `- \`_\` — nothing reads this slot, so whatever is passed is discarded`
          : `- \`${p.label}\` — ${p.type}${p.required ? ", required" : ", optional"}${
              p.doc ? `. ${p.doc}` : ""
            }`,
      );
    }
    lines.push("");
  }

  if (doc.parameters.length > 0) {
    lines.push("**Parameters** — named, in the trailing `{…}`");
    for (const p of doc.parameters) {
      lines.push(`- \`${p.name}\` (${p.type}) — ${p.doc}`);
    }
    lines.push("");
  }

  if (doc.options.length > 0) {
    lines.push("**Options** — named, in the trailing `{…}`");
    for (const o of doc.options) {
      lines.push(`- \`${o.name}\` (${o.type}) — ${o.doc}`);
    }
    lines.push("");
  }

  if (doc.sensor) {
    lines.push(
      "Reads a value. Compare it in a condition, or assign it to a variable to measure it.",
    );
  }

  return lines.join("\n");
}

/** Markdown form of a builtin's documentation, for Monaco hovers and completions. */
export function documentationFor(builtin: BuiltinSpec): string {
  return docMarkdown(docFor(builtin));
}

/** Every name with a reference entry: builtins plus the compile-time values. */
const DOCS_BY_NAME = new Map<string, FunctionDoc[]>();

/**
 * Look up a name's docs, e.g. `dig`, `rf`, `area`. Sensors return one entry
 * per subject — `items(area)` and `items(drone)` are different widgets.
 */
export function findFunctionDocs(name: string): readonly FunctionDoc[] {
  return DOCS_BY_NAME.get(name) ?? [];
}

export interface SignatureParameter {
  /** Offsets into the signature label, for highlighting the active input. */
  readonly label: [number, number];
  readonly documentation: string;
}

export interface SignatureLayout {
  readonly label: string;
  readonly parameters: readonly SignatureParameter[];
}

/**
 * Locate each input inside the signature text, so Monaco can highlight the one
 * being typed. The labels are found by scanning rather than rebuilt, which keeps
 * hand-written signatures like `area(pos1, pos2?, {options})` working.
 */
export function signatureLayout(doc: FunctionDoc): SignatureLayout {
  const parameters: SignatureParameter[] = [];
  let cursor = doc.name.length;

  for (const p of doc.positional) {
    const start = doc.signature.indexOf(p.label, cursor);
    if (start < 0) continue;
    cursor = start + p.label.length;
    parameters.push({
      label: [start, cursor],
      documentation: p.ignored
        ? "Nothing reads this slot — whatever is passed is discarded."
        : `${p.type}${p.required ? ", required" : ", optional"}${p.doc ? `. ${p.doc}` : ""}`,
    });
  }

  const options = doc.signature.indexOf("{options}", cursor);
  if (options >= 0) {
    const named = [...doc.parameters, ...doc.options];
    parameters.push({
      label: [options, options + "{options}".length],
      documentation: named.map((o) => `\`${o.name}\` (${o.type}) — ${o.doc}`).join("\n\n"),
    });
  }

  return { label: doc.signature, parameters };
}

// --- Function categories -----------------------------------------------------

export interface Category {
  readonly title: string;
  readonly blurb?: string;
  readonly entries: readonly FunctionDoc[];
}

/** Mirrors the comment groups in the compiler's builtins.ts. */
const ACTION_GROUPS: readonly { title: string; names: readonly string[] }[] = [
  { title: "Movement", names: ["goto", "teleport", "standby", "suicide"] },
  { title: "Blocks", names: ["dig", "place", "harvest", "rightClickBlock", "editSign"] },
  {
    title: "Items",
    names: [
      "importItems",
      "exportItems",
      "pickupItems",
      "dropItems",
      "voidItems",
      "craft",
      "itemAssign",
    ],
  },
  {
    title: "Fluids & energy",
    names: ["importLiquid", "exportLiquid", "voidLiquid", "importRF", "exportRF"],
  },
  {
    title: "Entities",
    names: ["attack", "rightClickEntity", "importEntities", "exportEntities"],
  },
  {
    title: "Misc",
    names: ["wait", "emitRedstone", "rename", "logistics", "externalProgram", "computerControl"],
  },
];

export const FUNCTION_CATEGORIES: readonly Category[] = (() => {
  const claimed = new Set<string>();
  const categories: Category[] = [];

  for (const group of ACTION_GROUPS) {
    const entries = group.names.flatMap((name) => {
      const builtin = BUILTINS.find((b) => b.name === name);
      if (!builtin) return [];
      claimed.add(name);
      return [docFor(builtin)];
    });
    categories.push({ title: group.title, entries });
  }

  const world = BUILTINS.filter((b) => b.subject === "area");
  const drone = BUILTINS.filter((b) => b.subject === "drone");
  for (const b of [...world, ...drone]) claimed.add(b.name);
  categories.push({
    title: "World sensors",
    blurb:
      "Measure an area of the world: the area is the first argument. Use in a condition, or assign to a variable.",
    entries: world.map(docFor),
  });
  categories.push({
    title: "Drone sensors",
    blurb:
      "Measure the drone itself: pass drone as the argument. Use in a condition, or assign to a variable.",
    entries: drone.map(docFor),
  });

  // Anything the lists above miss still gets documented, rather than vanishing
  // when a builtin is added to the compiler without a group assignment here.
  const other = BUILTINS.filter((b) => !claimed.has(b.name));
  if (other.length > 0) {
    categories.push({ title: "Other", entries: other.map(docFor) });
  }

  return categories;
})();

// --- Compile-time values -------------------------------------------------------

/** `area()`, `filter()` and `fluid()` live in the const-evaluator, not the
 * builtin table, so their docs are written by hand. */
export const PSEUDO_FUNCTIONS: readonly FunctionDoc[] = [
  {
    name: "area",
    key: "area",
    signature: "area(pos1, pos2?, {options})",
    summary:
      "Define an area from two corner positions — coordinate literals, constants, or variables. With one position, the area is that single block.",
    sensor: false,
    positional: [
      { label: "pos1", type: "coord", required: true },
      { label: "pos2?", type: "coord — omit for a one-block area", required: false },
    ],
    parameters: [],
    options: [
      {
        name: "shape",
        type: AREA_TYPES.map((a) => a.id).join(" | "),
        doc: "The solid the two corners describe. Defaults to box; each shape has its own options — see Area shapes below.",
      },
    ],
  },
  {
    name: "filter",
    key: "filter",
    signature: 'filter("mod:item", {options})',
    summary: "Define an item filter. Match a specific item, or widen the match with options.",
    sensor: false,
    positional: [{ label: '"mod:item"', type: "text — an item id", required: false }],
    parameters: [],
    options: [
      { name: "matchDurability", type: "bool", doc: "Also require the same damage value." },
      { name: "matchComponents", type: "bool", doc: "Also require the same NBT / components." },
      { name: "matchMod", type: "bool", doc: "Match anything from the same mod instead of the one item." },
      { name: "matchBlock", type: "bool", doc: "Match the placed block rather than the item form." },
      { name: "var", type: "string", doc: "Take the item from an item variable instead of naming one." },
    ],
  },
  {
    name: "fluid",
    key: "fluid",
    signature: 'fluid("mod:fluid", {options})',
    summary: "Define a fluid filter.",
    sensor: false,
    positional: [{ label: '"mod:fluid"', type: "text — a fluid id", required: true }],
    parameters: [],
    options: [
      {
        name: "amount",
        type: "int",
        doc: "Millibuckets the filter stands for; defaults to 1000 (one bucket).",
      },
    ],
  },
];

for (const builtin of BUILTINS) {
  const doc = docFor(builtin);
  DOCS_BY_NAME.set(doc.name, [...(DOCS_BY_NAME.get(doc.name) ?? []), doc]);
}
for (const doc of PSEUDO_FUNCTIONS) DOCS_BY_NAME.set(doc.name, [doc]);

export interface AreaShapeDoc {
  readonly id: string;
  readonly options: readonly { name: string; type: string; required: boolean }[];
}

/** Per-shape options for `area()`, straight from the compiler's table. */
export const AREA_SHAPE_DOCS: readonly AreaShapeDoc[] = AREA_TYPES.map((shape) => ({
  id: shape.id,
  options: shape.fields.map((f) => ({
    name: f.json,
    type:
      (f.values?.join(" | ") ?? f.kind) +
      (f.default !== undefined ? ` — defaults to ${String(f.default)}` : ""),
    required: f.required === true,
  })),
}));

// --- Syntax --------------------------------------------------------------------

export interface SyntaxEntry {
  readonly title: string;
  readonly body: string;
  readonly code?: string;
}

export interface SyntaxSection {
  readonly title: string;
  readonly entries: readonly SyntaxEntry[];
}

export const SYNTAX_SECTIONS: readonly SyntaxSection[] = [
  {
    title: "Types & literals",
    entries: [
      {
        title: "Types",
        body: "int and coord are the only runtime types. Every runtime variable in a drone program is a block position, so an int is one of those with its value in the x component. Areas, item filters and fluid filters are compile-time constants, declared with const and re-emitted at each use.",
        code: `const quarry = area(<0, 60, 0>, <15, 64, 15>, {shape: "box"});
const ores = filter("minecraft:iron_ore");
const water = fluid("minecraft:water");`,
      },
      {
        title: "Coordinates",
        body: "A coordinate literal is <x, y, z>. Components read back with .x, .y and .z — but only .x can be read into an int (see limitations). Coordinate arithmetic folds a whole chain of operands into one widget, and works inline wherever a position is expected — a runtime operand costs the same one widget the spelled-out assignment would, and an all-constant expression costs nothing.",
        code: `coord above = $drone_pos + <0, 3, 0>;
goto(refuelTarget + <0, 1, 0>);
int col = above.x;`,
      },
      {
        title: "Comments",
        body: "// line and /* block */ comments. They are stripped at compile time and never become widgets.",
      },
      {
        title: "Lists & options",
        body: "[a, b] chains areas or filters wherever one is accepted, and a const can hold one — bare coordinates in a list become one-block areas, so a list of points is an area you can foreach over. The trailing {name: value} object supplies a function's named options; names may be bare or quoted.",
        code: `const fuelSpots = [<100, 100, 100>, <100, 101, 100>];
foreach (b in fuelSpots) { goto(b); }
dig(mine, {only: [filter("minecraft:stone"), filter("minecraft:deepslate")],
           order: "closest", maxActions: 8});`,
      },
    ],
  },
  {
    title: "Variables",
    entries: [
      {
        title: "Scopes by sigil",
        body: "A bare name is local to the drone. #name is shared across your drones, %name is shared server-wide, and $name is a read-only value the game provides.",
        code: `int mined = 0;          // this drone only
global int #handoff = 0; // all of your drones
server int %beacon = 0;  // everyone, server-wide`,
      },
      {
        title: "Declarations",
        body: "int or coord, optionally preceded by global or server to match the # or % sigil — the sigil on the name is what determines the scope. const declares a compile-time value: a number, coordinate, area, filter or fluid.",
      },
    ],
  },
  {
    title: "Control flow",
    entries: [
      {
        title: "Branching & loops",
        body: "if / else, while, for (init; cond; step), and foreach over an area or the drone's items. break and continue work in while and for; break is rejected inside foreach. suicide() ends the program by destroying the drone.",
        code: `foreach (spot in quarry) { dig(spot); }
foreach (it in items(drone, {only: ores})) {
  dropItems(porch, {only: filter({var: "it"})});
}
while (pressure(drone) >= 2) { … }
suicide();`,
      },
      {
        title: "Functions",
        body: "Declared void, int or coord and called by name. They compile to a label plus a jump-sub; a drone has no call stack, so each function gets its own variables — sound because recursion is rejected.",
        code: `int nextRow(int row) {
  return row + 1;
}`,
      },
      {
        title: "Conditions",
        body: "There are no boolean values, only branching: a condition may only appear in if, while or for. A sensor's first argument is its subject — an area of the world, or the drone itself: pressure(machines) vs pressure(drone). A bare sensor call means “reads at least 1”. && and || cost no extra widgets. The game only offers =, >= and <=; the compiler rewrites >, < and != for free by swapping branch targets. Assign a sensor to a variable to measure it instead of branching.",
        code: `if (items(chest, {only: ores}) >= 64 && rf(drone) > 0) { … }
int level = light(porch);   // measure, not branch`,
      },
      {
        title: "Operators",
        body: "Unary - and !. Arithmetic + - * / (no modulo — no widget does it). Comparison == != < <= > >=. Logical && and ||, in conditions only. Assignment = += -= *= /=, plus ++ and --.",
      },
    ],
  },
];

/** All 18 language keywords, straight from the lexer. */
export const KEYWORD_LIST: readonly string[] = [...KEYWORDS];

// --- Special variables -----------------------------------------------------------

export interface SpecialVariableDoc {
  readonly name: string;
  readonly description: string;
  readonly legacy?: boolean;
  /** Takes a `=name` argument, so it is matched by prefix. */
  readonly prefix?: boolean;
}

const SPECIAL_VARIABLE_DESCRIPTIONS: readonly SpecialVariableDoc[] = [
  { name: "$drone_pos", description: "The drone's own position." },
  { name: "$controller_pos", description: "The Programmable Controller running the program." },
  { name: "$owner_pos", description: "The player who deployed the drone, tracked live." },
  { name: "$deploy_pos", description: "Where the drone was deployed." },
  { name: "$owner_look", description: "The owner's look direction, as a unit-ish offset." },
  { name: "$owner", description: "Older spelling of $owner_pos.", legacy: true },
  { name: "$drone", description: "Older spelling of $drone_pos.", legacy: true },
  {
    name: "$player_pos=name",
    description: "A named player's position. Only works while that player is online.",
    prefix: true,
  },
  { name: "$player=name", description: "Older spelling of $player_pos=name.", legacy: true, prefix: true },
];

/** Every special variable the compiler accepts, with a doc entry guaranteed. */
export const SPECIAL_VARIABLE_DOCS: readonly SpecialVariableDoc[] = (() => {
  const docs = [...SPECIAL_VARIABLE_DESCRIPTIONS];
  const covered = new Set(docs.map((d) => (d.prefix ? d.name.split("=")[0]! : d.name)));
  const missing = [
    ...[...SPECIAL_VARIABLES].filter((name) => !covered.has(name)),
    ...SPECIAL_VARIABLE_PREFIXES.filter((prefix) => !covered.has(prefix)),
  ];
  for (const name of missing) {
    console.warn(`reference.ts has no description for special variable ${name}`);
    docs.push({ name, description: "Game-provided value." });
  }
  return docs;
})();

// --- Limitations ------------------------------------------------------------------

/** Deliberate limits, from HANDOFF.md — each exists for a reason. */
export const LIMITATIONS: readonly string[] = [
  ".y and .z cannot be read into an int — the coordinate operator cannot move a value between axes. Comparing on those axes works fine.",
  "break inside foreach is rejected: the game's iteration widgets drive their own looping.",
  "emitRedstone takes a constant strength; the mod has no variable form.",
  "No modulo operator — no widget computes it.",
  "Recursion is rejected; the game's jump-back mechanism cannot express it.",
  "Some settings are 1.21-only — digSide, randomize, and computerControl. Targeting 1.20.4 reports them rather than dropping them silently.",
  'Entity filters: an unquoted name matches an entity type ("zombie"); a quoted name ("\\"Steve\\"") matches a player or entity name exactly, where only * and ? are wildcards.',
];
