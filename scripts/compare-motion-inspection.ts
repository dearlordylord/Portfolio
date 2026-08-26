import { existsSync, readFileSync } from "node:fs";
import path from "node:path";

type JsonValue = null | boolean | number | string | JsonValue[] | { [key: string]: JsonValue };
type Diff = Readonly<{ path: string; current: unknown; previous: unknown }>;

const defaultCurrent = path.resolve(
  "motion-artifacts",
  "inspection-current",
  "mobile-390x844",
);
const defaultPrevious = `${defaultCurrent}.previous`;
const currentDirectory = path.resolve(process.argv[2] ?? defaultCurrent);
const previousDirectory = path.resolve(process.argv[3] ?? defaultPrevious);

function readJson(filePath: string): JsonValue {
  return JSON.parse(readFileSync(filePath, "utf8")) as JsonValue;
}

function normalizeObservation(value: JsonValue): JsonValue {
  if (typeof value === "number") {
    if (!Number.isFinite(value)) return value;
    const rounded = Math.round(value * 1_000) / 1_000;
    return Object.is(rounded, -0) ? 0 : rounded;
  }
  if (Array.isArray(value)) return value.map(normalizeObservation);
  if (value !== null && typeof value === "object") {
    return Object.fromEntries(
      Object.keys(value)
        .sort()
        .map((key) => [key, normalizeObservation(value[key]!)]),
    );
  }
  return value;
}

function collectDiff(
  current: unknown,
  previous: unknown,
  at = "$",
  differences: Diff[] = [],
  limit = 20,
): Diff[] {
  if (differences.length >= limit) return differences;
  if (Object.is(current, previous)) return differences;
  if (Array.isArray(current) || Array.isArray(previous)) {
    if (!Array.isArray(current) || !Array.isArray(previous)) {
      differences.push({ path: at, current, previous });
      return differences;
    }
    if (current.length !== previous.length) {
      differences.push({
        path: `${at}.length`,
        current: current.length,
        previous: previous.length,
      });
    }
    const length = Math.max(current.length, previous.length);
    for (let index = 0; index < length; index += 1) {
      collectDiff(current[index], previous[index], `${at}[${index}]`, differences, limit);
      if (differences.length >= limit) break;
    }
    return differences;
  }
  if (
    current !== null &&
    previous !== null &&
    typeof current === "object" &&
    typeof previous === "object"
  ) {
    const currentObject = current as Record<string, unknown>;
    const previousObject = previous as Record<string, unknown>;
    const keys = new Set([...Object.keys(currentObject), ...Object.keys(previousObject)]);
    for (const key of [...keys].sort()) {
      collectDiff(currentObject[key], previousObject[key], `${at}.${key}`, differences, limit);
      if (differences.length >= limit) break;
    }
    return differences;
  }
  differences.push({ path: at, current, previous });
  return differences;
}

function display(value: unknown): string {
  const serialized = JSON.stringify(value);
  if (serialized === undefined) return "undefined";
  return serialized.length > 180 ? `${serialized.slice(0, 177)}...` : serialized;
}

function reportDiff(label: string, differences: readonly Diff[]): void {
  if (differences.length === 0) return;
  console.error(`${label}: ${differences.length}${differences.length === 20 ? "+" : ""} difference(s)`);
  for (const difference of differences) {
    console.error(
      `  ${difference.path}: current=${display(difference.current)} previous=${display(difference.previous)}`,
    );
  }
}

function requireFile(directory: string, name: string): string {
  const filePath = path.join(directory, name);
  if (!existsSync(filePath)) throw new Error(`Missing ${name}: ${filePath}`);
  return filePath;
}

try {
  const currentFindingsPath = requireFile(currentDirectory, "findings.json");
  const previousFindingsPath = requireFile(previousDirectory, "findings.json");
  const currentObservationsPath = requireFile(currentDirectory, "observations.json");
  const previousObservationsPath = requireFile(previousDirectory, "observations.json");

  const currentFindingsBytes = readFileSync(currentFindingsPath);
  const previousFindingsBytes = readFileSync(previousFindingsPath);
  const findingsBytesEqual = currentFindingsBytes.equals(previousFindingsBytes);
  const findingsDiff = collectDiff(
    readJson(currentFindingsPath),
    readJson(previousFindingsPath),
  );
  const normalizedCurrentObservations = normalizeObservation(readJson(currentObservationsPath));
  const normalizedPreviousObservations = normalizeObservation(readJson(previousObservationsPath));
  const observationsDiff = collectDiff(
    normalizedCurrentObservations,
    normalizedPreviousObservations,
  );

  console.log(`Comparing current ${currentDirectory}`);
  console.log(`       previous ${previousDirectory}`);
  console.log(`findings bytes: ${findingsBytesEqual ? "exact" : "DIFFERENT"}`);
  console.log(`findings semantics: ${findingsDiff.length === 0 ? "exact" : "DIFFERENT"}`);
  console.log(`observations (finite numbers rounded to 0.001): ${observationsDiff.length === 0 ? "equal" : "DIFFERENT"}`);
  reportDiff("Finding diff", findingsDiff);
  reportDiff("Observation diff", observationsDiff);

  if (!findingsBytesEqual || findingsDiff.length > 0 || observationsDiff.length > 0) {
    process.exitCode = 1;
  } else {
    console.log("Determinism comparison passed.");
  }
} catch (error) {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
}
