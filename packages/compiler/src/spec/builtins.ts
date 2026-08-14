/**
 * Built-in functions: how DroneScript calls map onto widgets.
 *
 * Positional arguments fill parameter rows (areas first, then filters/text);
 * a trailing options object fills the widget's scalar fields. Both are declared
 * here rather than hard-coded in the lowering, so this table also drives
 * signature checking, the reference sheet and editor completions — which is why
 * every option carries a `doc` string: whatever the compiler accepts, the
 * editor can explain.
 *
 * Sensors exist per *subject* — what the first argument measures. `items(area)`
 * counts inventories in the world; `items(drone)` counts the drone's own cargo.
 * The two are different widgets with different options, so each is its own
 * entry, sharing a name and discriminated by `subject`.
 */

import { ALL_SIDES, DEFAULT_INV_SIDES } from "./widgets.js";
import type { ParamType } from "./types.js";

/** Where a parameter row's contents come from in the call. */
export type ParamSource =
  | { readonly kind: "arg"; readonly index: number }
  | { readonly kind: "option"; readonly name: string };

export interface ParamBinding {
  readonly row: number;
  readonly side: "whitelist" | "blacklist";
  readonly type: ParamType;
  readonly from: ParamSource;
  /** Reject the call if this row is left empty. */
  readonly required?: boolean;
  /** What this input does, shown in the reference and signature help. */
  readonly doc?: string;
}

export type FieldKindName =
  | "int"
  | "bool"
  | "string"
  | "enum"
  | "sides"
  | "direction";

export interface FieldBinding {
  /** Option name as written in source, e.g. `maxActions`. */
  readonly option: string;
  /** Path into the emitted widget fields, e.g. `["dig_place", "max_actions"]`. */
  readonly path: readonly string[];
  readonly kind: FieldKindName;
  readonly values?: readonly string[];
  /** Written even when the option is absent — for fields the codec requires. */
  readonly fallback?: unknown;
  /**
   * Booleans the mod uses to mean "this setting is in effect", set alongside
   * the value: `count` needs `use_count`, `maxActions` needs `use_max_actions`.
   */
  readonly enables?: readonly string[];
  /** What this option does, shown in the reference and signature help. */
  readonly doc: string;
}

/** Paths a condition widget uses; they differ between world and drone conditions. */
export interface ConditionPaths {
  readonly operator: readonly string[];
  readonly count: readonly string[];
  readonly measure: readonly string[];
  readonly andFunction: readonly string[];
}

export interface BuiltinSpec {
  readonly name: string;
  /**
   * Sensors only: what the first argument must be. A name can have one entry
   * per subject; the lowering picks by looking at the call's first argument.
   */
  readonly subject?: "drone" | "area";
  readonly widget: string;
  readonly params: readonly ParamBinding[];
  readonly fields: readonly FieldBinding[];
  /** Conditions only: how to write the operator, count, and measurement var. */
  readonly condition?: ConditionPaths;
  /** Parameter row holding the branch target text. Conditions only. */
  readonly branchRow?: number;
  readonly summary: string;
}

const WORLD_CONDITION: ConditionPaths = {
  operator: ["cond", "cond_op"],
  count: ["inv", "count"],
  measure: ["cond", "measure_var"],
  andFunction: ["cond", "and_func"],
};

const DRONE_CONDITION: ConditionPaths = {
  operator: ["drone_cond", "cond_op"],
  count: ["drone_cond", "required_count"],
  measure: ["drone_cond", "measure_var"],
  andFunction: ["drone_cond", "and_func"],
};

// The mask is ALWAYS written, even when the call names no sides. On ≤1.20.4
// `ProgWidgetInventoryBase.readFromNBT` assigns all six flags unconditionally
// from the tag, so a missing key reads as false rather than "unset" — omitting
// the field would wipe the widget's own UP default and leave the drone with no
// side active, which the game refuses to run. Same trap as an area's pos2.
const SIDES_FIELD: FieldBinding = {
  option: "sides",
  path: ["inv", "sides"],
  kind: "sides",
  fallback: DEFAULT_INV_SIDES,
  doc: 'Faces of the target block the drone may work through, e.g. ["up", "north"]. At least one; defaults to up.',
};
const COUNT_FIELD: FieldBinding = {
  option: "count",
  path: ["inv", "count"],
  kind: "int",
  enables: ["inv", "use_count"],
  doc: "Move at most this many — items here, mB for fluids, FE for energy — then move on.",
};

/** Area rows, plus their blacklist counterpart. */
function areaRow(row: number, argIndex: number, required = true): ParamBinding[] {
  return [
    { row, side: "whitelist", type: "area", from: { kind: "arg", index: argIndex }, required },
    {
      row,
      side: "blacklist",
      type: "area",
      from: { kind: "option", name: "exceptArea" },
      doc: "Skip blocks in this area, even where the main area covers them.",
    },
  ];
}

/** Item filter rows come from `only` (whitelist) and `except` (blacklist). */
function itemFilterRow(row: number): ParamBinding[] {
  return [
    {
      row,
      side: "whitelist",
      type: "item_filter",
      from: { kind: "option", name: "only" },
      doc: "Match only items passing these filters.",
    },
    {
      row,
      side: "blacklist",
      type: "item_filter",
      from: { kind: "option", name: "except" },
      doc: "Ignore anything matching these filters.",
    },
  ];
}

function liquidFilterRow(row: number): ParamBinding[] {
  return [
    {
      row,
      side: "whitelist",
      type: "liquid_filter",
      from: { kind: "option", name: "only" },
      doc: "Match only fluids passing these filters.",
    },
    {
      row,
      side: "blacklist",
      type: "liquid_filter",
      from: { kind: "option", name: "except" },
      doc: "Ignore any fluid matching these filters.",
    },
  ];
}

/** The entity-name text row on entity-targeting widgets. */
function entityFilterRow(row: number): ParamBinding[] {
  return [
    {
      row,
      side: "whitelist",
      type: "text",
      from: { kind: "option", name: "entities" },
      doc: 'An entity type ("zombie" — * and ? are wildcards), or a quoted name ("\\"Steve\\"") to match one entity or player exactly.',
    },
    {
      row,
      side: "blacklist",
      type: "text",
      from: { kind: "option", name: "exceptEntities" },
      doc: "Leave matching entities alone, using the same matching rules.",
    },
  ];
}

const DIG_PLACE_FIELDS: readonly FieldBinding[] = [
  {
    option: "order",
    path: ["dig_place", "order"],
    kind: "enum",
    values: ["closest", "lowToHigh", "highToLow"],
    // The mod's codec requires this field, so it is always written.
    fallback: "closest",
    doc: "Which matching block to target first: closest, lowToHigh (bottom of the area upward), or highToLow (top down).",
  },
  {
    option: "maxActions",
    path: ["dig_place", "max_actions"],
    kind: "int",
    enables: ["dig_place", "use_max_actions"],
    doc: "Interact with at most this many blocks, then move on.",
  },
];

export const BUILTINS: readonly BuiltinSpec[] = [
  // --- Movement ------------------------------------------------------------
  {
    name: "goto",
    widget: "goto",
    params: areaRow(0, 0),
    fields: [
      {
        option: "doneWhenDeparting",
        path: ["done_when_depart"],
        kind: "bool",
        doc: "Move on to the next action as soon as the drone sets off, instead of when it arrives.",
      },
    ],
    summary: "Fly to a location or area.",
  },
  {
    name: "teleport",
    widget: "teleport",
    params: areaRow(0, 0),
    fields: [],
    summary: "Teleport to a location (needs a Teleport upgrade).",
  },
  {
    name: "standby",
    widget: "standby",
    params: [],
    fields: [
      {
        option: "allowPickup",
        path: ["allow_pickup"],
        kind: "bool",
        doc: "While idle, other entities — boats, minecarts — may pick the drone up.",
      },
    ],
    summary: "Land and go idle.",
  },
  {
    name: "suicide",
    widget: "suicide",
    params: [],
    fields: [],
    summary: "The drone destroys itself, dropping whatever it carries. Ends the program.",
  },

  // --- Blocks --------------------------------------------------------------
  {
    name: "dig",
    widget: "dig",
    params: [...areaRow(0, 0), ...itemFilterRow(1)],
    fields: [
      ...DIG_PLACE_FIELDS,
      {
        option: "requireTool",
        path: ["require_tool"],
        kind: "bool",
        doc: "Only dig while a suitable tool is equipped. An equipped tool also digs faster and lends its enchantments, like Silk Touch.",
      },
      {
        option: "digSide",
        path: ["dig_side"],
        kind: "direction",
        doc: "Approach and break each block from this side. (1.21 only.)",
      },
    ],
    summary: "Break blocks in an area.",
  },
  {
    name: "place",
    widget: "place",
    params: [...areaRow(0, 0), ...itemFilterRow(1)],
    fields: [
      ...DIG_PLACE_FIELDS,
      {
        option: "randomize",
        path: ["randomize"],
        kind: "bool",
        doc: "Place a random matching item each time instead of working through the filter in order. (1.21 only.)",
      },
    ],
    summary: "Place blocks in an area.",
  },
  {
    name: "harvest",
    widget: "harvest",
    params: [...areaRow(0, 0), ...itemFilterRow(1)],
    fields: [
      ...DIG_PLACE_FIELDS,
      {
        option: "requireHoe",
        path: ["require_hoe"],
        kind: "bool",
        doc: "Only harvest while a hoe is equipped. A hoe-equipped drone also replants what it harvests.",
      },
    ],
    summary: "Harvest mature crops in an area.",
  },
  {
    name: "rightClickBlock",
    widget: "block_right_click",
    params: [...areaRow(0, 0), ...itemFilterRow(1)],
    fields: [
      ...DIG_PLACE_FIELDS,
      {
        option: "side",
        path: ["side"],
        kind: "direction",
        doc: "Which face of the block to click.",
      },
      {
        option: "sneaking",
        path: ["sneaking"],
        kind: "bool",
        doc: "Click as if sneaking.",
      },
      {
        option: "clickType",
        path: ["click_type"],
        kind: "enum",
        values: ["click_item", "click_block"],
        doc: "click_item uses the held item's right-click logic (e.g. flint and steel); click_block uses the block's own (e.g. flipping a lever).",
      },
    ],
    summary: "Right-click blocks in an area.",
  },
  {
    name: "editSign",
    widget: "edit_sign",
    params: [
      ...areaRow(0, 0),
      {
        row: 1,
        side: "whitelist",
        type: "text",
        from: { kind: "arg", index: 1 },
        doc: "The text to write.",
      },
    ],
    fields: [
      {
        option: "backSide",
        path: ["back_side"],
        kind: "bool",
        doc: "Write the back of the sign instead of the front.",
      },
    ],
    summary: "Write lines onto a sign.",
  },

  // --- Items ---------------------------------------------------------------
  {
    name: "importItems",
    widget: "inventory_import",
    params: [...areaRow(0, 0), ...itemFilterRow(1)],
    fields: [SIDES_FIELD, COUNT_FIELD],
    summary: "Pull items out of inventories in an area.",
  },
  {
    name: "exportItems",
    widget: "inventory_export",
    params: [...areaRow(0, 0), ...itemFilterRow(1)],
    fields: [SIDES_FIELD, COUNT_FIELD],
    summary: "Push items into inventories in an area.",
  },
  {
    name: "pickupItems",
    widget: "pickup_item",
    params: [...areaRow(0, 0), ...itemFilterRow(1)],
    fields: [
      {
        option: "canSteal",
        path: ["can_steal"],
        kind: "bool",
        doc: "Also grab items normally protected from pickup, like items on conveyor belts.",
      },
    ],
    summary: "Pick up dropped items.",
  },
  {
    name: "dropItems",
    widget: "drop_item",
    params: [...areaRow(0, 0), ...itemFilterRow(1)],
    fields: [
      SIDES_FIELD,
      COUNT_FIELD,
      {
        option: "dropStraight",
        path: ["drop_straight"],
        kind: "bool",
        doc: "Drop straight down instead of tossing with a random spread.",
      },
      {
        option: "pickupDelay",
        path: ["pick_delay"],
        kind: "bool",
        doc: "Give dropped items the normal 40-tick pickup delay.",
      },
    ],
    summary: "Drop items on the ground.",
  },
  {
    name: "voidItems",
    widget: "void_item",
    params: itemFilterRow(0),
    fields: [],
    summary: "Destroy matching items held by the drone.",
  },
  {
    name: "craft",
    widget: "crafting",
    params: [
      { row: 0, side: "whitelist", type: "item_filter", from: { kind: "arg", index: 0 }, doc: "Top row of the crafting grid." },
      { row: 1, side: "whitelist", type: "item_filter", from: { kind: "arg", index: 1 }, doc: "Middle row of the crafting grid." },
      { row: 2, side: "whitelist", type: "item_filter", from: { kind: "arg", index: 2 }, doc: "Bottom row of the crafting grid." },
    ],
    fields: [
      {
        option: "count",
        path: ["count"],
        kind: "int",
        enables: ["use_count"],
        doc: "Craft at most this many results, then move on.",
      },
    ],
    summary: "Craft from the drone's inventory, one row of the grid per argument.",
  },
  {
    name: "itemAssign",
    widget: "item_assign",
    params: [
      {
        row: 0,
        side: "whitelist",
        type: "item_filter",
        from: { kind: "arg", index: 1 },
        required: true,
        doc: "The filter to store. Exactly one.",
      },
    ],
    fields: [
      {
        option: "var",
        path: ["var"],
        kind: "string",
        doc: "Name of the item variable to store the filter in.",
      },
    ],
    summary: "Store an item filter into an item variable.",
  },

  // --- Fluids and energy ---------------------------------------------------
  {
    name: "importLiquid",
    widget: "liquid_import",
    params: [...areaRow(0, 0), ...liquidFilterRow(1)],
    fields: [
      SIDES_FIELD,
      COUNT_FIELD,
      {
        option: "order",
        path: ["order"],
        kind: "enum",
        values: ["closest", "lowToHigh", "highToLow"],
        doc: "Which tank to drain first: closest, lowToHigh (bottom of the area upward), or highToLow (top down).",
      },
      {
        option: "voidExcess",
        path: ["void_excess"],
        kind: "bool",
        doc: "If drained fluid does not fit in the drone's tank, destroy it instead of leaving it behind.",
      },
    ],
    summary: "Drain fluid from tanks in an area.",
  },
  {
    name: "exportLiquid",
    widget: "liquid_export",
    params: [...areaRow(0, 0), ...liquidFilterRow(1)],
    fields: [
      SIDES_FIELD,
      COUNT_FIELD,
      {
        option: "placeFluidBlocks",
        path: ["place_fluid_blocks"],
        kind: "bool",
        doc: "Place the fluid into the world as source blocks instead of filling tanks.",
      },
    ],
    summary: "Fill tanks in an area from the drone's tank.",
  },
  {
    name: "voidLiquid",
    widget: "void_liquid",
    params: liquidFilterRow(0),
    fields: [],
    summary: "Empty the drone's tank of matching fluid.",
  },
  {
    name: "importRF",
    widget: "rf_import",
    params: areaRow(0, 0),
    fields: [SIDES_FIELD, COUNT_FIELD],
    summary: "Draw energy from blocks in an area.",
  },
  {
    name: "exportRF",
    widget: "rf_export",
    params: areaRow(0, 0),
    fields: [SIDES_FIELD, COUNT_FIELD],
    summary: "Charge blocks in an area.",
  },

  // --- Entities ------------------------------------------------------------
  {
    name: "attack",
    widget: "entity_attack",
    params: [...areaRow(0, 0), ...entityFilterRow(1)],
    fields: [
      {
        option: "maxActions",
        path: ["max_actions"],
        kind: "int",
        enables: ["use_max_actions"],
        doc: "Attack at most this many entities, then move on.",
      },
      {
        option: "checkSight",
        path: ["check_sight"],
        kind: "bool",
        doc: "Only attack entities the drone can see; ignore ones behind walls.",
      },
    ],
    summary: "Attack entities in an area.",
  },
  {
    name: "rightClickEntity",
    widget: "entity_right_click",
    params: [...areaRow(0, 0), ...entityFilterRow(1)],
    fields: [],
    summary: "Right-click entities in an area.",
  },
  {
    name: "importEntities",
    widget: "entity_import",
    params: [...areaRow(0, 0), ...entityFilterRow(1)],
    fields: [],
    summary: "Carry entities from an area.",
  },
  {
    name: "exportEntities",
    widget: "entity_export",
    params: [...areaRow(0, 0), ...entityFilterRow(1)],
    fields: [],
    summary: "Release carried entities into an area.",
  },

  // --- Misc ----------------------------------------------------------------
  {
    name: "wait",
    widget: "wait",
    params: [
      {
        row: 0,
        side: "whitelist",
        type: "text",
        from: { kind: "arg", index: 0 },
        required: true,
        doc: "Ticks to pause — 20 per second. Must be a constant.",
      },
    ],
    fields: [],
    summary: "Pause for a number of ticks.",
  },
  {
    name: "emitRedstone",
    widget: "emit_redstone",
    params: [
      {
        row: 0,
        side: "whitelist",
        type: "text",
        from: { kind: "arg", index: 0 },
        required: true,
        doc: "Signal strength, 0–15. Must be a constant.",
      },
    ],
    fields: [
      {
        ...SIDES_FIELD,
        path: ["sides"],
        // ProgWidgetEmitRedstone reads its sides the same unconditional way,
        // but its own default is every side rather than UP.
        fallback: ALL_SIDES,
        doc: "Which of the drone's sides emit the signal. At least one; defaults to all six.",
      },
    ],
    summary: "Emit a redstone signal. The strength must be a constant.",
  },
  {
    name: "rename",
    widget: "rename",
    params: [
      {
        row: 0,
        side: "whitelist",
        type: "text",
        from: { kind: "arg", index: 0 },
        required: true,
        doc: "The drone's new name.",
      },
    ],
    fields: [],
    summary: "Rename the drone.",
  },
  {
    name: "logistics",
    widget: "logistics",
    params: areaRow(0, 0),
    fields: [],
    summary: "Run logistics tasks for frames in an area.",
  },
  {
    name: "externalProgram",
    widget: "external_program",
    params: areaRow(0, 0),
    fields: [
      {
        option: "shareVariables",
        path: ["share_variables"],
        kind: "bool",
        doc: "Share this program's variables with the called program, instead of giving it a clean slate.",
      },
    ],
    summary: "Run a program stored in a Programmable Controller in an area.",
  },
  {
    name: "computerControl",
    widget: "computer_control",
    params: areaRow(0, 0),
    fields: [SIDES_FIELD, COUNT_FIELD],
    summary: "Hand control to an attached computer.",
  },

  // --- Sensors, world subject: measure an area ------------------------------
  {
    name: "items",
    subject: "area",
    widget: "condition_item_inventory",
    params: [...areaRow(0, 0), ...itemFilterRow(1)],
    fields: [SIDES_FIELD],
    condition: WORLD_CONDITION,
    branchRow: 2,
    summary: "Count matching items in inventories in an area.",
  },
  {
    name: "liquid",
    subject: "area",
    widget: "condition_liquid_inventory",
    params: [...areaRow(0, 0), ...liquidFilterRow(1)],
    fields: [SIDES_FIELD],
    condition: WORLD_CONDITION,
    branchRow: 2,
    summary: "Measure fluid in tanks in an area, in mB.",
  },
  {
    name: "blocks",
    subject: "area",
    widget: "condition_block",
    params: [...areaRow(0, 0), ...itemFilterRow(1)],
    fields: [
      SIDES_FIELD,
      {
        option: "checkAir",
        path: ["check_air"],
        kind: "bool",
        doc: "Count air blocks as matching the filter.",
      },
      {
        option: "checkLiquid",
        path: ["check_liquid"],
        kind: "bool",
        doc: "Count liquid blocks as matching the filter.",
      },
    ],
    condition: WORLD_CONDITION,
    branchRow: 2,
    summary: "Count matching blocks in an area.",
  },
  {
    name: "redstone",
    subject: "area",
    widget: "condition_redstone",
    params: [...areaRow(0, 0)],
    fields: [SIDES_FIELD],
    condition: WORLD_CONDITION,
    branchRow: 1,
    summary: "Read the redstone level in an area.",
  },
  {
    name: "light",
    subject: "area",
    widget: "condition_light",
    params: [...areaRow(0, 0)],
    fields: [SIDES_FIELD],
    condition: WORLD_CONDITION,
    branchRow: 1,
    summary: "Read the light level in an area.",
  },
  {
    name: "pressure",
    subject: "area",
    widget: "condition_pressure",
    params: [...areaRow(0, 0)],
    fields: [SIDES_FIELD],
    condition: WORLD_CONDITION,
    branchRow: 1,
    summary: "Read the pressure of machines in an area, in bar.",
  },
  {
    name: "rf",
    subject: "area",
    widget: "condition_rf",
    params: [...areaRow(0, 0)],
    fields: [SIDES_FIELD],
    condition: WORLD_CONDITION,
    branchRow: 1,
    summary: "Read stored energy in an area — as a percentage, unlike rf(drone).",
  },
  {
    name: "entities",
    subject: "area",
    widget: "condition_entity",
    params: [...areaRow(0, 0), ...entityFilterRow(1)],
    fields: [SIDES_FIELD],
    condition: WORLD_CONDITION,
    branchRow: 2,
    summary: "Count entities in an area.",
  },

  // --- Sensors, drone subject: measure the drone itself ---------------------
  {
    name: "items",
    subject: "drone",
    widget: "drone_condition_item",
    params: itemFilterRow(0),
    fields: [],
    condition: DRONE_CONDITION,
    branchRow: 1,
    summary:
      "Count matching items the drone is carrying. Also the foreach iterable: foreach (it in items(drone)).",
  },
  {
    name: "liquid",
    subject: "drone",
    widget: "drone_condition_liquid",
    params: liquidFilterRow(0),
    fields: [],
    condition: DRONE_CONDITION,
    branchRow: 1,
    summary: "Measure fluid in the drone's tank, in mB.",
  },
  {
    name: "entities",
    subject: "drone",
    widget: "drone_condition_entity",
    params: entityFilterRow(0),
    fields: [],
    condition: DRONE_CONDITION,
    branchRow: 1,
    summary: "Count entities the drone is carrying.",
  },
  {
    name: "pressure",
    subject: "drone",
    widget: "drone_condition_pressure",
    params: [],
    fields: [],
    condition: DRONE_CONDITION,
    branchRow: 0,
    summary: "Read the drone's own pressure, in bar.",
  },
  {
    name: "rf",
    subject: "drone",
    widget: "drone_condition_rf",
    params: [],
    fields: [],
    condition: DRONE_CONDITION,
    branchRow: 0,
    summary: "Read the drone's stored energy — absolute FE, unlike rf(area).",
  },
  {
    name: "upgrades",
    subject: "drone",
    widget: "drone_condition_upgrades",
    params: itemFilterRow(0),
    fields: [],
    condition: DRONE_CONDITION,
    branchRow: 1,
    summary: "Count matching upgrades installed in the drone.",
  },
];

/** Sensor variants that share a name, one per subject. */
export interface SensorVariants {
  readonly drone?: BuiltinSpec;
  readonly area?: BuiltinSpec;
}

const ACTIONS = new Map<string, BuiltinSpec>();
const SENSORS = new Map<string, SensorVariants>();
for (const b of BUILTINS) {
  if (b.subject) {
    SENSORS.set(b.name, { ...SENSORS.get(b.name), [b.subject]: b });
  } else {
    ACTIONS.set(b.name, b);
  }
}

/** Non-sensor builtins, which have exactly one form per name. */
export function getBuiltin(name: string): BuiltinSpec | undefined {
  return ACTIONS.get(name);
}

/** A sensor's variants: which subjects it can measure. */
export function getSensor(name: string): SensorVariants | undefined {
  return SENSORS.get(name);
}

export function isBuiltin(name: string): boolean {
  return ACTIONS.has(name) || SENSORS.has(name);
}

/** Builtins usable in a condition, i.e. those backed by a condition widget. */
export function isSensor(name: string): boolean {
  return SENSORS.has(name);
}
