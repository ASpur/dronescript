/**
 * Emitter for PneumaticCraft 7.0.x (Minecraft 1.20.1 – 1.20.4).
 *
 * That version predates the codec rewrite: the Programmer serializes its widget
 * list to NBT and then renders the NBT as JSON, tagging every value with its NBT
 * type id. Importing runs `JsonToNBTConverter` over the document, which calls
 * `getAsJsonObject()` on every value — so a bare number or string anywhere at
 * the top level throws, and the player sees only "Invalid formatted Pastebin or
 * JSON."
 *
 * The document therefore looks like:
 *
 *   {"pneumaticcraft:progWidgets": {"type": 9, "value": [
 *     {"name": {"type": 8, "value": "goto"}, "x": {...}, "y": {...}}
 *   ]}}
 *
 * Field names differ from the 1.21 codecs, and the grouped objects that version
 * uses (`inv`, `cond`, `dig_place`) are flat here. `V2_FIELDS` maps the
 * compiler's canonical field paths onto this encoding.
 */

import { AREA_TYPES, DIRECTIONS, getWidget } from "../spec/widgets.js";
import type { PlacedWidget } from "./model.js";
import { EmitError } from "./emit.js";

/** NBT tag ids, as written into the `type` of each value. */
const TAG = {
  byte: 1,
  int: 3,
  string: 8,
  list: 9,
  compound: 10,
} as const;

/** `IProgrammable.NBT_WIDGETS`. */
const WIDGETS_KEY = "pneumaticcraft:progWidgets";

type NbtValue =
  | { readonly type: number; readonly value: number }
  | { readonly type: number; readonly value: string }
  | { readonly type: number; readonly value: NbtCompound }
  | { readonly type: number; readonly value: NbtCompound[] };

interface NbtCompound {
  [key: string]: NbtValue;
}

function nbtInt(value: number): NbtValue {
  return { type: TAG.int, value };
}

function nbtByte(value: number): NbtValue {
  return { type: TAG.byte, value };
}

function nbtBool(value: boolean): NbtValue {
  // NBT has no boolean; putBoolean writes a byte.
  return { type: TAG.byte, value: value ? 1 : 0 };
}

function nbtString(value: string): NbtValue {
  return { type: TAG.string, value };
}

function nbtCompound(value: NbtCompound): NbtValue {
  return { type: TAG.compound, value };
}

/** `NbtUtils.writeBlockPos` on 1.20.4 writes a compound of X, Y and Z. */
function nbtBlockPos(pos: readonly number[]): NbtValue {
  return nbtCompound({
    X: nbtInt(pos[0] ?? 0),
    Y: nbtInt(pos[1] ?? 0),
    Z: nbtInt(pos[2] ?? 0),
  });
}

/** How a canonical field is written in this format. */
type Encoder = (value: unknown, into: NbtCompound) => void;

function simple(name: string, encode: (value: unknown) => NbtValue): Encoder {
  return (value, into) => {
    into[name] = encode(value);
  };
}

/** Enum values are stored as the ordinal of the mod's enum. */
function ordinal(name: string, order: readonly string[], tag: number = TAG.byte): Encoder {
  return (value, into) => {
    const index = order.indexOf(String(value));
    if (index < 0) {
      throw new EmitError(`"${String(value)}" is not one of ${order.join(", ")}`);
    }
    into[name] = { type: tag, value: index };
  };
}

/** A side bitmask becomes one boolean per direction, keyed by its NBT name. */
const sidesEncoder: Encoder = (value, into) => {
  const mask = Number(value);
  DIRECTIONS.forEach((direction, bit) => {
    if ((mask & (1 << bit)) !== 0) into[direction.toUpperCase()] = nbtBool(true);
  });
};

/** `AxisOptions.writeToNBT` always writes all three flags. */
const axisEncoder: Encoder = (value, into) => {
  const mask = Number(value);
  into["checkX"] = nbtBool((mask & 1) !== 0);
  into["checkY"] = nbtBool((mask & 2) !== 0);
  into["checkZ"] = nbtBool((mask & 4) !== 0);
};

/** `ItemStack.save` on 1.20.4 writes id, Count and an optional tag. */
const itemStackEncoder: Encoder = (value, into) => {
  const stack = value as { id?: string; count?: number };
  if (!stack?.id) throw new EmitError("an item filter needs an item id");
  into["id"] = nbtString(stack.id);
  into["Count"] = nbtByte(stack.count ?? 1);
};

/** The fluid filter stores only the fluid's registry name. */
const fluidEncoder: Encoder = (value, into) => {
  const fluid = value as { id?: string };
  if (!fluid?.id) throw new EmitError("a fluid filter needs a fluid id");
  into["fluid"] = nbtString(fluid.id);
};

/** The area type's name, plus its own fields flattened into the same compound. */
const areaTypeEncoder: Encoder = (value, into) => {
  const area = value as Record<string, unknown>;
  const id = String(area["type"]);
  const spec = AREA_TYPES.find((a) => a.id === id);
  if (!spec) throw new EmitError(`unknown area shape "${id}"`);
  into["type"] = nbtString(id);

  for (const field of spec.fields) {
    const raw = area[field.json] ?? field.default;
    if (raw === undefined) continue;
    // Area-type fields are named differently and stored as ordinals here.
    const mapped = AREA_TYPE_FIELDS[`${id}.${field.json}`];
    if (!mapped) continue;
    mapped(raw, into);
  }
};

const AXES = ["x", "y", "z"] as const;
const FILL = ["filled", "hollow"] as const;

/** Per-area-shape field encodings, keyed by `<shape>.<canonical field>`. */
const AREA_TYPE_FIELDS: Record<string, Encoder> = {
  "box.box_type": ordinal("boxType", ["filled", "hollow", "frame"]),
  "sphere.sphere_type": ordinal("sphereType", FILL),
  "cylinder.cylinder_type": ordinal("cylinderType", ["filled", "hollow", "tube"]),
  "cylinder.axis": ordinal("axis", AXES),
  "pyramid.pyramid_type": ordinal("pyramidType", FILL),
  "pyramid.axis": ordinal("axis", AXES),
  "torus.torus_type": ordinal("torusType", FILL),
  "torus.axis": ordinal("axis", AXES),
  "wall.axis": ordinal("axis", AXES),
  "grid.interval": simple("interval", (v) => nbtInt(Number(v))),
  "random.picked_amount": simple("pickedAmount", (v) => nbtInt(Number(v))),
};

const ORDERINGS = ["closest", "lowToHigh", "highToLow"] as const;
const OPERATORS = ["eq", "ge", "le"] as const;
const COORD_OPS = ["plus_minus", "multiply_divide", "max_min"] as const;

/**
 * Canonical field path (as the lowering writes it) to its 1.20.4 encoding.
 * A path absent from this map is not supported by that version.
 */
const V2_FIELDS: Record<string, Encoder> = {
  // Shared groups, which are flat in this version.
  "inv.sides": sidesEncoder,
  "inv.use_count": simple("useCount", (v) => nbtBool(Boolean(v))),
  "inv.count": simple("count", (v) => nbtInt(Number(v))),
  "dig_place.order": ordinal("order", ORDERINGS, TAG.int),
  "dig_place.max_actions": simple("maxActions", (v) => nbtInt(Number(v))),
  "dig_place.use_max_actions": simple("useMaxActions", (v) => nbtBool(Boolean(v))),
  "cond.and_func": simple("isAndFunction", (v) => nbtBool(Boolean(v))),
  "cond.cond_op": ordinal("operator", OPERATORS),
  "cond.measure_var": simple("measureVar", (v) => nbtString(String(v))),
  "drone_cond.and_func": simple("isAndFunction", (v) => nbtBool(Boolean(v))),
  "drone_cond.cond_op": ordinal("operator", OPERATORS),
  "drone_cond.required_count": simple("requiredCount", (v) => nbtInt(Number(v))),
  "drone_cond.measure_var": simple("measureVar", (v) => nbtString(String(v))),

  // Parameter widgets.
  string: simple("string", (v) => nbtString(String(v))),
  pos1: simple("pos1", (v) => nbtBlockPos(v as number[])),
  pos2: simple("pos2", (v) => nbtBlockPos(v as number[])),
  var1: simple("var1", (v) => nbtString(String(v))),
  var2: simple("var2", (v) => nbtString(String(v))),
  area_type: areaTypeEncoder,
  coord: simple("coord", (v) => nbtBlockPos(v as number[])),
  var: simple("variable", (v) => nbtString(String(v))),
  using_var: simple("useVariable", (v) => nbtBool(Boolean(v))),
  chk_item: itemStackEncoder,
  chk_durability: simple("useMetadata", (v) => nbtBool(Boolean(v))),
  chk_components: simple("useNBT", (v) => nbtBool(Boolean(v))),
  chk_mod: simple("useModSimilarity", (v) => nbtBool(Boolean(v))),
  chk_block: simple("matchBlock", (v) => nbtBool(Boolean(v))),
  fluid: fluidEncoder,
  coord_op: ordinal("operator", COORD_OPS),
  axis_options: axisEncoder,
  cond_op: ordinal("operator", OPERATORS),

  // Action widgets.
  done_when_depart: simple("doneWhenDeparting", (v) => nbtBool(Boolean(v))),
  require_tool: simple("requireDiggingTool", (v) => nbtBool(Boolean(v))),
  require_hoe: simple("requireHoe", (v) => nbtBool(Boolean(v))),
  can_steal: simple("canSteal", (v) => nbtBool(Boolean(v))),
  drop_straight: simple("dropStraight", (v) => nbtBool(Boolean(v))),
  pick_delay: simple("pickupDelay", (v) => nbtBool(Boolean(v))),
  place_fluid_blocks: simple("placeFluidBlocks", (v) => nbtBool(Boolean(v))),
  void_excess: simple("voidExcess", (v) => nbtBool(Boolean(v))),
  order: ordinal("order", ORDERINGS, TAG.int),
  use_max_actions: simple("useMaxActions", (v) => nbtBool(Boolean(v))),
  max_actions: simple("maxActions", (v) => nbtInt(Number(v))),
  check_sight: simple("checkSight", (v) => nbtBool(Boolean(v))),
  sides: sidesEncoder,
  use_count: simple("useCount", (v) => nbtBool(Boolean(v))),
  count: simple("count", (v) => nbtInt(Number(v))),
  allow_pickup: simple("allowStandbyPickup", (v) => nbtBool(Boolean(v))),
  share_variables: simple("shareVariables", (v) => nbtBool(Boolean(v))),
  back_side: simple("back", (v) => nbtBool(Boolean(v))),
  check_air: simple("checkingForAir", (v) => nbtBool(Boolean(v))),
  check_liquid: simple("checkingForLiquids", (v) => nbtBool(Boolean(v))),
  side: (value, into) => {
    const index = DIRECTIONS.indexOf(value as (typeof DIRECTIONS)[number]);
    if (index < 0) throw new EmitError(`"${String(value)}" is not a direction`);
    into["dir"] = nbtInt(index);
  },
  sneaking: simple("sneaking", (v) => nbtBool(Boolean(v))),
  click_type: simple("clickType", (v) => nbtString(String(v).toUpperCase())),
};

/** Settings this version has no equivalent for, reported rather than dropped. */
const UNSUPPORTED: Record<string, string> = {
  dig_side: "choosing which side to dig from",
  randomize: "placing blocks in a random order",
};

/** Widget types that exist in 1.21 but not in 7.0.x. */
const UNSUPPORTED_WIDGETS = new Set(["computer_control"]);

export interface V2Result {
  readonly json: Record<string, unknown>;
  readonly text: string;
}

export function emitV2(placed: readonly PlacedWidget[]): V2Result {
  const widgets = placed.map(emitWidget);
  const json = {
    [WIDGETS_KEY]: { type: TAG.list, value: widgets },
  };
  return { json, text: JSON.stringify(json) };
}

function emitWidget(placed: PlacedWidget): NbtCompound {
  if (UNSUPPORTED_WIDGETS.has(placed.type)) {
    throw new EmitError(
      `the ${placed.type} widget does not exist in PneumaticCraft 7.0.x; ` +
        `switch the target to 1.21 to use it`,
    );
  }

  const spec = getWidget(placed.type);
  const out: NbtCompound = {
    // The mod strips its own namespace when writing widget names.
    name: nbtString(placed.type),
    x: nbtInt(placed.x),
    y: nbtInt(placed.y),
  };

  for (const field of spec.fields) {
    const value = placed.fields[field.json];
    if (value === undefined) continue;

    if (field.kind === "group" && field.json !== "area_type") {
      const group = value as Record<string, unknown>;
      for (const sub of field.fields ?? []) {
        const subValue = group[sub.json];
        if (subValue === undefined) continue;
        encodeField(placed.type, `${field.json}.${sub.json}`, subValue, out);
      }
      continue;
    }

    encodeField(placed.type, field.json, value, out);
  }

  return out;
}

function encodeField(
  widgetType: string,
  path: string,
  value: unknown,
  into: NbtCompound,
): void {
  const unsupported = UNSUPPORTED[path];
  if (unsupported) {
    throw new EmitError(
      `${widgetType}: PneumaticCraft 7.0.x has no support for ${unsupported}`,
    );
  }
  const encoder = V2_FIELDS[path];
  if (!encoder) {
    throw new EmitError(`no 1.20.4 encoding is known for ${widgetType}.${path}`);
  }
  try {
    encoder(value, into);
  } catch (error) {
    throw new EmitError(
      `${widgetType}.${path}: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}
