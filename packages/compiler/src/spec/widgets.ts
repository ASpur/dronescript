/**
 * The widget spec table — the single source of truth for this compiler.
 *
 * Every entry was transcribed from TeamPneumatic/pnc-repressurized branch `1.21`
 * (MC 1.21.1 / NeoForge, mod v8.2.x). `javaClass` names the class the data came
 * from so entries can be re-audited against upstream.
 *
 * Field names and defaults mirror each class's `CODEC` exactly. Getting these
 * wrong is expensive: the mod parses imports with `resultOrPartial`, so a bad
 * field silently yields an EMPTY program with only a log warning.
 */

import type { AreaTypeSpec, FieldSpec, WidgetSpec } from "./types.js";

export const NAMESPACE = "pneumaticcraft";

/** `ProgWidget.JSON_VERSION` — must be emitted, or the importer assumes v1. */
export const JSON_VERSION = 3;

/** `ProgWidget.PROGWIDGET_WIDTH` / `PROGWIDGET_HEIGHT`. */
export const PROGWIDGET_WIDTH = 30;
export const PROGWIDGET_HEIGHT = 22;

/**
 * All connection math halves these constants (`getWidth() / 2`,
 * `getHeight() / 2`, `paramIdx * PROGWIDGET_HEIGHT / 2`), so program-space
 * units are half of GUI units.
 */
export const PARAM_X_STEP = PROGWIDGET_WIDTH / 2; // 15
export const PARAM_Y_STEP = PROGWIDGET_HEIGHT / 2; // 11

/** `ICondition.Operator.getSerializedName()` — lowercase enum names. */
export const CONDITION_OPERATORS = ["eq", "ge", "le"] as const;
export type ConditionOperator = (typeof CONDITION_OPERATORS)[number];

/** `IBlockOrdered.Ordering` — note the camelCase serialized names. */
export const BLOCK_ORDERINGS = ["closest", "lowToHigh", "highToLow"] as const;

/** `ProgWidgetCoordinateOperator.EnumOperator`. */
export const COORD_OPERATORS = [
  "plus_minus",
  "multiply_divide",
  "max_min",
] as const;
export type CoordOperator = (typeof COORD_OPERATORS)[number];

/** `IBlockRightClicker.RightClickType`. */
export const RIGHT_CLICK_TYPES = ["click_item", "click_block"] as const;

/** `AreaType.AreaAxis`. */
export const AREA_AXES = ["x", "y", "z"] as const;

/** Lowercase `Direction` names, ordered by `Direction.get3DDataValue()`. */
export const DIRECTIONS = [
  "down",
  "up",
  "north",
  "south",
  "west",
  "east",
] as const;
export type DirectionName = (typeof DIRECTIONS)[number];

/** `ProgWidgetInventoryBase.DEFAULT_SIDES` — UP only (bit 1). */
export const DEFAULT_INV_SIDES = 1 << 1;
/** `ProgWidgetEmitRedstone.ALL_SIDES`. */
export const ALL_SIDES = 0b111111;
/** `AxisOptions.TRUE` — all three axes selected. */
export const ALL_AXES = 0b111;

// ---------------------------------------------------------------------------
// Reusable field groups (the mod composes these into several widgets' codecs)
// ---------------------------------------------------------------------------

/** `ProgWidgetInventoryBase.InvBaseFields`, emitted under key `inv`. */
const INV_GROUP: FieldSpec = {
  json: "inv",
  kind: "group",
  required: true,
  fields: [
    { json: "sides", kind: "sides", default: DEFAULT_INV_SIDES },
    { json: "use_count", kind: "bool", default: false },
    { json: "count", kind: "int", default: 1 },
  ],
};

/** `ProgWidgetDigAndPlace.DigPlaceFields`, key `dig_place`. `order` is required. */
const DIG_PLACE_GROUP: FieldSpec = {
  json: "dig_place",
  kind: "group",
  required: true,
  fields: [
    { json: "order", kind: "enum", required: true, values: BLOCK_ORDERINGS },
    { json: "max_actions", kind: "int", default: 1 },
    { json: "use_max_actions", kind: "bool", default: false },
  ],
};

/**
 * `ProgWidgetCondition.ConditionFields`, key `cond`. World conditions take their
 * required count from `inv.count`, not from here.
 */
const COND_GROUP: FieldSpec = {
  json: "cond",
  kind: "group",
  required: true,
  fields: [
    { json: "and_func", kind: "bool", default: false },
    { json: "cond_op", kind: "enum", default: "ge", values: CONDITION_OPERATORS },
    { json: "measure_var", kind: "string", default: "" },
  ],
};

/** `ProgWidgetDroneCondition.DroneConditionFields`, key `drone_cond`. */
const DRONE_COND_GROUP: FieldSpec = {
  json: "drone_cond",
  kind: "group",
  required: true,
  fields: [
    { json: "and_func", kind: "bool", default: false },
    { json: "cond_op", kind: "enum", default: "ge", values: CONDITION_OPERATORS },
    { json: "required_count", kind: "int", default: 1 },
    { json: "measure_var", kind: "string", default: "" },
  ],
};

// Common parameter row shapes. `blacklist` records whether the left side of that
// row accepts a widget, from each class's hasBlacklist()/canSetParameter().
const AREA_ITEM = [
  { type: "area", blacklist: true },
  { type: "item_filter", blacklist: true },
] as const;
const AREA_LIQUID = [
  { type: "area", blacklist: true },
  { type: "liquid_filter", blacklist: true },
] as const;
const AREA_TEXT = [
  { type: "area", blacklist: true },
  { type: "text", blacklist: true },
] as const;
const AREA_ONLY = [{ type: "area", blacklist: true }] as const;
const TEXT_ONLY_NO_BL = [{ type: "text", blacklist: false }] as const;

// ---------------------------------------------------------------------------
// Widget table — all 61 registered types, in ModProgWidgetTypes order
// ---------------------------------------------------------------------------

export const WIDGETS: readonly WidgetSpec[] = [
  {
    id: "comment",
    javaClass: "ProgWidgetComment",
    category: "meta",
    params: [],
    fields: [{ json: "string", kind: "string", required: true }],
    hasStepInput: false,
    hasStepOutput: false,
    free: true, // the only widget costing no puzzle piece
    width: 40, // getWidth() = super + 10
    height: 32, // getHeight() = super + 10
  },
  {
    id: "start",
    javaClass: "ProgWidgetStart",
    category: "flow",
    params: [],
    fields: [],
    hasStepInput: false,
    hasStepOutput: true,
  },
  {
    id: "area",
    javaClass: "ProgWidgetArea",
    category: "parameter",
    params: [{ type: "area", blacklist: true }],
    fields: [
      { json: "pos1", kind: "blockpos" },
      { json: "pos2", kind: "blockpos" },
      { json: "area_type", kind: "group", required: true },
      { json: "var1", kind: "string", default: "" },
      { json: "var2", kind: "string", default: "" },
    ],
    hasStepInput: false,
    hasStepOutput: false,
    returnType: "area",
  },
  {
    id: "text",
    javaClass: "ProgWidgetText",
    category: "parameter",
    params: [{ type: "text", blacklist: true }],
    fields: [{ json: "string", kind: "string", required: true }],
    hasStepInput: false,
    hasStepOutput: false,
    returnType: "text",
  },
  {
    id: "item_filter",
    javaClass: "ProgWidgetItemFilter",
    category: "parameter",
    params: [{ type: "item_filter", blacklist: true }],
    fields: [
      { json: "chk_item", kind: "itemstack" },
      { json: "chk_durability", kind: "bool", default: false },
      { json: "chk_components", kind: "bool", default: false },
      { json: "chk_mod", kind: "bool", default: false },
      { json: "chk_block", kind: "bool", default: false },
      { json: "var", kind: "string", default: "" },
    ],
    hasStepInput: false,
    hasStepOutput: false,
    returnType: "item_filter",
  },
  {
    id: "item_assign",
    javaClass: "ProgWidgetItemAssign",
    category: "action",
    params: [{ type: "item_filter", blacklist: false }],
    fields: [{ json: "var", kind: "string", default: "" }],
    hasStepInput: true,
    hasStepOutput: true,
  },
  {
    id: "liquid_filter",
    javaClass: "ProgWidgetLiquidFilter",
    category: "parameter",
    params: [{ type: "liquid_filter", blacklist: true }],
    fields: [{ json: "fluid", kind: "fluidstack" }],
    hasStepInput: false,
    hasStepOutput: false,
    returnType: "liquid_filter",
  },
  {
    id: "coordinate",
    javaClass: "ProgWidgetCoordinate",
    category: "parameter",
    params: [{ type: "coordinate", blacklist: true }],
    fields: [
      { json: "coord", kind: "blockpos", default: [0, 0, 0] },
      { json: "var", kind: "string", default: "" },
      { json: "using_var", kind: "bool", default: false },
    ],
    hasStepInput: false,
    hasStepOutput: false,
    returnType: "coordinate",
  },
  {
    id: "coordinate_operator",
    javaClass: "ProgWidgetCoordinateOperator",
    category: "action",
    params: [{ type: "coordinate", blacklist: true }],
    fields: [
      { json: "var", kind: "string", default: "" },
      { json: "coord_op", kind: "enum", default: "plus_minus", values: COORD_OPERATORS },
      { json: "axis_options", kind: "axes", default: ALL_AXES },
    ],
    hasStepInput: true,
    hasStepOutput: true,
  },
  {
    id: "entity_attack",
    javaClass: "ProgWidgetEntityAttack",
    category: "action",
    params: AREA_TEXT,
    fields: [
      { json: "use_max_actions", kind: "bool", default: false },
      { json: "max_actions", kind: "int", default: 1 },
      { json: "check_sight", kind: "bool", default: false },
    ],
    hasStepInput: true,
    hasStepOutput: true,
    controllerBlacklisted: true,
  },
  {
    id: "dig",
    javaClass: "ProgWidgetDig",
    category: "action",
    params: AREA_ITEM,
    fields: [
      DIG_PLACE_GROUP,
      { json: "require_tool", kind: "bool", default: false },
      { json: "dig_side", kind: "direction", default: "up" },
    ],
    hasStepInput: true,
    hasStepOutput: true,
  },
  {
    id: "harvest",
    javaClass: "ProgWidgetHarvest",
    category: "action",
    params: AREA_ITEM,
    fields: [DIG_PLACE_GROUP, { json: "require_hoe", kind: "bool", default: false }],
    hasStepInput: true,
    hasStepOutput: true,
  },
  {
    id: "place",
    javaClass: "ProgWidgetPlace",
    category: "action",
    params: AREA_ITEM,
    fields: [DIG_PLACE_GROUP, { json: "randomize", kind: "bool", default: false }],
    hasStepInput: true,
    hasStepOutput: true,
  },
  {
    // Extends ProgWidgetPlace in Java but its codec omits `randomize`.
    id: "block_right_click",
    javaClass: "ProgWidgetBlockRightClick",
    category: "action",
    params: AREA_ITEM,
    fields: [
      DIG_PLACE_GROUP,
      { json: "side", kind: "direction", default: "up" },
      { json: "sneaking", kind: "bool", default: false },
      { json: "click_type", kind: "enum", default: "click_item", values: RIGHT_CLICK_TYPES },
    ],
    hasStepInput: true,
    hasStepOutput: true,
  },
  {
    id: "entity_right_click",
    javaClass: "ProgWidgetEntityRightClick",
    category: "action",
    params: AREA_TEXT,
    fields: [],
    hasStepInput: true,
    hasStepOutput: true,
  },
  {
    id: "pickup_item",
    javaClass: "ProgWidgetPickupItem",
    category: "action",
    params: AREA_ITEM,
    fields: [{ json: "can_steal", kind: "bool", default: false }],
    hasStepInput: true,
    hasStepOutput: true,
  },
  {
    id: "drop_item",
    javaClass: "ProgWidgetDropItem",
    category: "action",
    params: AREA_ITEM,
    fields: [
      INV_GROUP,
      { json: "drop_straight", kind: "bool", default: false },
      { json: "pick_delay", kind: "bool", default: false },
    ],
    hasStepInput: true,
    hasStepOutput: true,
  },
  {
    id: "void_item",
    javaClass: "ProgWidgetVoidItem",
    category: "action",
    params: [{ type: "item_filter", blacklist: true }],
    fields: [],
    hasStepInput: true,
    hasStepOutput: true,
  },
  {
    id: "void_liquid",
    javaClass: "ProgWidgetVoidLiquid",
    category: "action",
    params: [{ type: "liquid_filter", blacklist: true }],
    fields: [],
    hasStepInput: true,
    hasStepOutput: true,
  },
  {
    id: "inventory_export",
    javaClass: "ProgWidgetInventoryExport",
    category: "action",
    params: AREA_ITEM,
    fields: [INV_GROUP],
    hasStepInput: true,
    hasStepOutput: true,
  },
  {
    id: "inventory_import",
    javaClass: "ProgWidgetInventoryImport",
    category: "action",
    params: AREA_ITEM,
    fields: [INV_GROUP],
    hasStepInput: true,
    hasStepOutput: true,
  },
  {
    id: "liquid_export",
    javaClass: "ProgWidgetLiquidExport",
    category: "action",
    params: AREA_LIQUID,
    fields: [INV_GROUP, { json: "place_fluid_blocks", kind: "bool", default: false }],
    hasStepInput: true,
    hasStepOutput: true,
  },
  {
    id: "liquid_import",
    javaClass: "ProgWidgetLiquidImport",
    category: "action",
    params: AREA_LIQUID,
    fields: [
      INV_GROUP,
      { json: "order", kind: "enum", default: "highToLow", values: BLOCK_ORDERINGS },
      { json: "void_excess", kind: "bool", default: false },
    ],
    hasStepInput: true,
    hasStepOutput: true,
  },
  {
    id: "entity_export",
    javaClass: "ProgWidgetEntityExport",
    category: "action",
    params: AREA_TEXT,
    fields: [],
    hasStepInput: true,
    hasStepOutput: true,
    controllerBlacklisted: true,
  },
  {
    id: "entity_import",
    javaClass: "ProgWidgetEntityImport",
    category: "action",
    params: AREA_TEXT,
    fields: [],
    hasStepInput: true,
    hasStepOutput: true,
    controllerBlacklisted: true,
  },
  {
    id: "rf_import",
    javaClass: "ProgWidgetEnergyImport",
    category: "action",
    params: AREA_ONLY,
    fields: [INV_GROUP],
    hasStepInput: true,
    hasStepOutput: true,
  },
  {
    id: "rf_export",
    javaClass: "ProgWidgetEnergyExport",
    category: "action",
    params: AREA_ONLY,
    fields: [INV_GROUP],
    hasStepInput: true,
    hasStepOutput: true,
  },
  {
    id: "goto",
    javaClass: "ProgWidgetGoToLocation",
    category: "action",
    params: AREA_ONLY,
    fields: [{ json: "done_when_depart", kind: "bool", default: false }],
    hasStepInput: true,
    hasStepOutput: true,
  },
  {
    // Extends GoToLocation but its codec is baseParts only — no done_when_depart.
    id: "teleport",
    javaClass: "ProgWidgetTeleport",
    category: "action",
    params: AREA_ONLY,
    fields: [],
    hasStepInput: true,
    hasStepOutput: true,
    controllerBlacklisted: true,
  },
  {
    // `sides` sits at top level here, not inside an `inv` group.
    id: "emit_redstone",
    javaClass: "ProgWidgetEmitRedstone",
    category: "action",
    params: TEXT_ONLY_NO_BL,
    fields: [{ json: "sides", kind: "sides", default: ALL_SIDES }],
    hasStepInput: true,
    hasStepOutput: true,
  },
  {
    // No step input: flow can never fall into a label from above.
    id: "label",
    javaClass: "ProgWidgetLabel",
    category: "flow",
    params: TEXT_ONLY_NO_BL,
    fields: [],
    hasStepInput: false,
    hasStepOutput: true,
  },
  {
    // No step output: nothing may be placed below a jump.
    id: "jump",
    javaClass: "ProgWidgetJump",
    category: "flow",
    params: TEXT_ONLY_NO_BL,
    fields: [],
    hasStepInput: true,
    hasStepOutput: false,
  },
  {
    id: "jump_sub",
    javaClass: "ProgWidgetJumpSub",
    category: "flow",
    params: TEXT_ONLY_NO_BL,
    fields: [],
    hasStepInput: true,
    hasStepOutput: true,
  },
  {
    id: "wait",
    javaClass: "ProgWidgetWait",
    category: "action",
    params: TEXT_ONLY_NO_BL,
    fields: [],
    hasStepInput: true,
    hasStepOutput: true,
  },
  {
    id: "rename",
    javaClass: "ProgWidgetRename",
    category: "action",
    params: [{ type: "text", blacklist: true }],
    fields: [],
    hasStepInput: true,
    hasStepOutput: true,
  },
  {
    id: "suicide",
    javaClass: "ProgWidgetSuicide",
    category: "flow",
    params: [],
    fields: [],
    hasStepInput: true,
    hasStepOutput: false,
    width: 40,
  },
  {
    id: "external_program",
    javaClass: "ProgWidgetExternalProgram",
    category: "action",
    params: AREA_ONLY,
    fields: [{ json: "share_variables", kind: "bool", default: false }],
    hasStepInput: true,
    hasStepOutput: true,
  },
  {
    // `use_count`/`count` are top level here, not inside `inv`.
    id: "crafting",
    javaClass: "ProgWidgetCrafting",
    category: "action",
    params: [
      { type: "item_filter", blacklist: false },
      { type: "item_filter", blacklist: false },
      { type: "item_filter", blacklist: false },
    ],
    fields: [
      { json: "use_count", kind: "bool", default: false },
      { json: "count", kind: "int", default: 1 },
    ],
    hasStepInput: true,
    hasStepOutput: true,
  },
  {
    id: "standby",
    javaClass: "ProgWidgetStandby",
    category: "action",
    params: [],
    fields: [{ json: "allow_pickup", kind: "bool", default: false }],
    hasStepInput: true,
    hasStepOutput: true,
    controllerBlacklisted: true,
  },
  {
    id: "logistics",
    javaClass: "ProgWidgetLogistics",
    category: "action",
    params: AREA_ONLY,
    fields: [],
    hasStepInput: true,
    hasStepOutput: true,
  },
  {
    // canSetParameter(index) => index != 2, so the area row's blacklist side is open
    // but the text row's is not.
    id: "for_each_coordinate",
    javaClass: "ProgWidgetForEachCoordinate",
    category: "action",
    params: [
      { type: "area", blacklist: true },
      { type: "text", blacklist: false },
    ],
    fields: [{ json: "var", kind: "string", default: "" }],
    hasStepInput: true,
    hasStepOutput: true,
  },
  {
    id: "for_each_item",
    javaClass: "ProgWidgetForEachItem",
    category: "action",
    params: [
      { type: "item_filter", blacklist: false },
      { type: "text", blacklist: false },
    ],
    fields: [{ json: "var", kind: "string", default: "" }],
    hasStepInput: true,
    hasStepOutput: true,
  },
  {
    // canSetParameter(index) => index != 3 (the text row's blacklist slot).
    id: "edit_sign",
    javaClass: "ProgWidgetEditSign",
    category: "action",
    params: [
      { type: "area", blacklist: true },
      { type: "text", blacklist: false },
    ],
    fields: [{ json: "back_side", kind: "bool", default: false }],
    hasStepInput: true,
    hasStepOutput: true,
  },
  {
    // Both axis_options and cond_op are REQUIRED here (fieldOf, not optionalFieldOf).
    id: "condition_coordinate",
    javaClass: "ProgWidgetCoordinateCondition",
    category: "condition",
    params: [
      { type: "coordinate", blacklist: true },
      { type: "coordinate", blacklist: true },
      { type: "text", blacklist: true },
    ],
    fields: [
      { json: "axis_options", kind: "axes", required: true },
      { json: "cond_op", kind: "enum", required: true, values: CONDITION_OPERATORS },
    ],
    hasStepInput: true,
    hasStepOutput: true,
    isCondition: true,
  },
  {
    id: "condition_redstone",
    javaClass: "ProgWidgetRedstoneCondition",
    category: "condition",
    params: AREA_TEXT,
    fields: [INV_GROUP, COND_GROUP],
    hasStepInput: true,
    hasStepOutput: true,
    isCondition: true,
  },
  {
    id: "condition_light",
    javaClass: "ProgWidgetLightCondition",
    category: "condition",
    params: AREA_TEXT,
    fields: [INV_GROUP, COND_GROUP],
    hasStepInput: true,
    hasStepOutput: true,
    isCondition: true,
  },
  {
    id: "condition_dimension",
    javaClass: "ProgWidgetDimensionCondition",
    category: "condition",
    params: [
      { type: "text", blacklist: true },
      { type: "text", blacklist: true },
    ],
    fields: [],
    hasStepInput: true,
    hasStepOutput: true,
    isCondition: true,
  },
  {
    id: "condition_item_inventory",
    javaClass: "ProgWidgetItemInventoryCondition",
    category: "condition",
    params: [
      { type: "area", blacklist: true },
      { type: "item_filter", blacklist: true },
      { type: "text", blacklist: true },
    ],
    fields: [INV_GROUP, COND_GROUP],
    hasStepInput: true,
    hasStepOutput: true,
    isCondition: true,
  },
  {
    id: "condition_block",
    javaClass: "ProgWidgetBlockCondition",
    category: "condition",
    params: [
      { type: "area", blacklist: true },
      { type: "item_filter", blacklist: true },
      { type: "text", blacklist: true },
    ],
    fields: [
      INV_GROUP,
      COND_GROUP,
      { json: "check_air", kind: "bool", default: false },
      { json: "check_liquid", kind: "bool", default: false },
    ],
    hasStepInput: true,
    hasStepOutput: true,
    isCondition: true,
  },
  {
    id: "condition_liquid_inventory",
    javaClass: "ProgWidgetLiquidInventoryCondition",
    category: "condition",
    params: [
      { type: "area", blacklist: true },
      { type: "liquid_filter", blacklist: true },
      { type: "text", blacklist: true },
    ],
    fields: [INV_GROUP, COND_GROUP],
    hasStepInput: true,
    hasStepOutput: true,
    isCondition: true,
  },
  {
    id: "condition_entity",
    javaClass: "ProgWidgetEntityCondition",
    category: "condition",
    params: [
      { type: "area", blacklist: true },
      { type: "text", blacklist: true },
      { type: "text", blacklist: true },
    ],
    fields: [INV_GROUP, COND_GROUP],
    hasStepInput: true,
    hasStepOutput: true,
    isCondition: true,
  },
  {
    id: "condition_pressure",
    javaClass: "ProgWidgetPressureCondition",
    category: "condition",
    params: AREA_TEXT,
    fields: [INV_GROUP, COND_GROUP],
    hasStepInput: true,
    hasStepOutput: true,
    isCondition: true,
  },
  {
    id: "condition_item",
    javaClass: "ProgWidgetItemCondition",
    category: "condition",
    params: [
      { type: "item_filter", blacklist: true },
      { type: "item_filter", blacklist: true },
      { type: "text", blacklist: true },
    ],
    fields: [],
    hasStepInput: true,
    hasStepOutput: true,
    isCondition: true,
  },
  {
    id: "drone_condition_item",
    javaClass: "ProgWidgetDroneConditionItem",
    category: "condition",
    params: [
      { type: "item_filter", blacklist: true },
      { type: "text", blacklist: true },
    ],
    fields: [DRONE_COND_GROUP],
    hasStepInput: true,
    hasStepOutput: true,
    isCondition: true,
  },
  {
    id: "drone_condition_liquid",
    javaClass: "ProgWidgetDroneConditionFluid",
    category: "condition",
    params: [
      { type: "liquid_filter", blacklist: true },
      { type: "text", blacklist: true },
    ],
    fields: [DRONE_COND_GROUP],
    hasStepInput: true,
    hasStepOutput: true,
    isCondition: true,
  },
  {
    id: "drone_condition_entity",
    javaClass: "ProgWidgetDroneConditionEntity",
    category: "condition",
    params: [
      { type: "text", blacklist: true },
      { type: "text", blacklist: true },
    ],
    fields: [DRONE_COND_GROUP],
    hasStepInput: true,
    hasStepOutput: true,
    isCondition: true,
    controllerBlacklisted: true,
  },
  {
    id: "drone_condition_pressure",
    javaClass: "ProgWidgetDroneConditionPressure",
    category: "condition",
    params: [{ type: "text", blacklist: true }],
    fields: [DRONE_COND_GROUP],
    hasStepInput: true,
    hasStepOutput: true,
    isCondition: true,
  },
  {
    id: "drone_condition_upgrades",
    javaClass: "ProgWidgetDroneConditionUpgrades",
    category: "condition",
    params: [
      { type: "item_filter", blacklist: true },
      { type: "text", blacklist: true },
    ],
    fields: [DRONE_COND_GROUP],
    hasStepInput: true,
    hasStepOutput: true,
    isCondition: true,
  },
  {
    id: "condition_rf",
    javaClass: "ProgWidgetEnergyCondition",
    category: "condition",
    params: AREA_TEXT,
    fields: [INV_GROUP, COND_GROUP],
    hasStepInput: true,
    hasStepOutput: true,
    isCondition: true,
  },
  {
    id: "drone_condition_rf",
    javaClass: "ProgWidgetDroneConditionEnergy",
    category: "condition",
    params: [{ type: "text", blacklist: true }],
    fields: [DRONE_COND_GROUP],
    hasStepInput: true,
    hasStepOutput: true,
    isCondition: true,
  },
  {
    id: "computer_control",
    javaClass: "ProgWidgetCC",
    category: "action",
    params: AREA_ONLY,
    fields: [INV_GROUP],
    hasStepInput: true,
    hasStepOutput: true,
    controllerBlacklisted: true,
  },
];

/** `ModProgWidgetAreaTypes` — dispatched on `type` inside an area's `area_type`. */
export const AREA_TYPES: readonly AreaTypeSpec[] = [
  {
    id: "box",
    javaClass: "AreaTypeBox",
    fields: [
      { json: "box_type", kind: "enum", default: "filled", values: ["filled", "hollow", "frame"] },
    ],
  },
  {
    id: "cylinder",
    javaClass: "AreaTypeCylinder",
    fields: [
      { json: "cylinder_type", kind: "enum", default: "filled", values: ["filled", "hollow", "tube"] },
      { json: "axis", kind: "enum", default: "x", values: AREA_AXES },
    ],
  },
  {
    id: "grid",
    javaClass: "AreaTypeGrid",
    fields: [{ json: "interval", kind: "int", required: true }],
  },
  { id: "line", javaClass: "AreaTypeLine", fields: [] },
  {
    id: "pyramid",
    javaClass: "AreaTypePyramid",
    fields: [
      { json: "axis", kind: "enum", default: "x", values: AREA_AXES },
      { json: "pyramid_type", kind: "enum", default: "filled", values: ["filled", "hollow"] },
    ],
  },
  {
    id: "random",
    javaClass: "AreaTypeRandom",
    fields: [{ json: "picked_amount", kind: "int", required: true }],
  },
  {
    id: "sphere",
    javaClass: "AreaTypeSphere",
    fields: [
      { json: "sphere_type", kind: "enum", default: "filled", values: ["filled", "hollow"] },
    ],
  },
  {
    id: "torus",
    javaClass: "AreaTypeTorus",
    fields: [
      { json: "axis", kind: "enum", default: "x", values: AREA_AXES },
      { json: "torus_type", kind: "enum", default: "filled", values: ["filled", "hollow"] },
    ],
  },
  {
    id: "wall",
    javaClass: "AreaTypeWall",
    fields: [{ json: "axis", kind: "enum", required: true, values: AREA_AXES }],
  },
];

const BY_ID = new Map(WIDGETS.map((w) => [w.id, w]));
const AREA_TYPES_BY_ID = new Map(AREA_TYPES.map((a) => [a.id, a]));

export function getWidget(id: string): WidgetSpec {
  const spec = BY_ID.get(id);
  if (!spec) throw new Error(`unknown widget type: ${id}`);
  return spec;
}

export function tryGetWidget(id: string): WidgetSpec | undefined {
  return BY_ID.get(id);
}

export function getAreaType(id: string): AreaTypeSpec {
  const spec = AREA_TYPES_BY_ID.get(id);
  if (!spec) throw new Error(`unknown area type: ${id}`);
  return spec;
}

/**
 * Vertical extent in program coordinates: `getHeight() / 2`, where
 * `getHeight() = PROGWIDGET_HEIGHT * max(1, params.size())`. This is the drop
 * from a widget's origin to the one it connects to below.
 */
export function widgetHeight(spec: WidgetSpec): number {
  const gui = spec.height ?? PROGWIDGET_HEIGHT * Math.max(1, spec.params.length);
  return gui / 2;
}

/**
 * Horizontal extent in program coordinates: `getWidth() / 2`. This is the offset
 * to a widget's own whitelist parameter column — note it uses the *owner's*
 * width, so a wider widget reaches further right.
 */
export function widgetWidth(spec: WidgetSpec): number {
  return (spec.width ?? PROGWIDGET_WIDTH) / 2;
}

/** Encode a set of directions as the byte bitmask the mod expects. */
export function encodeSides(sides: readonly DirectionName[]): number {
  let mask = 0;
  for (const s of sides) {
    const bit = DIRECTIONS.indexOf(s);
    if (bit < 0) throw new Error(`unknown direction: ${s}`);
    mask |= 1 << bit;
  }
  return mask;
}

export function decodeSides(mask: number): DirectionName[] {
  return DIRECTIONS.filter((_, i) => (mask & (1 << i)) !== 0);
}
