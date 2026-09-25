# Retro Board

A small, polished retrospective board for one work team. It has a fixed **What Went Well / To Improve / Action Items** layout, live updates, lightweight history, and a proper private-writing phase.

The important privacy property is enforced in Firebase Realtime Database rules: while a retro is hidden, a member’s browser is only allowed to read `cards/<retro>/<their UID>`. Other people’s cards are not merely hidden in the UI—they are not sent to that member at all. When an admin reveals the retro, the rules permit the shared card collection to be read; an admin can hide it again at any time.

## What it includes

- Anonymous Firebase identity with browser-local persistence
- Independent shareable rooms; the creator of each room is its first admin
- Admin-approved teammate access requests
- Three fixed retrospective columns
- Add, edit, and delete only your own cards
- Member-only readiness markers and an admin view of the room’s ready check-in
- Admin-controlled 1-, 5-, or 10-minute writing timer with browser notifications
- Admin-only reveal, re-hide, and new-retro creation
- Realtime card updates plus a searchable Retro Archive with stable IDs and shareable direct links
- Admin discussion checkmarks and an Undiscussed focus view after a retro is revealed
- Responsive dark interface with no build step or paid dependency

## Required one-time setup

This repository deliberately does **not** include your Firebase project configuration. A Firebase web config is normally public, but keeping project values out of the repository makes this starter safe to reuse. The deployed workflow injects it from GitHub Actions.

### 1. Create or select a Firebase project

You can reuse the Firebase project from Scrum Poker or make a separate project. In the Firebase Console:

1. Create a **Web app** in the project (or use an existing web app) and copy its configuration object.
2. Go to **Authentication → Sign-in method** and enable **Anonymous**.
3. Go to **Realtime Database** and create a database. Start in locked mode; pick the same region you want to keep long-term.
4. Open **Realtime Database → Rules** and replace the rules with the contents of [`firebase.database.rules.json`](firebase.database.rules.json). Publish them.

Whenever this repository updates `firebase.database.rules.json`, publish the revised file in that same Rules tab. GitHub Pages deploys the website automatically, but Firebase rules are a separate security setting.

You may deploy the rules with the Firebase CLI instead:

```bash
npm install --global firebase-tools
firebase login
firebase use YOUR_PROJECT_ID
firebase deploy --only database
```

The first person to create a room becomes that room’s initial admin. Share its room link or six-character code with teammates; they request access and an admin approves them. Approval is stored against that browser’s Firebase anonymous identity, so an approved teammate can return for future retros without asking again. Promote at least one trusted teammate to admin from **Room members** so a single browser identity cannot strand the room.

An approved teammate will need approval again if they clear browser/site data, use a private window or another browser/device, lose their anonymous Firebase identity, are removed by an admin, or choose **Leave room**.

### 2. Configure GitHub Pages deployment

In the GitHub repository’s **Settings → Secrets and variables → Actions**:

1. Add a repository **secret** named `FIREBASE_CONFIG_JSON`. Its value must be the Firebase web config as compact JSON, for example:

   ```json
   {"apiKey":"AIza...","authDomain":"your-project.firebaseapp.com","databaseURL":"https://your-project-default-rtdb.firebaseio.com","projectId":"your-project","appId":"1:123:web:abc"}
   ```

2. In **Settings → Pages**, set Source to **GitHub Actions**.
3. Push to `main` (or run the **Deploy Retro Board to GitHub Pages** workflow). The workflow creates `firebase-config.js` only in the build artifact and deploys it to Pages.

`RETRO_TEAM_ID` is no longer required. You may leave the existing repository variable in place for compatibility with the original room; enter that room code from the Rooms page whenever you need its history.

The values in a Firebase web configuration are visible to site visitors by design. Do not put an Admin SDK service-account key, a private key, an API token, or any other server secret in `FIREBASE_CONFIG_JSON`.

### Local development

Copy `firebase-config.example.js` to `firebase-config.js`, fill in your Firebase web config, then open the project with any static web server. `firebase-config.js` is ignored by Git.

For example:

```bash
npx serve .
```

For local development and the deployed Pages URL, add their hostnames under **Authentication → Settings → Authorized domains** if Firebase asks you to do so. `localhost` is normally present already.

## Data model and access boundaries

```text
teams/<teamId>
  meta                 # room title, room code, current retro
  members/<uid>        # approved members and admin role
  retros/<retroId>     # title, hidden/revealed state, and admin-controlled timer timestamps
  readiness/<retroId>/<uid>  # a member's private ready marker
  cards/<retroId>/<uid>/<cardId>
  discussions/<retroId>/<cardAuthorUid>/<cardId>  # admin-managed, revealed-only checkmarks

accessRequests/<teamId>/<uid>
```

Anonymous Authentication gives each browser a real Firebase UID that persists locally. The database rules bind card writes to that UID, so changing browser storage cannot turn a member into an admin or expose someone else’s hidden cards.

While a retro is hidden, each approved member can mark themselves ready. The marker is private to that member and room admins; it does not reveal whether they wrote cards or how many. The admin’s count uses all approved room members, including those not currently online. Adding, editing, or deleting a card atomically clears that member’s ready marker.

Only admins can start the writing timer. Its countdown is based on shared start/end timestamps rather than per-second database updates. Browser notifications are optional and best-effort: they require permission and an open, connected app tab. Background tabs get alerts when the timer starts and expires; visible tabs use the on-page timer. Closing the browser or losing the connection prevents notifications, and the timer never reveals responses automatically.

## Security notes

- The frontend never downloads all cards while `status` is `hidden`. Hiding a revealed retro immediately clears shared cards and discussion markers from the active browser view before the database update finishes.
- The rules also block direct database reads of other people’s hidden card paths.
- Only an existing admin can reveal or re-hide a retro, create retros, edit room metadata, approve people, or assign admin roles. This is enforced by the database rules, not just the interface.
- Only admins can write timer settings. Members can read and change only their own readiness marker; admins can read the room’s markers. The timer and readiness permissions are enforced by database rules.
- Members can only write below their own UID card path.
- Only room admins can mark a revealed card as discussed; every member can see that marker after reveal.
- Members may remove only their own membership record to leave a room; admins can remove other members.
- Anonymous auth is a lightweight identity, not corporate SSO. The approval queue is intentionally included so a visitor cannot simply self-enroll as a member. For stricter corporate identity, switch Firebase Auth to Google or email sign-in and adapt the onboarding rules.

Hiding a retro restores database access to own-card-only visibility. It cannot retract text someone already copied, saved, or screenshotted while the retro was revealed.

## Quick verification

1. Create a room in one browser and request access from another; approve the request and refresh both browsers to confirm the membership remains approved.
2. Create a hidden retro. Mark members ready in turn and confirm only the admin sees the room-wide names/count; each member should see only their own status.
3. Add, edit, or delete a card after marking ready and confirm that member’s ready marker clears. Confirm a different member’s marker is unchanged.
4. Start each timer preset as admin and verify the countdown syncs across browsers. At zero, confirm the board stays hidden and background tabs with notification permission get an alert.
5. While hidden, confirm a member sees only their own cards. Reveal the retro and confirm all approved members see every card and discussion marker live.
6. Mark cards discussed, use **All** and **Undiscussed**, then choose **Hide responses**. Shared cards and markers should disappear immediately, leaving each member with only their own cards.
7. Create another retro and confirm earlier retros remain in the archive after refreshing the page.

## Repository files

- `index.html`, `styles.css`, `app.js`, `retro-workflow.js` — dependency-free app
- `firebase.database.rules.json` — security rules to publish
- `tests/` — dependency-free Node.js checks for workflow helpers and the checked-in rules
- `firebase-config.example.js` — safe local config template
- `.github/workflows/deploy-pages.yml` — GitHub Pages deployment
