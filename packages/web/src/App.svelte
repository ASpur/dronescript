<script lang="ts">
  import type { CompileResult } from "@dronescript/compiler";

  import Editor from "./lib/Editor.svelte";
  import Preview from "./lib/Preview.svelte";
  import CompileWorker from "./lib/compile.worker.ts?worker";
  import type { CompileRequest, CompileResponse } from "./lib/compile.worker.js";
  import { EXAMPLES } from "./lib/examples.js";

  const INITIAL_SOURCE = EXAMPLES[0]!.source;

  let source = $state(INITIAL_SOURCE);
  let result: CompileResult | undefined = $state();
  let tab: "preview" | "json" = $state("preview");
  let copied = $state(false);
  let editor: Editor | undefined = $state();

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
    const message: CompileRequest = { id: ++pending, source: next };
    worker.postMessage(message);
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
    <div class="title">
      <strong>DroneScript</strong>
      <span class="sub">a compiler for PneumaticCraft: Repressurized drones</span>
    </div>
    <div class="actions">
      <select onchange={loadExample} aria-label="Load an example">
        <option value="">Examples…</option>
        {#each EXAMPLES as example (example.name)}
          <option value={example.name}>{example.name}</option>
        {/each}
      </select>
      <button onclick={copyJson} disabled={!canExport}>
        {copied ? "Copied" : "Copy program JSON"}
      </button>
    </div>
  </header>

  <main>
    <section class="pane editor-pane">
      <Editor
        bind:this={editor}
        bind:value={source}
        diagnostics={result?.diagnostics ?? []}
        {onchange}
      />
    </section>

    <section class="pane output-pane">
      <nav class="tabs">
        <button class:active={tab === "preview"} onclick={() => (tab = "preview")}>
          Puzzle layout
        </button>
        <button class:active={tab === "json"} onclick={() => (tab = "json")}>JSON</button>
        <span class="spacer"></span>
        {#if result?.pieces !== undefined && errors.length === 0}
          <span class="pieces">{result.pieces} puzzle pieces</span>
        {/if}
      </nav>

      <div class="output">
        {#if tab === "preview"}
          <Preview placed={result?.placed ?? []} />
        {:else}
          <pre class="json">{result?.text ? formatJson(result.text) : ""}</pre>
        {/if}
      </div>
    </section>
  </main>

  <footer class:bad={errors.length > 0 || issues.length > 0}>
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
    gap: 16px;
    padding: 10px 16px;
    border-bottom: 1px solid var(--border);
    background: var(--panel);
    flex-wrap: wrap;
  }

  .title strong {
    font-size: 15px;
  }

  .sub {
    color: var(--muted);
    margin-left: 10px;
    font-size: 13px;
  }

  .actions {
    display: flex;
    gap: 8px;
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
    background: var(--panel);
  }

  .output-pane {
    border-left: 1px solid var(--border);
  }

  .tabs {
    display: flex;
    align-items: center;
    gap: 6px;
    padding: 6px 10px;
    border-bottom: 1px solid var(--border);
  }

  .tabs button {
    background: transparent;
    border-color: transparent;
  }

  .tabs button.active {
    background: var(--panel-2);
    border-color: var(--border);
  }

  .spacer {
    flex: 1;
  }

  .pieces {
    color: var(--muted);
    font-size: 12px;
  }

  .output {
    flex: 1;
    min-height: 0;
    overflow: auto;
  }

  .json {
    margin: 0;
    padding: 12px;
    font-family: ui-monospace, "Cascadia Code", "Consolas", monospace;
    font-size: 12px;
    white-space: pre;
  }

  footer {
    border-top: 1px solid var(--border);
    background: var(--panel);
    padding: 8px 16px;
    max-height: 160px;
    overflow: auto;
    font-size: 13px;
  }

  footer.bad {
    border-top-color: var(--error);
  }

  .ok {
    color: var(--muted);
  }

  .messages {
    margin: 0;
    padding-left: 18px;
    color: var(--error);
  }

  .where {
    color: var(--muted);
    margin-right: 6px;
  }
</style>
