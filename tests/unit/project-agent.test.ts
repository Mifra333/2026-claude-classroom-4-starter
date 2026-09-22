// @vitest-environment node
import { validateA2UIComponents } from "@ag-ui/a2ui-toolkit";
import { RequestContext } from "@mastra/core/request-context";
import { describe, expect, test } from "vitest";
import { TUTOR_CATALOG_ID } from "@/lib/progress-card";
import type { ProjectPatch } from "@/lib/project";
import { createProjectTools } from "@/lib/project-agent";
import {
  PROJECT_STATE_DESCRIPTION,
  PROJECT_SURFACE_ID,
} from "@/lib/project-card";

// No database and no model: the tool is pure, which is the point of it. It
// takes what the model worked out, applies lib/project.ts's rules to whatever
// the page says is on the card, and returns the operations that follow.
const tools = createProjectTools();

type Operation = Record<string, unknown>;

type SetProjectResult = {
  a2ui_operations: Operation[];
  status: string;
};

/**
 * One run. `card` is the data model the page sends up, exactly as the AG-UI
 * bridge leaves it on the RequestContext; leaving it out is the first run,
 * when there is no card yet.
 *
 * `createTool` types `execute` as optional and expects the rest of the
 * execution context the runtime fills in, so one cast keeps the assertions
 * below plain while still running the real executor.
 */
const setProject = (patch: ProjectPatch, card?: unknown) => {
  const requestContext = new RequestContext();
  requestContext.set("today", "2026-04-08");
  if (card !== undefined) {
    requestContext.set("ag-ui", {
      context: [
        { description: PROJECT_STATE_DESCRIPTION, value: JSON.stringify(card) },
      ],
    });
  }

  return tools.setProject.execute?.(patch, {
    requestContext,
  } as never) as Promise<SetProjectResult>;
};

/** The payload of the one operation carrying `key`, whichever position it is in. */
const payloadOf = <T>(operations: Operation[], key: string) =>
  operations.find((operation) => operation[key])?.[key] as T;

const componentsOf = (operations: Operation[]) =>
  payloadOf<{ surfaceId: string; components: Operation[] }>(
    operations,
    "updateComponents",
  );

/** Also what the page would send back on the next run, which is the point. */
const dataOf = (operations: Operation[]) =>
  payloadOf<{ value: Record<string, unknown> }>(operations, "updateDataModel")
    .value;

/** The worked example in the agent's own instructions. */
const websiteRelaunch: ProjectPatch = {
  title: "Website relaunch",
  description: "Relaunch of the public website.",
  startDate: "2026-04-13",
  endDate: "2026-05-01",
  effortPersonDays: 30,
};

const noErrors = { startDate: "", endDate: "", effortPersonDays: "" };

describe("the setProject tool", () => {
  test("creates the surface on the first call", async () => {
    const { a2ui_operations: operations } = await setProject(websiteRelaunch);

    expect(operations.map((operation) => Object.keys(operation))).toEqual([
      ["version", "createSurface"],
      ["version", "updateComponents"],
      ["version", "updateDataModel"],
    ]);
    for (const operation of operations) {
      expect(operation.version).toBe("v0.9");
    }

    expect(payloadOf(operations, "createSurface")).toEqual({
      surfaceId: PROJECT_SURFACE_ID,
      // The client renders this surface itself, and its catalog is registered
      // under this id; a mismatch renders as "Catalog not found".
      catalogId: TUTOR_CATALOG_ID,
    });
    expect(componentsOf(operations).surfaceId).toBe(PROJECT_SURFACE_ID);
  });

  test("only updates the data model once a card exists", async () => {
    const first = await setProject(websiteRelaunch);
    const { a2ui_operations: operations } = await setProject(
      { criticality: "high" },
      dataOf(first.a2ui_operations),
    );

    // One operation, and it is the data. No second `createSurface` (invalid on
    // an id that exists) and no `updateComponents`, so the card is amended in
    // place rather than repainted.
    expect(operations).toHaveLength(1);
    expect(Object.keys(operations[0])).toEqual(["version", "updateDataModel"]);
    expect(operations[0].version).toBe("v0.9");
    expect(
      payloadOf<{ surfaceId: string }>(operations, "updateDataModel").surfaceId,
    ).toBe(PROJECT_SURFACE_ID);
  });

  test("a later turn builds on the card instead of starting again", async () => {
    const first = await setProject(websiteRelaunch);
    const second = await setProject(
      { criticality: "high" },
      dataOf(first.a2ui_operations),
    );

    expect(dataOf(second.a2ui_operations)).toEqual({
      ...dataOf(first.a2ui_operations),
      criticalityChoice: ["high"],
    });
    expect(second.status).toBe("Set criticality to high.");
  });

  test("an edit made by hand in the card survives the next run", async () => {
    const first = await setProject(websiteRelaunch);

    // What the inputs write back: the effort field and the choice picker bind
    // to their own paths, and these are the values the tool reads back.
    const edited = {
      ...dataOf(first.a2ui_operations),
      title: "Website relaunch, phase two",
      effort: "42",
      criticalityChoice: ["low"],
    };

    const { a2ui_operations: operations } = await setProject(
      { description: "Now with a shop." },
      edited,
    );

    expect(dataOf(operations)).toMatchObject({
      title: "Website relaunch, phase two",
      description: "Now with a shop.",
      effort: "42",
      criticalityChoice: ["low"],
    });
  });

  test("the tree is valid A2UI, and every field of it is an input", async () => {
    const { a2ui_operations: operations } = await setProject(websiteRelaunch);
    const { components } = componentsOf(operations);

    expect(
      validateA2UIComponents({ components, data: dataOf(operations) }),
    ).toEqual({ valid: true, errors: [] });

    expect(components[0]).toMatchObject({ id: "root", component: "Column" });
    expect(new Set(components.map((component) => component.component))).toEqual(
      new Set([
        "Column",
        "Row",
        "TextField",
        "DateTimeInput",
        "ChoicePicker",
        // The error slots, which are in the tree from the first paint.
        "Text",
      ]),
    );
  });

  test("the tree is authored once — only the data model moves", async () => {
    const one = await setProject(websiteRelaunch);
    const other = await setProject({ title: "Something else entirely" });

    expect(componentsOf(other.a2ui_operations)).toEqual(
      componentsOf(one.a2ui_operations),
    );
    expect(dataOf(other.a2ui_operations)).not.toEqual(
      dataOf(one.a2ui_operations),
    );

    // Every field the tree shows, and every error it can show, is bound rather
    // than written into it.
    const bindings = JSON.stringify(componentsOf(one.a2ui_operations))
      .match(/"path":"[^"]+"/g)
      ?.map((binding) => binding.slice(8, -1));
    expect(bindings?.sort()).toEqual([
      "/criticalityChoice",
      "/description",
      "/effort",
      "/endDate",
      "/errors/effortPersonDays",
      "/errors/endDate",
      "/errors/startDate",
      "/startDate",
      "/title",
    ]);
  });

  test("the dates and the effort arrive as the model sent them", async () => {
    const { a2ui_operations: operations } = await setProject(websiteRelaunch);

    expect(dataOf(operations)).toEqual({
      title: "Website relaunch",
      description: "Relaunch of the public website.",
      startDate: "2026-04-13",
      endDate: "2026-05-01",
      // The two the basic catalog's inputs need in a shape of their own.
      effort: "30",
      criticalityChoice: ["medium"],
      errors: noErrors,
    });
  });

  test("a refused date comes back as an error beside its own field", async () => {
    const first = await setProject({ startDate: "2026-05-01" });
    const { a2ui_operations: operations, status } = await setProject(
      { endDate: "2026-04-13" },
      dataOf(first.a2ui_operations),
    );

    expect(dataOf(operations)).toMatchObject({
      startDate: "2026-05-01",
      endDate: "",
      errors: {
        ...noErrors,
        endDate: "The end date is before the start date.",
      },
    });
    // The error is in the card, next to the field it was refused for. The
    // status line says what the run did land, and nothing else.
    expect(status).toBe("Nothing changed.");
  });

  test("a refused effort does the same", async () => {
    const { a2ui_operations: operations, status } = await setProject({
      title: "Website relaunch",
      effortPersonDays: 0,
    });

    expect(dataOf(operations)).toMatchObject({
      effort: "",
      errors: {
        ...noErrors,
        effortPersonDays: "Effort has to be more than zero person-days.",
      },
    });
    expect(status).toBe('Set title to "Website relaunch".');
  });

  test("the status line says what the run set", async () => {
    const { status } = await setProject({
      title: "Website relaunch",
      effortPersonDays: 30,
      criticality: "high",
    });

    expect(status).toBe(
      'Set title to "Website relaunch", effort to 30 person-days and criticality to high.',
    );
  });

  test("a card that did not survive the trip is treated as no card", async () => {
    // Anything but the shape lib/project-card.ts sends: the run draws a fresh
    // surface rather than failing.
    const { a2ui_operations: operations } = await setProject(
      { title: "Website relaunch" },
      { nonsense: true },
    );

    expect(payloadOf(operations, "createSurface")).toBeDefined();
    expect(dataOf(operations)).toMatchObject({ title: "Website relaunch" });
  });

  test("an empty patch leaves the card alone and says so", async () => {
    const { a2ui_operations: operations, status } = await setProject({});

    expect(dataOf(operations)).toMatchObject({ title: "", effort: "" });
    expect(status).toBe("Nothing changed.");
  });
});
