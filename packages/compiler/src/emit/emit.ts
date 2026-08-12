/**
 * Serialize positioned widgets to the v3 JSON the Programmer imports.
 *
 * Field names and shapes are validated against the spec table on the way out.
 * The mod parses imports with `resultOrPartial`, so anything malformed yields an
 * empty program and a log line the player never sees — we would rather fail here.
 */

import {
  AREA_TYPES,
  JSON_VERSION,
  NAMESPACE,
  getAreaType,
  getWidget,
} from "../spec/widgets.js";
import type { FieldSpec } from "../spec/types.js";
import type { PlacedWidget } from "./model.js";

export interface ProgramJson {
  readonly version: number;
  readonly widgets: readonly Record<string, unknown>[];
}

export class EmitError extends Error {}

/** Widgets whose `freeToUse()` is false each cost one Programming Puzzle piece. */
export function puzzlePieceCount(placed: readonly PlacedWidget[]): number {
  return placed.filter((p) => !getWidget(p.type).free).length;
}

export function emit(placed: readonly PlacedWidget[]): ProgramJson {
  return {
    version: JSON_VERSION,
    widgets: placed.map(emitWidget),
  };
}

/** Compact JSON, matching what the mod's clipboard export produces. */
export function emitString(placed: readonly PlacedWidget[]): string {
  return JSON.stringify(emit(placed));
}

function emitWidget(placed: PlacedWidget): Record<string, unknown> {
  const spec = getWidget(placed.type);
  const out: Record<string, unknown> = {
    type: `${NAMESPACE}:${placed.type}`,
    pos: { x: placed.x, y: placed.y },
  };

  const known = new Set(spec.fields.map((f) => f.json));
  for (const name of Object.keys(placed.fields)) {
    if (!known.has(name)) {
      throw new EmitError(`${placed.type} has no field "${name}"`);
    }
  }

  for (const field of spec.fields) {
    let value = placed.fields[field.json];
    if (value === undefined) {
      if (!field.required) continue;
      // `inv`, `cond`, `dig_place` and `drone_cond` are `fieldOf` in the mod's
      // codecs, so the key must exist even when every setting is left at its
      // default. An empty object is the right thing to write; any genuinely
      // required sub-field still errors below.
      if (field.kind !== "group") {
        throw new EmitError(`${placed.type} is missing required field "${field.json}"`);
      }
      value = {};
    }
    // Omitting a value the mod would default to anyway keeps output small and
    // diffable; required fields are always written.
    if (!field.required && field.default !== undefined && sameAsDefault(value, field.default)) {
      continue;
    }
    out[field.json] = encodeField(placed.type, field, value);
  }

  return out;
}

function sameAsDefault(value: unknown, def: unknown): boolean {
  if (Array.isArray(value) && Array.isArray(def)) {
    return value.length === def.length && value.every((v, i) => v === def[i]);
  }
  return value === def;
}

function encodeField(widgetType: string, field: FieldSpec, value: unknown): unknown {
  switch (field.kind) {
    case "int":
      requireInt(widgetType, field, value);
      return value;
    case "bool":
      if (typeof value !== "boolean") {
        throw new EmitError(`${widgetType}.${field.json} must be a boolean`);
      }
      return value;
    case "string":
      if (typeof value !== "string") {
        throw new EmitError(`${widgetType}.${field.json} must be a string`);
      }
      return value;
    case "enum": {
      if (typeof value !== "string" || !field.values?.includes(value)) {
        throw new EmitError(
          `${widgetType}.${field.json} must be one of ${field.values?.join(", ")}, got ${String(value)}`,
        );
      }
      return value;
    }
    case "blockpos":
      return encodeBlockPos(widgetType, field, value);
    case "direction":
      if (typeof value !== "string") {
        throw new EmitError(`${widgetType}.${field.json} must be a direction name`);
      }
      return value;
    case "sides": {
      const mask = toMask(widgetType, field, value, 6);
      return mask;
    }
    case "axes": {
      // AxisOptions is an object wrapping a 3-bit mask.
      const mask = toMask(widgetType, field, value, 3);
      return { axes: mask };
    }
    case "itemstack":
      return encodeItemStack(widgetType, field, value);
    case "fluidstack":
      return encodeFluidStack(widgetType, field, value);
    case "group":
      return encodeGroup(widgetType, field, value);
  }
}

function requireInt(widgetType: string, field: FieldSpec, value: unknown): void {
  if (typeof value !== "number" || !Number.isInteger(value)) {
    throw new EmitError(`${widgetType}.${field.json} must be an integer`);
  }
}

function encodeBlockPos(widgetType: string, field: FieldSpec, value: unknown): number[] {
  if (
    !Array.isArray(value) ||
    value.length !== 3 ||
    value.some((v) => typeof v !== "number" || !Number.isInteger(v))
  ) {
    throw new EmitError(`${widgetType}.${field.json} must be [x, y, z] integers`);
  }
  return value as number[];
}

function toMask(widgetType: string, field: FieldSpec, value: unknown, bits: number): number {
  if (typeof value !== "number" || !Number.isInteger(value)) {
    throw new EmitError(`${widgetType}.${field.json} must be an integer bitmask`);
  }
  const max = (1 << bits) - 1;
  if (value < 0 || value > max) {
    throw new EmitError(`${widgetType}.${field.json} must be a ${bits}-bit mask (0..${max})`);
  }
  return value;
}

function encodeItemStack(
  widgetType: string,
  field: FieldSpec,
  value: unknown,
): Record<string, unknown> {
  if (typeof value !== "object" || value === null) {
    throw new EmitError(`${widgetType}.${field.json} must be an item stack object`);
  }
  const v = value as Record<string, unknown>;
  if (typeof v["id"] !== "string") {
    throw new EmitError(`${widgetType}.${field.json} needs an "id" like "minecraft:cobblestone"`);
  }
  const out: Record<string, unknown> = { id: v["id"] };
  if (v["count"] !== undefined) out["count"] = v["count"];
  if (v["components"] !== undefined) out["components"] = v["components"];
  return out;
}

function encodeFluidStack(
  widgetType: string,
  field: FieldSpec,
  value: unknown,
): Record<string, unknown> {
  if (typeof value !== "object" || value === null) {
    throw new EmitError(`${widgetType}.${field.json} must be a fluid stack object`);
  }
  const v = value as Record<string, unknown>;
  if (typeof v["id"] !== "string") {
    throw new EmitError(`${widgetType}.${field.json} needs an "id" like "minecraft:water"`);
  }
  return { id: v["id"], amount: v["amount"] ?? 1000 };
}

function encodeGroup(
  widgetType: string,
  field: FieldSpec,
  value: unknown,
): Record<string, unknown> {
  if (typeof value !== "object" || value === null) {
    throw new EmitError(`${widgetType}.${field.json} must be an object`);
  }
  const v = value as Record<string, unknown>;

  // `area_type` dispatches on its own `type` key rather than having fixed fields.
  if (field.json === "area_type") {
    const id = v["type"];
    if (typeof id !== "string") {
      throw new EmitError(
        `${widgetType}.area_type needs a "type", one of ${AREA_TYPES.map((a) => a.id).join(", ")}`,
      );
    }
    const areaSpec = getAreaType(id);
    const out: Record<string, unknown> = { type: `${NAMESPACE}:${id}` };
    for (const sub of areaSpec.fields) {
      const subValue = v[sub.json];
      if (subValue === undefined) {
        if (sub.required) {
          throw new EmitError(`area type "${id}" is missing required field "${sub.json}"`);
        }
        continue;
      }
      if (!sub.required && sub.default !== undefined && sameAsDefault(subValue, sub.default)) {
        continue;
      }
      out[sub.json] = encodeField(`area_type:${id}`, sub, subValue);
    }
    for (const name of Object.keys(v)) {
      if (name !== "type" && !areaSpec.fields.some((f) => f.json === name)) {
        throw new EmitError(`area type "${id}" has no field "${name}"`);
      }
    }
    return out;
  }

  const subs = field.fields ?? [];
  const out: Record<string, unknown> = {};
  for (const name of Object.keys(v)) {
    if (!subs.some((f) => f.json === name)) {
      throw new EmitError(`${widgetType}.${field.json} has no field "${name}"`);
    }
  }
  for (const sub of subs) {
    const subValue = v[sub.json];
    if (subValue === undefined) {
      if (sub.required) {
        throw new EmitError(
          `${widgetType}.${field.json} is missing required field "${sub.json}"`,
        );
      }
      continue;
    }
    if (!sub.required && sub.default !== undefined && sameAsDefault(subValue, sub.default)) {
      continue;
    }
    out[sub.json] = encodeField(`${widgetType}.${field.json}`, sub, subValue);
  }
  return out;
}
