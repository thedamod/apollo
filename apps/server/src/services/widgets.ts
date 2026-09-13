import * as fsp from "node:fs/promises";
import * as path from "node:path";
import * as crypto from "node:crypto";
import type { WidgetDefinition } from "@home-server/contracts";
import type { ScriptService } from "./scripts.ts";

function isValidWidgetId(id: string): boolean {
  return /^[a-z0-9_-]+$/.test(id);
}

/**
 * WidgetService — persists Home-tab widgets (script + preset params) to
 * `userdata/widgets.json`. Running a widget is just `scripts.run` with the
 * stored preset params, so this service only owns CRUD.
 */
export class WidgetService {
  private defs = new Map<string, WidgetDefinition>();

  constructor(
    private readonly widgetsPath: string,
    private readonly scriptService?: ScriptService,
  ) {}

  async init(): Promise<void> {
    try {
      await fsp.mkdir(path.dirname(this.widgetsPath), { recursive: true });
    } catch {}
    let raw: string | null = null;
    try {
      raw = await fsp.readFile(this.widgetsPath, "utf8");
    } catch (e) {
      if ((e as NodeJS.ErrnoException)?.code !== "ENOENT") return;
      return;
    }
    if (!raw) return;
    try {
      const arr = JSON.parse(raw) as WidgetDefinition[];
      for (const d of arr) {
        if (d?.id) this.defs.set(d.id, d);
      }
    } catch {}
  }

  private async persist(): Promise<void> {
    try {
      await fsp.writeFile(
        this.widgetsPath,
        JSON.stringify([...this.defs.values()], null, 2) + "\n",
        "utf8",
      );
    } catch {}
  }

  list(): WidgetDefinition[] {
    return [...this.defs.values()].sort((a, b) => a.name.localeCompare(b.name));
  }

  get(id: string): WidgetDefinition | undefined {
    return this.defs.get(id);
  }

  async upsert(input: {
    id?: string;
    name: string;
    scriptId: string;
    params?: Record<string, string | number | boolean>;
  }): Promise<WidgetDefinition> {
    const id = input.id ?? `wdg_${crypto.randomBytes(4).toString("hex")}`;
    if (!isValidWidgetId(id)) {
      throw Object.assign(new Error(`Invalid widget id: ${id}`), { code: "invalid_id" });
    }
    if (this.scriptService && !this.scriptService.get(input.scriptId)) {
      throw Object.assign(new Error(`Unknown script: ${input.scriptId}`), { code: "not_found" });
    }
    const now = new Date().toISOString();
    const existing = this.defs.get(id);
    const def: WidgetDefinition = {
      id,
      name: input.name,
      scriptId: input.scriptId,
      params: input.params,
      createdAt: existing?.createdAt ?? now,
      updatedAt: now,
    };
    this.defs.set(id, def);
    await this.persist();
    return def;
  }

  async delete(id: string): Promise<void> {
    if (!this.defs.has(id)) {
      throw Object.assign(new Error(`Unknown widget: ${id}`), { code: "not_found" });
    }
    this.defs.delete(id);
    await this.persist();
  }
}
