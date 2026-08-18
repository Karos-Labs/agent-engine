import { describe, expect, it } from "vitest";
import * as path from "node:path";
import { assembleJob, planToCutaways, planToOverlays, resolveRunPaths } from "../src/workflow/job-builder.js";
import type { GraphicsPlanOutput } from "../src/workflow/types.js";

const workDir = path.join("/tmp", "run-1");

describe("resolveRunPaths", () => {
  it("derives every intermediate path as absolute, under the given work directory", () => {
    const paths = resolveRunPaths(workDir);
    expect(paths.profilePath).toBe(path.join(workDir, "brand-profile.json"));
    expect(paths.transcriptPath).toBe(path.join(workDir, "transcript.json"));
    expect(paths.jobPath).toBe(path.join(workDir, "job.json"));
    expect(paths.outputPath).toBe(path.join(workDir, "edit", "final.mp4"));
  });
});

describe("planToOverlays / planToCutaways", () => {
  const plan: GraphicsPlanOutput = {
    overlays: [{ archetype: "Growth Chart", start: 1.0, end: 3.0, illustrates: "revenue tripled" }],
    cutaways: [
      { kind: "burst", start: 4.0, end: 5.2, wordSrcStart: 3.9, phrase: "the launch event", stillCount: 4 },
      { kind: "plate", start: 6.0, end: 7.0, wordSrcStart: 5.9, phrase: "the product shot" },
    ],
  };

  it("matches make_motion_repertoire.template.py's documented convention (overlays/anim-<name>/%04d.png) so graphic_qa.py finds real frames", () => {
    const overlays = planToOverlays(plan, workDir);
    expect(overlays).toEqual([{ file: path.join(workDir, "edit", "overlays", "anim-growth_chart-0", "0000.png"), start: 1.0, end: 3.0 }]);
  });

  it("disambiguates two overlays sharing the same archetype with distinct directories", () => {
    const twoOfSame: GraphicsPlanOutput = {
      overlays: [
        { archetype: "Growth Chart", start: 1.0, end: 3.0, illustrates: "revenue tripled" },
        { archetype: "Growth Chart", start: 8.0, end: 10.0, illustrates: "then tripled again" },
      ],
      cutaways: [],
    };
    const overlays = planToOverlays(twoOfSame, workDir);
    expect(overlays[0]!.file).toBe(path.join(workDir, "edit", "overlays", "anim-growth_chart-0", "0000.png"));
    expect(overlays[1]!.file).toBe(path.join(workDir, "edit", "overlays", "anim-growth_chart-1", "0000.png"));
  });

  it("expands a burst into `stillCount` still paths and a plate into a single `file`", () => {
    const cutaways = planToCutaways(plan, workDir);
    expect(cutaways[0]).toEqual({
      stills: [0, 1, 2, 3].map((s) => path.join(workDir, "edit", "burst", `0_${s}.png`)),
      start: 4.0,
      end: 5.2,
      word_src_start: 3.9,
      phrase: "the launch event",
    });
    expect(cutaways[1]).toEqual({
      file: path.join(workDir, "edit", "cutaway", "1", "plate.png"),
      start: 6.0,
      end: 7.0,
      word_src_start: 5.9,
      phrase: "the product shot",
    });
  });
});

describe("assembleJob", () => {
  it("produces build_short.py's job spec shape with every path absolute", () => {
    const paths = resolveRunPaths(workDir);
    const job = assembleJob({
      paths,
      sourceVideoPath: "/videos/clip.mov",
      grade: "auto",
      segments: [[0, 10]],
      contentCuts: [],
      highlightStarts: [2.5],
      plan: { overlays: [], cutaways: [] },
    });

    expect(job.source).toBe("/videos/clip.mov");
    expect(job.transcript).toBe(paths.transcriptPath);
    expect(job.output).toBe(paths.outputPath);
    expect(job.edit_dir).toBe(path.join(workDir, "edit"));
    expect(job.grade).toBe("auto");
    expect(job.segments).toEqual([[0, 10]]);
    expect(job.highlight_starts).toEqual([2.5]);
    expect(job.overlays).toEqual([]);
    expect(job.cutaways).toEqual([]);
  });

  it("carries declared content cuts straight through to the job's content_cuts field", () => {
    const paths = resolveRunPaths(workDir);
    const job = assembleJob({
      paths,
      sourceVideoPath: "/videos/clip.mov",
      grade: "auto",
      segments: [[0, 1.9], [4.1, 10]],
      contentCuts: [{ span: [1.9, 4.1], reason: "client asked to remove this line" }],
      highlightStarts: [],
      plan: { overlays: [], cutaways: [] },
    });
    expect(job.content_cuts).toEqual([{ span: [1.9, 4.1], reason: "client asked to remove this line" }]);
  });
});
