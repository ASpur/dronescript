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
}

export interface FunctionDoc {
  readonly name: string;
  readonly signature: string;
  readonly summary: string;
  /** Condition widgets: usable in `if`/`while`/`for`, or assigned to measure. */
  readonly sensor: boolean;
  /** Filter/area options that become parameter widgets (`only`, `exceptArea`). */
  readonly parameters: readonly OptionDoc[];
  /** Scalar options that become widget fields (`order`, `maxActions`). */
  readonly options: readonly OptionDoc[];
}

export function docFor(builtin: BuiltinSpec): FunctionDoc {
  const positional = builtin.params
    .filter((p) => p.from.kind === "arg" && p.side === "whitelist")
    .map((p) => p.type);
  const parameters = builtin.params.flatMap((p) =>
    p.from.kind === "option" ? [{ name: p.from.name, type: p.type.replace("_", " ") }] : [],
  );
  const options = builtin.fields.map((field) => ({
    name: field.option,
    type:
      field.values?.join(" | ") ??
      (field.kind === "direction" || field.kind === "sides"
        ? DIRECTIONS.join(" | ")
        : field.kind),
  }));
  return {
    name: builtin.name,
    signature: `${builtin.name}(${positional.join(", ")}${positional.length > 0 ? ", " : ""}{options})`,
    summary: builtin.summary,
    sensor: builtin.condition !== undefined,
    parameters,
    options,
  };
}

export function signatureOf(builtin: BuiltinSpec): string {
  return docFor(builtin).signature;
}

/** Markdown form of a builtin's documentation, for Monaco hovers and completions. */
export function documentationFor(builtin: BuiltinSpec): string {
  const doc = docFor(builtin);
  const lines = [doc.summary, ""];

  if (doc.parameters.length > 0) {
    lines.push("**Parameters**");
    for (const p of doc.parameters) {
      lines.push(`- \`${p.name}\` — ${p.type}`);
    }
    lines.push("");
  }

  if (doc.options.length > 0) {
    lines.push("**Options**");
    for (const o of doc.options) {
      lines.push(`- \`${o.name}\`: ${o.type}`);
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

// --- Function categories -----------------------------------------------------

export interface Category {
  readonly title: string;
  readonly blurb?: string;
  readonly entries: readonly FunctionDoc[];
}

/** Mirrors the comment groups in the compiler's builtins.ts. */
const ACTION_GROUPS: readonly { title: string; names: readonly string[] }[] = [
  { title: "Movement", names: ["goto", "teleport", "standby"] },
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

  const sensors = BUILTINS.filter((b) => b.condition && !claimed.has(b.name));
  const world = sensors.filter((b) => !b.name.startsWith("drone."));
  const drone = sensors.filter((b) => b.name.startsWith("drone."));
  for (const b of sensors) claimed.add(b.name);
  categories.push({
    title: "World sensors",
    blurb: "Read the world. Use in a condition, or assign to a variable to measure.",
    entries: world.map(docFor),
  });
  categories.push({
    title: "Drone sensors",
    blurb: "Read the drone itself. Use in a condition, or assign to a variable to measure.",
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

/** `area()`, `filter()`, `fluid()` and `items()` live in the const-evaluator,
 * not the builtin table, so their docs are written by hand. */
export const PSEUDO_FUNCTIONS: readonly FunctionDoc[] = [
  {
    name: "area",
    signature: "area(pos1, pos2?, {options})",
    summary:
      "Define an area from two corner positions — coordinate literals, constants, or variables. With one position, the area is that single block.",
    sensor: false,
    parameters: [],
    options: [{ name: "shape", type: AREA_TYPES.map((a) => a.id).join(" | ") }],
  },
  {
    name: "filter",
    signature: 'filter("mod:item", {options})',
    summary: "Define an item filter. Match a specific item, or widen the match with options.",
    sensor: false,
    parameters: [],
    options: [
      { name: "matchDurability", type: "bool" },
      { name: "matchComponents", type: "bool" },
      { name: "matchMod", type: "bool" },
      { name: "matchBlock", type: "bool" },
      { name: "var", type: "string" },
    ],
  },
  {
    name: "fluid",
    signature: 'fluid("mod:fluid", {options})',
    summary: "Define a fluid filter.",
    sensor: false,
    parameters: [],
    options: [{ name: "amount", type: "int — millibuckets, defaults to 1000" }],
  },
  {
    name: "items",
    signature: "items(filter)",
    summary:
      "Iterate the drone's inventory. Only legal as the iterable of a foreach: foreach (item in items(f)) { … }.",
    sensor: false,
    parameters: [],
    options: [],
  },
];

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
        body: "A coordinate literal is <x, y, z>. Components read back with .x, .y and .z — but only .x can be read into an int (see limitations). Coordinate arithmetic folds a whole chain of operands into one widget.",
        code: `coord above = $drone_pos + <0, 3, 0>;
int col = above.x;`,
      },
      {
        title: "Comments",
        body: "// line and /* block */ comments. They are stripped at compile time and never become widgets.",
      },
      {
        title: "Lists & options",
        body: "[a, b] chains areas or filters wherever one is accepted. The trailing {name: value} object supplies a function's named options; names may be bare or quoted.",
        code: `dig(mine, {only: [filter("minecraft:stone"), filter("minecraft:deepslate")],
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
        body: "if / else, while, for (init; cond; step), and foreach over an area or the drone's items. break and continue work in while and for; break is rejected inside foreach. halt is the suicide widget.",
        code: `foreach (spot in quarry) { dig(spot); }
foreach (item in items(ores)) { dropItems(porch, {only: item}); }
while (drone.pressure() >= 2) { … }
halt;`,
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
        body: "There are no boolean values, only branching: a condition may only appear in if, while or for. A bare sensor call means “reads at least 1”. && and || cost no extra widgets. The game only offers =, >= and <=; the compiler rewrites >, < and != for free by swapping branch targets. Assign a sensor to a variable to measure it instead of branching.",
        code: `if (itemsIn(chest, {only: ores}) >= 64 && drone.rf() > 0) { … }
int level = lightAt(porch);   // measure, not branch`,
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
