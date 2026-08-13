/**
 * Built-in functions: how DroneScript calls map onto widgets.
 *
 * Positional arguments fill parameter rows (areas first, then filters/text);
 * a trailing options object fills the widget's scalar fields. Both are declared
 * here rather than hard-coded in the lowering, so this table also drives
 * signature checking and editor completions.
 */

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

const SIDES_FIELD: FieldBinding = { option: "sides", path: ["inv", "sides"], kind: "sides" };
const COUNT_FIELD: FieldBinding = {
  option: "count",
  path: ["inv", "count"],
  kind: "int",
  enables: ["inv", "use_count"],
};

/** Area rows, plus their blacklist counterpart. */
function areaRow(row: number, argIndex: number, required = true): ParamBinding[] {
  return [
    { row, side: "whitelist", type: "area", from: { kind: "arg", index: argIndex }, required },
    { row, side: "blacklist", type: "area", from: { kind: "option", name: "exceptArea" } },
  ];
}

/** Item filter rows come from `only` (whitelist) and `except` (blacklist). */
function itemFilterRow(row: number): ParamBinding[] {
  return [
    { row, side: "whitelist", type: "item_filter", from: { kind: "option", name: "only" } },
    { row, side: "blacklist", type: "item_filter", from: { kind: "option", name: "except" } },
  ];
}

function liquidFilterRow(row: number): ParamBinding[] {
  return [
    { row, side: "whitelist", type: "liquid_filter", from: { kind: "option", name: "only" } },
    { row, side: "blacklist", type: "liquid_filter", from: { kind: "option", name: "except" } },
  ];
}

/** The entity-name text row on entity-targeting widgets. */
function entityFilterRow(row: number): ParamBinding[] {
  return [
    { row, side: "whitelist", type: "text", from: { kind: "option", name: "entities" } },
    { row, side: "blacklist", type: "text", from: { kind: "option", name: "exceptEntities" } },
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
  },
  {
    option: "maxActions",
    path: ["dig_place", "max_actions"],
    kind: "int",
    enables: ["dig_place", "use_max_actions"],
  },
];

export const BUILTINS: readonly BuiltinSpec[] = [
  // --- Movement ------------------------------------------------------------
  {
    name: "goto",
    widget: "goto",
    params: areaRow(0, 0),
    fields: [{ option: "doneWhenDeparting", path: ["done_when_depart"], kind: "bool" }],
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
    fields: [{ option: "allowPickup", path: ["allow_pickup"], kind: "bool" }],
    summary: "Land and go idle.",
  },

  // --- Blocks --------------------------------------------------------------
  {
    name: "dig",
    widget: "dig",
    params: [...areaRow(0, 0), ...itemFilterRow(1)],
    fields: [
      ...DIG_PLACE_FIELDS,
      { option: "requireTool", path: ["require_tool"], kind: "bool" },
      { option: "digSide", path: ["dig_side"], kind: "direction" },
    ],
    summary: "Break blocks in an area.",
  },
  {
    name: "place",
    widget: "place",
    params: [...areaRow(0, 0), ...itemFilterRow(1)],
    fields: [...DIG_PLACE_FIELDS, { option: "randomize", path: ["randomize"], kind: "bool" }],
    summary: "Place blocks in an area.",
  },
  {
    name: "harvest",
    widget: "harvest",
    params: [...areaRow(0, 0), ...itemFilterRow(1)],
    fields: [...DIG_PLACE_FIELDS, { option: "requireHoe", path: ["require_hoe"], kind: "bool" }],
    summary: "Harvest mature crops in an area.",
  },
  {
    name: "rightClickBlock",
    widget: "block_right_click",
    params: [...areaRow(0, 0), ...itemFilterRow(1)],
    fields: [
      ...DIG_PLACE_FIELDS,
      { option: "side", path: ["side"], kind: "direction" },
      { option: "sneaking", path: ["sneaking"], kind: "bool" },
      {
        option: "clickType",
        path: ["click_type"],
        kind: "enum",
        values: ["click_item", "click_block"],
      },
    ],
    summary: "Right-click blocks in an area.",
  },
  {
    name: "editSign",
    widget: "edit_sign",
    params: [
      ...areaRow(0, 0),
      { row: 1, side: "whitelist", type: "text", from: { kind: "arg", index: 1 } },
    ],
    fields: [{ option: "backSide", path: ["back_side"], kind: "bool" }],
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
    fields: [{ option: "canSteal", path: ["can_steal"], kind: "bool" }],
    summary: "Pick up dropped items.",
  },
  {
    name: "dropItems",
    widget: "drop_item",
    params: [...areaRow(0, 0), ...itemFilterRow(1)],
    fields: [
      SIDES_FIELD,
      COUNT_FIELD,
      { option: "dropStraight", path: ["drop_straight"], kind: "bool" },
      { option: "pickupDelay", path: ["pick_delay"], kind: "bool" },
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
      { row: 0, side: "whitelist", type: "item_filter", from: { kind: "arg", index: 0 } },
      { row: 1, side: "whitelist", type: "item_filter", from: { kind: "arg", index: 1 } },
      { row: 2, side: "whitelist", type: "item_filter", from: { kind: "arg", index: 2 } },
    ],
    fields: [{ option: "count", path: ["count"], kind: "int", enables: ["use_count"] }],
    summary: "Craft from the drone's inventory, one row of the grid per argument.",
  },
  {
    name: "itemAssign",
    widget: "item_assign",
    params: [
      { row: 0, side: "whitelist", type: "item_filter", from: { kind: "arg", index: 1 }, required: true },
    ],
    fields: [{ option: "var", path: ["var"], kind: "string" }],
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
      },
      { option: "voidExcess", path: ["void_excess"], kind: "bool" },
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
      { option: "placeFluidBlocks", path: ["place_fluid_blocks"], kind: "bool" },
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
      },
      { option: "checkSight", path: ["check_sight"], kind: "bool" },
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
      { row: 0, side: "whitelist", type: "text", from: { kind: "arg", index: 0 }, required: true },
    ],
    fields: [],
    summary: "Pause for a number of ticks.",
  },
  {
    name: "emitRedstone",
    widget: "emit_redstone",
    params: [
      { row: 0, side: "whitelist", type: "text", from: { kind: "arg", index: 0 }, required: true },
    ],
    fields: [{ option: "sides", path: ["sides"], kind: "sides" }],
    summary: "Emit a redstone signal. The strength must be a constant.",
  },
  {
    name: "rename",
    widget: "rename",
    params: [
      { row: 0, side: "whitelist", type: "text", from: { kind: "arg", index: 0 }, required: true },
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
    fields: [{ option: "shareVariables", path: ["share_variables"], kind: "bool" }],
    summary: "Run a program stored in a Programmable Controller in an area.",
  },
  {
    name: "computerControl",
    widget: "computer_control",
    params: areaRow(0, 0),
    fields: [SIDES_FIELD, COUNT_FIELD],
    summary: "Hand control to an attached computer.",
  },

  // --- Sensors (condition widgets) ----------------------------------------
  {
    name: "itemsIn",
    widget: "condition_item_inventory",
    params: [...areaRow(0, 0), ...itemFilterRow(1)],
    fields: [SIDES_FIELD],
    condition: WORLD_CONDITION,
    branchRow: 2,
    summary: "Count matching items in inventories in an area.",
  },
  {
    name: "liquidIn",
    widget: "condition_liquid_inventory",
    params: [...areaRow(0, 0), ...liquidFilterRow(1)],
    fields: [SIDES_FIELD],
    condition: WORLD_CONDITION,
    branchRow: 2,
    summary: "Measure fluid in tanks in an area.",
  },
  {
    name: "blocksIn",
    widget: "condition_block",
    params: [...areaRow(0, 0), ...itemFilterRow(1)],
    fields: [
      { option: "checkAir", path: ["check_air"], kind: "bool" },
      { option: "checkLiquid", path: ["check_liquid"], kind: "bool" },
    ],
    condition: WORLD_CONDITION,
    branchRow: 2,
    summary: "Count matching blocks in an area.",
  },
  {
    name: "redstoneAt",
    widget: "condition_redstone",
    params: [...areaRow(0, 0)],
    fields: [SIDES_FIELD],
    condition: WORLD_CONDITION,
    branchRow: 1,
    summary: "Read the redstone level in an area.",
  },
  {
    name: "lightAt",
    widget: "condition_light",
    params: [...areaRow(0, 0)],
    fields: [],
    condition: WORLD_CONDITION,
    branchRow: 1,
    summary: "Read the light level in an area.",
  },
  {
    name: "pressureAt",
    widget: "condition_pressure",
    params: [...areaRow(0, 0)],
    fields: [],
    condition: WORLD_CONDITION,
    branchRow: 1,
    summary: "Read the pressure of machines in an area.",
  },
  {
    name: "rfAt",
    widget: "condition_rf",
    params: [...areaRow(0, 0)],
    fields: [],
    condition: WORLD_CONDITION,
    branchRow: 1,
    summary: "Read stored energy in an area, as a percentage.",
  },
  {
    name: "entitiesIn",
    widget: "condition_entity",
    params: [...areaRow(0, 0), ...entityFilterRow(1)],
    fields: [],
    condition: WORLD_CONDITION,
    branchRow: 2,
    summary: "Count entities in an area.",
  },

  // --- Sensors about the drone itself -------------------------------------
  {
    name: "drone.items",
    widget: "drone_condition_item",
    params: itemFilterRow(0),
    fields: [],
    condition: DRONE_CONDITION,
    branchRow: 1,
    summary: "Count matching items the drone is carrying.",
  },
  {
    name: "drone.liquid",
    widget: "drone_condition_liquid",
    params: liquidFilterRow(0),
    fields: [],
    condition: DRONE_CONDITION,
    branchRow: 1,
    summary: "Measure fluid in the drone's tank.",
  },
  {
    name: "drone.entities",
    widget: "drone_condition_entity",
    params: entityFilterRow(0),
    fields: [],
    condition: DRONE_CONDITION,
    branchRow: 1,
    summary: "Count entities the drone is carrying.",
  },
  {
    name: "drone.pressure",
    widget: "drone_condition_pressure",
    params: [],
    fields: [],
    condition: DRONE_CONDITION,
    branchRow: 0,
    summary: "Read the drone's own pressure.",
  },
  {
    name: "drone.rf",
    widget: "drone_condition_rf",
    params: [],
    fields: [],
    condition: DRONE_CONDITION,
    branchRow: 0,
    summary: "Read the drone's stored energy.",
  },
  {
    name: "drone.upgrades",
    widget: "drone_condition_upgrades",
    params: itemFilterRow(0),
    fields: [],
    condition: DRONE_CONDITION,
    branchRow: 1,
    summary: "Count matching upgrades installed in the drone.",
  },
];

const BY_NAME = new Map(BUILTINS.map((b) => [b.name, b]));

export function getBuiltin(name: string): BuiltinSpec | undefined {
  return BY_NAME.get(name);
}

export function isBuiltin(name: string): boolean {
  return BY_NAME.has(name);
}

/** Builtins usable in a condition, i.e. those backed by a condition widget. */
export function isSensor(name: string): boolean {
  return BY_NAME.get(name)?.condition !== undefined;
}
