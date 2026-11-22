import assert from "node:assert/strict";
import { test } from "node:test";
import { redact } from "../lib/redact";
import { SCENARIOS } from "../data/scenarios";

test("secrets and personal data are replaced and counted", () => {
  const input = [
    "2026-11-21T19:02:15Z ERROR auth login failed for priya.k@example.com from 203.0.113.42",
    "2026-11-21T19:02:16Z WARN  client Authorization: Bearer abcDEF123456ghiJKL789",
    "2026-11-21T19:02:17Z ERROR db connect postgres://app_user:hunter2secret@db.internal:5432/orders",
    "2026-11-21T19:02:18Z DEBUG cfg api_key=AIzaSyA1234567890abcdefghijklmnopqrstuv password: \"s3cr3t-pass\"",
    "2026-11-21T19:02:19Z ERROR billing charge failed card=4242 4242 4242 4242 token eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTYifQ.sflKxwRJSMeKKF2QT4fwpM",
    "AKIAIOSFODNN7EXAMPLE",
  ].join("\n");
  const r = redact(input);
  for (const leaked of ["priya.k@example.com", "203.0.113.42", "abcDEF123456ghiJKL789", "hunter2secret", "AIzaSyA1234567890", "s3cr3t-pass", "4242 4242 4242 4242", "eyJhbGci", "AKIAIOSFODNN7EXAMPLE"]) {
    assert.ok(!r.text.includes(leaked), `leaked ${leaked}`);
  }
  assert.match(r.text, /postgres:\/\/app_user:\[redacted\]@db\.internal:5432/, "keeps the user, host and port for diagnosis");
  assert.deepEqual(r.counts, { jwt: 1, api_key: 2, bearer_token: 1, url_credentials: 1, secret_value: 1, email: 1, ip: 1, card_number: 1 });
});

test("diagnostic numbers, ids and timestamps survive", () => {
  const line = "2026-11-21T19:02:10Z WARN redis used_memory=1.91GB maxmemory=2GB evicted_keys=1871 order=1732201234567890 port=6379 v2.14.3 at 127.0.0.1 tokens=512";
  const r = redact(line);
  assert.equal(r.text, line);
  assert.deepEqual(r.counts, {});
});

test("the built-in samples contain nothing to redact, so the demo story is unchanged", () => {
  for (const s of SCENARIOS) assert.deepEqual(redact(`${s.title}\n${s.description}\n${s.logs}`).counts, {}, s.id);
});
