/**
 * Code highlighting for the file preview, mirroring t3code mobile
 * (`context/t3code/apps/mobile/src/features/review/shikiReviewHighlighter.ts`):
 * Shiki core + the pure-JS regex engine (no oniguruma WASM — it can't run
 * in React Native), a single dark theme, statically-imported grammars so
 * Metro bundles them, per-line tokens rendered as nested `<Text>` spans.
 */

import { createHighlighterCore, type HighlighterCore } from "@shikijs/core";
import { createJavaScriptRegexEngine } from "@shikijs/engine-javascript";
import bash from "@shikijs/langs/bash";
import c from "@shikijs/langs/c";
import cpp from "@shikijs/langs/cpp";
import css from "@shikijs/langs/css";
import csv from "@shikijs/langs/csv";
import dockerfile from "@shikijs/langs/dockerfile";
import go from "@shikijs/langs/go";
import html from "@shikijs/langs/html";
import ini from "@shikijs/langs/ini";
import java from "@shikijs/langs/java";
import javascript from "@shikijs/langs/javascript";
import json from "@shikijs/langs/json";
import jsonc from "@shikijs/langs/jsonc";
import jsx from "@shikijs/langs/jsx";
import markdown from "@shikijs/langs/markdown";
import php from "@shikijs/langs/php";
import python from "@shikijs/langs/python";
import ruby from "@shikijs/langs/ruby";
import rust from "@shikijs/langs/rust";
import scss from "@shikijs/langs/scss";
import sql from "@shikijs/langs/sql";
import svelte from "@shikijs/langs/svelte";
import toml from "@shikijs/langs/toml";
import tsx from "@shikijs/langs/tsx";
import typescript from "@shikijs/langs/typescript";
import vue from "@shikijs/langs/vue";
import xml from "@shikijs/langs/xml";
import yaml from "@shikijs/langs/yaml";
import githubDark from "@shikijs/themes/github-dark";
import { extOf } from "./files";

export const SHIKI_THEME = "github-dark";

/** Shiki highlight can take seconds on huge inputs — highlight this much max. */
const HIGHLIGHT_CHAR_BUDGET = 300_000;

export interface HighlightedToken {
  text: string;
  /** Hex color from the theme, or undefined for default foreground. */
  color?: string;
}

export type HighlightedLine = HighlightedToken[];

const EXT_TO_LANG: Record<string, string> = {
  ".ts": "typescript",
  ".mts": "typescript",
  ".cts": "typescript",
  ".tsx": "tsx",
  ".js": "javascript",
  ".mjs": "javascript",
  ".cjs": "javascript",
  ".jsx": "jsx",
  ".json": "json",
  ".jsonc": "jsonc",
  ".yaml": "yaml",
  ".yml": "yaml",
  ".toml": "toml",
  ".ini": "ini",
  ".env": "ini",
  ".py": "python",
  ".pyi": "python",
  ".sh": "bash",
  ".bash": "bash",
  ".zsh": "bash",
  ".go": "go",
  ".rs": "rust",
  ".java": "java",
  ".c": "c",
  ".h": "c",
  ".cpp": "cpp",
  ".hpp": "cpp",
  ".cc": "cpp",
  ".css": "css",
  ".scss": "scss",
  ".html": "html",
  ".htm": "html",
  ".xml": "xml",
  ".vue": "vue",
  ".svelte": "svelte",
  ".sql": "sql",
  ".rb": "ruby",
  ".php": "php",
  ".md": "markdown",
  ".markdown": "markdown",
  ".mdx": "markdown",
  ".csv": "csv",
  ".tsv": "csv",
  ".ipynb": "json",
};

/** Shiki language id for a filename, or null when it should render plain. */
export function shikiLangForFile(name: string): string | null {
  const base = name.split("/").pop() ?? name;
  if (base === "Dockerfile" || base.toLowerCase().startsWith("dockerfile.")) return "dockerfile";
  if (base === "Makefile") return null;
  const lang = EXT_TO_LANG[extOf(name).toLowerCase()];
  if (!lang || lang === "text") return null;
  return lang;
}

let highlighterPromise: Promise<HighlighterCore> | null = null;

/** Shared singleton (t3code keeps one `getSharedHighlighter` too). */
export function getHighlighter(): Promise<HighlighterCore> {
  if (!highlighterPromise) {
    highlighterPromise = createHighlighterCore({
      themes: [githubDark],
      langs: [
        bash, c, cpp, css, csv, dockerfile, go, html, ini, java,
        javascript, json, jsonc, jsx, markdown, php, python, ruby,
        rust, scss, sql, svelte, toml, tsx, typescript, vue, xml, yaml,
      ],
      engine: createJavaScriptRegexEngine(),
    }).catch((e) => {
      highlighterPromise = null;
      throw e;
    });
  }
  return highlighterPromise;
}

/**
 * Highlight `code` into per-line tokens. Returns null when highlighting
 * isn't available for the file (unknown type, over budget, init failure) —
 * callers fall back to plain rendering.
 */
export async function highlightCode(code: string, filename: string): Promise<HighlightedLine[] | null> {
  const lang = shikiLangForFile(filename);
  if (!lang || code.length === 0 || code.length > HIGHLIGHT_CHAR_BUDGET) return null;
  try {
    const hl = await getHighlighter();
    const { tokens } = hl.codeToTokens(code, { lang, theme: SHIKI_THEME });
    return tokens.map((line) =>
      line.map((t) => ({ text: t.content, color: t.color && t.color !== "#00000000" ? t.color : undefined })),
    );
  } catch {
    return null;
  }
}
