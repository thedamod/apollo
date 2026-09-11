/**
 * Parameter schema for parameterized scripts.
 *
 * Mirrors the future contracts shape (`ScriptParam`) so the server
 * increment can adopt these types 1:1 — mobile leads, server follows.
 * Values flow: schema → generated UI → values → `scripts.run { params }`
 * → server substitutes `{{key}}` in the command.
 */

export type ScriptParamType = "slider" | "number" | "text" | "toggle" | "select" | "color" | "file";

export interface ScriptParamOption {
  value: string;
  label: string;
}

export interface ScriptParam {
  key: string;
  type: ScriptParamType;
  label: string;
  defaultValue?: string | number | boolean;
  min?: number;
  max?: number;
  step?: number;
  unit?: string;
  required?: boolean;
  options?: ScriptParamOption[];
  placeholder?: string;
  hint?: string;
}

export type ParamValues = Record<string, string | number | boolean>;

export const PARAM_TYPES: Array<{ value: ScriptParamType; label: string; desc: string }> = [
  { value: "slider", label: "Slider", desc: "Brightness, volume, …" },
  { value: "number", label: "Number", desc: "Durations, temperatures, …" },
  { value: "text", label: "Text", desc: "Arbitrary strings" },
  { value: "toggle", label: "Toggle", desc: "On/off booleans" },
  { value: "select", label: "Dropdown", desc: "Predefined options" },
  { value: "color", label: "Color", desc: "Lighting / RGB" },
  { value: "file", label: "File / path", desc: "Path on the server" },
];

export function isValidParamKey(key: string): boolean {
  return /^[a-zA-Z_][a-zA-Z0-9_]*$/.test(key) && key.length <= 64;
}

/** `{{key}}` placeholders referenced by a command. */
export function referencedParamKeys(command: string): string[] {
  const out = new Set<string>();
  for (const m of command.matchAll(/\{\{\s*([a-zA-Z_][a-zA-Z0-9_]*)\s*\}\}/g)) out.add(m[1]);
  return [...out];
}

export function defaultParamValues(params: ScriptParam[]): ParamValues {
  const values: ParamValues = {};
  for (const p of params) {
    if (p.defaultValue !== undefined) values[p.key] = p.defaultValue;
    else if (p.type === "toggle") values[p.key] = false;
    else if (p.type === "slider" || p.type === "number") values[p.key] = p.min ?? 0;
    else if (p.type === "select") values[p.key] = p.options?.[0]?.value ?? "";
    else values[p.key] = "";
  }
  return values;
}

function coerceNumber(v: string | number | boolean | undefined, fallback: number): number {
  const n = typeof v === "number" ? v : typeof v === "string" ? Number(v) : NaN;
  return Number.isFinite(n) ? n : fallback;
}

/** Validate values against the schema — returns key → message. */
export function validateParamValues(params: ScriptParam[], values: ParamValues): Record<string, string> {
  const errors: Record<string, string> = {};
  for (const p of params) {
    const v = values[p.key];
    const empty = v === undefined || v === null || (typeof v === "string" && v.trim() === "");
    if (empty) {
      if (p.required) errors[p.key] = "Required";
      continue;
    }
    if (p.type === "slider" || p.type === "number") {
      const n = coerceNumber(v, NaN);
      if (!Number.isFinite(n)) errors[p.key] = "Must be a number";
      else if (p.min !== undefined && n < p.min) errors[p.key] = `Min ${p.min}`;
      else if (p.max !== undefined && n > p.max) errors[p.key] = `Max ${p.max}`;
    } else if (p.type === "select") {
      const allowed = (p.options ?? []).map((o) => o.value);
      if (allowed.length > 0 && !allowed.includes(String(v))) errors[p.key] = "Pick one of the options";
    } else if (p.type === "color") {
      if (!/^#[0-9a-fA-F]{6}$/.test(String(v))) errors[p.key] = "Use #rrggbb";
    }
  }
  return errors;
}

/** Serialize a value for `{{key}}` substitution / env passing. */
export function serializeParamValue(v: string | number | boolean | undefined): string {
  if (typeof v === "boolean") return v ? "true" : "false";
  return String(v ?? "");
}
