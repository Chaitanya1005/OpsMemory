import assert from "node:assert/strict";
import { test } from "node:test";
import { INCIDENT_LIMITS, parseIncident } from "../lib/incident";

const valid = { title: "Payments API timing out", service: "payments-api", severity: "SEV2", logs: "2026-11-20T14:02:11Z ERROR payments-api upstream timeout" };

test("a minimal valid incident is accepted, trimmed, with an empty description", () => {
  const i = parseIncident({ ...valid, title: "  Payments API timing out  " });
  assert.equal(i.title, "Payments API timing out");
  assert.equal(i.description, "");
});

test("every problem is reported at once", () => {
  assert.throws(() => parseIncident({ title: "x", service: "bad service!", severity: "SEV9", logs: "   " }), (e: Error) => {
    for (const part of ["Title is required", "Service:", "Paste at least one log line"]) assert.match(e.message, new RegExp(part));
    return true;
  });
});

test("logs over the character or line limit are refused", () => {
  assert.throws(() => parseIncident({ ...valid, logs: "x".repeat(INCIDENT_LIMITS.logChars + 1) }), /characters/);
  assert.throws(() => parseIncident({ ...valid, logs: "line\n".repeat(INCIDENT_LIMITS.logLines + 1) }), /lines/);
});

test("free-form logs are allowed; only the shape of the fields is checked", () => {
  assert.equal(parseIncident({ ...valid, logs: "java.lang.OutOfMemoryError: Java heap space\n\tat com.example.Cache.put" }).severity, "SEV2");
});
