import { describe, expect, it } from "vitest";
import { createColorGrade } from "../src/tools/color-grade.js";
import { ctx } from "./test-helpers.js";

const baseProfile = { color: { background: "#141414", foreground: "#F5F0E8", accent: "#FF6B2C" } };

describe("video.colorGrade", () => {
  it("defaults to auto when the profile has no locked grade — zero judgment, no subprocess involved", async () => {
    const tool = createColorGrade();
    const outcome = await tool.execute({ profile: baseProfile }, { ctx });
    expect(outcome).toEqual({ status: "success", result: { grade: "auto", source: "auto" } });
  });

  it("uses the profile's locked override when present, changing a grade needs the client's explicit sign-off (PLAYBOOK §4b)", async () => {
    const tool = createColorGrade();
    const outcome = await tool.execute({ profile: { ...baseProfile, video_grade: "eq=contrast=1.06:saturation=0.92" } }, { ctx });
    expect(outcome).toEqual({ status: "success", result: { grade: "eq=contrast=1.06:saturation=0.92", source: "profile_locked" } });
  });

  it("rejects a profile missing required palette keys before it ever reaches the render step", async () => {
    const tool = createColorGrade();
    // Deliberately malformed input, exercising the tool's own runtime schema validation.
    const outcome = await tool.execute({ profile: { color: { background: "#141414" } } } as unknown as Parameters<typeof tool.execute>[0], { ctx });
    expect(outcome.status).toBe("tooling_error");
  });
});
