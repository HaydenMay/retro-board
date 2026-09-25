/* global firebase */
(() => {
  "use strict";

  const config = window.RETRO_FIREBASE_CONFIG;
  const LEGACY_TEAM_ID = window.RETRO_LEGACY_ROOM_ID || window.RETRO_TEAM_ID;
  const ROOM_STORAGE_KEY = "retro-board-last-room";
  const app = document.querySelector("#app");
  const cardDialog = document.querySelector("#card-dialog");
  const retroDialog = document.querySelector("#retro-dialog");
  const deleteRetroDialog = document.querySelector("#delete-retro-dialog");
  const cardForm = document.querySelector("#card-form");
  const retroForm = document.querySelector("#retro-form");
  const deleteRetroForm = document.querySelector("#delete-retro-form");
  const cardText = document.querySelector("#card-text");
  const cardCount = document.querySelector("#card-count");

  const COLUMNS = [
    { id: "wentWell", title: "What Went Well", cardClass: "well" },
    { id: "improve", title: "To Improve", cardClass: "improve" },
    { id: "actions", title: "Action Items", cardClass: "action" }
  ];

  const state = {
    user: null,
    teamId: "",
    member: null,
    team: null,
    retros: {},
    members: {},
    requests: {},
    selectedRetroId: null,
    view: "archive",
    archiveSearch: "",
    discussionFilter: "all",
    ownCards: {},
    allCards: {},
    discussions: {},
    readiness: {},
    listenerCleanups: [],
    membershipCleanups: [],
    requestCleanups: [],
    cardsCleanup: [],
    error: "",
    message: "",
    editing: null,
    pending: false,
    pendingDeleteRetroId: null,
    deletingRetro: false
  };

  let db;
  let auth;
  let feedbackTimer;
  let countdownInterval = null;
  let notificationPermissionPromise = null;
  const timerTimeouts = new Map();

  function validConfig() {
    return config && config.apiKey && config.apiKey !== "YOUR_API_KEY" && config.databaseURL;
  }

  function esc(value) {
    return String(value ?? "").replace(/[&<>'"]/g, (char) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", "'": "&#39;", '"': "&quot;" })[char]);
  }

  function nameFromMember(member) {
    return member?.name || "Teammate";
  }

  function initials(name) {
    return name.split(/\s+/).filter(Boolean).slice(0, 2).map((part) => part[0]).join("").toUpperCase() || "?";
  }

  function dateLabel(value) {
    if (!value) return "just now";
    return new Intl.DateTimeFormat(undefined, { month: "short", day: "numeric" }).format(new Date(value));
  }

  function dateTimeLabel(value) {
    if (!value) return "Unknown date";
    return new Intl.DateTimeFormat(undefined, { month: "short", day: "numeric", year: "numeric" }).format(new Date(value));
  }

  function retroCode(id, retro) {
    return retro?.code || id;
  }

  function makeRetroCode() {
    const date = new Date();
    const stamp = `${date.getFullYear()}${String(date.getMonth() + 1).padStart(2, "0")}${String(date.getDate()).padStart(2, "0")}`;
    return `R-${stamp}-${Math.random().toString(36).slice(2, 6).toUpperCase()}`;
  }

  function normalizeRoom(value) {
    return String(value || "").trim().toLowerCase().replace(/[^a-z0-9-]/g, "").slice(0, 32);
  }

  function roomFromUrl() {
    return normalizeRoom(new URLSearchParams(window.location.search).get("room"));
  }

  function roomLabel() {
    return state.team?.code || state.teamId.toUpperCase();
  }

  function generateRoomCode() {
    const chars = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
    let code = "";
    for (let index = 0; index < 6; index += 1) code += chars[Math.floor(Math.random() * chars.length)];
    return code;
  }

  function isAdmin() { return state.member?.role === "admin"; }
  function activeRetro() { return state.retros[state.selectedRetroId] || null; }
  function clearMessage() { clearTimeout(feedbackTimer); state.message = ""; }
  function setFeedback(message = "", error = "") {
    clearMessage();
    state.message = message;
    state.error = error;
    if (message) {
      feedbackTimer = setTimeout(() => {
        if (state.message === message) { state.message = ""; render(); }
      }, 4500);
    }
  }

  function ref(path = "") { return db.ref(`teams/${state.teamId}${path ? `/${path}` : ""}`); }
  function requestRef(path = "") { return db.ref(`accessRequests/${state.teamId}${path ? `/${path}` : ""}`); }

  function clearTimerTimeouts() {
    timerTimeouts.forEach((timeout) => clearTimeout(timeout));
    timerTimeouts.clear();
  }

  function stopCountdownTicker() {
    if (countdownInterval) clearInterval(countdownInterval);
    countdownInterval = null;
  }

  function updateCountdown() {
    const retro = activeRetro();
    const display = document.querySelector("#writing-countdown");
    if (!display || state.view !== "board" || !retro || retro.status !== "hidden") {
      stopCountdownTicker();
      return;
    }
    const timer = window.RetroBoardWorkflow.timerState(retro);
    if (timer.status !== "running") {
      stopCountdownTicker();
      display.textContent = timer.status === "expired" ? "0:00" : "Not started";
      if (timer.status === "expired" && display.dataset.timerState !== "expired") render();
      return;
    }
    display.textContent = window.RetroBoardWorkflow.formatTime(timer.remainingMs);
  }

  function startCountdownTicker() {
    if (countdownInterval) return;
    updateCountdown();
    countdownInterval = setInterval(updateCountdown, 250);
  }

  function requestTimerNotifications() {
    if (typeof window.Notification !== "function" || window.Notification.permission !== "default") return Promise.resolve(window.Notification?.permission || "unsupported");
    if (notificationPermissionPromise) return notificationPermissionPromise;
    try {
      notificationPermissionPromise = Promise.resolve(window.Notification.requestPermission()).catch(() => "denied");
    } catch (_error) {
      notificationPermissionPromise = Promise.resolve("denied");
    }
    return notificationPermissionPromise;
  }

  const ORIGINAL_TITLE = document.title;
  let titleFlashInterval = null;

  function stopTitleFlash() {
    if (titleFlashInterval) clearInterval(titleFlashInterval);
    titleFlashInterval = null;
    document.title = ORIGINAL_TITLE;
  }

  function flashTabTitle(message) {
    if (document.visibilityState !== "hidden") return;
    stopTitleFlash();
    let showMessage = true;
    titleFlashInterval = setInterval(() => {
      document.title = showMessage ? `⏱️ ${message}` : ORIGINAL_TITLE;
      showMessage = !showMessage;
    }, 1000);
  }

  function notifyTimerEvent(retroId, retro, eventName) {
    const workflow = window.RetroBoardWorkflow;
    const title = retro?.title || "Retro board";
    const notificationTitle = eventName === "started" ? "Writing timer started" : "Writing time is up";
    if (eventName === "started") flashTabTitle("Writing timer started!");
    if (eventName === "expired") flashTabTitle("Writing time is up!");

    const notification = window.Notification;
    if (typeof notification !== "function" || !workflow.shouldNotify(true, document.visibilityState, notification.permission)) return;
    const startedAt = Number(retro.timerStartedAt);
    const key = workflow.notificationKey(retroId, eventName, startedAt);
    let storage;
    try { storage = window.sessionStorage; } catch (_error) { storage = null; }
    if (!workflow.claimNotification(key, storage)) return;

    const timerLength = workflow.TIMER_PRESETS.find((preset) => preset.seconds === Number(retro.timerDurationSeconds))?.label || "writing";
    const body = eventName === "started"
      ? `The admin started a ${timerLength} timer for “${title}”.`
      : `Time is up for “${title}”. Responses are still hidden.`;
    try {
      const message = new notification(notificationTitle, { body, tag: key });
      message.onclick = () => {
        window.focus();
        if (state.member && state.retros[retroId]) openRetro(retroId);
        message.close();
      };
    } catch (_error) {
      // Browser notifications can be unavailable even after permission was granted.
    }
  }

  function syncTimerNotifications(retros) {
    clearTimerTimeouts();
    Object.entries(retros || {}).forEach(([retroId, retro]) => {
      const timer = window.RetroBoardWorkflow.timerState(retro);
      if (retro?.status !== "hidden" || timer.status !== "running") return;
      const startedAt = Number(retro.timerStartedAt);
      const endsAt = Number(retro.timerEndsAt);
      const timeout = setTimeout(() => {
        timerTimeouts.delete(retroId);
        const current = state.retros[retroId];
        if (!current || current.status !== "hidden" || Number(current.timerStartedAt) !== startedAt || Number(current.timerEndsAt) !== endsAt) return;
        if (window.RetroBoardWorkflow.timerState(current).status === "expired") {
          notifyTimerEvent(retroId, current, "expired");
          if (state.view === "board" && state.selectedRetroId === retroId) render();
        }
      }, Math.max(0, endsAt - Date.now()));
      timerTimeouts.set(retroId, timeout);
    });
  }

  function detach(list) { list.splice(0).forEach((cleanup) => cleanup()); }
  function listen(reference, callback, errorCallback) {
    const onError = errorCallback || ((error) => { state.error = friendlyError(error); render(); });
    reference.on("value", callback, onError);
    return () => reference.off("value", callback);
  }

  function friendlyError(error) {
    if (error?.code === "PERMISSION_DENIED") return "That room could not be opened, or you do not have access yet. Check the room code or request access from an admin.";
    return error?.message || "Something went wrong. Please try again.";
  }

  function currentCards() {
    return activeRetro()?.status === "revealed" ? state.allCards : state.ownCards;
  }

  function isDiscussed(card) {
    return Boolean(state.discussions[card.authorId]?.[card.id]?.discussed);
  }

  function flattenCards(tree) {
    return Object.entries(tree || {}).flatMap(([authorId, cards]) => Object.entries(cards || {}).map(([id, card]) => ({ id, authorId, ...card })))
      .filter((card) => COLUMNS.some((column) => column.id === card.column))
      .sort((a, b) => (a.createdAt || 0) - (b.createdAt || 0));
  }

  function render() {
    const writingBoard = state.view === "board" && activeRetro()?.status === "hidden";
    if (!writingBoard) stopCountdownTicker();
    if (!validConfig()) {
      app.innerHTML = setupNeeded();
      return;
    }
    if (!state.user) {
      app.innerHTML = loadingScreen("Signing in securely…");
      return;
    }
    if (!state.teamId) {
      app.innerHTML = lobbyScreen();
      return;
    }
    if (!state.member) {
      app.innerHTML = accessScreen();
      return;
    }
    if (state.view === "rooms") {
      app.innerHTML = roomScreen();
      return;
    }
    if (state.view === "archive" && document.activeElement?.id === "archive-search" && renderArchiveResults()) return;
    app.innerHTML = state.view === "board" && activeRetro() ? boardScreen() : archiveScreen();
    if (writingBoard) startCountdownTicker();
  }

  function loadingScreen(text) {
    return `<section class="panel"><div class="skeleton"></div><h1>Retro Board</h1><p>${esc(text)}</p></section>`;
  }

  function setupNeeded() {
    return `<section class="panel wide"><p class="eyebrow">CONFIGURATION REQUIRED</p><h1>Connect Retro Board to Firebase</h1><p>This published app does not yet have a Firebase configuration. Follow the setup checklist in <code>README.md</code>, set the <code>FIREBASE_CONFIG_JSON</code> GitHub Actions secret, and redeploy.</p><p class="muted">No credentials were embedded in this public repository.</p></section>`;
  }

  function lobbyScreen() {
    const savedName = localStorage.getItem("retro-board-display-name") || "";
    return `<section class="panel wide lobby-panel">
      <p class="eyebrow">TEAM RETROS</p>
      <h1>Choose a team room</h1>
      <p>Create a private room for your team. Your retros and action items stay available between sprints.</p>
      <div class="lobby-grid">
        <section class="lobby-option"><h2>Start a room</h2><p>You’ll get a code to share with your team.</p><label>Your display name<input id="start-name" maxlength="60" value="${esc(savedName)}" placeholder="e.g. Alex Rivera" /></label><label>Team name<input id="start-team-name" maxlength="100" placeholder="e.g. Product Team" /></label><button class="button primary full" data-action="start-room">Create room</button></section>
        <section class="lobby-option"><h2>Join a room</h2><p>Enter the room code your team shared with you.</p><label>Room code<input id="join-room-code" maxlength="32" placeholder="e.g. 7XQ2KM" autocapitalize="characters" /></label><button class="button full" data-action="join-room">Find room</button></section>
      </div>
      ${state.error ? `<p class="error">${esc(state.error)}</p>` : ""}${state.message ? `<p class="success">${esc(state.message)}</p>` : ""}
    </section>`;
  }

  function accessScreen() {
    const request = state.requests[state.user.uid];
    const defaultName = request?.name || localStorage.getItem("retro-board-display-name") || "";
    return `<section class="panel">
      <p class="eyebrow">ROOM ${esc(roomLabel())}</p>
      <h1>${request ? "Access requested" : "Join the conversation"}</h1>
      <p>${request ? "Your request is waiting for an admin. This browser will remember your identity, so you can safely come back later." : "Enter the name your teammates know you by. An admin approves new people before they can see or add retrospective cards."}</p>
      <label>Your display name<input id="display-name" maxlength="60" value="${esc(defaultName)}" placeholder="e.g. Alex Rivera" ${request ? "disabled" : ""} /></label>
      <div class="stack">${request ? `<button class="button ghost full" data-action="withdraw-request">Withdraw request</button>` : `<button class="button primary full" data-action="request-access">Request access</button>`}<button class="button ghost full" data-action="room-lobby">Back to rooms</button></div>
      ${state.error ? `<p class="error">${esc(state.error)}</p>` : ""}
      ${state.message ? `<p class="success">${esc(state.message)}</p>` : ""}
      <p class="muted">Your identity is anonymous to Firebase, but your chosen display name is visible to approved teammates after cards are revealed.</p>
    </section>`;
  }

  function boardScreen() {
    const retro = activeRetro();
    if (!retro) return `<section class="panel"><h1>Preparing your board…</h1><p>Create the first retro to get started.</p>${isAdmin() ? `<button class="button primary" data-action="new-retro">Create first retro</button>` : ""}</section>`;
    const isRevealed = retro.status === "revealed";
    const sortedRetros = Object.entries(state.retros).sort(([, a], [, b]) => (b.createdAt || 0) - (a.createdAt || 0));
    return `<div class="shell">
      <header class="topbar">
        <button class="brand brand-link" data-action="archive" aria-label="Return to Retro Archive"><span class="brand-mark">R</span> Retro Board</button>
        <div class="identity"><span class="avatar">${esc(initials(nameFromMember(state.member)))}</span><span>${esc(nameFromMember(state.member))}${isAdmin() ? " · Admin" : ""}</span>${!isAdmin() ? `<button class="plain-button leave-link" data-action="leave-room">Leave room</button>` : ""}<button class="plain-button" data-action="rooms">Rooms</button></div>
      </header>
      <section class="hero">
        <div><p class="eyebrow">${esc(state.team?.name || "YOUR TEAM")}</p><h1>${esc(retro.title || "Sprint Retro")}</h1><p class="subtitle">A focused space to reflect together, then turn the conversation into action.</p><p class="room-code">Room code <code>${esc(roomLabel())}</code> <button class="plain-button" data-action="copy-room">Copy link</button></p></div>
        <div class="status-box"><div class="status-line"><span class="status-dot ${isRevealed ? "revealed" : ""}"></span>${isRevealed ? "Responses revealed" : "Responses hidden"}</div><p class="status-detail">${isRevealed ? "Everyone can now see the board." : "Only you can see your cards."}</p></div>
      </section>
      <section class="toolbar">
        <select id="retro-picker" class="retro-picker" aria-label="Choose a retro">${sortedRetros.map(([id, item]) => `<option value="${esc(id)}" ${id === state.selectedRetroId ? "selected" : ""}>${esc(item.title || "Untitled retro")} · ${dateLabel(item.createdAt)}</option>`).join("")}</select>
        <div class="toolbar-actions">${isAdmin() && isRevealed ? `<span class="discussion-filter" aria-label="Discussion filter"><button class="filter-button ${state.discussionFilter === "all" ? "selected" : ""}" data-action="show-all">All</button><button class="filter-button ${state.discussionFilter === "undiscussed" ? "selected" : ""}" data-action="show-undiscussed">Undiscussed</button></span><button class="button" data-action="hide">Hide responses</button>` : ""}${isAdmin() && !isRevealed ? `<button class="button primary" data-action="reveal">Reveal board</button>` : ""}${isAdmin() ? `<button class="button" data-action="new-retro">+ New retro</button>` : ""}</div>
      </section>
      <p class="retro-id">Retro ID: <code>${esc(retroCode(state.selectedRetroId, retro))}</code></p>
      ${!isRevealed ? writingToolsMarkup(retro) : ""}
      <section class="board">${COLUMNS.map((column) => columnMarkup(column)).join("")}</section>
      ${isAdmin() ? adminAccessMarkup() : ""}
      ${isAdmin() ? `<section class="delete-retro-zone"><div><p class="eyebrow">DANGER ZONE</p><h2>Delete this retro</h2><p>This permanently removes the retro and its cards from the archive.</p></div><button class="button danger" data-action="delete-retro" data-retro-id="${esc(state.selectedRetroId)}">Delete retro</button></section>` : ""}
      ${state.error ? `<p class="error">${esc(state.error)}</p>` : ""}
      ${state.message ? `<p class="success">${esc(state.message)}</p>` : ""}
    </div>`;
  }

  function archiveData() {
    const retros = Object.entries(state.retros)
      .sort(([, a], [, b]) => (b.createdAt || 0) - (a.createdAt || 0));
    const query = state.archiveSearch.trim().toLowerCase();
    const matching = retros.filter(([id, retro]) => !query || `${retro.title || ""} ${retroCode(id, retro)} ${id}`.toLowerCase().includes(query));
    return { retros, matching, query };
  }

  function archiveCountLabel(retros, matching, query) {
    if (query) return `${matching.length} of ${retros.length} ${retros.length === 1 ? "retro" : "retros"}`;
    return `${retros.length} ${retros.length === 1 ? "retro" : "retros"} saved`;
  }

  function archiveResultsMarkup(retros, matching) {
    return matching.length ? matching.map(([id, retro]) => retroListItem(id, retro)).join("") : `<div class="empty-archive"><h2>${retros.length ? "No matching retros" : "No retros yet"}</h2><p>${retros.length ? "Try another title or Retro ID." : isAdmin() ? "Create your first retro to begin." : "An admin will create the first retro soon."}</p>${!retros.length && isAdmin() ? `<button class="button primary" data-action="new-retro">Create first retro</button>` : ""}</div>`;
  }

  function archiveNoticesMarkup() {
    return `${state.error ? `<p class="error">${esc(state.error)}</p>` : ""}${state.message ? `<p class="success">${esc(state.message)}</p>` : ""}`;
  }

  function renderArchiveResults() {
    if (state.view !== "archive") return false;
    const count = document.querySelector("#archive-count");
    const results = document.querySelector("#archive-results");
    const notices = document.querySelector("#archive-notices");
    if (!count || !results || !notices) return false;
    const { retros, matching, query } = archiveData();
    count.textContent = archiveCountLabel(retros, matching, query);
    results.innerHTML = archiveResultsMarkup(retros, matching);
    notices.innerHTML = archiveNoticesMarkup();
    return true;
  }

  function archiveScreen() {
    const { retros, matching, query } = archiveData();
    return `<div class="shell">
      <header class="topbar">
        <button class="brand brand-link" data-action="archive" aria-label="Return to Retro Archive"><span class="brand-mark">R</span> Retro Board</button>
        <div class="identity"><span class="avatar">${esc(initials(nameFromMember(state.member)))}</span><span>${esc(nameFromMember(state.member))}${isAdmin() ? " · Admin" : ""}</span>${!isAdmin() ? `<button class="plain-button leave-link" data-action="leave-room">Leave room</button>` : ""}<button class="plain-button" data-action="rooms">Rooms</button></div>
      </header>
      <section class="hero archive-hero">
        <div><p class="eyebrow">${esc(state.team?.name || "YOUR TEAM")}</p><h1>Retro archive</h1><p class="subtitle">Every retrospective stays here. Open a board to continue it, revisit its actions, or share its exact ID with the team.</p><p class="room-code">Room code <code>${esc(roomLabel())}</code> <button class="plain-button" data-action="copy-room">Copy link</button></p></div>
        ${isAdmin() ? `<button class="button primary archive-new" data-action="new-retro">+ New retro</button>` : ""}
      </section>
      <section class="archive-controls"><label class="search-label">Find a retro<input id="archive-search" value="${esc(state.archiveSearch)}" placeholder="Search title or Retro ID" /></label><p class="archive-count" id="archive-count">${archiveCountLabel(retros, matching, query)}</p></section>
      <section class="retro-list" id="archive-results">${archiveResultsMarkup(retros, matching)}</section>
      <div id="archive-notices">${archiveNoticesMarkup()}</div>
    </div>`;
  }

  function roomScreen() {
    const retroCount = Object.keys(state.retros).length;
    const retroCountLabel = `${retroCount} ${retroCount === 1 ? "retro" : "retros"} saved`;
    return `<div class="shell">
      <header class="topbar">
        <button class="brand brand-link" data-action="archive" aria-label="Return to Retro Archive"><span class="brand-mark">R</span> Retro Board</button>
        <div class="identity"><span class="avatar">${esc(initials(nameFromMember(state.member)))}</span><span>${esc(nameFromMember(state.member))}${isAdmin() ? " · Admin" : ""}</span>${!isAdmin() ? `<button class="plain-button leave-link" data-action="leave-room">Leave room</button>` : ""}<button class="plain-button" data-action="room-lobby">Switch rooms</button></div>
      </header>
      <section class="hero room-hero">
        <div><p class="eyebrow">ROOM</p><h1>${esc(state.team?.name || "Your room")}</h1><p class="subtitle">Your team’s private space for retros that stay useful between sprints.</p><p class="room-code">Room code <code>${esc(roomLabel())}</code> <button class="plain-button" data-action="copy-room">Copy link</button></p></div>
      </section>
      <button class="archive-destination" data-action="archive" aria-label="Open Retro archive, ${esc(retroCountLabel)}"><span class="archive-destination-copy"><span class="eyebrow">RETROS</span><span class="archive-destination-title">Retro archive</span><span class="archive-destination-description">Open your current and previous retros.</span></span><span class="archive-destination-meta"><span class="archive-destination-count">${esc(retroCountLabel)}</span><span class="archive-destination-open">Open archive →</span></span></button>
      ${isAdmin() ? adminAccessMarkup() : `<section class="admin-access"><h2>Room access</h2><p>Admins manage access requests and room members here.</p></section>`}
      ${state.error ? `<p class="error">${esc(state.error)}</p>` : ""}${state.message ? `<p class="success">${esc(state.message)}</p>` : ""}
    </div>`;
  }

  function retroListItem(id, retro) {
    const revealed = retro.status === "revealed";
    const creator = retro.createdBy ? nameFromMember(state.members[retro.createdBy]) : "Team";
    const title = retro.title || "Untitled retro";
    return `<article class="retro-list-item"><button class="retro-list-open" data-action="open-retro" data-retro-id="${esc(id)}" aria-label="Open ${esc(title)}"><span class="retro-list-copy"><span class="retro-list-topline"><span class="retro-state ${revealed ? "revealed" : "hidden"}">${revealed ? "Revealed" : "Hidden"}</span><code>${esc(retroCode(id, retro))}</code></span><span class="retro-list-title">${esc(title)}</span><span class="retro-list-meta">Created ${esc(dateTimeLabel(retro.createdAt))} by ${esc(creator)}</span></span><span class="retro-open-hint">Open →</span></button>${isAdmin() ? `<button class="button danger small retro-delete" data-action="delete-retro" data-retro-id="${esc(id)}" aria-label="Delete ${esc(title)}">Delete</button>` : ""}</article>`;
  }

  function columnMarkup(column) {
    const cards = flattenCards(currentCards()).filter((card) => card.column === column.id);
    const discussed = cards.filter(isDiscussed).length;
    const visibleCards = state.discussionFilter === "undiscussed" ? cards.filter((card) => !isDiscussed(card)) : cards;
    const countLabel = activeRetro()?.status === "revealed" ? `${cards.length} cards · ${discussed} discussed` : `${cards.length} ${cards.length === 1 ? "card" : "cards"}`;
    const emptyMessage = cards.length && state.discussionFilter === "undiscussed" ? "Everything here has been discussed." : "Nothing here yet.";
    return `<article class="column"><div class="column-head"><h2 class="column-title">${column.title}</h2><span class="card-count">${countLabel}</span></div><div class="cards">${visibleCards.length ? visibleCards.map((card) => cardMarkup(card, column)).join("") : `<p class="empty-column">${emptyMessage}</p>`}</div><button class="button add-card" data-action="add-card" data-column="${column.id}">+ Add card</button></article>`;
  }

  function writingToolsMarkup(retro) {
    const workflow = window.RetroBoardWorkflow;
    const timer = workflow.timerState(retro);
    const readiness = workflow.readinessSummary(state.members, state.readiness);
    const ownReady = Boolean(state.readiness[state.user.uid]?.readyAt);
    const timerMessage = timer.status === "running"
      ? `<span id="writing-countdown" class="writing-countdown" data-timer-state="running" role="timer" aria-label="Time remaining">${workflow.formatTime(timer.remainingMs)}</span><span class="timer-caption">remaining</span>`
      : timer.status === "expired"
        ? `<span id="writing-countdown" class="writing-countdown" data-timer-state="expired" role="timer" aria-label="Timer finished">0:00</span><p class="timer-expired" role="status">Time’s up. Responses are still hidden.</p>`
        : `<span id="writing-countdown" class="writing-countdown idle" data-timer-state="idle">Not started</span><p class="timer-caption">The admin can start a writing timer when the team is ready.</p>`;
    const timerControls = isAdmin() && timer.status !== "running"
      ? `<div class="timer-controls"><label for="writing-timer-duration">Duration</label><select id="writing-timer-duration" aria-label="Writing timer duration">${workflow.TIMER_PRESETS.map((preset) => `<option value="${preset.seconds}" ${preset.seconds === 300 ? "selected" : ""}>${preset.label}</option>`).join("")}</select><button class="button primary" data-action="start-timer">${timer.status === "expired" ? "Start another timer" : "Start timer"}</button></div>`
      : "";
    const readinessMarkup = isAdmin()
      ? `<div class="readiness-summary"><span class="readiness-count">${readiness.readyCount} of ${readiness.total} ${readiness.total === 1 ? "member" : "members"} ready</span><span class="readiness-note">Ready status is self-reported; cards stay hidden.</span></div><ul class="readiness-list">${readiness.ready.map((member) => `<li><span>${esc(member.name)}</span><span class="readiness-badge ready">Ready</span></li>`).join("")}${readiness.waiting.map((member) => `<li><span>${esc(member.name)}</span><span class="readiness-badge">Not marked ready</span></li>`).join("")}</ul>`
      : `<p class="own-readiness">Your status: <strong>${ownReady ? "Ready" : "Not ready"}</strong></p>`;

    return `<section class="writing-tools" aria-label="Writing controls">
      <section class="writing-panel timer-panel"><header class="writing-panel-heading"><h2>Writing timer</h2></header><div class="timer-readout">${timerMessage}</div>${timerControls}</section>
      <section class="writing-panel readiness-panel"><header class="writing-panel-heading"><div><p class="eyebrow">TEAM CHECK-IN</p><h2>${isAdmin() ? "Ready to reveal" : "Your readiness"}</h2></div></header>${readinessMarkup}<button class="button ${ownReady ? "ghost" : "primary"} ready-toggle" data-action="toggle-ready" aria-pressed="${ownReady}">${workflow.readinessActionLabel(ownReady)}</button></section>
    </section>`;
  }

  function cardMarkup(card, column) {
    const own = card.authorId === state.user.uid;
    const owner = own ? "You" : nameFromMember(state.members[card.authorId]);
    const discussed = isDiscussed(card);
    const revealComplete = activeRetro()?.status === "revealed";
    const discussionControl = revealComplete && isAdmin() ? `<button class="discussion-toggle ${discussed ? "complete" : ""}" data-action="toggle-discussed" data-card-id="${esc(card.id)}" data-author-id="${esc(card.authorId)}" aria-label="${discussed ? "Mark as not discussed" : "Mark as discussed"}" title="${discussed ? "Discussed" : "Mark discussed"}">✓</button>` : discussed ? `<span class="discussion-indicator" title="Discussed">✓</span>` : "";
    return `<article class="retro-card ${column.cardClass} ${discussed ? "discussed" : ""}">${discussionControl}<p class="card-text">${esc(card.text)}</p><footer class="card-footer"><span class="card-owner">${esc(owner)}</span>${own ? `<span class="card-menu"><button data-action="edit-card" data-card-id="${esc(card.id)}" data-author-id="${esc(card.authorId)}">Edit</button><button data-action="delete-card" data-card-id="${esc(card.id)}" data-author-id="${esc(card.authorId)}">Delete</button></span>` : ""}</footer></article>`;
  }

  function adminAccessMarkup() {
    const requests = Object.entries(state.requests).sort(([, a], [, b]) => (a.requestedAt || 0) - (b.requestedAt || 0));
    const members = Object.entries(state.members).sort(([, a], [, b]) => a.name.localeCompare(b.name));
    return `<section class="admin-access"><header class="access-heading"><div><p class="eyebrow">ROOM ACCESS</p><h2>Members</h2></div><span class="member-total">${members.length} ${members.length === 1 ? "member" : "members"}</span></header><div class="member-list">${members.map(([uid, member]) => `<div class="member-row"><span><span class="request-name">${esc(member.name || "Unnamed teammate")}</span><span class="request-date">${member.role === "admin" ? "Admin" : "Member"}</span></span>${uid === state.user.uid ? `<span class="role-label">You</span>` : member.role === "admin" ? `<span class="member-actions"><span class="role-label">Admin</span><button class="button small danger" data-action="remove-member" data-uid="${esc(uid)}">Remove</button></span>` : `<span class="member-actions"><button class="button small" data-action="make-admin" data-uid="${esc(uid)}">Make admin</button><button class="button small danger" data-action="remove-member" data-uid="${esc(uid)}">Remove</button></span>`}</div>`).join("")}</div>${requests.length ? `<section class="access-requests"><h3>Access requests <span>${requests.length}</span></h3>${requests.map(([uid, request]) => `<div class="member-row"><span><span class="request-name">${esc(request.name || "Unnamed teammate")}</span><span class="request-date">Requested ${dateLabel(request.requestedAt)}</span></span><button class="button small primary" data-action="approve" data-uid="${esc(uid)}">Approve</button></div>`).join("")}</section>` : ""}</section>`;
  }

  function readName(inputId = "display-name") {
    const input = document.querySelector(`#${inputId}`);
    const name = input?.value.trim();
    if (!name) { setFeedback("", "Please enter a display name."); render(); return null; }
    return name.slice(0, 60);
  }

  async function requestAccess() {
    const name = readName(); if (!name) return;
    try { await requestRef(state.user.uid).set({ name, requestedAt: Date.now() }); localStorage.setItem("retro-board-display-name", name); setFeedback("Access request sent."); }
    catch (error) { setFeedback("", friendlyError(error)); }
    render();
  }

  async function approve(uid) {
    const request = state.requests[uid]; if (!request) return;
    try { await ref(`members/${uid}`).set({ name: request.name || "Teammate", role: "member", joinedAt: Date.now() }); await requestRef(uid).remove(); setFeedback(`${request.name || "Teammate"} can now join this room.`); }
    catch (error) { setFeedback("", friendlyError(error)); }
    render();
  }

  async function makeAdmin(uid) {
    const member = state.members[uid]; if (!member) return;
    if (!confirm(`Make ${member.name} an admin for this room?`)) return;
    try { await ref(`members/${uid}`).update({ role: "admin" }); setFeedback(`${member.name} is now an admin.`); }
    catch (error) { setFeedback("", friendlyError(error)); }
    render();
  }

  async function removeMember(uid) {
    const member = state.members[uid]; if (!member || uid === state.user.uid) return;
    if (!confirm(`Remove ${member.name} from this room? They can request access again later.`)) return;
    try { await ref(`members/${uid}`).remove(); setFeedback(`${member.name} was removed from the room.`); }
    catch (error) { setFeedback("", friendlyError(error)); }
    render();
  }

  async function withdrawRequest() { try { await requestRef(state.user.uid).remove(); setFeedback("Request withdrawn."); } catch (error) { setFeedback("", friendlyError(error)); } render(); }

  function resetRoomState() {
    detach(state.listenerCleanups); detach(state.membershipCleanups); detach(state.requestCleanups); detach(state.cardsCleanup);
    state.member = null; state.team = null; state.retros = {}; state.members = {}; state.requests = {};
    state.selectedRetroId = null; state.view = "archive"; state.archiveSearch = ""; state.discussionFilter = "all"; state.ownCards = {}; state.allCards = {}; state.discussions = {}; state.readiness = {};
    clearTimerTimeouts(); stopCountdownTicker(); stopTitleFlash();
  }

  function updateRoomUrl(room, replace = false) {
    const url = new URL(window.location.href);
    if (room) url.searchParams.set("room", room);
    else url.searchParams.delete("room");
    if (!room) url.hash = "";
    window.history[replace ? "replaceState" : "pushState"]({}, "", url);
  }

  function activateRoom(room, replace = false) {
    const normalized = normalizeRoom(room);
    if (!normalized) { setFeedback("", "Enter a valid room code."); render(); return; }
    clearMessage();
    resetRoomState();
    state.teamId = normalized;
    localStorage.setItem(ROOM_STORAGE_KEY, normalized);
    updateRoomUrl(normalized, replace);
    watchMembership();
    render();
  }

  async function startRoom() {
    const name = readName("start-name"); if (!name) return;
    const teamName = document.querySelector("#start-team-name")?.value.trim().slice(0, 100) || "My Team";
    const code = generateRoomCode(); const now = Date.now();
    setFeedback(); activateRoom(code);
    try {
      await ref().set({ meta: { name: teamName, code, createdAt: now, createdBy: state.user.uid, activeRetroId: null }, members: { [state.user.uid]: { name, role: "admin", joinedAt: now } }, retros: {} });
      localStorage.setItem("retro-board-display-name", name);
      setFeedback(`Room ${code} created. You are its first admin.`);
    } catch (error) { setFeedback("", friendlyError(error)); }
    render();
  }

  function joinRoom() {
    const code = document.querySelector("#join-room-code")?.value;
    activateRoom(code);
  }

  function openRooms(replace = false) {
    if (!state.member) { openRoomLobby(); return; }
    clearMessage();
    detach(state.cardsCleanup);
    state.view = "rooms";
    setHash("#rooms", replace);
    render();
  }

  function openRoomLobby() {
    clearMessage();
    resetRoomState(); state.teamId = ""; localStorage.removeItem(ROOM_STORAGE_KEY); updateRoomUrl(""); render();
  }

  async function leaveRoom() {
    if (isAdmin()) return;
    if (!confirm("Leave this room? You will need to request access again to return.")) return;
    try {
      await ref(`members/${state.user.uid}`).remove();
      openRoomLobby();
    } catch (error) { setFeedback("", friendlyError(error)); render(); }
  }

  async function copyRoomLink() {
    const url = new URL(window.location.href);
    url.searchParams.set("room", state.teamId); url.hash = "retros";
    try { await navigator.clipboard.writeText(url.toString()); setFeedback("Room link copied."); }
    catch (error) { setFeedback("", "Could not copy the link. Copy it from your browser address bar instead."); }
    render();
  }

  function openCard(column, card = null) {
    state.editing = card ? { ...card } : { column };
    document.querySelector("#card-dialog-title").textContent = card ? "Edit your thought" : "Add a thought";
    document.querySelector("#card-dialog-kicker").textContent = card ? "EDIT CARD" : COLUMNS.find((item) => item.id === column)?.title.toUpperCase() || "NEW CARD";
    document.querySelector("#save-card").textContent = card ? "Save changes" : "Save card";
    cardText.value = card?.text || ""; cardCount.textContent = cardText.value.length;
    cardDialog.showModal(); cardText.focus();
  }

  async function saveCard() {
    const text = cardText.value.trim(); if (!text || !state.editing || !activeRetro()) return;
    const now = Date.now(); const retroId = state.selectedRetroId;
    try {
      if (state.editing.id) {
        await ref().update(window.RetroBoardWorkflow.cardMutationPatch(retroId, state.user.uid, state.editing.id, { text, updatedAt: now }));
      } else {
        const newRef = ref(`cards/${retroId}/${state.user.uid}`).push();
        await ref().update(window.RetroBoardWorkflow.cardMutationPatch(retroId, state.user.uid, newRef.key, { authorId: state.user.uid, column: state.editing.column, text, createdAt: now, updatedAt: now }));
      }
      cardDialog.close(); state.editing = null;
    } catch (error) { setFeedback("", friendlyError(error)); render(); }
  }

  function findCard(authorId, cardId) { return flattenCards(activeRetro()?.status === "revealed" ? state.allCards : state.ownCards).find((card) => card.authorId === authorId && card.id === cardId); }
  async function deleteCard(authorId, cardId) {
    if (authorId !== state.user.uid || !confirm("Delete this card?")) return;
    try { await ref().update(window.RetroBoardWorkflow.cardMutationPatch(state.selectedRetroId, state.user.uid, cardId, null)); }
    catch (error) { setFeedback("", friendlyError(error)); render(); }
  }

  async function toggleReady() {
    const retro = activeRetro();
    if (!state.user || !retro || retro.status !== "hidden") return;
    const reference = ref(`readiness/${state.selectedRetroId}/${state.user.uid}`);
    try {
      if (state.readiness[state.user.uid]?.readyAt) await reference.remove();
      else await reference.set({ readyAt: Date.now() });
    } catch (error) { setFeedback("", friendlyError(error)); render(); }
  }

  async function startWritingTimer() {
    const retro = activeRetro();
    if (!isAdmin() || !retro || retro.status !== "hidden" || window.RetroBoardWorkflow.timerState(retro).status === "running") return;
    const durationSeconds = Number(document.querySelector("#writing-timer-duration")?.value || 300);
    const timer = window.RetroBoardWorkflow.timerFields(Date.now(), durationSeconds);
    if (!timer) return;
    try { await requestTimerNotifications(); await ref(`retros/${state.selectedRetroId}`).update(timer); }
    catch (error) { setFeedback("", friendlyError(error)); render(); }
  }

  async function reveal() {
    if (!isAdmin() || activeRetro()?.status !== "hidden") return;
    if (!confirm("Reveal all responses to the team?")) return;
    try { await ref(`retros/${state.selectedRetroId}`).update({ status: "revealed", revealedAt: Date.now(), revealedBy: state.user.uid, timerStartedAt: null, timerDurationSeconds: null, timerEndsAt: null }); }
    catch (error) { setFeedback("", friendlyError(error)); render(); }
  }

  async function hideResponses() {
    const retroId = state.selectedRetroId;
    const retro = activeRetro();
    if (!isAdmin() || !retro || retro.status !== "revealed") return;
    if (!confirm("Hide responses again? Teammates will immediately return to seeing only their own cards.")) return;

    const previousRetro = { ...retro };
    state.retros[retroId] = { ...retro, status: "hidden" };
    state.discussionFilter = "all";
    attachCards();

    try {
      await ref(`retros/${retroId}`).update({ status: "hidden" });
    } catch (error) {
      state.retros[retroId] = previousRetro;
      if (state.selectedRetroId === retroId) attachCards();
      setFeedback("", friendlyError(error));
      render();
    }
  }

  async function toggleDiscussed(authorId, cardId) {
    if (!isAdmin() || activeRetro()?.status !== "revealed") return;
    const path = `discussions/${state.selectedRetroId}/${authorId}/${cardId}`;
    const discussed = Boolean(state.discussions[authorId]?.[cardId]?.discussed);
    try {
      if (discussed) await ref(path).remove();
      else await ref(path).set({ discussed: true, updatedAt: Date.now(), updatedBy: state.user.uid });
    } catch (error) { setFeedback("", friendlyError(error)); render(); }
  }
  function openRetroDialog() { document.querySelector("#retro-title").value = ""; retroDialog.showModal(); document.querySelector("#retro-title").focus(); }
  function openDeleteRetroDialog(retroId) {
    const retro = state.retros[retroId];
    if (!isAdmin() || !retro) return;
    state.pendingDeleteRetroId = retroId;
    document.querySelector("#delete-retro-name").textContent = retro.title || "Untitled retro";
    const submit = document.querySelector("#confirm-delete-retro");
    submit.disabled = false;
    submit.textContent = "Delete retro";
    document.querySelectorAll('[data-dialog-cancel="delete-retro"]').forEach((button) => { button.disabled = false; });
    deleteRetroDialog.showModal();
  }

  async function deleteRetro() {
    const retroId = state.pendingDeleteRetroId;
    const retro = state.retros[retroId];
    if (!isAdmin() || !retroId || !retro || state.deletingRetro) return;

    state.deletingRetro = true;
    const wasSelectedRetro = state.selectedRetroId === retroId;
    const submit = document.querySelector("#confirm-delete-retro");
    submit.disabled = true;
    submit.textContent = "Deleting…";
    document.querySelectorAll('[data-dialog-cancel="delete-retro"]').forEach((button) => { button.disabled = true; });
    const patch = window.RetroBoardWorkflow.retroDeletionPatch(state.retros, retroId, state.team?.activeRetroId);
    try {
      await ref().update(patch);
      delete state.retros[retroId];
      if (Object.hasOwn(patch, "meta/activeRetroId")) {
        state.team = { ...state.team, activeRetroId: patch["meta/activeRetroId"] };
      }
      if (wasSelectedRetro) {
        detach(state.cardsCleanup);
        state.ownCards = {};
        state.allCards = {};
        state.discussions = {};
        state.readiness = {};
        state.selectedRetroId = state.team?.activeRetroId && state.retros[state.team.activeRetroId]
          ? state.team.activeRetroId
          : Object.entries(state.retros).sort(([, a], [, b]) => (b.createdAt || 0) - (a.createdAt || 0))[0]?.[0] || null;
      }
      deleteRetroDialog.close();
      state.pendingDeleteRetroId = null;
      openArchive();
      setFeedback(`Deleted “${retro.title || "Untitled retro"}”.`);
      render();
    } catch (error) {
      deleteRetroDialog.close();
      state.pendingDeleteRetroId = null;
      setFeedback("", friendlyError(error));
      render();
    } finally {
      state.deletingRetro = false;
      submit.disabled = false;
      submit.textContent = "Delete retro";
      document.querySelectorAll('[data-dialog-cancel="delete-retro"]').forEach((button) => { button.disabled = false; });
    }
  }

  async function createRetro() {
    const title = document.querySelector("#retro-title").value.trim(); if (!title) return;
    const id = `retro-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`; const now = Date.now();
    const retro = { title: title.slice(0, 100), code: makeRetroCode(), status: "hidden", createdAt: now, createdBy: state.user.uid };
    try {
      await ref(`retros/${id}`).set(retro);
      await ref("meta").update({ activeRetroId: id });
      state.retros[id] = retro;
      retroDialog.close(); openRetro(id);
    }
    catch (error) { setFeedback("", friendlyError(error)); render(); }
  }

  function setHash(value, replace = false) {
    const url = `${window.location.pathname}${window.location.search}${value}`;
    window.history[replace ? "replaceState" : "pushState"]({}, "", url);
  }

  function routeRetroId() {
    return new URLSearchParams(window.location.hash.replace(/^#/, "")).get("retro");
  }

  function openRetro(id, replace = false) {
    if (!state.retros[id] && id !== state.selectedRetroId) return;
    clearMessage();
    if (id !== state.selectedRetroId) state.discussionFilter = "all";
    state.selectedRetroId = id;
    state.view = "board";
    setHash(`#retro=${encodeURIComponent(id)}`, replace);
    attachCards();
  }

  function openArchive(replace = false) {
    clearMessage();
    state.view = "archive";
    detach(state.cardsCleanup);
    setHash("#retros", replace);
    render();
  }

  function applyRoute() {
    if (window.location.hash === "#rooms") { openRooms(true); return; }
    const id = routeRetroId();
    if (id && state.retros[id]) openRetro(id, true);
    else openArchive(true);
  }

  function attachCards() {
    detach(state.cardsCleanup); state.ownCards = {}; state.allCards = {}; state.discussions = {}; state.readiness = {};
    const retro = activeRetro(); if (!retro || !state.user) { render(); return; }
    state.cardsCleanup.push(listen(ref(`cards/${state.selectedRetroId}/${state.user.uid}`), (snap) => { state.ownCards = { [state.user.uid]: snap.val() || {} }; render(); }));
    if (retro.status === "hidden") {
      const readinessPath = `readiness/${state.selectedRetroId}`;
      if (isAdmin()) {
        state.cardsCleanup.push(listen(ref(readinessPath), (snap) => { state.readiness = snap.val() || {}; render(); }));
      } else {
        state.cardsCleanup.push(listen(ref(`${readinessPath}/${state.user.uid}`), (snap) => { state.readiness = snap.val() ? { [state.user.uid]: snap.val() } : {}; render(); }));
      }
    } else if (retro.status === "revealed") {
      state.cardsCleanup.push(listen(ref(`cards/${state.selectedRetroId}`), (snap) => { state.allCards = snap.val() || {}; render(); }));
      state.cardsCleanup.push(listen(ref(`discussions/${state.selectedRetroId}`), (snap) => { state.discussions = snap.val() || {}; render(); }));
    }
    render();
  }

  function attachMemberData() {
    detach(state.listenerCleanups);
    state.listenerCleanups.push(listen(ref("meta"), (snap) => { state.team = snap.val() || {}; render(); }));
    state.listenerCleanups.push(listen(ref("retros"), (snap) => {
      const nextRetros = snap.val() || {};
      Object.entries(nextRetros).forEach(([retroId, retro]) => {
        const previous = state.retros[retroId];
        if (previous && retro?.status === "hidden" && Number(retro.timerStartedAt) > 0 && Number(retro.timerStartedAt) !== Number(previous.timerStartedAt)) {
          notifyTimerEvent(retroId, retro, "started");
        }
      });
      state.retros = nextRetros;
      syncTimerNotifications(state.retros);
      const routeId = routeRetroId();
      if (window.location.hash === "#rooms") { state.view = "rooms"; detach(state.cardsCleanup); render(); }
      else if (routeId && state.retros[routeId]) { state.selectedRetroId = routeId; state.view = "board"; attachCards(); }
      else {
        state.selectedRetroId = state.team?.activeRetroId || Object.keys(state.retros)[0] || null;
        state.view = "archive";
        detach(state.cardsCleanup);
        state.ownCards = {}; state.allCards = {}; state.discussions = {}; state.readiness = {};
        render();
      }
    }));
    state.listenerCleanups.push(listen(ref("members"), (snap) => { state.members = snap.val() || {}; render(); }));
    watchAccessRequests();
  }

  function watchAccessRequests() {
    detach(state.requestCleanups);
    if (!isAdmin()) return;
    state.requests = {};
    const requestsReference = requestRef();
    const onAdded = (snap) => { state.requests = { ...state.requests, [snap.key]: snap.val() }; render(); };
    const onChanged = (snap) => { state.requests = { ...state.requests, [snap.key]: snap.val() }; render(); };
    const onRemoved = (snap) => {
      const { [snap.key]: removed, ...remaining } = state.requests;
      state.requests = remaining;
      render();
    };
    const onError = (error) => { state.error = friendlyError(error); render(); };
    requestsReference.on("child_added", onAdded, onError);
    requestsReference.on("child_changed", onChanged, onError);
    requestsReference.on("child_removed", onRemoved, onError);
    state.requestCleanups.push(() => requestsReference.off("child_added", onAdded));
    state.requestCleanups.push(() => requestsReference.off("child_changed", onChanged));
    state.requestCleanups.push(() => requestsReference.off("child_removed", onRemoved));
  }

  function watchMembership() {
    if (!state.user) return;
    const memberReference = ref(`members/${state.user.uid}`);
    memberReference.on("value", (snap) => {
      const wasMember = Boolean(state.member); const wasAdmin = isAdmin(); state.member = snap.val();
      if (state.member && !wasMember) attachMemberData();
      if (state.member && !wasAdmin && isAdmin()) attachMemberData();
      if (!state.member && wasMember) { detach(state.listenerCleanups); detach(state.requestCleanups); detach(state.cardsCleanup); state.retros = {}; state.requests = {}; state.readiness = {}; syncTimerNotifications({}); }
      render();
    }, (error) => { state.member = null; state.error = friendlyError(error); render(); });
    state.membershipCleanups.push(() => memberReference.off("value"));
    const ownRequest = requestRef(state.user.uid);
    ownRequest.on("value", (snap) => {
      if (!state.member) {
        state.requests = snap.val() ? { [state.user.uid]: snap.val() } : {};
        render();
      }
    });
    state.membershipCleanups.push(() => ownRequest.off("value"));
  }

  app.addEventListener("click", (event) => {
    const button = event.target.closest("[data-action]");
    if (state.member || ["start-room", "join-room", "request-access"].includes(button?.dataset.action)) requestTimerNotifications();
    if (!button) return;
    const { action, column, cardId, authorId, uid } = button.dataset;
    if (action === "request-access") requestAccess();
    if (action === "start-room") startRoom();
    if (action === "join-room") joinRoom();
    if (action === "open-legacy-room") activateRoom(button.dataset.room);
    if (action === "withdraw-request") withdrawRequest();
    if (action === "approve") approve(uid);
    if (action === "make-admin") makeAdmin(uid);
    if (action === "remove-member") removeMember(uid);
    if (action === "add-card") openCard(column);
    if (action === "edit-card") { const card = findCard(authorId, cardId); if (card) openCard(card.column, card); }
    if (action === "delete-card") deleteCard(authorId, cardId);
    if (action === "toggle-ready") toggleReady();
    if (action === "start-timer") startWritingTimer();
    if (action === "reveal") reveal();
    if (action === "hide") hideResponses();
    if (action === "toggle-discussed") toggleDiscussed(authorId, cardId);
    if (action === "show-all") { state.discussionFilter = "all"; render(); }
    if (action === "show-undiscussed") { state.discussionFilter = "undiscussed"; render(); }
    if (action === "new-retro") openRetroDialog();
    if (action === "delete-retro") openDeleteRetroDialog(button.dataset.retroId || state.selectedRetroId);
    if (action === "open-retro") openRetro(button.dataset.retroId);
    if (action === "archive") openArchive();
    if (action === "rooms") openRooms();
    if (action === "room-lobby") openRoomLobby();
    if (action === "leave-room") leaveRoom();
    if (action === "copy-room") copyRoomLink();
  });
  app.addEventListener("change", (event) => {
    if (event.target.id === "retro-picker") openRetro(event.target.value);
  });
  app.addEventListener("input", (event) => {
    if (event.target.id !== "archive-search") return;
    state.archiveSearch = event.target.value;
    renderArchiveResults();
  });
  cardText.addEventListener("input", () => { cardCount.textContent = cardText.value.length; });
  cardForm.addEventListener("submit", (event) => {
    event.preventDefault();
    saveCard();
  });
  retroForm.addEventListener("submit", (event) => {
    event.preventDefault();
    createRetro();
  });
  document.querySelectorAll('[data-dialog-cancel="card"]').forEach((button) => button.addEventListener("click", () => { cardDialog.close(); state.editing = null; }));
  document.querySelectorAll('[data-dialog-cancel="retro"]').forEach((button) => button.addEventListener("click", () => retroDialog.close()));
  document.querySelectorAll('[data-dialog-cancel="delete-retro"]').forEach((button) => button.addEventListener("click", () => deleteRetroDialog.close()));
  deleteRetroDialog.addEventListener("close", () => {
    if (!state.deletingRetro) state.pendingDeleteRetroId = null;
  });
  deleteRetroDialog.addEventListener("cancel", (event) => {
    if (state.deletingRetro) event.preventDefault();
  });
  deleteRetroForm.addEventListener("submit", (event) => {
    event.preventDefault();
    deleteRetro();
  });
  window.addEventListener("hashchange", applyRoute);
  document.addEventListener("visibilitychange", () => { if (document.visibilityState === "visible") stopTitleFlash(); });

  async function start() {
    if (!validConfig()) { render(); return; }
    firebase.initializeApp(config); auth = firebase.auth(); db = firebase.database();
    await auth.setPersistence(firebase.auth.Auth.Persistence.LOCAL);
    auth.onAuthStateChanged(async (user) => {
      resetRoomState(); state.user = user;
      if (!user) { render(); try { await auth.signInAnonymously(); } catch (error) { state.error = friendlyError(error); render(); } return; }
      const remembered = localStorage.getItem(ROOM_STORAGE_KEY);
      const room = roomFromUrl() || remembered;
      if (room) activateRoom(room, true);
      else render();
    });
  }

  start();
})();
