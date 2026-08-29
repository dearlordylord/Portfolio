/**
 * Validate and append a real-phone hero-role observation to the latest
 * synthetic run. Browser chrome is not observable from page JavaScript, so
 * this is deliberately a small, explicit evidence envelope rather than an
 * attempt to infer chrome from visualViewport numbers.
 */
import { createHash } from "node:crypto";
import {
  copyFileSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  readlinkSync,
  rmSync,
  renameSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { execFileSync } from "node:child_process";
import path from "node:path";
import {
  evaluateVisualConvergence,
  type BrowserChromeReview,
  type HeroObservation,
  type VisualProbeObservation,
  type VisualScenarioObservation,
} from "../src/motion/visual-inspection";

type DeviceEvidenceEnvelope = {
  schemaVersion: 1;
  run: {
    runId: string;
    checkpoint: "hero-role";
    url: string;
    commit: string;
    diffHash: string;
    capturedAt: string;
    userAgent: string;
    browser: { name: string; version: string };
    viewport: { width: number; height: number; dpr: number };
  };
  probe: VisualProbeObservation;
  hero: HeroObservation;
  browserChrome: {
    expanded: { screenshot: string; sha256: string; curtainVisible: boolean };
    collapsed: { screenshot: string; sha256: string; curtainVisible: boolean };
    reviewedAt: string;
  };
};

type SyntheticManifest = {
  schemaVersion: number;
  runId: string;
  completed: boolean;
  completedAt?: string;
  commit: string;
  diffHash: string;
  createdAt: string;
};

const inputPath = process.argv[2];
if (!inputPath)
  throw new Error(
    "Usage: npm run inspect:motion:device -- path/to/device-evidence.json",
  );

const directory = path.resolve(
  "motion-artifacts",
  "inspection-current",
  "mobile-390x844",
);
const observationsPath = path.join(directory, "observations.json");
const manifestPath = path.join(directory, "manifest.json");
const completionPath = path.join(directory, "COMPLETED");
if (
  !existsSync(observationsPath) ||
  !existsSync(manifestPath) ||
  !existsSync(completionPath)
) {
  throw new Error(
    "Synthetic inspection is missing a completed manifest/observations set; run npm run inspect:motion first",
  );
}

function parseJson<T>(filePath: string): T {
  return JSON.parse(readFileSync(filePath, "utf8")) as T;
}

function finite(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

function sha256(filePath: string): string {
  return createHash("sha256").update(readFileSync(filePath)).digest("hex");
}

const pngSignature = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);

function gitOutput(...args: string[]): string {
  return execFileSync("git", args, { encoding: "utf8" }).trim();
}

/**
 * The manifest is only useful while the workspace it describes is unchanged.
 * Hash the same non-ignored tracked/untracked inputs as the browser capture,
 * including path, file kind, mode, symlink target, and bytes.
 */
function workspaceDiffHash(): string {
  const status = gitOutput("status", "--porcelain=v1");
  const files = execFileSync("git", [
    "ls-files",
    "--cached",
    "--others",
    "--exclude-standard",
    "-z",
  ])
    .toString()
    .split("\0")
    .filter(Boolean)
    .sort();
  const digest = createHash("sha256").update(`${status}\0`);
  for (const relativePath of files) {
    const absolutePath = path.resolve(relativePath);
    const stat = lstatSync(absolutePath);
    const kind = stat.isSymbolicLink()
      ? "symlink"
      : stat.isFile()
        ? "file"
        : "other";
    const contents = stat.isSymbolicLink()
      ? readlinkSync(absolutePath)
      : stat.isFile()
        ? readFileSync(absolutePath)
        : "";
    digest.update(`${relativePath}\0${kind}\0${stat.mode.toString(8)}\0`);
    digest.update(contents);
    digest.update("\0");
  }
  return digest.digest("hex");
}

type ScreenshotInfo = Readonly<{
  sourcePath: string;
  sha256: string;
  width: number;
  height: number;
}>;

function validateScreenshot(
  screenshot: string,
  expectedHash: string,
  inputDirectory: string,
  label: string,
): ScreenshotInfo {
  if (!screenshot.trim() || !/^[a-f0-9]{64}$/iu.test(expectedHash))
    throw new Error(`${label} requires a path and a 64-character SHA-256 hash`);
  const resolved = path.resolve(inputDirectory, screenshot);
  if (
    !existsSync(resolved) ||
    !statSync(resolved).isFile() ||
    statSync(resolved).size === 0
  )
    throw new Error(
      `${label} screenshot does not exist or is empty: ${resolved}`,
    );
  const bytes = readFileSync(resolved);
  if (bytes.length < 24 || !bytes.subarray(0, 8).equals(pngSignature))
    throw new Error(`${label} screenshot is not a PNG file: ${resolved}`);
  const width = bytes.readUInt32BE(16);
  const height = bytes.readUInt32BE(20);
  if (width <= 0 || height <= 0)
    throw new Error(`${label} screenshot has invalid PNG dimensions: ${resolved}`);
  const actual = sha256(resolved);
  if (actual.toLowerCase() !== expectedHash.toLowerCase())
    throw new Error(
      `${label} screenshot hash mismatch: expected ${expectedHash}, got ${actual}`,
    );
  return { sourcePath: resolved, sha256: actual, width, height };
}

type ValidatedScreenshot = Readonly<{
  sourcePath: string;
  sha256: string;
  width: number;
  height: number;
  curtainVisible: boolean;
}>;

type ValidatedDeviceInput = Readonly<{
  expanded: ValidatedScreenshot;
  collapsed: ValidatedScreenshot;
  reviewedAt: string;
}>;

function validateInput(
  input: DeviceEvidenceEnvelope,
  manifest: SyntheticManifest,
  inputDirectory: string,
): ValidatedDeviceInput {
  if (input.schemaVersion !== 1)
    throw new Error("Unsupported device evidence schemaVersion; expected 1");
  if (input.run?.checkpoint !== "hero-role")
    throw new Error(
      "Device evidence must be captured at the hero-role checkpoint",
    );
  if (input.run.runId !== manifest.runId)
    throw new Error(
      `Device runId ${input.run.runId} does not match synthetic run ${manifest.runId}`,
    );
  if (
    !/^[a-f0-9]{40}$/iu.test(input.run.commit) ||
    input.run.commit !== manifest.commit
  )
    throw new Error("Device commit must be the full SHA of the synthetic run");
  if (
    !/^[a-f0-9]{64}$/iu.test(input.run.diffHash) ||
    input.run.diffHash !== manifest.diffHash
  )
    throw new Error("Device diffHash does not match the synthetic run");
  if (!input.run.url.includes("motionDiagnostics"))
    throw new Error("Device URL must include ?motionDiagnostics=1");
  if (
    !input.run.userAgent.trim() ||
    !input.run.browser?.name.trim() ||
    !input.run.browser.version.trim()
  )
    throw new Error("Device browser provenance is incomplete");
  if (
    ![
      input.run.viewport.width,
      input.run.viewport.height,
      input.run.viewport.dpr,
    ].every(finite) ||
    input.run.viewport.width <= 0 ||
    input.run.viewport.height <= 0 ||
    input.run.viewport.dpr <= 0
  )
    throw new Error("Device viewport provenance is invalid");
  const capturedAt = Date.parse(input.run.capturedAt);
  const reviewedAt = Date.parse(input.browserChrome?.reviewedAt ?? "");
  const now = Date.now();
  const maxAgeMs = Number.parseInt(
    process.env.MOTION_DEVICE_MAX_AGE_MS ?? "604800000",
    10,
  );
  if (
    !Number.isFinite(capturedAt) ||
    capturedAt > now + 300_000 ||
    now - capturedAt > maxAgeMs
  )
    throw new Error("Device evidence is missing, future-dated, or stale");
  if (
    !Number.isFinite(reviewedAt) ||
    reviewedAt < capturedAt ||
    reviewedAt > now + 300_000
  )
    throw new Error("Browser-chrome review timestamp is invalid");
  if (
    !input.probe?.viewport ||
    !input.probe.surfaces ||
    !input.probe.insets ||
    !input.hero?.experience
  )
    throw new Error(
      "Device evidence must contain the visual probe and normalized hero observation",
    );
  const expanded = validateScreenshot(
    input.browserChrome.expanded.screenshot,
    input.browserChrome.expanded.sha256,
    inputDirectory,
    "expanded browser-chrome",
  );
  const collapsed = validateScreenshot(
    input.browserChrome.collapsed.screenshot,
    input.browserChrome.collapsed.sha256,
    inputDirectory,
    "collapsed browser-chrome",
  );
  if (expanded.sourcePath === collapsed.sourcePath || expanded.sha256 === collapsed.sha256)
    throw new Error(
      "Expanded and collapsed browser-chrome screenshots must have distinct files and SHA-256 hashes",
    );
  const minimumWidth = Math.max(
    1,
    Math.round(input.run.viewport.width * input.run.viewport.dpr),
  );
  const minimumHeight = Math.max(
    1,
    Math.round(input.run.viewport.height * input.run.viewport.dpr),
  );
  if (
    expanded.width < minimumWidth ||
    expanded.height < minimumHeight ||
    collapsed.width < minimumWidth ||
    collapsed.height < minimumHeight
  )
    throw new Error(
      `Browser-chrome PNG dimensions must cover the reported viewport at DPR ${input.run.viewport.dpr}`,
    );
  return {
    expanded: {
      sourcePath: expanded.sourcePath,
      sha256: expanded.sha256,
      width: expanded.width,
      height: expanded.height,
      curtainVisible: input.browserChrome.expanded.curtainVisible,
    },
    collapsed: {
      sourcePath: collapsed.sourcePath,
      sha256: collapsed.sha256,
      width: collapsed.width,
      height: collapsed.height,
      curtainVisible: input.browserChrome.collapsed.curtainVisible,
    },
    reviewedAt: input.browserChrome.reviewedAt,
  };
}

function stageScreenshotEvidence(
  validated: ValidatedDeviceInput,
  manifest: SyntheticManifest,
): BrowserChromeReview {
  const relativeDirectory = path.join("device-evidence", manifest.runId);
  const finalDirectory = path.join(directory, relativeDirectory);
  const stagingDirectory = `${finalDirectory}.${process.pid}.tmp`;
  if (existsSync(finalDirectory))
    throw new Error(`Device evidence sidecar already exists: ${finalDirectory}`);
  rmSync(stagingDirectory, { recursive: true, force: true });
  mkdirSync(stagingDirectory, { recursive: true });
  try {
    const expandedPath = path.join(stagingDirectory, "expanded.png");
    const collapsedPath = path.join(stagingDirectory, "collapsed.png");
    copyFileSync(validated.expanded.sourcePath, expandedPath);
    copyFileSync(validated.collapsed.sourcePath, collapsedPath);
    if (
      sha256(expandedPath).toLowerCase() !== validated.expanded.sha256.toLowerCase() ||
      sha256(collapsedPath).toLowerCase() !== validated.collapsed.sha256.toLowerCase()
    ) {
      throw new Error("Copied device screenshot failed SHA-256 verification");
    }
    renameSync(stagingDirectory, finalDirectory);
  } catch (error) {
    rmSync(stagingDirectory, { recursive: true, force: true });
    throw error;
  }
  return {
    expanded: {
      screenshot: path.join(relativeDirectory, "expanded.png"),
      curtainVisible: validated.expanded.curtainVisible,
    },
    collapsed: {
      screenshot: path.join(relativeDirectory, "collapsed.png"),
      curtainVisible: validated.collapsed.curtainVisible,
    },
    reviewedAt: validated.reviewedAt,
  };
}

const manifest = parseJson<SyntheticManifest>(manifestPath);
if (!manifest.completed || manifest.schemaVersion !== 2)
  throw new Error("Synthetic manifest is not a completed schemaVersion 2 run");
if (
  !manifest.completedAt ||
  readFileSync(completionPath, "utf8").trim() !== manifest.completedAt
)
  throw new Error("Synthetic inspection completion marker does not match its manifest");
if (gitOutput("rev-parse", "HEAD") !== manifest.commit)
  throw new Error("Synthetic inspection is stale: current commit differs from the manifest");
if (workspaceDiffHash() !== manifest.diffHash)
  throw new Error("Synthetic inspection is stale: tracked/untracked workspace inputs differ from the manifest");
const observations = parseJson<VisualScenarioObservation[]>(observationsPath);
const deviceInput = parseJson<DeviceEvidenceEnvelope>(path.resolve(inputPath));
const validatedDeviceInput = validateInput(
  deviceInput,
  manifest,
  path.dirname(path.resolve(inputPath)),
);
const browserChrome = stageScreenshotEvidence(validatedDeviceInput, manifest);
const role = observations.find(
  (observation) =>
    observation.checkpoint === "hero-role" &&
    observation.evidence === "synthetic-browser",
);
if (!role)
  throw new Error("Synthetic inspection has no synthetic hero-role checkpoint");

// Append a separate lane. Replacing the synthetic role would make R2 depend
// on whatever fields a phone devtools snapshot happened to omit and would
// erase the original reproducible evidence.
const deviceObservation: VisualScenarioObservation = {
  // Keep the device lane distinct. The synthetic scenario remains the source
  // of R2/R3/R4 so a partial phone probe cannot make those requirements pass
  // or disappear.
  scenarioId: `device-${deviceInput.run.runId}`,
  evidence: "real-device",
  checkpoint: "hero-role",
  probe: deviceInput.probe,
  hero: deviceInput.hero,
  browserChrome,
};
const merged = [...observations, deviceObservation];
const syntheticFindings = evaluateVisualConvergence(observations);
const mergedFindings = evaluateVisualConvergence(merged);
const findings = syntheticFindings.map((finding) =>
  finding.requirement === "R1"
    ? mergedFindings.find((candidate) => candidate.requirement === "R1") ?? finding
    : finding,
);
const outputObservations = path.join(directory, "observations-device.json");
const outputFindings = path.join(directory, "findings-device.json");
const outputMetadata = path.join(directory, "device-evidence.json");
const tempSuffix = `.${process.pid}.tmp`;
writeFileSync(
  `${outputObservations}${tempSuffix}`,
  `${JSON.stringify(merged, null, 2)}\n`,
);
writeFileSync(
  `${outputFindings}${tempSuffix}`,
  `${JSON.stringify(findings, null, 2)}\n`,
);
writeFileSync(
  `${outputMetadata}${tempSuffix}`,
  `${JSON.stringify({
    schemaVersion: 1,
    source: path.resolve(inputPath),
    runId: manifest.runId,
    commit: manifest.commit,
    diffHash: manifest.diffHash,
    screenshots: {
      expanded: {
        path: browserChrome.expanded.screenshot,
        source: validatedDeviceInput.expanded.sourcePath,
        sha256: validatedDeviceInput.expanded.sha256,
      },
      collapsed: {
        path: browserChrome.collapsed.screenshot,
        source: validatedDeviceInput.collapsed.sourcePath,
        sha256: validatedDeviceInput.collapsed.sha256,
      },
    },
  }, null, 2)}\n`,
);
renameSync(`${outputObservations}${tempSuffix}`, outputObservations);
renameSync(`${outputFindings}${tempSuffix}`, outputFindings);
renameSync(`${outputMetadata}${tempSuffix}`, outputMetadata);
console.log(
  JSON.stringify(
    findings.find((finding) => finding.requirement === "R1"),
    null,
    2,
  ),
);
