(function attachRetroWorkflow(root, factory) {
  "use strict";

  const workflow = factory();
  if (typeof module === "object" && module.exports) module.exports = workflow;
  if (root) root.RetroBoardWorkflow = workflow;
})(typeof globalThis === "object" ? globalThis : this, function createRetroWorkflow() {
  "use strict";

  const TIMER_PRESETS = Object.freeze([
    Object.freeze({ minutes: 1, seconds: 60, label: "1 minute" }),
    Object.freeze({ minutes: 5, seconds: 300, label: "5 minutes" }),
    Object.freeze({ minutes: 10, seconds: 600, label: "10 minutes" })
  ]);
  const claimedNotifications = new Set();

  function timerFields(startedAt, durationSeconds) {
    const preset = TIMER_PRESETS.find((item) => item.seconds === Number(durationSeconds));
    if (!preset || !Number.isFinite(Number(startedAt))) return null;
    const start = Number(startedAt);
    return {
      timerStartedAt: start,
      timerDurationSeconds: preset.seconds,
      timerEndsAt: start + preset.seconds * 1000
    };
  }

  function timerState(retro, now = Date.now()) {
    const startedAt = Number(retro?.timerStartedAt);
    const endsAt = Number(retro?.timerEndsAt);
    if (!Number.isFinite(startedAt) || startedAt <= 0 || !Number.isFinite(endsAt) || endsAt <= 0) {
      return { status: "idle", remainingMs: 0 };
    }
    const remainingMs = Math.max(0, endsAt - now);
    return { status: remainingMs > 0 ? "running" : "expired", remainingMs };
  }

  function formatTime(milliseconds) {
    const totalSeconds = Math.max(0, Math.ceil(Number(milliseconds || 0) / 1000));
    const minutes = Math.floor(totalSeconds / 60);
    const seconds = totalSeconds % 60;
    return `${minutes}:${String(seconds).padStart(2, "0")}`;
  }

  function readinessSummary(members, readiness) {
    const rows = Object.entries(members || {})
      .filter(([, member]) => Boolean(member))
      .map(([uid, member]) => ({ uid, name: member.name || "Unnamed teammate", isReady: Boolean(readiness?.[uid]?.readyAt) }))
      .sort((a, b) => a.name.localeCompare(b.name));
    const ready = rows.filter((row) => row.isReady);
    const waiting = rows.filter((row) => !row.isReady);
    return { total: rows.length, readyCount: ready.length, ready, waiting };
  }

  function cardMutationPatch(retroId, uid, cardId, changes) {
    const cardPath = `cards/${retroId}/${uid}/${cardId}`;
    const patch = {};
    if (changes === null) patch[cardPath] = null;
    else Object.entries(changes || {}).forEach(([field, value]) => {
      if (value !== undefined) patch[`${cardPath}/${field}`] = value;
    });
    patch[`readiness/${retroId}/${uid}`] = null;
    return patch;
  }

  function retroDeletionPatch(retros, retroId, activeRetroId) {
    const patch = {
      [`retros/${retroId}`]: null,
      [`cards/${retroId}`]: null,
      [`readiness/${retroId}`]: null,
      [`discussions/${retroId}`]: null
    };
    if (activeRetroId === retroId) {
      const nextActiveRetroId = Object.entries(retros || {})
        .filter(([id, retro]) => id !== retroId && Boolean(retro))
        .sort(([, a], [, b]) => (b.createdAt || 0) - (a.createdAt || 0))[0]?.[0] || null;
      patch["meta/activeRetroId"] = nextActiveRetroId;
    }
    return patch;
  }

  function shouldNotify(apiAvailable, visibilityState, permission) {
    return Boolean(apiAvailable && visibilityState === "hidden" && permission === "granted");
  }

  function notificationKey(retroId, event, timerStartedAt) {
    return `retro-board:timer:${retroId}:${timerStartedAt}:${event}`;
  }

  function claimNotification(key, storage) {
    if (claimedNotifications.has(key)) return false;
    try {
      if (storage?.getItem(key)) {
        claimedNotifications.add(key);
        return false;
      }
      storage?.setItem(key, "1");
    } catch (_error) {
      // Keep an in-memory guard when browser storage is unavailable.
    }
    claimedNotifications.add(key);
    return true;
  }

  return Object.freeze({
    TIMER_PRESETS,
    timerFields,
    timerState,
    formatTime,
    readinessSummary,
    cardMutationPatch,
    retroDeletionPatch,
    shouldNotify,
    notificationKey,
    claimNotification
  });
});
