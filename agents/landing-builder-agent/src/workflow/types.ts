/** What a Landing Builder v2 run returns (RFC-11 §7). */
export interface LandingBuilderWorkflowResult {
  status: "ok" | "needs_human";
  client: string;
  /** The page's `<title>`, so a listing can name the deliverable. */
  title: string;
  /** `pass` when both the deterministic floor and the render checks cleared (after the fix pass, if one ran). */
  gate: "pass" | "fail";
  craftVerdict: "pass" | "content_fail" | "skipped";
  /** `true` when the fix pass ran. */
  fixed: boolean;
  /** `https://<site>.web.app` once the approved version is live. Absent without Hosting configured. */
  liveUrl?: string;
  /** The auto-expiring Hosting preview channel the reviewer saw. */
  previewUrl?: string;
  /** Firebase Hosting version that was reviewed and released. */
  versionName?: string;
  /** `gs://<bucket>/landing/<slug>/<runId>/`: index.html, blueprint.json, parts.json, screenshots. */
  gcsPrefix?: string;
  /** 7-day signed URLs of the desktop and mobile screenshots the reviewer saw. */
  screenshots: Array<{ label: string; url?: string; gcsUri?: string }>;
  deliverableId?: string;
  /** Everything the blueprint, build and fix steps had to assume, plus the checks' warnings. */
  assumptions: string[];
  /** The captured old site's method (`browser`/`fetch`) or `none`. */
  oldSite: "browser" | "fetch" | "none";
  revision: boolean;
}
