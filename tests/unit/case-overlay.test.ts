import {
  CASE_PROJECTS,
  encodeCaseImagePath,
} from "../../src/browser/case-overlay";
import { describe, expect, it } from "vitest";

describe("case overlay manifest", () => {
  it("encodes Unicode and reserved characters per path segment", () => {
    expect(encodeCaseImagePath("Проекты/пчелы/05 1#.png")).toBe(
      "%D0%9F%D1%80%D0%BE%D0%B5%D0%BA%D1%82%D1%8B/%D0%BF%D1%87%D0%B5%D0%BB%D1%8B/05%201%23.png",
    );
  });

  it("retains the complete project manifest used by the page", () => {
    expect(Object.keys(CASE_PROJECTS)).toEqual(["fridj", "beehive", "unno", "restfood"]);
    expect(CASE_PROJECTS.fridj.images).toHaveLength(17);
    expect(CASE_PROJECTS.beehive.images).toHaveLength(18);
    expect(CASE_PROJECTS.unno.images).toHaveLength(3);
    expect(CASE_PROJECTS.restfood.images).toHaveLength(7);
  });
});
