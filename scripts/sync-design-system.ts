/**
 * Sync the Instagram slide design system into all eight plates.
 *
 * WHY THIS EXISTS. The scale, the ground, the brand-mark zone and the fit
 * ladder used to be declared independently inside each of the eight templates.
 * Five different authors edited "a template", nothing held them together, and
 * the set drifted until one carousel rendered 22-28 distinct type sizes against
 * a six-step scale and three accent colours at eleven widths — which is what the
 * owner read as machine-made. There was no single place where "one accent" or
 * "one scale" could be made true, so no amount of patching could make it true.
 *
 * Now there is. `_design-system.css` and `_ds-fit.js` are the source; this
 * script writes them into the region each template marks off, and
 * `__tests__/design-system-sync.test.ts` fails if a plate's copy has drifted.
 * Edit the source, run `npx tsx scripts/sync-design-system.ts`, commit both.
 *
 *   --check   verify only, exit 1 on drift (what CI and the test use)
 */
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const DIR = join(process.cwd(), "agents/instagram-agent/assets/templates/default");

export const PLATES = [
  "closer.html",
  "comparison-card.html",
  "cover.html",
  "headline-focus.html",
  "list-takeaway.html",
  "quote-card.html",
  "slide.html",
  "stat-callout.html",
] as const;

/** Each injected region: the source file, and the markers that bound it. */
const REGIONS = [
  { source: "_design-system.css", start: "/* @ds:start */", end: "/* @ds:end */" },
  { source: "_ds-fit.js", start: "/* @ds:fit-start */", end: "/* @ds:fit-end */" },
] as const;

/** Templates are CRLF on disk and several guards read them as source, so every
 *  write normalises — a mixed-ending file is a diff nobody can review. */
const crlf = (s: string): string => s.replace(/\r?\n/g, "\r\n");

export function renderPlate(plate: string): string {
  const original = readFileSync(join(DIR, plate), "utf8");
  let out = original;
  for (const region of REGIONS) {
    const body = readFileSync(join(DIR, region.source), "utf8").replace(/\r?\n/g, "\n").trim();
    const from = out.indexOf(region.start);
    const to = out.indexOf(region.end);
    if (from === -1 || to === -1 || to < from) {
      throw new Error(`${plate}: missing or inverted markers ${region.start} … ${region.end}`);
    }
    out = `${out.slice(0, from + region.start.length)}\n${body}\n${out.slice(to)}`;
  }
  return crlf(out);
}

function main(): void {
  const check = process.argv.includes("--check");
  /* Naming plates limits the run to them — used while the set is being rebuilt
     one plate at a time, when the others do not carry the markers yet. */
  const named = process.argv.slice(2).filter((a) => a.endsWith(".html"));
  const plates = named.length > 0 ? named : PLATES;
  const drifted: string[] = [];
  for (const plate of plates) {
    const next = renderPlate(plate);
    const current = readFileSync(join(DIR, plate), "utf8");
    if (current === next) continue;
    drifted.push(plate);
    if (!check) writeFileSync(join(DIR, plate), next);
  }
  if (check && drifted.length > 0) {
    console.error(
      `design system out of sync in ${drifted.length} plate(s): ${drifted.join(", ")}\n` +
        "run: npx tsx scripts/sync-design-system.ts",
    );
    process.exit(1);
  }
  console.log(
    check
      ? `design system in sync across ${plates.length} plates`
      : drifted.length === 0
        ? `design system already in sync across ${plates.length} plates`
        : `design system written into ${drifted.length} plate(s): ${drifted.join(", ")}`,
  );
}

if (process.argv[1]?.includes("sync-design-system")) main();
