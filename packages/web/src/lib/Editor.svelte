<script lang="ts">
  import * as monaco from "monaco-editor/esm/vs/editor/editor.api";
  import editorWorker from "monaco-editor/esm/vs/editor/editor.worker?worker";
  import { onMount } from "svelte";

  import type { Diagnostic } from "@dronescript/compiler";
  import { LANGUAGE_ID, registerLanguage } from "./language.js";

  interface Props {
    value: string;
    diagnostics: readonly Diagnostic[];
    onchange: (value: string) => void;
  }

  let { value = $bindable(), diagnostics, onchange }: Props = $props();

  let container: HTMLDivElement;
  let editor: monaco.editor.IStandaloneCodeEditor | undefined = $state();

  // Monaco needs its own worker; DroneScript has no other language services.
  self.MonacoEnvironment = { getWorker: () => new editorWorker() };

  onMount(() => {
    registerLanguage();

    // Pulled from app.css so the editor reads as one surface with the chrome.
    monaco.editor.defineTheme("dronescript-dark", {
      base: "vs-dark",
      inherit: true,
      colors: {
        "editor.background": "#1b1d21",
        "editorGutter.background": "#1b1d21",
        "editor.lineHighlightBackground": "#25272c",
        "editorLineNumber.foreground": "#5a5c65",
        "editorLineNumber.activeForeground": "#a3a3a3",
        "editorIndentGuide.background1": "#2d2f35",
        "editorCursor.foreground": "#ffd257",
        "editor.selectionBackground": "#3987e544",
      },
      rules: [
        { token: "type.identifier", foreground: "3987e5" },
        { token: "variable.predefined", foreground: "e09b17" },
      ],
    });

    const ui = getComputedStyle(document.body).getPropertyValue("--font-ui");

    editor = monaco.editor.create(container, {
      value,
      language: LANGUAGE_ID,
      theme: "dronescript-dark",
      automaticLayout: true,
      minimap: { enabled: false },
      fontFamily: ui,
      fontSize: 13,
      scrollBeyondLastLine: false,
      renderLineHighlight: "gutter",
      tabSize: 2,
    });

    editor.onDidChangeModelContent(() => {
      const next = editor!.getValue();
      value = next;
      onchange(next);
    });

    return () => editor?.dispose();
  });

  // Push the compiler's diagnostics into the gutter as markers.
  $effect(() => {
    const model = editor?.getModel();
    if (!model) return;
    monaco.editor.setModelMarkers(
      model,
      "dronescript",
      diagnostics.map((d) => {
        const start = model.getPositionAt(d.span.start);
        const end = model.getPositionAt(Math.max(d.span.end, d.span.start + 1));
        return {
          severity:
            d.severity === "error"
              ? monaco.MarkerSeverity.Error
              : monaco.MarkerSeverity.Warning,
          message: d.message,
          code: d.code,
          startLineNumber: start.lineNumber,
          startColumn: start.column,
          endLineNumber: end.lineNumber,
          endColumn: end.column,
        };
      }),
    );
  });

  /** Replace the whole document, e.g. when an example is chosen. */
  export function setValue(next: string): void {
    editor?.setValue(next);
  }
</script>

<div class="editor" bind:this={container}></div>

<style>
  /* A flex child rather than height:100%: the pane also holds a header strip. */
  .editor {
    flex: 1;
    min-height: 0;
    width: 100%;
  }
</style>
