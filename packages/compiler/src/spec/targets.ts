/**
 * Which build of PneumaticCraft: Repressurized a program is being written for.
 *
 * The mod rewrote its serialization for 1.20.6, so the two supported targets
 * emit structurally different documents. Widget geometry is identical between
 * them (30 wide, 22 per parameter row), so layout, linking and verification are
 * shared — only the final encoding differs.
 */

export type Target = "1.20.4" | "1.21";

export interface TargetInfo {
  readonly id: Target;
  /** Minecraft versions this covers. */
  readonly minecraft: string;
  /** Mod versions known to use this format. */
  readonly mod: string;
  /** The serialization the Programmer's pastebin screen expects. */
  readonly format: "nbt-json" | "codec-json";
  readonly note: string;
}

export const TARGETS: readonly TargetInfo[] = [
  {
    id: "1.20.4",
    minecraft: "1.20.1 – 1.20.4",
    mod: "7.0.x",
    format: "nbt-json",
    note: "NBT rendered as JSON with explicit type tags. Used by FTB NeoTech.",
  },
  {
    id: "1.21",
    minecraft: "1.21.1",
    mod: "8.x",
    format: "codec-json",
    note: "Codec-based JSON with a version field. Used from 1.20.6 onwards.",
  },
];

export const DEFAULT_TARGET: Target = "1.20.4";

export function targetInfo(target: Target): TargetInfo {
  const found = TARGETS.find((t) => t.id === target);
  if (!found) throw new Error(`unknown target: ${target}`);
  return found;
}
