/**
 * Monaco language support for DroneScript.
 *
 * Completions and hover text come from the compiler's own builtin table, so the
 * editor can never advertise a function or option the compiler does not accept.
 */

// The editor core only: none of Monaco's bundled languages are wanted here, and
// importing the default entry point pulls in every one of them.
import * as monaco from "monaco-editor/esm/vs/editor/editor.api";
import { AREA_TYPES, BUILTINS, DIRECTIONS, KEYWORDS } from "@dronescript/compiler";
import type { BuiltinSpec } from "@dronescript/compiler";

export const LANGUAGE_ID = "dronescript";

const SPECIAL_VARIABLES = [
  "$drone_pos",
  "$controller_pos",
  "$owner_pos",
  "$deploy_pos",
  "$owner_look",
];

export function registerLanguage(): void {
  if (monaco.languages.getLanguages().some((l) => l.id === LANGUAGE_ID)) return;

  monaco.languages.register({ id: LANGUAGE_ID });

  monaco.languages.setMonarchTokensProvider(LANGUAGE_ID, {
    keywords: [...KEYWORDS],
    builtins: BUILTINS.map((b) => b.name.split(".").pop()!),
    tokenizer: {
      root: [
        [/\/\/.*$/, "comment"],
        [/\/\*/, "comment", "@comment"],
        [/"([^"\\]|\\.)*"/, "string"],
        [/[#%$][A-Za-z_]\w*/, "variable.predefined"],
        [/\d+/, "number"],
        [
          /[A-Za-z_]\w*/,
          {
            cases: {
              "@keywords": "keyword",
              "@builtins": "type.identifier",
              "@default": "identifier",
            },
          },
        ],
        [/[{}()[\]]/, "@brackets"],
        [/[<>!=]=|&&|\|\||[+\-*/<>=!]/, "operator"],
      ],
      comment: [
        [/[^*/]+/, "comment"],
        [/\*\//, "comment", "@pop"],
        [/./, "comment"],
      ],
    },
  });

  monaco.languages.setLanguageConfiguration(LANGUAGE_ID, {
    comments: { lineComment: "//", blockComment: ["/*", "*/"] },
    brackets: [
      ["{", "}"],
      ["[", "]"],
      ["(", ")"],
    ],
    autoClosingPairs: [
      { open: "{", close: "}" },
      { open: "[", close: "]" },
      { open: "(", close: ")" },
      { open: '"', close: '"' },
    ],
  });

  monaco.languages.registerCompletionItemProvider(LANGUAGE_ID, {
    triggerCharacters: ["."],
    provideCompletionItems(model, position) {
      const word = model.getWordUntilPosition(position);
      const range: monaco.IRange = {
        startLineNumber: position.lineNumber,
        endLineNumber: position.lineNumber,
        startColumn: word.startColumn,
        endColumn: word.endColumn,
      };

      const suggestions: monaco.languages.CompletionItem[] = [];

      for (const builtin of BUILTINS) {
        suggestions.push({
          label: builtin.name,
          kind: builtin.condition
            ? monaco.languages.CompletionItemKind.Property
            : monaco.languages.CompletionItemKind.Function,
          detail: signatureOf(builtin),
          documentation: { value: documentationFor(builtin) },
          insertText: `${builtin.name.split(".").pop()!}($0)`,
          insertTextRules: monaco.languages.CompletionItemInsertTextRule.InsertAsSnippet,
          range,
        });
      }

      for (const keyword of KEYWORDS) {
        suggestions.push({
          label: keyword,
          kind: monaco.languages.CompletionItemKind.Keyword,
          insertText: keyword,
          range,
        });
      }

      for (const name of SPECIAL_VARIABLES) {
        suggestions.push({
          label: name,
          kind: monaco.languages.CompletionItemKind.Constant,
          detail: "built-in coordinate, read-only",
          insertText: name,
          range,
        });
      }

      for (const name of ["area", "filter", "fluid"]) {
        suggestions.push({
          label: name,
          kind: monaco.languages.CompletionItemKind.Function,
          detail: "compile-time value",
          insertText: `${name}($0)`,
          insertTextRules: monaco.languages.CompletionItemInsertTextRule.InsertAsSnippet,
          range,
        });
      }

      return { suggestions };
    },
  });

  monaco.languages.registerHoverProvider(LANGUAGE_ID, {
    provideHover(model, position) {
      const word = model.getWordAtPosition(position);
      if (!word) return null;
      const builtin =
        BUILTINS.find((b) => b.name === word.word) ??
        BUILTINS.find((b) => b.name.split(".").pop() === word.word);
      if (!builtin) return null;
      return {
        contents: [
          { value: `\`\`\`\n${signatureOf(builtin)}\n\`\`\`` },
          { value: documentationFor(builtin) },
        ],
      };
    },
  });
}

function signatureOf(builtin: BuiltinSpec): string {
  const positional = builtin.params
    .filter((p) => p.from.kind === "arg" && p.side === "whitelist")
    .map((p) => p.type);
  return `${builtin.name}(${positional.join(", ")}${positional.length > 0 ? ", " : ""}{options})`;
}

function documentationFor(builtin: BuiltinSpec): string {
  const lines = [builtin.summary, ""];

  const optionParams = builtin.params.filter((p) => p.from.kind === "option");
  if (optionParams.length > 0) {
    lines.push("**Parameters**");
    for (const p of optionParams) {
      if (p.from.kind !== "option") continue;
      lines.push(`- \`${p.from.name}\` — ${p.type.replace("_", " ")}`);
    }
    lines.push("");
  }

  if (builtin.fields.length > 0) {
    lines.push("**Options**");
    for (const field of builtin.fields) {
      const values =
        field.values?.join(" | ") ??
        (field.kind === "direction" || field.kind === "sides"
          ? DIRECTIONS.join(" | ")
          : field.kind);
      lines.push(`- \`${field.option}\`: ${values}`);
    }
    lines.push("");
  }

  if (builtin.condition) {
    lines.push(
      "Reads a value. Compare it in a condition, or assign it to a variable to measure it.",
    );
  }

  return lines.join("\n");
}

/** Area shapes, for documentation elsewhere in the UI. */
export const AREA_SHAPES = AREA_TYPES.map((a) => a.id);
