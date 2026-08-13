/**
 * Compile-time values.
 *
 * Areas and filters are not runtime values in a drone program — they are
 * physical parameter widgets attached to whatever uses them. So they exist here
 * only as templates, and are re-emitted at each use site: two widgets can never
 * share one parameter widget.
 */

import type { WidgetNode } from "../emit/model.js";

export type CompileValue =
  | { readonly kind: "int"; readonly value: number }
  | { readonly kind: "coord"; readonly value: readonly [number, number, number] }
  | { readonly kind: "text"; readonly value: string }
  | { readonly kind: "area"; readonly chain: readonly WidgetNode[] }
  | { readonly kind: "itemFilter"; readonly chain: readonly WidgetNode[] }
  | { readonly kind: "liquidFilter"; readonly chain: readonly WidgetNode[] };

export function describeValue(value: CompileValue): string {
  switch (value.kind) {
    case "int":
      return "int";
    case "coord":
      return "coord";
    case "text":
      return "text";
    case "area":
      return "area";
    case "itemFilter":
      return "item filter";
    case "liquidFilter":
      return "fluid filter";
  }
}

/** Read-only variables the mod resolves itself; see DroneSpecialVariableHandler. */
export const SPECIAL_VARIABLES = new Set([
  "$drone_pos",
  "$controller_pos",
  "$owner_pos",
  "$deploy_pos",
  "$owner_look",
  // Legacy spellings, still supported by the mod.
  "$owner",
  "$drone",
]);

/** `$player_pos=name` takes an argument, so it is matched by prefix. */
export const SPECIAL_VARIABLE_PREFIXES = ["$player_pos", "$player"];

export function isSpecialVariable(name: string): boolean {
  if (!name.startsWith("$")) return false;
  if (SPECIAL_VARIABLES.has(name)) return true;
  return SPECIAL_VARIABLE_PREFIXES.some((p) => name === p || name.startsWith(`${p}=`));
}

export function scopeOf(name: string): "local" | "global" | "server" | "special" {
  if (name.startsWith("#")) return "global";
  if (name.startsWith("%")) return "server";
  if (name.startsWith("$")) return "special";
  return "local";
}
