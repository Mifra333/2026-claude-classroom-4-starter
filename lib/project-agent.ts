import { Agent } from "@mastra/core/agent";
import { Mastra } from "@mastra/core/mastra";
import { RequestContext } from "@mastra/core/request-context";
import { createTool } from "@mastra/core/tools";
import { z } from "zod";
import {
  applyProjectPatch,
  describeChanges,
  emptyProject,
  type Project,
  projectPatchSchema,
} from "@/lib/project";
import {
  PROJECT_STATE_DESCRIPTION,
  projectCardOperations,
  projectFromCardData,
} from "@/lib/project-card";

/**
 * The agent behind the project wizard: one tool, no memory, one turn.
 *
 * It is a second agent rather than a second duty for Bartholomew because the
 * two want opposite things. The tutor keeps a thread and a reasoning model;
 * this one is asked to do arithmetic and then put the answer in a tool call,
 * and a reasoning model works the dates out in its reasoning and then leaves
 * them out of the call. Hence its own model below, and hence instructions
 * whose first claim is that the tool call is the whole answer.
 */

/** Registry key of the wizard agent, and the CopilotKit `agentId` on the page. */
export const PROJECT_AGENT_ID = "project";

/**
 * The one key the agent reads out of Mastra's `RequestContext`. The date has
 * to come from somewhere outside the model — it has no clock, and a browser's
 * is its own — so the route sets it from the server's (see
 * app/api/copilotkit/[...all]/route.ts). Declared as a schema so a run without
 * one fails rather than planning against an imaginary today.
 */
const requestContextSchema = z.object({ today: z.string().min(1) });

/** Builds a context the agent accepts; the route and the tests share it. */
export function projectRequestContext(today: string) {
  const requestContext = new RequestContext();
  requestContext.set("today", today);
  return requestContext;
}

/**
 * The state of the wizard, read off the run's own context.
 *
 * This is how turns build on each other without the agent remembering
 * anything: the page sends the card's data model with every run, the AG-UI
 * bridge puts the run's context entries on the `RequestContext` under
 * "ag-ui", and the tool finds its own entry there by description. Manual edits
 * are included, because the model the page sends is the live one the inputs
 * write into.
 *
 * `undefined` means no card has been drawn yet — nothing to build on, and the
 * surface has to be created rather than updated.
 */
function projectOnTheCard(requestContext: RequestContext): Project | undefined {
  const forwarded = requestContext.get("ag-ui") as
    | { context?: Array<{ description?: string; value?: string }> }
    | undefined;
  const entry = forwarded?.context?.find(
    (item) => item.description === PROJECT_STATE_DESCRIPTION,
  );
  if (!entry?.value) {
    return undefined;
  }

  try {
    return projectFromCardData(JSON.parse(entry.value));
  } catch {
    // Not JSON at all. Treated as no card rather than as a failed run: the
    // worst of it is that the user's next instruction starts a fresh one.
    return undefined;
  }
}

/**
 * The one tool. It takes a patch, applies the wizard's own rules to whatever
 * is on the card, and hands back the card those rules produced — so the model
 * never decides what is valid, and never draws anything.
 *
 * What it does not do is repaint. The first call creates the surface; every
 * call after it sends the data model alone, so the card is amended in place.
 */
export function createProjectTools() {
  const setProject = createTool({
    id: "setProject",
    description:
      "Set the fields of the project card the user is looking at. Send only the fields the instruction settles. Calling this is the whole answer; the user reads the card, not a reply.",
    inputSchema: projectPatchSchema,
    // An A2UI operation is an open envelope by design, so the shape is checked
    // where it matters (lib/project-card.ts and its test) rather than here.
    outputSchema: z.object({
      a2ui_operations: z.array(z.record(z.string(), z.unknown())),
      status: z.string(),
    }),
    execute: async (patch, { requestContext }) => {
      const current = projectOnTheCard(requestContext);
      const before = current ?? emptyProject;
      const { project, errors } = applyProjectPatch(before, patch);

      return {
        // A card to build on is a card to amend. Without one there is nothing
        // on screen yet, so this run is the one that draws it.
        a2ui_operations: projectCardOperations(
          project,
          errors,
          current ? "update" : "create",
        ),
        // What landed. What did not is in the card, beside the field it was
        // refused for, which is the only place it means anything.
        status: describeChanges(before, project),
      };
    },
  });

  return { setProject };
}

/**
 * Written against a date the caller supplies rather than a fixed string,
 * because half of what this agent does is arithmetic on today.
 */
function projectInstructions(today: string) {
  return `You turn one instruction about a project into exactly one call to setProject.

Today is ${today}.

The tool call is the whole answer. Do not reply in prose, do not explain how you
arrived at anything, and do not ask a question first. The user is looking at a card
that is drawn from the arguments you send; a sentence beside it reaches nobody. Work
every figure out inside the arguments, not before them.

The card the user is looking at is given to you as JSON whenever there is one. Read it:
an instruction builds on what is already there ("push it a week later", "make that high
priority"), so work from those values. Send only the fields the instruction changes —
a field you leave out keeps what the card already holds.

The fields, all optional — send the ones the instruction settles and leave the rest out:
- title: a short name for the project.
- description: one or two sentences on what it delivers.
- startDate and endDate: ISO calendar dates, such as 2026-04-13. Resolve relative
  wording ("next Monday", "in three weeks", "by the end of the quarter") against
  today's date above. Work is counted in working days, so a run of whole weeks ends
  on the Friday of the last one.
- effortPersonDays: total effort in person-days, counting every person on the team.
  One person full time is 5 person-days a week; multiply by the people and the weeks.
- criticality: low, medium or high.

Worked example. If today were 2026-04-08, a Wednesday, and the instruction were
"relaunch the website, starts next Monday, three weeks, two people full-time", the
whole answer would be:

  setProject({
    "title": "Website relaunch",
    "description": "Relaunch of the public website.",
    "startDate": "2026-04-13",
    "endDate": "2026-05-01",
    "effortPersonDays": 30
  })

The Monday after Wednesday 8 April is 13 April. Three weeks of work from that Monday
end on Friday 1 May. Two people for three weeks is 2 x 3 x 5 = 30 person-days.
Criticality is absent because the instruction did not settle it.`;
}

const projectAgent = new Agent({
  id: PROJECT_AGENT_ID,
  name: "Project planner",
  // Resolved per run, so the date is the server's at the moment of the run and
  // not the one this module happened to be evaluated on.
  instructions: ({ requestContext }) =>
    projectInstructions(
      requestContextSchema.parse({ today: requestContext.get("today") }).today,
    ),
  model: {
    // Not the tutor's model, and the difference is the point. See the note at
    // the top of this file. Same OPENROUTER_BASE_URL proxy escape as lib/tutor.ts.
    id: "openrouter/google/gemini-3.1-flash-lite",
    ...(process.env.OPENROUTER_BASE_URL && {
      url: process.env.OPENROUTER_BASE_URL,
      apiKey: process.env.OPENROUTER_API_KEY,
    }),
  },
  // No `memory`, so nothing of a run survives it, and no store to keep it in.
  tools: createProjectTools(),
});

/**
 * Its own Mastra instance, with no storage at all: there is no thread to
 * persist, and sharing the tutor's would hand this agent a durable store it
 * has no use for. Nothing here holds a connection, so unlike lib/tutor.ts
 * there is nothing to cache across a hot reload.
 */
export const projectMastra = new Mastra({
  agents: { [PROJECT_AGENT_ID]: projectAgent },
});
