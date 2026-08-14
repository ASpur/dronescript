/**
 * The mod's own puzzle-piece art, mapped from widget type to texture URL.
 *
 * Every PNG is a square power of two (32/64/128) with the art anchored in the
 * top-left corner at native size and the rest transparent, so a piece renders
 * by drawing the WHOLE file at the widget's origin — the padding overlaps
 * nothing. Art size is `(width + 10·hasParams) × (height + 10·hasStepOutput)`
 * GUI px, and the mod blits it at 0.5×, which is exactly one program unit per
 * two texels — the same halving the compiler's PARAM_X_STEP/PARAM_Y_STEP bake
 * in. See assets/progwidgets/NOTICE.md for where the art comes from.
 */

import {
  PROGWIDGET_HEIGHT,
  PROGWIDGET_WIDTH,
} from "@dronescript/compiler";
import type { PlacedWidget, WidgetSpec } from "@dronescript/compiler";

const urls = import.meta.glob("../assets/progwidgets/*.png", {
  eager: true,
  import: "default",
  query: "?url",
}) as Record<string, string>;

/**
 * Widget id → texture file, transcribed from the mod's `Textures.java`. Most
 * follow `<id>_piece.png`; the exceptions are listed the way upstream spells
 * them. `coordinate_operator` is handled in `textureFor` — its art varies with
 * the operator field.
 */
const IRREGULAR: Record<string, string> = {
  entity_attack: "attack_piece.png",
  pickup_item: "item_pick_piece.png",
  drop_item: "item_drop_piece.png",
  void_liquid: "void_fluid_piece.png",
  crafting: "craft_piece.png",
  for_each_coordinate: "for_each_coordinate.png",
  for_each_item: "for_each_item.png",
  condition_item: "condition_item.png",
  drone_condition_item: "condition_drone_inventory_piece.png",
  drone_condition_liquid: "condition_drone_liquid_piece.png",
  drone_condition_entity: "condition_drone_entity_piece.png",
  drone_condition_pressure: "condition_drone_pressure_piece.png",
  drone_condition_rf: "condition_drone_rf_piece.png",
  drone_condition_upgrades: "condition_drone_upgrades_piece.png",
};

function urlFor(file: string): string | undefined {
  return urls[`../assets/progwidgets/${file}`];
}

/** The texture URL for a placed widget, or undefined to fall back to a rect. */
export function textureFor(widget: PlacedWidget): string | undefined {
  if (widget.type === "coordinate_operator") {
    const op =
      typeof widget.fields["coord_op"] === "string"
        ? (widget.fields["coord_op"] as string)
        : "plus_minus";
    return urlFor(`coordinate_operation_${op}.png`);
  }
  return urlFor(IRREGULAR[widget.type] ?? `${widget.type}_piece.png`);
}

/**
 * The full PNG's edge length in program units. Derived, not measured: every
 * upstream file is `nextPow2(max(artW, artH))` texels square, and the art
 * dimensions are a pure function of the spec — verified against all 63 IHDRs.
 */
export function textureUnits(spec: WidgetSpec): number {
  const artW = (spec.width ?? PROGWIDGET_WIDTH) + (spec.params.length > 0 ? 10 : 0);
  const artH =
    (spec.height ?? PROGWIDGET_HEIGHT * Math.max(1, spec.params.length)) +
    (spec.hasStepOutput ? 10 : 0);
  let size = 1;
  while (size < Math.max(artW, artH)) size *= 2;
  return size / 2;
}
