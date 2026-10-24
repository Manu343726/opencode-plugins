import test from "node:test";
import assert from "node:assert/strict";

import { collect, elapsed, prune, statusKind, summary, type SessionsLike } from "../collect.ts";

function fake(children: Array<[string, string, "idle" | "running", number]>): SessionsLike {
  const byId = new Map(children.map(([id, agent, status, created]) => [id, { agent, status, created }]));
  return {
    family: (sessionID) => [sessionID, ...children.map(([id]) => id)],
    get: (sessionID) => {
      const entry = byId.get(sessionID);
      return entry
        ? { title: `task for ${entry.agent}`, agent: { id: entry.agent }, time: { created: entry.created } }
        : undefined;
    },
    status: (sessionID) => byId.get(sessionID)?.status ?? "idle",
  };
}

test("only the children of the session are listed, not the session itself", () => {
  const rows = collect(fake([["a", "reviewer", "running", 10]]), "root");
  assert.deepEqual(rows.map((row) => row.id), ["a"]);
});

test("running subagents come first, then newest", () => {
  const rows = collect(
    fake([
      ["old-idle", "explore", "idle", 100],
      ["new-idle", "explore", "idle", 300],
      ["run", "reviewer", "running", 200],
    ]),
    "root",
  );
  assert.deepEqual(rows.map((row) => row.id), ["run", "new-idle", "old-idle"]);
});

test("the agent id survives both shapes the schema allows", () => {
  const sessions: SessionsLike = {
    family: () => ["root", "a", "b"],
    get: (id) => (id === "a" ? { agent: "string-agent" } : { agent: { id: "object-agent" } }),
    status: () => "idle",
  };
  assert.deepEqual(collect(sessions, "root").map((row) => row.agent), ["string-agent", "object-agent"]);
});

test("a missing info still yields a row, titled by its id", () => {
  const sessions: SessionsLike = {
    family: () => ["root", "a"],
    get: () => undefined,
    status: () => "running",
  };
  const [row] = collect(sessions, "root");
  assert.equal(row?.title, "a");
  assert.equal(row?.agent, "agent");
  assert.equal(row?.running, true);
  assert.equal(row?.created, 0);
});

test("the summary counts and names what is running", () => {
  const rows = collect(
    fake([
      ["a", "reviewer", "running", 1],
      ["b", "explore", "idle", 2],
    ]),
    "root",
  );
  const line = summary(rows, Date.now());
  assert.match(line, /1 running · 2 in this session/);
  assert.match(line, /● reviewer/);
  assert.match(line, /○ explore done/);
});

test("an empty session says so instead of showing a bare header", () => {
  assert.match(summary([], Date.now()), /none yet/);
});

test("elapsed time is readable at each scale", () => {
  assert.equal(elapsed(1000, 1000 + 5_000), "5s");
  assert.equal(elapsed(0, 1000), "");
  assert.equal(elapsed(1000, 1000 + 65_000), "1m05s");
  assert.equal(elapsed(1000, 1000 + 3_725_000), "1h02m");
});

test("a finished subagent stays for the ttl and then goes", () => {
  const rows = collect(fake([["a", "reviewer", "idle", 1_000]]), "root");
  const seen = new Map<string, number>();
  const start = 1_000 + 60_000;

  const first = prune(rows, { now: start, ttlMs: 300_000, seenFinished: seen });
  assert.equal(first.rows.length, 1, "still inside the five minutes");

  const later = prune(rows, { now: start + 300_001, ttlMs: 300_000, seenFinished: seen });
  assert.equal(later.rows.length, 0);
  assert.deepEqual(later.removed, ["a"]);
});

test("a running subagent is never pruned", () => {
  const rows = collect(fake([["a", "reviewer", "running", 1]]), "root");
  const seen = new Map<string, number>([["a", 1]]);
  const out = prune(rows, { now: 10_000_000, ttlMs: 300_000, seenFinished: seen });
  assert.equal(out.rows.length, 1);
  assert.equal(seen.has("a"), false, "a running subagent is forgotten, not timed");
});

test("a subagent that runs again gets the full time again", () => {
  const seen = new Map<string, number>();
  const idle = collect(fake([["a", "reviewer", "idle", 1_000]]), "root");
  prune(idle, { now: 200_000, ttlMs: 300_000, seenFinished: seen });
  assert.equal(seen.has("a"), true);

  const running = collect(fake([["a", "reviewer", "running", 1_000]]), "root");
  prune(running, { now: 210_000, ttlMs: 300_000, seenFinished: seen });
  assert.equal(seen.has("a"), false);

  const again = collect(fake([["a", "reviewer", "idle", 1_000]]), "root");
  const out = prune(again, { now: 250_000, ttlMs: 300_000, seenFinished: seen });
  assert.equal(out.rows.length, 1);
});

test("a ttl of zero keeps finished subagents forever", () => {
  const rows = collect(fake([["a", "reviewer", "idle", 1]]), "root");
  const out = prune(rows, { now: 10_000_000, ttlMs: 0, seenFinished: new Map() });
  assert.equal(out.rows.length, 1);
});

test("the session's own updated time is the fallback when it was already finished", () => {
  const sessions: SessionsLike = {
    family: () => ["root", "a"],
    get: () => ({ title: "done", agent: "reviewer", time: { created: 1_000, updated: 400_000 } }),
    status: () => "idle",
  };
  const rows = collect(sessions, "root");
  assert.equal(rows[0]?.updated, 400_000);

  const seen = new Map<string, number>();
  const justAfter = prune(rows, { now: 500_000, ttlMs: 300_000, seenFinished: seen });
  assert.equal(justAfter.rows.length, 1);
  const longAfter = prune(rows, { now: 700_001, ttlMs: 300_000, seenFinished: seen });
  assert.equal(longAfter.rows.length, 0);
});

test("the status marker follows the outcome, and running wins", () => {
  assert.equal(statusKind(true, "error"), "running");
  assert.equal(statusKind(false, "ok"), "ok");
  assert.equal(statusKind(false, "error"), "error");
  assert.equal(statusKind(false, "aborted"), "aborted");
  assert.equal(statusKind(false, undefined), "unknown");
});
