const test = require("node:test");
const assert = require("node:assert/strict");
const rules = require("../firebase.database.rules.json").rules;

const team = rules.teams.$teamId;
const adminRole = "root.child('teams').child($teamId).child('members').child(auth.uid).child('role').val() === 'admin'";

test("only approved members read the timer-bearing retro record and only admins write it", () => {
  const retro = team.retros.$retroId;
  assert.match(retro[".read"], /members.*exists\(\)/);
  assert.equal(retro[".write"], `auth != null && ${adminRole}`);
  assert.match(retro[".validate"], /timerDurationSeconds/);
  assert.match(retro[".validate"], /timerEndsAt/);
});

test("readiness is private to its member except that admins can review the retro roster", () => {
  const readiness = team.readiness.$retroId;
  const member = readiness.$memberId;
  assert.equal(readiness[".read"], `auth != null && ${adminRole}`);
  assert.match(member[".read"], /auth\.uid === \$memberId/);
  assert.match(member[".read"], /role.*admin/);
  assert.match(member[".write"], /auth\.uid === \$memberId/);
  assert.match(member[".write"], /members.*exists\(\)/);
  assert.match(member[".validate"], /readyAt/);
});

test("hidden card reads remain restricted to the author and revealed boards", () => {
  const cards = team.cards.$retroId;
  assert.match(cards[".read"], /status'\)\.val\(\) === 'revealed'/);
  assert.match(cards.$authorId[".read"], /auth\.uid === \$authorId/);
});
