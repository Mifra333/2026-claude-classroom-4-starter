import { assembleOps } from "@ag-ui/a2ui-toolkit";
import type { TodoProgress } from "@/lib/todo-tools";

/**
 * The progress card the `showProgress` tool paints into the chat, as A2UI v0.9
 * rather than as a React component written for that one tool.
 *
 * Two things are deliberate here and both are easy to undo by accident:
 *
 *   - The component tree below is authored **once**, as a constant. No model
 *     designs it, at request time or at any other time: the tool hands these
 *     operations straight back, so the card costs one database read and no
 *     second model call.
 *   - The figures are **not** in the tree. Every number reaches the card
 *     through the data model as a `{ path }` binding, which is what lets the
 *     same tree carry any tally. Writing a value into a component here would
 *     silently make the card a snapshot of whoever rendered it first.
 *
 * Plain module, no React and no `server-only`: the tool imports it on the
 * server, and a unit test imports it without a browser.
 */

/**
 * The catalog the card is drawn with — `components/a2ui-catalog.tsx` registers
 * the renderers under this same id, and `createSurface` names it so the
 * frontend picks that catalog rather than the bare basic one. The two must
 * agree; a mismatch renders as "Catalog not found".
 */
export const TUTOR_CATALOG_ID = "copilotkit://ai-tutor-catalog";

/** The surface the card occupies. One per rendered card, in its own message. */
export const PROGRESS_SURFACE_ID = "todo-progress";

/**
 * The card, in the v0.9 flat wire format: every component is a sibling in one
 * array and refers to its children by id.
 *
 *   Card
 *   └ Column
 *     ├ Text "Progress on the list"   — chrome, so it is a literal
 *     ├ ProgressBar                   — the custom component, bound to /doneShare
 *     └ Row
 *       ├ Text  bound to /doneText
 *       └ Text  bound to /openText
 *
 * `Card`, `Column`, `Row` and `Text` come from the basic catalog; `ProgressBar`
 * is the one component this app adds, because the basic catalog has none.
 */
const progressCardComponents = [
  { id: "root", component: "Card", child: "progress-body" },
  {
    id: "progress-body",
    component: "Column",
    children: ["progress-heading", "progress-bar", "progress-figures"],
  },
  {
    id: "progress-heading",
    component: "Text",
    text: "Progress on the list",
    variant: "h3",
  },
  {
    id: "progress-bar",
    component: "ProgressBar",
    value: { path: "/doneShare" },
    label: { path: "/shareText" },
  },
  {
    id: "progress-figures",
    component: "Row",
    justify: "spaceBetween",
    children: ["progress-done", "progress-open"],
  },
  {
    id: "progress-done",
    component: "Text",
    text: { path: "/doneText" },
    variant: "caption",
  },
  {
    id: "progress-open",
    component: "Text",
    text: { path: "/openText" },
    variant: "caption",
  },
];

/**
 * The data model the tree binds against. The counts and shares go in as the
 * numbers `todoProgressFor` computed; the three strings are the card's
 * phrasing of those same numbers, because `Text` takes a string and a bound
 * number would reach the renderer unrenderable.
 *
 * The phrasing holds at zero without a branch — "0 of 0 done" is true of an
 * empty list — so the tree above stays the only one.
 */
function progressCardData(progress: TodoProgress) {
  return {
    ...progress,
    shareText: `${progress.doneShare}% done`,
    doneText: `${progress.done} of ${progress.total} done`,
    openText: `${progress.open} open`,
  };
}

/**
 * The A2UI operations for one card: create the surface, set the tree, set the
 * data. `assembleOps` stamps each one with `version: "v0.9"`.
 *
 * The tool returns these under the `a2ui_operations` key, which is what the
 * A2UI middleware looks for in a tool result before turning it into a surface.
 */
export function progressCardOperations(progress: TodoProgress) {
  return assembleOps({
    intent: "create",
    surfaceId: PROGRESS_SURFACE_ID,
    catalogId: TUTOR_CATALOG_ID,
    components: progressCardComponents,
    data: progressCardData(progress),
  });
}
