/**
 * Types describing the PneumaticCraft: Repressurized ProgWidget system.
 *
 * Mirrors the mod's Codec-based serialization (branch `1.21`, MC 1.21.1, v8.2.x).
 * See src/main/java/me/desht/pneumaticcraft/common/drone/progwidgets/ in
 * TeamPneumatic/pnc-repressurized.
 */

/** Parameter slot types — the only widgets with a non-null `returnType()`. */
export type ParamType =
  | "area"
  | "text"
  | "item_filter"
  | "liquid_filter"
  | "coordinate";

/** Scalar field value kinds, as they appear in the emitted JSON. */
export type FieldKind =
  | "int"
  | "bool"
  | "string"
  | "enum"
  | "blockpos" // [x, y, z]
  | "direction" // lowercase Direction name
  | "sides" // BitSet(6) collapsed to one byte
  | "axes" // {axes: byte} bitmask, X=1 Y=2 Z=4
  | "itemstack" // {id, count, components?}
  | "fluidstack" // {id, amount}
  | "group"; // nested object of sub-fields (inv, cond, dig_place, ...)

export interface FieldSpec {
  /** Exact JSON key emitted for this field. */
  readonly json: string;
  readonly kind: FieldKind;
  /**
   * Codec `fieldOf` (required) vs `optionalFieldOf` (omittable). Required fields
   * MUST be emitted or the mod's codec parse fails — and a parse failure imports
   * an EMPTY program with only a log warning.
   */
  readonly required?: boolean;
  /** Default the mod applies when the field is absent; used to omit redundant output. */
  readonly default?: unknown;
  /** Legal values for `kind: "enum"`, as serialized (StringRepresentable names). */
  readonly values?: readonly string[];
  /** Sub-fields for `kind: "group"`. */
  readonly fields?: readonly FieldSpec[];
}

/**
 * A widget's parameter rows. Row i sits at (x + 15, y + 11*i) on the whitelist
 * side and (x - 15, y + 11*i) on the blacklist side.
 */
export interface ParamRow {
  readonly type: ParamType;
  /**
   * Whether the left/blacklist side of this row accepts a widget. Derived from
   * `hasBlacklist()` and `canSetParameter()` overrides in the Java classes.
   */
  readonly blacklist: boolean;
}

export type WidgetCategory =
  | "flow" // start, label, jump, jump_sub, suicide
  | "action" // dig, place, goto, ...
  | "condition" // condition_*, drone_condition_*
  | "parameter" // area, text, item_filter, liquid_filter, coordinate
  | "meta"; // comment

export interface WidgetSpec {
  /** Registry path; emitted as `pneumaticcraft:<id>`. */
  readonly id: string;
  /** Java class in the mod, for auditability against upstream. */
  readonly javaClass: string;
  readonly category: WidgetCategory;
  readonly params: readonly ParamRow[];
  readonly fields: readonly FieldSpec[];
  /** Can a widget above connect down into this one? `label` and `start` cannot. */
  readonly hasStepInput: boolean;
  /** Can this widget connect down into the next? `jump` and `suicide` cannot. */
  readonly hasStepOutput: boolean;
  /** Non-null only for parameter widgets; they attach to slots of this type. */
  readonly returnType?: ParamType;
  /** `freeToUse()` — only `comment` costs no Programming Puzzle piece. */
  readonly free?: boolean;
  /**
   * Condition widgets branch on their LAST parameter row: the whitelist-side text
   * is the jump target when true, the blacklist-side text when false. An empty
   * side falls through to the widget below.
   */
  readonly isCondition?: boolean;
  /** Widgets rejected by the Programmable Controller (drones accept everything). */
  readonly controllerBlacklisted?: boolean;
}

/** `AreaType` subtypes dispatched on `type` inside an area widget's `area_type`. */
export interface AreaTypeSpec {
  readonly id: string;
  readonly javaClass: string;
  readonly fields: readonly FieldSpec[];
}
