const test = require("node:test");
const assert = require("node:assert/strict");
const workflow = require("../retro-workflow.js");

test("timer presets are limited to one, five, and ten minutes", () => {
  assert.deepEqual(workflow.TIMER_PRESETS.map(({ seconds }) => seconds), [60, 300, 600]);
  assert.equal(workflow.timerFields(1000, 300).timerEndsAt, 301000);
  assert.equal(workflow.timerFields(1000, 120), null);
});

test("timer display distinguishes idle, running, and expired retros", () => {
  assert.deepEqual(workflow.timerState({}, 1000), { status: "idle", remainingMs: 0 });
  assert.deepEqual(workflow.timerState({ timerStartedAt: 1000, timerEndsAt: 61000 }, 1000), {
    status: "running",
    remainingMs: 60000
  });
  assert.deepEqual(workflow.timerState({ timerStartedAt: 1000, timerEndsAt: 61000 }, 61000), {
    status: "expired",
    remainingMs: 0
  });
  assert.equal(workflow.formatTime(61000), "1:01");
  assert.equal(workflow.formatTime(0), "0:00");
});

test("readiness counts only currently approved members and sorts names", () => {
  const summary = workflow.readinessSummary(
    { b: { name: "Blair" }, a: { name: "Alex" }, departed: undefined },
    { a: { readyAt: 123 }, old: { readyAt: 456 } }
  );

  assert.equal(summary.total, 2);
  assert.equal(summary.readyCount, 1);
  assert.deepEqual(summary.ready.map(({ uid, name }) => [uid, name]), [["a", "Alex"]]);
  assert.deepEqual(summary.waiting.map(({ uid, name }) => [uid, name]), [["b", "Blair"]]);
});

test("readiness actions describe finishing or continuing to add cards", () => {
  assert.deepEqual([
    workflow.readinessActionLabel?.(false),
    workflow.readinessActionLabel?.(true)
  ], ["I’m done adding cards", "Continue adding cards"]);
});

test("card mutations atomically clear only that member's readiness", () => {
  assert.deepEqual(workflow.cardMutationPatch("retro-1", "uid-1", "card-1", {
    text: "Updated",
    updatedAt: 200
  }), {
    "cards/retro-1/uid-1/card-1/text": "Updated",
    "cards/retro-1/uid-1/card-1/updatedAt": 200,
    "readiness/retro-1/uid-1": null
  });
  assert.deepEqual(workflow.cardMutationPatch("retro-1", "uid-1", "card-1", null), {
    "cards/retro-1/uid-1/card-1": null,
    "readiness/retro-1/uid-1": null
  });
});

test("browser notifications are limited to supported, granted, background tabs", () => {
  assert.equal(workflow.shouldNotify(true, "hidden", "granted"), true);
  assert.equal(workflow.shouldNotify(true, "visible", "granted"), false);
  assert.equal(workflow.shouldNotify(true, "hidden", "default"), false);
  assert.equal(workflow.shouldNotify(false, "hidden", "granted"), false);
});

test("each start and expiry notification is claimed only once per session", () => {
  const values = new Map();
  const storage = {
    getItem: (key) => values.get(key) ?? null,
    setItem: (key, value) => values.set(key, value)
  };
  const started = workflow.notificationKey("retro-1", "started", 1000);
  const expired = workflow.notificationKey("retro-1", "expired", 1000);

  assert.notEqual(started, expired);
  assert.equal(workflow.claimNotification(started, storage), true);
  assert.equal(workflow.claimNotification(started, storage), false);
  assert.equal(workflow.claimNotification(expired, storage), true);
});

test("deleting the active retro removes all retro data and selects the newest remaining retro", () => {
  assert.deepEqual(workflow.retroDeletionPatch?.({
    "retro-old": { createdAt: 100 },
    "retro-current": { createdAt: 200 }
  }, "retro-current", "retro-current"), {
    "retros/retro-current": null,
    "cards/retro-current": null,
    "readiness/retro-current": null,
    "discussions/retro-current": null,
    "meta/activeRetroId": "retro-old"
  });
});

test("deleting a non-active retro leaves the room's active retro unchanged", () => {
  assert.deepEqual(workflow.retroDeletionPatch?.({
    "retro-old": { createdAt: 100 },
    "retro-current": { createdAt: 200 }
  }, "retro-old", "retro-current"), {
    "retros/retro-old": null,
    "cards/retro-old": null,
    "readiness/retro-old": null,
    "discussions/retro-old": null
  });
});
