import { describe, expect, test } from "vitest";
import { DEMO_FILES } from "../../../src/demo";
import { renderAblFilesToPng } from "../render";

describe("asbuilt render adapter", () => {
  test("renders demo project to PNG", () => {
    const { png, branch, svg } = renderAblFilesToPng(DEMO_FILES, {
      branch: "asbuilt",
      ppi: 3,
    });
    expect(branch).toBe("asbuilt");
    expect(svg).toContain("<svg");
    expect(png.length).toBeGreaterThan(1000);
    expect(png[0]).toBe(0x89); // PNG magic
  });
});
