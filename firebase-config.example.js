/*
 * Copy this file to firebase-config.js for local development, then replace the
 * placeholders with the Web app configuration from Firebase Console.
 *
 * The production GitHub Pages workflow creates firebase-config.js from the
 * FIREBASE_CONFIG_JSON GitHub Actions secret instead, so the repo contains no
 * project-specific configuration. Firebase web configuration identifies a
 * project but is not a server secret; database rules are the real protection.
 */
window.RETRO_FIREBASE_CONFIG = {
  apiKey: "YOUR_API_KEY",
  authDomain: "YOUR_PROJECT_ID.firebaseapp.com",
  databaseURL: "https://YOUR_PROJECT_ID-default-rtdb.firebaseio.com",
  projectId: "YOUR_PROJECT_ID",
  appId: "YOUR_WEB_APP_ID"
};

// Use a short, non-guessable permanent ID, for example "northstar-team-7m3q".
// This is a routing identifier, not a password. Access is controlled by rules.
window.RETRO_TEAM_ID = "YOUR_TEAM_ID";
