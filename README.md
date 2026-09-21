# Retro Board

A small, polished retrospective board for one work team. It has a fixed **What Went Well / To Improve / Action Items** layout, live updates, lightweight history, and a proper private-writing phase.

The important privacy property is enforced in Firebase Realtime Database rules: while a retro is hidden, a member’s browser is only allowed to read `cards/<retro>/<their UID>`. Other people’s cards are not merely hidden in the UI—they are not sent to that member at all. When an admin reveals the retro, the rules permit the shared card collection to be read.

## What it includes

- Anonymous Firebase identity with browser-local persistence
- One durable team; first creator is the admin
- Admin-approved teammate access requests
- Three fixed retrospective columns
- Add, edit, and delete only your own cards
- Admin-only reveal and new-retro creation
- Realtime card updates and retro history
- Responsive dark interface with no build step or paid dependency

## Required one-time setup

This repository deliberately does **not** include your Firebase project configuration. A Firebase web config is normally public, but keeping project values out of the repository makes this starter safe to reuse. The deployed workflow injects it from GitHub Actions.

### 1. Create or select a Firebase project

You can reuse the Firebase project from Scrum Poker or make a separate project. In the Firebase Console:

1. Create a **Web app** in the project (or use an existing web app) and copy its configuration object.
2. Go to **Authentication → Sign-in method** and enable **Anonymous**.
3. Go to **Realtime Database** and create a database. Start in locked mode; pick the same region you want to keep long-term.
4. Open **Realtime Database → Rules** and replace the rules with the contents of [`firebase.database.rules.json`](firebase.database.rules.json). Publish them.

You may deploy the rules with the Firebase CLI instead:

```bash
npm install --global firebase-tools
firebase login
firebase use YOUR_PROJECT_ID
firebase deploy --only database
```

The first person to use the deployed board should be the intended administrator. They choose **Set up this team** and become the sole initial admin. Everyone else requests access; the admin approves them in the board. Do that before sharing the Pages URL widely.

### 2. Configure GitHub Pages deployment

In the GitHub repository’s **Settings → Secrets and variables → Actions**:

1. Add a repository **secret** named `FIREBASE_CONFIG_JSON`. Its value must be the Firebase web config as compact JSON, for example:

   ```json
   {"apiKey":"AIza...","authDomain":"your-project.firebaseapp.com","databaseURL":"https://your-project-default-rtdb.firebaseio.com","projectId":"your-project","appId":"1:123:web:abc"}
   ```

2. Add a repository **variable** named `RETRO_TEAM_ID`, such as `engineering-9r7q`. Use a short, non-guessable permanent ID. It is a routing identifier, not a password—Firebase rules control access.
3. In **Settings → Pages**, set Source to **GitHub Actions**.
4. Push to `main` (or run the **Deploy Retro Board to GitHub Pages** workflow). The workflow creates `firebase-config.js` only in the build artifact and deploys it to Pages.

The values in a Firebase web configuration are visible to site visitors by design. Do not put an Admin SDK service-account key, a private key, an API token, or any other server secret in `FIREBASE_CONFIG_JSON`.

### Local development

Copy `firebase-config.example.js` to `firebase-config.js`, fill in your Firebase web config and permanent team ID, then open the project with any static web server. `firebase-config.js` is ignored by Git.

For example:

```bash
npx serve .
```

For local development and the deployed Pages URL, add their hostnames under **Authentication → Settings → Authorized domains** if Firebase asks you to do so. `localhost` is normally present already.

## Data model and access boundaries

```text
teams/<teamId>
  meta                 # team title, current retro
  members/<uid>        # approved members and admin role
  retros/<retroId>     # title + hidden/revealed state
  cards/<retroId>/<uid>/<cardId>

accessRequests/<teamId>/<uid>
```

Anonymous Authentication gives each browser a real Firebase UID that persists locally. The database rules bind card writes to that UID, so changing browser storage cannot turn a member into an admin or expose someone else’s hidden cards.

## Security notes

- The frontend never downloads all cards while `status` is `hidden`.
- The rules also block direct database reads of other people’s hidden card paths.
- Only an existing admin can reveal a retro, create retros, edit team metadata, approve people, or assign roles.
- Members can only write below their own UID card path.
- Anonymous auth is a lightweight identity, not corporate SSO. The approval queue is intentionally included so a visitor cannot simply self-enroll as a member. For stricter corporate identity, switch Firebase Auth to Google or email sign-in and adapt the onboarding rules.

## Repository files

- `index.html`, `styles.css`, `app.js` — dependency-free app
- `firebase.database.rules.json` — security rules to publish
- `firebase-config.example.js` — safe local config template
- `.github/workflows/deploy-pages.yml` — GitHub Pages deployment
