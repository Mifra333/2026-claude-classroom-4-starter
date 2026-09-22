// jsdom, the config default — this one renders, unlike the node-env tests.
import { getCustomComponentNames } from "@copilotkit/a2ui-renderer";
import { render, screen } from "@testing-library/react";
import { describe, expect, test } from "vitest";
import { ProgressBar, tutorCatalog } from "@/components/a2ui-catalog";
import { TUTOR_CATALOG_ID } from "@/lib/progress-card";

/**
 * The renderer is called with the props already resolved off the data model,
 * so a test hands it plain values. `children` here is not React's — it is the
 * catalog's child-builder, which ProgressBar never calls because it draws no
 * children of its own.
 */
const bar = (props: { value: unknown; label?: unknown }) =>
  render(<ProgressBar props={props}>{() => null}</ProgressBar>);

describe("ProgressBar", () => {
  test("reports the figure to assistive tech, not only as a width", () => {
    bar({ value: 38, label: "38% done" });

    const progressbar = screen.getByRole("progressbar");
    expect(progressbar).toHaveAttribute("aria-valuenow", "38");
    expect(progressbar).toHaveAttribute("aria-valuemin", "0");
    expect(progressbar).toHaveAttribute("aria-valuemax", "100");
    expect(progressbar).toHaveAccessibleName("38% done");
  });

  test("fills to the share, so the bar and the caption agree", () => {
    const { container } = bar({ value: 38, label: "38% done" });

    expect(
      container.querySelector<HTMLElement>(".bg-button")?.style.width,
    ).toBe("38%");
    expect(screen.getByText("38% done")).toBeInTheDocument();
  });

  test("reads as empty at zero and as full at a hundred", () => {
    const { container: empty } = bar({ value: 0 });
    expect(empty.querySelector<HTMLElement>(".bg-button")?.style.width).toBe(
      "0%",
    );

    const { container: full } = bar({ value: 100 });
    expect(full.querySelector<HTMLElement>(".bg-button")?.style.width).toBe(
      "100%",
    );
  });

  test("clamps and rounds, so no arithmetic can overdraw the track", () => {
    expect(bar({ value: 137 }).container.textContent).toBe("");
    expect(screen.getAllByRole("progressbar")[0]).toHaveAttribute(
      "aria-valuenow",
      "100",
    );

    bar({ value: -5 });
    expect(screen.getAllByRole("progressbar")[1]).toHaveAttribute(
      "aria-valuenow",
      "0",
    );

    bar({ value: 37.5 });
    expect(screen.getAllByRole("progressbar")[2]).toHaveAttribute(
      "aria-valuenow",
      "38",
    );
  });

  test("still draws when a binding did not resolve to a number", () => {
    // What an unresolved `{ path: … }` would look like arriving at the
    // renderer: the bar stays drawable rather than throwing inside the chat.
    bar({ value: { path: "/doneShare" }, label: { path: "/shareText" } });

    expect(screen.getByRole("progressbar")).toHaveAttribute(
      "aria-valuenow",
      "0",
    );
    expect(screen.getByRole("progressbar")).toHaveAccessibleName("Progress");
  });

  test("the caption is optional", () => {
    const { container } = bar({ value: 50 });

    expect(container.textContent).toBe("");
    expect(screen.getByRole("progressbar")).toHaveAccessibleName("Progress");
  });
});

describe("the tutor catalog", () => {
  test("adds ProgressBar beside the basic components, under the card's id", () => {
    expect(getCustomComponentNames(tutorCatalog)).toEqual(["ProgressBar"]);

    // Every component lib/progress-card.ts composes the card from has to be
    // here, or the surface renders as "Component not found".
    for (const name of ["Card", "Column", "Row", "Text", "ProgressBar"]) {
      expect(tutorCatalog.components.has(name)).toBe(true);
    }

    expect(tutorCatalog.id).toBe(TUTOR_CATALOG_ID);
  });
});
