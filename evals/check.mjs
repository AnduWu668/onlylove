import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const load = async (name) =>
  JSON.parse(await readFile(new URL(name, import.meta.url), "utf8"));
const interview = await load("interview-cases.json");
const extraction = await load("extraction-cases.json");

for (const category of [
  "leading_options",
  "correction",
  "low_confidence",
  "contradiction",
]) {
  assert(interview.some((item) => item.category === category), `missing ${category}`);
}
for (const category of [
  "eight_dimensions",
  "evidence_reference",
  "fact_hallucination",
]) {
  assert(extraction.some((item) => item.category === category), `missing ${category}`);
}
for (const item of interview.filter((item) => item.referenceOptions)) {
  assert(item.referenceOptions.length >= 3 && item.referenceOptions.length <= 4);
  assert(item.invariants.includes("no_quality_labels"));
}

console.info(`portrait benchmark corpus ok: ${interview.length + extraction.length} cases`);
