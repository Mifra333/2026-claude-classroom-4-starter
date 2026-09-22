"use client";

import {
  type CatalogDefinitions,
  type CatalogRenderers,
  createCatalog,
  DynamicNumberSchema,
  DynamicStringSchema,
  type RendererProps,
} from "@copilotkit/a2ui-renderer";
// Not the app's zod. `@copilotkit/a2ui-renderer` is built against zod 3 and
// keeps its own copy nested (Better Auth holds zod 4 at the root, see
// AGENTS.md), and the catalog reads these prop schemas with zod 3's internals
// — a zod 4 schema comes back out of them as `unknown`. `zod/v3` is zod 4's
// bundled zod 3 build, so it is the right runtime without a second install.
import { z } from "zod/v3";
import { TUTOR_CATALOG_ID } from "@/lib/progress-card";

/**
 * The renderer's own `Dynamic*Schema`s, retyped as this zod's `ZodTypeAny`.
 *
 * The two zod 3 copies agree at runtime — same version, same internals, and
 * `z.object()` here parses and reports on a schema from over there exactly as
 * it would on one of its own. Their *types*, though, are two declaration sites
 * of the same recursive generics, and asking `z.object()` to infer across them
 * exceeds TypeScript's instantiation depth. Nothing is lost by cutting it: the
 * inferred shape is not what the renderer reads (see `ProgressBarProps`).
 */
const bindable = (schema: unknown) => schema as z.ZodTypeAny;

/**
 * The component catalog the A2UI renderer draws the tutor's surfaces with:
 * CopilotKit's basic components, plus the one this app has to add.
 *
 * `DynamicNumberSchema` / `DynamicStringSchema` rather than `z.number()` /
 * `z.string()` is the load-bearing detail. A prop is bindable only if its
 * schema admits `{ path: "/…" }` alongside the plain value; declared as a bare
 * scalar, the unresolved path object reaches React as a child and the render
 * throws. These schemas are the card's contract — see lib/progress-card.ts for
 * the tree that binds against them.
 */
const definitions = {
  ProgressBar: {
    description:
      "A horizontal bar showing how much of something is complete, as a percentage.",
    props: z.object({
      value: bindable(DynamicNumberSchema).describe(
        "How much is complete, 0 to 100. Values outside that range are clamped.",
      ),
      label: bindable(DynamicStringSchema)
        .optional()
        .describe("A short caption under the bar, e.g. '43% done'."),
    }),
  },
};

/**
 * What the renderer is handed, which is not quite what the schema above
 * declares: the binder resolves every `{ path }` against the surface's data
 * model before a renderer runs, so these arrive as plain values. Typed as
 * `unknown` because "resolved" is a promise the renderer cannot check at
 * compile time — a surface built against a stale catalog delivers whatever it
 * likes, and the narrowing below is what keeps that from throwing in the chat.
 */
export type ProgressBarProps = { value: unknown; label?: unknown };

/**
 * The bar itself. Square, hairline-bordered, and filled with the graphite
 * button colour rather than the signal blue — blue in this system means "a
 * link", and a progress fill is not one (see the ai-tutor-design skill).
 *
 * `role="progressbar"` with the ARIA value attributes is what makes the figure
 * available to a screen reader, since the fill is pure geometry; the caption
 * repeats it in words for everyone else.
 */
export function ProgressBar({ props }: RendererProps<ProgressBarProps>) {
  const raw = typeof props.value === "number" ? props.value : 0;
  const percent = Math.min(100, Math.max(0, Math.round(raw)));
  const label = typeof props.label === "string" ? props.label : undefined;

  return (
    <div className="flex flex-col gap-1">
      <div
        aria-label={label ?? "Progress"}
        aria-valuemax={100}
        aria-valuemin={0}
        aria-valuenow={percent}
        className="h-2 w-full border border-edge bg-raised"
        role="progressbar"
      >
        <div className="h-full bg-button" style={{ width: `${percent}%` }} />
      </div>
      {label ? (
        <span className="text-sm text-ink-mute tabular-nums">{label}</span>
      ) : null}
    </div>
  );
}

/**
 * `includeBasicCatalog` merges Card, Column, Row, Text and the rest in, so the
 * card in lib/progress-card.ts composes its layout from them and reaches for
 * ProgressBar only where the basic catalog has nothing.
 *
 * The two casts are the same seam as `bindable` above. `CatalogDefinitions` is
 * typed against the renderer's own copy of zod, and `ZodObject` carries a
 * private field, so two copies are never assignable to each other however
 * identical their shapes — and the renderer map is typed off the definitions,
 * so it crosses the seam too. Nothing checked elsewhere is being widened: the
 * schemas above are the published contract, and `ProgressBarProps` is what the
 * renderer actually reads.
 */
export const tutorCatalog = createCatalog(
  definitions as unknown as CatalogDefinitions,
  { ProgressBar } as unknown as CatalogRenderers<CatalogDefinitions>,
  { catalogId: TUTOR_CATALOG_ID, includeBasicCatalog: true },
);
