<script lang="ts">
  import { tick } from "svelte";

  import { DEFAULT_TARGET, TARGETS } from "@dronescript/compiler";
  import type { CompileResult, Target } from "@dronescript/compiler";

  import Editor from "./lib/Editor.svelte";
  import Preview from "./lib/Preview.svelte";
  import Reference from "./lib/Reference.svelte";
  import ReferenceModal from "./lib/ReferenceModal.svelte";
  import { setReferenceOpener } from "./lib/language.js";
  import CompileWorker from "./lib/compile.worker.ts?worker";
  import type { CompileRequest, CompileResponse } from "./lib/compile.worker.js";
  import { EXAMPLES } from "./lib/examples.js";

  const INITIAL_SOURCE = EXAMPLES[0]!.source;

  let source = $state(INITIAL_SOURCE);
  let result: CompileResult | undefined = $state();
  let tab: "preview" | "json" | "reference" = $state("preview");
  let referenceExpanded = $state(false);
  let reference: Reference | undefined = $state();

  // Ctrl+click on a function name in the editor lands on its reference entry.
  setReferenceOpener(async (name) => {
    tab = "reference";
    await tick();
    reference?.scrollToFunction(name);
  });
  let copied = $state(false);
  let editor: Editor | undefined = $state();
  let target: Target = $state(DEFAULT_TARGET);

  const worker = new CompileWorker();
  let pending = 0;
  let latest = 0;

  worker.onmessage = (event: MessageEvent<CompileResponse>) => {
    // Out-of-order replies would flicker stale results back into view.
    if (event.data.id < latest) return;
    latest = event.data.id;
    result = event.data.result;
  };

  function requestCompile(next: string): void {
    const message: CompileRequest = { id: ++pending, source: next, target };
    worker.postMessage(message);
  }

  function changeTarget(event: Event): void {
    target = (event.currentTarget as HTMLSelectElement).value as Target;
    // The two versions serialize differently, so recompile rather than reuse.
    requestCompile(source);
  }

  // Compile as the program is typed, on a short debounce.
  let timer: ReturnType<typeof setTimeout> | undefined;
  function onchange(next: string): void {
    source = next;
    clearTimeout(timer);
    timer = setTimeout(() => requestCompile(next), 150);
  }

  // Compile once at startup; every later compile comes from onchange.
  requestCompile(INITIAL_SOURCE);

  const errors = $derived((result?.diagnostics ?? []).filter((d) => d.severity === "error"));
  const warnings = $derived((result?.diagnostics ?? []).filter((d) => d.severity === "warning"));
  const issues = $derived(result?.issues ?? []);
  const canExport = $derived(errors.length === 0 && issues.length === 0 && !!result?.text);
  const targetNote = $derived(TARGETS.find((t) => t.id === target)?.note ?? "");

  async function copyJson(): Promise<void> {
    if (!result?.text) return;
    await navigator.clipboard.writeText(result.text);
    copied = true;
    setTimeout(() => (copied = false), 1600);
  }

  function loadExample(event: Event): void {
    const name = (event.currentTarget as HTMLSelectElement).value;
    const example = EXAMPLES.find((e) => e.name === name);
    if (!example) return;
    editor?.setValue(example.source);
  }
</script>

<div class="app">
  <header>
    <h1 class="title">
      DroneScript
      <span class="sub">a compiler for PneumaticCraft: Repressurized drones</span>
    </h1>
    <div class="actions">
      <select onchange={changeTarget} aria-label="Mod version" title={targetNote}>
        {#each TARGETS as option (option.id)}
          <option value={option.id} selected={option.id === target}>
            MC {option.minecraft}
          </option>
        {/each}
      </select>
      <select onchange={loadExample} aria-label="Load an example">
        <option value="">Examples…</option>
        {#each EXAMPLES as example (example.name)}
          <option value={example.name}>{example.name}</option>
        {/each}
      </select>
      <button class="primary" onclick={copyJson} disabled={!canExport}>
        {copied ? "Copied" : "Copy program JSON"}
      </button>
    </div>
  </header>

  <main>
    <section class="pane editor-pane">
      <div class="pane-head">
        <span class="eyebrow">Source</span>
      </div>
      <Editor
        bind:this={editor}
        bind:value={source}
        diagnostics={result?.diagnostics ?? []}
        {onchange}
      />
    </section>

    <section class="pane output-pane">
      <nav class="pane-head tabs">
        <button class:active={tab === "preview"} onclick={() => (tab = "preview")}>
          Puzzle layout
        </button>
        <button class:active={tab === "json"} onclick={() => (tab = "json")}>JSON</button>
        <button class:active={tab === "reference"} onclick={() => (tab = "reference")}>
          Reference
        </button>
        <span class="spacer"></span>
        {#if tab === "reference"}
          <button class="expand" onclick={() => (referenceExpanded = true)}>Expand</button>
        {:else if result?.pieces !== undefined && errors.length === 0}
          <span class="pieces">{result.pieces} pieces</span>
        {/if}
      </nav>

      <div class="output">
        {#if tab === "preview"}
          <Preview placed={result?.placed ?? []} />
        {:else if tab === "reference"}
          <Reference bind:this={reference} />
        {:else}
          <pre class="json">{result?.text ? formatJson(result.text) : ""}</pre>
        {/if}
      </div>
    </section>
  </main>

  <footer class:bad={errors.length > 0 || issues.length > 0}>
    <span class="status eyebrow">
      {#if errors.length > 0}
        {errors.length} error{errors.length === 1 ? "" : "s"}
      {:else if issues.length > 0}
        Bad output
      {:else}
        OK
      {/if}
    </span>
    {#if errors.length > 0}
      <ul class="messages">
        {#each errors.slice(0, 8) as diagnostic (diagnostic.span.start + diagnostic.code)}
          <li>
            <span class="where">line {diagnostic.span.line}</span>
            {diagnostic.message}
          </li>
        {/each}
      </ul>
    {:else if issues.length > 0}
      <ul class="messages">
        <li class="where">
          The emitted program does not match its intended structure — please report this:
        </li>
        {#each issues.slice(0, 5) as issue (issue.message)}
          <li>{issue.message}</li>
        {/each}
      </ul>
    {:else}
      <span class="ok">
        Compiled cleanly{warnings.length > 0 ? ` with ${warnings.length} warning(s)` : ""}. Copy
        the JSON, then in game open the Programmer, click the pastebin button, and choose “Load
        code from clipboard”.
      </span>
    {/if}
  </footer>

  {#if referenceExpanded}
    <ReferenceModal onclose={() => (referenceExpanded = false)} />
  {/if}
</div>

<script module lang="ts">
  function formatJson(text: string): string {
    try {
      return JSON.stringify(JSON.parse(text), null, 2);
    } catch {
      return text;
    }
  }
</script>

<style>
  .app {
    display: flex;
    flex-direction: column;
    height: 100%;
  }

  header {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 12px;
    padding: 6px 12px;
    border-bottom: 1px solid var(--line);
    background: var(--surface);
    flex-wrap: wrap;
  }

  .title {
    display: flex;
    align-items: baseline;
    gap: 10px;
    margin: 0;
    font-size: 14px;
    font-weight: 700;
    letter-spacing: -0.025em;
  }

  .sub {
    color: var(--fg-muted);
    font-size: 11px;
    font-weight: 400;
    letter-spacing: 0;
  }

  /* Monocraft is a wide face, so the controls need somewhere to go on a phone. */
  .actions {
    display: flex;
    flex-wrap: wrap;
    gap: 6px;
  }

  /* The one call to action on the page, tinted the way the accent is used
     elsewhere: a wash of the accent rather than a solid fill. */
  .primary:not(:disabled) {
    color: var(--info);
    border-color: color-mix(in srgb, var(--info) 45%, transparent);
    background: color-mix(in srgb, var(--info) 12%, var(--surface));
  }

  .primary:not(:disabled):hover {
    color: var(--fg);
    background: color-mix(in srgb, var(--info) 22%, var(--surface));
  }

  main {
    flex: 1;
    min-height: 0;
    display: grid;
    grid-template-columns: minmax(0, 1fr) minmax(0, 1fr);
  }

  @media (max-width: 900px) {
    main {
      grid-template-columns: 1fr;
      grid-template-rows: minmax(0, 1fr) minmax(0, 1fr);
    }
  }

  .pane {
    min-width: 0;
    min-height: 0;
    display: flex;
    flex-direction: column;
    background: var(--background);
  }

  .output-pane {
    border-left: 1px solid var(--line);
  }

  /* Both panes carry the same 28px strip so their content lines up. */
  .pane-head {
    display: flex;
    align-items: center;
    gap: 4px;
    height: 30px;
    padding: 0 8px;
    border-bottom: 1px solid var(--line);
    background: var(--surface);
  }

  .tabs button {
    height: 22px;
    padding: 0 8px;
    font-size: 11px;
    font-weight: 700;
    text-transform: uppercase;
    letter-spacing: 0.08em;
    color: var(--fg-muted);
    background: transparent;
    border-color: transparent;
  }

  .tabs button.active {
    color: var(--fg);
    background: var(--surface-raised);
    border-color: var(--line-strong);
  }

  .spacer {
    flex: 1;
  }

  .pieces {
    color: var(--fg-muted);
    font-size: 11px;
  }

  .output {
    flex: 1;
    min-height: 0;
    overflow: auto;
  }

  .json {
    margin: 0;
    padding: 12px;
    font-family: var(--font-ui);
    font-size: 12px;
    color: var(--fg-subtle);
    white-space: pre;
  }

  footer {
    display: flex;
    align-items: baseline;
    gap: 10px;
    border-top: 1px solid var(--line);
    background: var(--surface);
    padding: 6px 12px;
    max-height: 160px;
    overflow: auto;
    font-size: 12px;
    color: var(--fg-muted);
  }

  footer.bad {
    border-top-color: var(--bad);
  }

  /* Square status pill, so the state reads before the message does. */
  .status {
    flex: none;
    padding: 1px 6px;
    border: 1px solid color-mix(in srgb, var(--good) 45%, transparent);
    background: color-mix(in srgb, var(--good) 14%, transparent);
    color: var(--good);
    border-radius: 4px;
  }

  footer.bad .status {
    border-color: color-mix(in srgb, var(--bad) 45%, transparent);
    background: color-mix(in srgb, var(--bad) 14%, transparent);
    color: var(--bad);
  }

  .messages {
    margin: 0;
    padding-left: 16px;
    color: var(--bad);
  }

  .where {
    color: var(--fg-muted);
    margin-right: 6px;
  }
</style>
