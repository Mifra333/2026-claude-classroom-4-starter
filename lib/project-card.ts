import { assembleOps, updateDataModel } from "@ag-ui/a2ui-toolkit";
import { z } from "zod";
import { TUTOR_CATALOG_ID } from "@/lib/progress-card";
import {
  applyProjectPatch,
  criticalities,
  emptyProject,
  type Project,
  type ProjectErrors,
} from "@/lib/project";

/**
 * The project card the wizard's `setProject` tool paints, as A2UI v0.9. Same
 * bargain as lib/progress-card.ts and for the same two reasons: the tree below
 * is authored once as a constant, so no model designs it and a card costs no
 * second model call, and no value appears in it — every field reaches the card
 * through the data model as a `{ path }` binding.
 *
 * What is different here is that the fields are inputs, and the bindings run
 * both ways: typing in one writes back into this surface's data model. That
 * makes the data model the state of the wizard, and the only copy of it. The
 * agent has no memory, so the page sends this model back with every run (see
 * `PROJECT_STATE_DESCRIPTION`) and the tool patches what it receives.
 *
 * Plain module, no React and no `server-only`: the tool imports it on the
 * server, and a unit test imports it without a browser.
 */

/** The surface the card occupies. One card, amended, never a second one. */
export const PROJECT_SURFACE_ID = "project-card";

/**
 * How the page's copy of the data model is labelled on its way to the agent,
 * and how the tool finds it again among the run's context entries. The text is
 * read by the model too, so it says what the value is for.
 */
export const PROJECT_STATE_DESCRIPTION =
  "The project card the user is looking at, as JSON. Patch what the instruction changes; everything else is already on the card and stays.";

/**
 * The card, in the v0.9 flat wire format.
 *
 *   Column
 *   ├ TextField       Title                 ← /title
 *   ├ TextField       Description           ← /description
 *   ├ Row
 *   │ ├ Column [ DateTimeInput Start date   ← /startDate
 *   │ │          Text                       ← /errors/startDate ]
 *   │ └ Column [ DateTimeInput End date     ← /endDate
 *   │            Text                       ← /errors/endDate ]
 *   ├ Column [ TextField Effort             ← /effort
 *   │          Text                         ← /errors/effortPersonDays ]
 *   └ ChoicePicker    Criticality           ← /criticalityChoice
 *
 * A `Column` and not a `Card` at the root: this surface is drawn into a panel
 * the page already owns, so a second frame around it would be chrome twice.
 * Every component here comes from the basic catalog.
 *
 * The three `Text`s are the error slots. They are in the tree from the first
 * paint and bound to a path that is "" when the field is fine, because the
 * tree never changes after that — only the data model does — so a slot that
 * appeared with the error would be a repaint.
 *
 * Only three, because `applyProjectPatch` can only refuse those three: a title
 * and a description are whatever the user says they are, and the criticality
 * comes off an enum.
 */
const projectCardComponents = [
  {
    id: "root",
    component: "Column",
    align: "stretch",
    children: [
      "project-title",
      "project-description",
      "project-dates",
      "project-effort-field",
      "project-criticality",
    ],
  },
  {
    id: "project-title",
    component: "TextField",
    label: "Title",
    value: { path: "/title" },
    variant: "shortText",
  },
  {
    id: "project-description",
    component: "TextField",
    label: "Description",
    value: { path: "/description" },
    variant: "longText",
  },
  {
    id: "project-dates",
    component: "Row",
    justify: "spaceBetween",
    children: ["project-start-field", "project-end-field"],
  },
  {
    id: "project-start-field",
    component: "Column",
    align: "stretch",
    children: ["project-start", "project-start-error"],
  },
  {
    id: "project-start",
    component: "DateTimeInput",
    label: "Start date",
    value: { path: "/startDate" },
    enableDate: true,
  },
  {
    id: "project-start-error",
    component: "Text",
    text: { path: "/errors/startDate" },
    variant: "caption",
  },
  {
    id: "project-end-field",
    component: "Column",
    align: "stretch",
    children: ["project-end", "project-end-error"],
  },
  {
    id: "project-end",
    component: "DateTimeInput",
    label: "End date",
    value: { path: "/endDate" },
    enableDate: true,
  },
  {
    id: "project-end-error",
    component: "Text",
    text: { path: "/errors/endDate" },
    variant: "caption",
  },
  {
    id: "project-effort-field",
    component: "Column",
    align: "stretch",
    children: ["project-effort", "project-effort-error"],
  },
  {
    id: "project-effort",
    component: "TextField",
    label: "Effort in person-days",
    value: { path: "/effort" },
    variant: "number",
  },
  {
    id: "project-effort-error",
    component: "Text",
    text: { path: "/errors/effortPersonDays" },
    variant: "caption",
  },
  {
    id: "project-criticality",
    component: "ChoicePicker",
    label: "Criticality",
    value: { path: "/criticalityChoice" },
    variant: "mutuallyExclusive",
    displayStyle: "chips",
    options: [
      { label: "Low", value: "low" },
      { label: "Medium", value: "medium" },
      { label: "High", value: "high" },
    ],
  },
];

/**
 * The data model the tree binds against, and nothing besides. Every key here
 * is a path some component reads, which is what lets the page hand the model
 * straight back as the state of the card.
 *
 * The effort and the criticality are not the project's own fields: `TextField`
 * takes a string, so an unset effort reads empty rather than "0", and
 * `ChoicePicker` binds to the list of selected values. They are the fields a
 * manual edit writes to, so they are the ones `projectFromCardData` reads back
 * — keeping `effortPersonDays` in here too would be a second copy that a
 * manual edit leaves stale.
 */
function projectCardData(project: Project, errors: ProjectErrors) {
  return {
    title: project.title,
    description: project.description,
    startDate: project.startDate,
    endDate: project.endDate,
    effort:
      project.effortPersonDays > 0 ? String(project.effortPersonDays) : "",
    criticalityChoice: [project.criticality],
    // "" rather than absent: the slots are bound, and a missing path would
    // leave the previous run's message standing.
    errors: {
      startDate: errors.startDate ?? "",
      endDate: errors.endDate ?? "",
      effortPersonDays: errors.effortPersonDays ?? "",
    },
  };
}

/** What the page sends back, which is whatever the card holds by then. */
const cardDataSchema = z.object({
  title: z.string(),
  description: z.string(),
  startDate: z.string(),
  endDate: z.string(),
  effort: z.string(),
  criticalityChoice: z.array(z.string()),
});

/**
 * The project the card is showing, read back out of its data model.
 *
 * Nothing here is trusted: the model has been through the browser and through
 * whatever the user typed into the inputs. Rather than re-implement the rules
 * for that, the fields go back through `applyProjectPatch` as a patch onto an
 * empty project, so a manually typed date that is not a date is dropped by the
 * same code that would have dropped it coming from the model.
 *
 * `undefined` means there is no card yet, which is what tells the tool to
 * create the surface rather than update it.
 */
export function projectFromCardData(data: unknown): Project | undefined {
  const parsed = cardDataSchema.safeParse(data);
  if (!parsed.success) {
    return undefined;
  }

  const { effort, criticalityChoice, ...fields } = parsed.data;
  return applyProjectPatch(emptyProject, {
    ...fields,
    // Absent rather than 0 or NaN when the field is empty: a patch that leaves
    // it out keeps the empty project's own value instead of failing a rule.
    ...(effort.trim() !== "" && { effortPersonDays: Number(effort) }),
    ...(criticalities.find((value) => value === criticalityChoice[0]) && {
      criticality: criticalityChoice[0] as Project["criticality"],
    }),
  }).project;
}

/**
 * The A2UI operations for the card, as one of two very different things.
 *
 * `create` is the first run: the surface, the tree, then the data. `update` is
 * every run after it, and is one `updateDataModel` — not `assembleOps`'s own
 * "update" intent, which still sends the components and would repaint a tree
 * that has not changed. The card is amended in place, and a value the user
 * typed into a field this run did not touch stays where it is.
 *
 * The tool returns these under the `a2ui_operations` key. Nothing on the
 * server reads it — the wizard agent runs without the A2UI middleware — but
 * the key is the protocol's, and components/project-wizard.tsx looks for it.
 */
export function projectCardOperations(
  project: Project,
  errors: ProjectErrors,
  intent: "create" | "update",
) {
  const data = projectCardData(project, errors);

  if (intent === "update") {
    return [updateDataModel(PROJECT_SURFACE_ID, data)];
  }

  return assembleOps({
    intent: "create",
    surfaceId: PROJECT_SURFACE_ID,
    catalogId: TUTOR_CATALOG_ID,
    components: projectCardComponents,
    data,
  });
}
