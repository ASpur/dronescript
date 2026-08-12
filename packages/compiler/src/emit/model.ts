/**
 * The pre-layout program model: widgets and their attached parameter chains,
 * arranged into vertical chains. Layout turns this into positioned widgets.
 */

import type { ParamType } from "../spec/types.js";

/** A widget with its fields filled in but no position yet. */
export interface WidgetNode {
  readonly type: string;
  /** Scalar fields, keyed by the JSON name from the spec table. */
  readonly fields: Readonly<Record<string, unknown>>;
  /**
   * Whitelist (right-side) parameter chains, indexed by parameter row. Each row
   * holds a chain: chain[0] attaches at (x+15, y+11*row), chain[1] at
   * (x+30, ...), and so on. Rows may be absent or empty.
   */
  readonly params?: readonly (readonly WidgetNode[] | undefined)[];
  /** Blacklist (left-side) chains, same indexing but extending leftward. */
  readonly blacklist?: readonly (readonly WidgetNode[] | undefined)[];
  /** Opaque id used to tie emitted widgets back to source or IR. */
  readonly origin?: string;
}

/**
 * A vertical run of widgets connected by fall-through. The first widget is the
 * chain head; each subsequent one sits directly below its predecessor.
 */
export interface Chain {
  readonly widgets: readonly WidgetNode[];
  /** Debug name, e.g. the label this chain starts with. */
  readonly name?: string;
}

export interface Program {
  readonly chains: readonly Chain[];
}

/** A widget with its final program-space coordinates. */
export interface PlacedWidget {
  readonly type: string;
  readonly x: number;
  readonly y: number;
  readonly fields: Readonly<Record<string, unknown>>;
  readonly origin?: string;
}

export function widget(
  type: string,
  fields: Record<string, unknown> = {},
  extra: {
    params?: readonly (readonly WidgetNode[] | undefined)[];
    blacklist?: readonly (readonly WidgetNode[] | undefined)[];
    origin?: string;
  } = {},
): WidgetNode {
  return { type, fields, ...extra };
}

/** Convenience for the common case of one parameter widget per row. */
export function param(type: string, fields: Record<string, unknown> = {}): WidgetNode {
  return { type, fields };
}

export function text(s: string): WidgetNode {
  return { type: "text", fields: { string: s } };
}

export function coordinate(
  value: readonly [number, number, number] | string,
): WidgetNode {
  return typeof value === "string"
    ? { type: "coordinate", fields: { var: value, using_var: true } }
    : { type: "coordinate", fields: { coord: value } };
}

export function area(
  pos1: readonly [number, number, number] | string,
  pos2?: readonly [number, number, number] | string,
  areaType: Record<string, unknown> = { type: "box" },
): WidgetNode {
  const fields: Record<string, unknown> = { area_type: areaType };
  if (typeof pos1 === "string") fields["var1"] = pos1;
  else fields["pos1"] = pos1;
  if (pos2 !== undefined) {
    if (typeof pos2 === "string") fields["var2"] = pos2;
    else fields["pos2"] = pos2;
  }
  return { type: "area", fields };
}

export const PARAM_TYPES: readonly ParamType[] = [
  "area",
  "text",
  "item_filter",
  "liquid_filter",
  "coordinate",
];
