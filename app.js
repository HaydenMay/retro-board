/* global firebase */
(() => {
  "use strict";

  const config = window.RETRO_FIREBASE_CONFIG;
  const LEGACY_TEAM_ID = window.RETRO_LEGACY_ROOM_ID || window.RETRO_TEAM_ID;
  const ROOM_STORAGE_KEY = "retro-board-last-room";
  const app = document.querySelector("#app");
  const cardDialog = document.querySelector("#card-dialog");
  const retroDialog = document.querySelector("#retro-dialog");
  const cardForm = document.querySelector("#card-form");
  const retroForm = document.querySelector("#retro-form");
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
    ownCards: {},
    allCards: {},
    listenerCleanups: [],
    membershipCleanups: [],
    cardsCleanup: [],
    error: "",
    message: "",
    editing: null,
    pending: false
  };

  let db;
  let auth;
  let archiveSearchTimer;

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
  function setFeedback(message = "", error = "") { state.message = message; state.error = error; }

  function ref(path = "") { return db.ref(`teams/${state.teamId}${path ? `/${path}` : ""}`); }
  function requestRef(path = "") { return db.ref(`accessRequests/${state.teamId}${path ? `/${path}` : ""}`); }

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

  function flattenCards(tree) {
    return Object.entries(tree || {}).flatMap(([authorId, cards]) => Object.entries(cards || {}).map(([id, card]) => ({ id, authorId, ...card })))
      .filter((card) => COLUMNS.some((column) => column.id === card.column))
      .sort((a, b) => (a.createdAt || 0) - (b.createdAt || 0));
  }

  function render() {
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
    app.innerHTML = state.view === "board" && activeRetro() ? boardScreen() : archiveScreen();
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
      <p class="eyebrow">PRIVATE TEAM RETROS</p>
      <h1>Choose a retro room</h1>
      <p>Each room is an independent, retained retrospective space. The person who creates a new room becomes its first admin.</p>
      <div class="lobby-grid">
        <section class="lobby-option"><h2>Start a room</h2><p>Create a new room and receive a shareable six-character code.</p><label>Your display name<input id="start-name" maxlength="60" value="${esc(savedName)}" placeholder="e.g. Alex Rivera" /></label><label>Team name<input id="start-team-name" maxlength="100" placeholder="e.g. Product Team" /></label><button class="button primary full" data-action="start-room">Create room</button></section>
        <section class="lobby-option"><h2>Join a room</h2><p>Enter the room code someone shared with you.</p><label>Room code<input id="join-room-code" maxlength="32" placeholder="e.g. 7XQ2KM" autocapitalize="characters" /></label><button class="button full" data-action="join-room">Find room</button></section>
      </div>
      ${state.error ? `<p class="error">${esc(state.error)}</p>` : ""}${state.message ? `<p class="success">${esc(state.message)}</p>` : ""}
      <p class="muted">Keep at least two admins in an important room. Admins can promote trusted teammates from the room’s access section.</p>
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
      <div class="stack">${request ? `<button class="button ghost full" data-action="withdraw-request">Withdraw request</button>` : `<button class="button primary full" data-action="request-access">Request access</button>`}<button class="button ghost full" data-action="rooms">Back to rooms</button></div>
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
        <div class="toolbar-actions">${isAdmin() && !isRevealed ? `<button class="button primary" data-action="reveal">Reveal board</button>` : ""}${isAdmin() ? `<button class="button" data-action="new-retro">+ New retro</button>` : ""}</div>
      </section>
      <p class="retro-id">Retro ID: <code>${esc(retroCode(state.selectedRetroId, retro))}</code></p>
      ${!isRevealed ? `<aside class="private-note"><span aria-hidden="true">🔒</span><p><strong>Private writing.</strong> Teammates’ cards stay hidden until you reveal the board.</p></aside>` : ""}
      <section class="board">${COLUMNS.map((column) => columnMarkup(column)).join("")}</section>
      ${isAdmin() ? adminAccessMarkup() : ""}
      ${state.error ? `<p class="error">${esc(state.error)}</p>` : ""}
      ${state.message ? `<p class="success">${esc(state.message)}</p>` : ""}
    </div>`;
  }

  function archiveScreen() {
    const retros = Object.entries(state.retros)
      .sort(([, a], [, b]) => (b.createdAt || 0) - (a.createdAt || 0));
    const query = state.archiveSearch.trim().toLowerCase();
    const matching = retros.filter(([id, retro]) => !query || `${retro.title || ""} ${retroCode(id, retro)} ${id}`.toLowerCase().includes(query));
    return `<div class="shell">
      <header class="topbar">
        <button class="brand brand-link" data-action="archive" aria-label="Return to Retro Archive"><span class="brand-mark">R</span> Retro Board</button>
        <div class="identity"><span class="avatar">${esc(initials(nameFromMember(state.member)))}</span><span>${esc(nameFromMember(state.member))}${isAdmin() ? " · Admin" : ""}</span>${!isAdmin() ? `<button class="plain-button leave-link" data-action="leave-room">Leave room</button>` : ""}<button class="plain-button" data-action="rooms">Rooms</button></div>
      </header>
      <section class="hero archive-hero">
        <div><p class="eyebrow">${esc(state.team?.name || "YOUR TEAM")}</p><h1>Retro archive</h1><p class="subtitle">Every retrospective stays here. Open a board to continue it, revisit its actions, or share its exact ID with the team.</p><p class="room-code">Room code <code>${esc(roomLabel())}</code> <button class="plain-button" data-action="copy-room">Copy link</button></p></div>
        ${isAdmin() ? `<button class="button primary archive-new" data-action="new-retro">+ New retro</button>` : ""}
      </section>
      <section class="archive-controls"><label class="search-label">Find a retro<input id="archive-search" value="${esc(state.archiveSearch)}" placeholder="Search title or Retro ID" /></label><p class="archive-count">${retros.length} ${retros.length === 1 ? "retro" : "retros"} saved</p></section>
      <section class="retro-list">${matching.length ? matching.map(([id, retro]) => retroListItem(id, retro)).join("") : `<div class="empty-archive"><h2>${retros.length ? "No matching retros" : "No retros yet"}</h2><p>${retros.length ? "Try another title or Retro ID." : isAdmin() ? "Create your first retro to begin." : "An admin will create the first retro soon."}</p>${!retros.length && isAdmin() ? `<button class="button primary" data-action="new-retro">Create first retro</button>` : ""}</div>`}</section>
      ${state.error ? `<p class="error">${esc(state.error)}</p>` : ""}${state.message ? `<p class="success">${esc(state.message)}</p>` : ""}
    </div>`;
  }

  function retroListItem(id, retro) {
    const revealed = retro.status === "revealed";
    const creator = retro.createdBy ? nameFromMember(state.members[retro.createdBy]) : "Team";
    return `<button class="retro-list-item" data-action="open-retro" data-retro-id="${esc(id)}" aria-label="Open ${esc(retro.title || "Untitled retro")}"><span class="retro-list-copy"><span class="retro-list-topline"><span class="retro-state ${revealed ? "revealed" : "hidden"}">${revealed ? "Revealed" : "Private"}</span><code>${esc(retroCode(id, retro))}</code></span><span class="retro-list-title">${esc(retro.title || "Untitled retro")}</span><span class="retro-list-meta">Created ${esc(dateTimeLabel(retro.createdAt))} by ${esc(creator)}</span></span><span class="retro-open-hint">Open →</span></button>`;
  }

  function columnMarkup(column) {
    const cards = flattenCards(currentCards()).filter((card) => card.column === column.id);
    return `<article class="column"><div class="column-head"><h2 class="column-title">${column.title}</h2><span class="card-count">${cards.length}</span></div><div class="cards">${cards.length ? cards.map((card) => cardMarkup(card, column)).join("") : `<p class="empty-column">Nothing here yet.</p>`}</div><button class="button add-card" data-action="add-card" data-column="${column.id}">+ Add card</button></article>`;
  }

  function cardMarkup(card, column) {
    const own = card.authorId === state.user.uid;
    const owner = own ? "You" : nameFromMember(state.members[card.authorId]);
    return `<article class="retro-card ${column.cardClass}"><p class="card-text">${esc(card.text)}</p><footer class="card-footer"><span class="card-owner">${esc(owner)}</span>${own ? `<span class="card-menu"><button data-action="edit-card" data-card-id="${esc(card.id)}" data-author-id="${esc(card.authorId)}">Edit</button><button data-action="delete-card" data-card-id="${esc(card.id)}" data-author-id="${esc(card.authorId)}">Delete</button></span>` : ""}</footer></article>`;
  }

  function adminAccessMarkup() {
    const requests = Object.entries(state.requests).sort(([, a], [, b]) => (a.requestedAt || 0) - (b.requestedAt || 0));
    const members = Object.entries(state.members).sort(([, a], [, b]) => a.name.localeCompare(b.name));
    return `<section class="admin-access"><header class="access-heading"><div><p class="eyebrow">ROOM ACCESS</p><h2>Members</h2><p>Keep a second trusted admin so the room is not tied to one browser.</p></div><span class="member-total">${members.length} ${members.length === 1 ? "member" : "members"}</span></header><div class="member-list">${members.map(([uid, member]) => `<div class="member-row"><span><span class="request-name">${esc(member.name || "Unnamed teammate")}</span><span class="request-date">${member.role === "admin" ? "Admin" : "Member"}</span></span>${uid === state.user.uid ? `<span class="role-label">You</span>` : member.role === "admin" ? `<span class="member-actions"><span class="role-label">Admin</span><button class="button small danger" data-action="remove-member" data-uid="${esc(uid)}">Remove</button></span>` : `<span class="member-actions"><button class="button small" data-action="make-admin" data-uid="${esc(uid)}">Make admin</button><button class="button small danger" data-action="remove-member" data-uid="${esc(uid)}">Remove</button></span>`}</div>`).join("")}</div>${requests.length ? `<section class="access-requests"><h3>Access requests <span>${requests.length}</span></h3>${requests.map(([uid, request]) => `<div class="member-row"><span><span class="request-name">${esc(request.name || "Unnamed teammate")}</span><span class="request-date">Requested ${dateLabel(request.requestedAt)}</span></span><button class="button small primary" data-action="approve" data-uid="${esc(uid)}">Approve</button></div>`).join("")}</section>` : ""}</section>`;
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
    try { await ref(`members/${uid}`).set({ name: request.name || "Teammate", role: "member", joinedAt: Date.now() }); await requestRef(uid).remove(); setFeedback(`${request.name || "Teammate"} can now join the board.`); }
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
    detach(state.listenerCleanups); detach(state.membershipCleanups); detach(state.cardsCleanup);
    state.member = null; state.team = null; state.retros = {}; state.members = {}; state.requests = {};
    state.selectedRetroId = null; state.view = "archive"; state.archiveSearch = ""; state.ownCards = {}; state.allCards = {};
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

  function openRooms() {
    resetRoomState(); state.teamId = ""; localStorage.removeItem(ROOM_STORAGE_KEY); updateRoomUrl(""); render();
  }

  async function leaveRoom() {
    if (isAdmin()) return;
    if (!confirm("Leave this room? You will need to request access again to return.")) return;
    try {
      await ref(`members/${state.user.uid}`).remove();
      openRooms();
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
        await ref(`cards/${retroId}/${state.user.uid}/${state.editing.id}`).update({ text, updatedAt: now });
      } else {
        const newRef = ref(`cards/${retroId}/${state.user.uid}`).push();
        await newRef.set({ authorId: state.user.uid, column: state.editing.column, text, createdAt: now, updatedAt: now });
      }
      cardDialog.close(); state.editing = null;
    } catch (error) { setFeedback("", friendlyError(error)); render(); }
  }

  function findCard(authorId, cardId) { return flattenCards(activeRetro()?.status === "revealed" ? state.allCards : state.ownCards).find((card) => card.authorId === authorId && card.id === cardId); }
  async function deleteCard(authorId, cardId) { if (!confirm("Delete this card?")) return; try { await ref(`cards/${state.selectedRetroId}/${authorId}/${cardId}`).remove(); } catch (error) { setFeedback("", friendlyError(error)); render(); } }

  async function reveal() { if (!confirm("Reveal all responses to the team? This cannot be undone.")) return; try { await ref(`retros/${state.selectedRetroId}`).update({ status: "revealed", revealedAt: Date.now(), revealedBy: state.user.uid }); } catch (error) { setFeedback("", friendlyError(error)); render(); } }
  function openRetroDialog() { document.querySelector("#retro-title").value = ""; retroDialog.showModal(); document.querySelector("#retro-title").focus(); }
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
    state.selectedRetroId = id;
    state.view = "board";
    setHash(`#retro=${encodeURIComponent(id)}`, replace);
    attachCards();
  }

  function openArchive(replace = false) {
    state.view = "archive";
    detach(state.cardsCleanup);
    setHash("#retros", replace);
    render();
  }

  function applyRoute() {
    const id = routeRetroId();
    if (id && state.retros[id]) openRetro(id, true);
    else openArchive(true);
  }

  function attachCards() {
    detach(state.cardsCleanup); state.ownCards = {}; state.allCards = {};
    const retro = activeRetro(); if (!retro || !state.user) { render(); return; }
    state.cardsCleanup.push(listen(ref(`cards/${state.selectedRetroId}/${state.user.uid}`), (snap) => { state.ownCards = { [state.user.uid]: snap.val() || {} }; render(); }));
    if (retro.status === "revealed") state.cardsCleanup.push(listen(ref(`cards/${state.selectedRetroId}`), (snap) => { state.allCards = snap.val() || {}; render(); }));
    render();
  }

  function attachMemberData() {
    detach(state.listenerCleanups);
    state.listenerCleanups.push(listen(ref("meta"), (snap) => { state.team = snap.val() || {}; render(); }));
    state.listenerCleanups.push(listen(ref("retros"), (snap) => {
      state.retros = snap.val() || {};
      const routeId = routeRetroId();
      if (routeId && state.retros[routeId]) { state.selectedRetroId = routeId; state.view = "board"; attachCards(); }
      else { state.selectedRetroId = state.team?.activeRetroId || Object.keys(state.retros)[0] || null; state.view = "archive"; detach(state.cardsCleanup); render(); }
    }));
    state.listenerCleanups.push(listen(ref("members"), (snap) => { state.members = snap.val() || {}; render(); }));
    if (isAdmin()) state.listenerCleanups.push(listen(requestRef(), (snap) => { state.requests = snap.val() || {}; render(); }));
  }

  function watchMembership() {
    if (!state.user) return;
    const memberReference = ref(`members/${state.user.uid}`);
    memberReference.on("value", (snap) => {
      const wasMember = Boolean(state.member); const wasAdmin = isAdmin(); state.member = snap.val();
      if (state.member && !wasMember) attachMemberData();
      if (state.member && !wasAdmin && isAdmin()) attachMemberData();
      if (!state.member && wasMember) { detach(state.listenerCleanups); detach(state.cardsCleanup); state.retros = {}; }
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
    const button = event.target.closest("[data-action]"); if (!button) return;
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
    if (action === "reveal") reveal();
    if (action === "new-retro") openRetroDialog();
    if (action === "open-retro") openRetro(button.dataset.retroId);
    if (action === "archive") openArchive();
    if (action === "rooms") openRooms();
    if (action === "leave-room") leaveRoom();
    if (action === "copy-room") copyRoomLink();
  });
  app.addEventListener("change", (event) => {
    if (event.target.id === "retro-picker") openRetro(event.target.value);
    if (event.target.id === "archive-search") { state.archiveSearch = event.target.value; render(); }
  });
  app.addEventListener("input", (event) => {
    if (event.target.id !== "archive-search") return;
    state.archiveSearch = event.target.value;
    window.clearTimeout(archiveSearchTimer);
    archiveSearchTimer = window.setTimeout(() => {
      if (state.view !== "archive") return;
      const cursor = state.archiveSearch.length;
      render();
      const input = document.querySelector("#archive-search");
      input?.focus(); input?.setSelectionRange(cursor, cursor);
    }, 150);
  });
  cardText.addEventListener("input", () => { cardCount.textContent = cardText.value.length; });
  cardForm.addEventListener("submit", (event) => { event.preventDefault(); saveCard(); });
  retroForm.addEventListener("submit", (event) => { event.preventDefault(); createRetro(); });
  window.addEventListener("hashchange", applyRoute);

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
