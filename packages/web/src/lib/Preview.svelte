<script lang="ts">
  import {
    PARAM_X_STEP,
    PARAM_Y_STEP,
    getWidget,
    relink,
    widgetHeight,
  } from "@dronescript/compiler";
  import type { PlacedWidget } from "@dronescript/compiler";

  interface Props {
    placed: readonly PlacedWidget[];
  }

  let { placed }: Props = $props();

  /** Pixels per program unit. A widget is 15 units wide and 11 units per row. */
  const SCALE = 4;
  const PADDING = 24;

  let zoom = $state(1);
  let dragging = $state(false);
  let hovered: number | undefined = $state();
  let canvas: HTMLDivElement | undefined = $state();

  // The links the game will actually make, derived the same way it derives them.
  const linked = $derived(placed.length > 0 ? relink(placed) : undefined);

  const bounds = $derived.by(() => {
    if (placed.length === 0) return { minX: 0, minY: 0, width: 100, height: 100 };
    let minX = Infinity;
    let minY = Infinity;
    let maxX = -Infinity;
    let maxY = -Infinity;
    for (const w of placed) {
      minX = Math.min(minX, w.x);
      minY = Math.min(minY, w.y);
      maxX = Math.max(maxX, w.x + PARAM_X_STEP);
      maxY = Math.max(maxY, w.y + widgetHeight(getWidget(w.type)));
    }
    return {
      minX: minX - 2,
      minY: minY - 2,
      width: maxX - minX + 4,
      height: maxY - minY + 4,
    };
  });

  interface Box {
    readonly index: number;
    readonly x: number;
    readonly y: number;
    readonly w: number;
    readonly h: number;
    readonly label: string;
    readonly detail: string;
    readonly category: string;
  }

  const boxes = $derived.by((): Box[] =>
    placed.map((widget, index) => {
      const spec = getWidget(widget.type);
      return {
        index,
        x: (widget.x - bounds.minX) * SCALE,
        y: (widget.y - bounds.minY) * SCALE,
        w: PARAM_X_STEP * SCALE - 2,
        h: widgetHeight(spec) * SCALE - 2,
        label: widget.type,
        detail: detailOf(widget),
        category: spec.category,
      };
    }),
  );

  /** Arrows from each jump or branch to the label it targets. */
  const jumps = $derived.by(() => {
    if (!linked) return [];
    const labels = new Map<string, number>();
    placed.forEach((w, i) => {
      if (w.type !== "label") return;
      const slot = linked.widgets[i]?.parameters[0];
      if (slot === undefined || slot < 0) return;
      const name = placed[slot]?.fields["string"];
      if (typeof name === "string") labels.set(name, i);
    });

    const arrows: { from: number; to: number; kind: string }[] = [];
    placed.forEach((w, i) => {
      if (w.type !== "text") return;
      const target = w.fields["string"];
      if (typeof target !== "string") return;
      const to = labels.get(target);
      if (to === undefined || to === i) return;
      // Attribute the arrow to whatever this text is attached to.
      const parent = linked.widgets[i]?.parent ?? -1;
      if (parent < 0) return;
      arrows.push({ from: parent, to, kind: placed[parent]!.type });
    });
    return arrows;
  });

  function detailOf(widget: PlacedWidget): string {
    const fields = widget.fields;
    if (typeof fields["string"] === "string") return `"${fields["string"]}"`;
    if (typeof fields["var"] === "string" && fields["var"]) return fields["var"];
    if (Array.isArray(fields["coord"])) return `<${(fields["coord"] as number[]).join(",")}>`;
    if (Array.isArray(fields["pos1"])) return `<${(fields["pos1"] as number[]).join(",")}>`;
    if (typeof fields["var1"] === "string" && fields["var1"]) return fields["var1"];
    const item = fields["chk_item"] as { id?: string } | undefined;
    if (item?.id) return item.id.replace("minecraft:", "");
    return "";
  }

  function centreOf(index: number): { x: number; y: number } {
    const box = boxes[index]!;
    return { x: box.x + box.w / 2, y: box.y + box.h / 2 };
  }

  function onWheel(event: WheelEvent): void {
    event.preventDefault();
    zoom = Math.min(4, Math.max(0.3, zoom * (event.deltaY < 0 ? 1.15 : 1 / 1.15)));
  }

  function onPointerDown(event: PointerEvent): void {
    dragging = true;
    (event.currentTarget as Element).setPointerCapture(event.pointerId);
  }

  // Dragging scrolls, so a program taller than the pane stays reachable at a
  // readable scale rather than being shrunk to fit.
  function onPointerMove(event: PointerEvent): void {
    if (!dragging || !canvas) return;
    canvas.scrollLeft -= event.movementX;
    canvas.scrollTop -= event.movementY;
  }

  function reset(): void {
    zoom = 1;
    canvas?.scrollTo({ left: 0, top: 0 });
  }
</script>

<div class="preview">
  <div class="controls">
    <span class="hint">scroll to zoom, drag to pan</span>
    <button onclick={reset}>Reset view</button>
  </div>

  <!-- svelte-ignore a11y_no_static_element_interactions -->
  <div
    class="canvas"
    bind:this={canvas}
    onwheel={onWheel}
    onpointerdown={onPointerDown}
    onpointermove={onPointerMove}
    onpointerup={() => (dragging = false)}
    onpointerleave={() => (dragging = false)}
  >
    {#if placed.length === 0}
      <p class="empty">Nothing to show yet.</p>
    {:else}
      <svg
        width={(bounds.width * SCALE + PADDING * 2) * zoom}
        height={(bounds.height * SCALE + PADDING * 2) * zoom}
        viewBox={`${-PADDING} ${-PADDING} ${bounds.width * SCALE + PADDING * 2} ${
          bounds.height * SCALE + PADDING * 2
        }`}
      >
        <defs>
          <marker
            id="arrow"
            viewBox="0 0 8 8"
            refX="7"
            refY="4"
            markerWidth="6"
            markerHeight="6"
            orient="auto-start-reverse"
          >
            <path d="M0,0 L8,4 L0,8 z" fill="var(--fg-muted)" />
          </marker>
        </defs>

        {#each jumps as jump (jump.from + ":" + jump.to)}
          {@const from = centreOf(jump.from)}
          {@const to = centreOf(jump.to)}
          <path
            d={`M ${from.x} ${from.y} C ${from.x + 60} ${from.y}, ${to.x + 60} ${to.y}, ${to.x} ${to.y}`}
            class="jump"
            marker-end="url(#arrow)"
          />
        {/each}

        {#each boxes as box (box.index)}
          <g
            role="listitem"
            onpointerenter={() => (hovered = box.index)}
            onpointerleave={() => (hovered = undefined)}
          >
            <rect
              x={box.x}
              y={box.y}
              width={box.w}
              height={box.h}
              class="widget {box.category}"
              class:hovered={hovered === box.index}
            />
            <!-- Top-left highlight and bottom-right shade: the two strokes that
                 make a flat square read as a bevelled Minecraft panel. -->
            <path
              class="lit"
              d={`M ${box.x + 1} ${box.y + box.h - 1} L ${box.x + 1} ${box.y + 1} L ${box.x + box.w - 1} ${box.y + 1}`}
            />
            <path
              class="shade"
              d={`M ${box.x + box.w - 1} ${box.y + 1} L ${box.x + box.w - 1} ${box.y + box.h - 1} L ${box.x + 1} ${box.y + box.h - 1}`}
            />
            <text x={box.x + 5} y={box.y + 12} class="name">{box.label}</text>
            {#if box.detail}
              <text x={box.x + 5} y={box.y + 23} class="detail">{box.detail}</text>
            {/if}
          </g>
        {/each}
      </svg>
    {/if}
  </div>

  <div class="legend">
    {#each ["flow", "action", "condition", "parameter"] as category}
      <span class="key"><i class={category}></i>{category}</span>
    {/each}
  </div>
</div>

<style>
  .preview {
    display: flex;
    flex-direction: column;
    height: 100%;
    min-height: 0;
  }

  .controls {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 12px;
    padding: 4px 8px;
    border-bottom: 1px solid var(--line);
    background: var(--surface-sunken);
  }

  .controls button {
    height: 22px;
    padding: 0 8px;
    font-size: 11px;
  }

  .hint {
    color: var(--fg-muted);
    font-size: 11px;
  }

  /* The dotted grid the program floats on, matching the planner's node canvas. */
  .canvas {
    flex: 1;
    min-height: 0;
    overflow: auto;
    cursor: grab;
    touch-action: none;
    background-color: var(--canvas);
    background-image: radial-gradient(var(--canvas-dot) 1px, transparent 1px);
    background-size: 20px 20px;
  }

  .canvas:active {
    cursor: grabbing;
  }

  .empty {
    color: var(--fg-muted);
    padding: 24px;
    font-size: 12px;
  }

  .widget {
    stroke: var(--mc-15);
    stroke-width: 2;
  }

  .lit,
  .shade {
    fill: none;
    stroke-width: 2;
    pointer-events: none;
  }

  .lit {
    stroke: rgb(255 255 255 / 0.3);
  }

  .shade {
    stroke: rgb(0 0 0 / 0.28);
  }

  .widget.flow {
    fill: var(--flow);
  }
  .widget.action {
    fill: var(--action);
  }
  .widget.condition {
    fill: var(--condition);
  }
  .widget.parameter {
    fill: var(--parameter);
  }
  .widget.meta {
    fill: var(--meta);
  }

  .widget.hovered {
    stroke: var(--glow);
    stroke-width: 2;
  }

  .name {
    font-size: 9px;
    fill: var(--mc-15);
    font-weight: 700;
    pointer-events: none;
  }

  .detail {
    font-size: 8px;
    fill: rgb(17 19 23 / 0.7);
    pointer-events: none;
  }

  .jump {
    fill: none;
    stroke: var(--fg-muted);
    stroke-width: 1;
    stroke-dasharray: 4 3;
    opacity: 0.7;
  }

  .legend {
    display: flex;
    gap: 12px;
    padding: 5px 8px;
    border-top: 1px solid var(--line);
    background: var(--surface-sunken);
    color: var(--fg-muted);
    font-size: 11px;
    font-weight: 700;
    text-transform: uppercase;
    letter-spacing: 0.08em;
  }

  .key {
    display: inline-flex;
    align-items: center;
    gap: 5px;
  }

  /* Square swatches with the same hard border the widgets get. */
  .key i {
    width: 9px;
    height: 9px;
    border: 1px solid var(--mc-15);
    display: inline-block;
  }

  .key i.flow {
    background: var(--flow);
  }
  .key i.action {
    background: var(--action);
  }
  .key i.condition {
    background: var(--condition);
  }
  .key i.parameter {
    background: var(--parameter);
  }
</style>
