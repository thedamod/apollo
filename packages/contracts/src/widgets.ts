import { z } from "zod";

import { ScriptParamValue } from "./scripts.ts";

/**
 * Widgets — pinned script shortcuts on the Home tab.
 * A widget is a script plus preset parameter values, e.g. "Dim lights"
 * runs the Room Lighting script with `{ brightness: 50 }`.
 */

export const WidgetDefinition = z.object({
  id: z.string().min(1).max(64).regex(/^[a-z0-9_-]+$/),
  name: z.string().min(1).max(128),
  /** script this widget triggers via `scripts.run` */
  scriptId: z.string().min(1).max(64),
  /** preset parameter values merged over the script's defaults at run time */
  params: z.record(z.string(), ScriptParamValue).optional(),
  createdAt: z.string(),
  updatedAt: z.string(),
});
export type WidgetDefinition = z.infer<typeof WidgetDefinition>;

export const WidgetListInput = z.object({}).optional();
export type WidgetListInput = z.infer<typeof WidgetListInput>;

export const WidgetGetInput = z.object({ id: z.string().min(1) });
export type WidgetGetInput = z.infer<typeof WidgetGetInput>;

export const WidgetUpsertInput = z.object({
  id: z.string().min(1).max(64).regex(/^[a-z0-9_-]+$/).optional(),
  name: z.string().min(1).max(128),
  scriptId: z.string().min(1).max(64),
  params: z.record(z.string(), ScriptParamValue).optional(),
});
export type WidgetUpsertInput = z.infer<typeof WidgetUpsertInput>;

export const WidgetDeleteInput = z.object({ id: z.string().min(1) });
export type WidgetDeleteInput = z.infer<typeof WidgetDeleteInput>;
