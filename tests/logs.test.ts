import assert from "node:assert/strict";
import { test } from "node:test";
import { analyzeLogs, formatAnalysis } from "../lib/analysis/logs";

const LOGS = `
2026-09-14T02:10:07Z ERROR checkout-api pool: timeout acquiring connection after 30000ms (active=8, max=8)
2026-09-14T02:10:09Z ERROR checkout-api pool: timeout acquiring connection after 30012ms (active=8, max=8)
2026-09-14T02:10:01Z WARN  hpa scaled checkout-api from 4 to 12 replicas
not a log line
2026-09-14T02:10:11Z FATAL postgres too many connections for role "checkout"
`;

test("repeated errors that differ only in numbers group into one signature", () => {
  const a = analyzeLogs(LOGS);
  const pool = a.signatures.find((s) => s.component === "checkout-api");
  assert.equal(pool?.count, 2);
  assert.equal(pool?.first, "2026-09-14T02:10:07Z");
  assert.equal(pool?.last, "2026-09-14T02:10:09Z");
  assert.match(pool!.pattern, /after Nms \(active=N, max=N\)/);
});

test("counts levels, keeps unparsed lines visible and finds the time window", () => {
  const a = analyzeLogs(LOGS);
  assert.equal(a.totalLines, 5);
  assert.deepEqual(a.byLevel, { ERROR: 2, WARN: 1, FATAL: 1, UNPARSED: 1 });
  assert.deepEqual(a.window, { start: "2026-09-14T02:10:01Z", end: "2026-09-14T02:10:11Z" });
});

test("signatures are ordered by severity, then frequency", () => {
  assert.deepEqual(analyzeLogs(LOGS).signatures.map((s) => s.level), ["FATAL", "ERROR", "WARN"]);
});

test("empty input yields an empty analysis, and formatting it does not throw", () => {
  const a = analyzeLogs("");
  assert.equal(a.totalLines, 0);
  assert.equal(a.window, null);
  assert.equal(typeof formatAnalysis(a), "string");
});
