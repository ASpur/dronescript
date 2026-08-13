import quarry from "../../../../examples/quarry.drn?raw";
import sorter from "../../../../examples/sorter.drn?raw";

export interface Example {
  readonly name: string;
  readonly source: string;
}

export const EXAMPLES: readonly Example[] = [
  { name: "Quarry", source: quarry },
  { name: "Item sorter", source: sorter },
  {
    name: "Tour a route",
    source: `// Visit three points in turn, forever.
const a = area(<0, 64, 0>);
const b = area(<0, 64, 16>);
const c = area(<16, 64, 16>);

while (true) {
  goto(a);
  wait(40);
  goto(b);
  wait(40);
  goto(c);
  wait(40);
}
`,
  },
  {
    name: "Dig one block at a time",
    source: `// foreach uses the game's own iteration widget, so the drone
// walks the area block by block without any counter of its own.
const field = area(<0, 63, 0>, <15, 63, 15>);

foreach (spot in field) {
  goto(spot);
  dig(spot);
}
`,
  },
];
