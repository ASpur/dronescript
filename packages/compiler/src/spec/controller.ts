/**
 * What a Programmable Controller can run, as opposed to a drone.
 *
 * The controller executes the same programs, but it is a block rather than an
 * entity, which changes three things:
 *
 *  - Seven widgets are on `ProgrammableControllerBlockEntity.BLACKLISTED_WIDGETS`
 *    (identical on 1.20.4 and 1.21). The check is all-or-nothing and happens
 *    when the programmed item is put in the slot: `isItemValid` runs every
 *    widget past `isProgramApplicable`, so ONE excluded piece means the item
 *    will not go in at all. There is no "skip the piece and run the rest",
 *    which is why these are errors rather than warnings.
 *  - `rename` is accepted and then breaks the program, because the controller
 *    has no entity to rename and instead renames the programmed item in its own
 *    slot; that fires `onContentsChanged`, which rebuilds the AI manager and
 *    restarts at the start piece.
 *  - Some pieces are accepted and simply mean something else, mostly because
 *    the controller has no pathfinding and supplies its own air.
 */

import type { Severity } from "../diagnostics.js";
import type { BuiltinSpec } from "./builtins.js";

export interface ControllerNote {
  readonly severity: Severity;
  readonly code: string;
  readonly message: string;
}

/** Widgets the controller refuses outright, and what each one does. */
const EXCLUDED: Record<string, string> = {
  computer_control: "hand control to an attached computer",
  entity_attack: "attack entities",
  drone_condition_entity: "count the entities it is carrying",
  standby: "go on standby",
  teleport: "teleport",
  entity_import: "pick entities up",
  entity_export: "put entities down",
};

/** Widgets that load and run, but do not mean what they mean on a drone. */
const QUIRKS: Record<string, ControllerNote> = {
  rename: {
    severity: "error",
    code: "controller-rename",
    message:
      "a Programmable Controller has no drone to rename, so this renames the programmed " +
      "item in its own slot — which reloads the program and restarts it at the start " +
      "piece, forever. Name the Network API in an anvil instead",
  },
  suicide: {
    severity: "warning",
    code: "controller-suicide",
    message:
      "on a Programmable Controller this ejects the programmed item into an adjacent " +
      "inventory, or drops it on the ground, and stops",
  },
  goto: {
    severity: "warning",
    code: "controller-goto",
    message:
      "a Programmable Controller does not pathfind: it only travels to a destination " +
      "block that is empty, and skips this piece otherwise. Import and export pieces " +
      "move themselves to a free face, so they work without it",
  },
  drone_condition_pressure: {
    severity: "warning",
    code: "controller-pressure",
    message:
      "this reads the Programmable Controller's own pressure, which is at least its " +
      "10 bar working pressure whenever the program is running at all",
  },
};

/** How the call reads in source, for the message. */
function spell(builtin: BuiltinSpec): string {
  return builtin.subject === "drone" ? `${builtin.name}(drone)` : `${builtin.name}()`;
}

/**
 * What to say about `builtin` when the program is meant for a Programmable
 * Controller, or undefined when the controller runs it exactly like a drone.
 */
export function controllerNote(builtin: BuiltinSpec): ControllerNote | undefined {
  const excluded = EXCLUDED[builtin.widget];
  if (excluded) {
    return {
      severity: "error",
      code: "controller-excluded",
      message:
        `a Programmable Controller cannot ${excluded}, and refuses a program containing ` +
        `${spell(builtin)} rather than skipping the piece — the programmed item will not ` +
        `go in its slot`,
    };
  }
  const quirk = QUIRKS[builtin.widget];
  return quirk && { ...quirk, message: `${spell(builtin)}: ${quirk.message}` };
}
