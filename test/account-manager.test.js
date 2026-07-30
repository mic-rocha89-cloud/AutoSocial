const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");

const { _private } = require("../src/account-manager");

const {
  getCookieCandidates,
  hasSavedSessionInProfileDir,
  selectProfileDir,
} = _private;

async function createTempRoot(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "autosocial-account-manager-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  return root;
}

async function writeModernCookieDb(profileDir) {
  const cookieDb = path.join(profileDir, "Default", "Network", "Cookies");
  await fs.mkdir(path.dirname(cookieDb), { recursive: true });
  await fs.writeFile(cookieDb, "cookie-db");
}

test("session detection includes the modern Chromium cookie database", async (t) => {
  const root = await createTempRoot(t);
  const profileDir = path.join(root, "profile");
  await writeModernCookieDb(profileDir);

  assert.ok(
    getCookieCandidates(profileDir).includes(
      path.join(profileDir, "Default", "Network", "Cookies")
    )
  );
  assert.equal(await hasSavedSessionInProfileDir(profileDir), true);
});

test("profile selection prefers an authenticated modern profile", async (t) => {
  const root = await createTempRoot(t);
  const modernProfileDir = path.join(root, "modern");
  const legacyProfileDir = path.join(root, "legacy");
  await writeModernCookieDb(modernProfileDir);
  await writeModernCookieDb(legacyProfileDir);

  assert.equal(
    await selectProfileDir(modernProfileDir, legacyProfileDir),
    modernProfileDir
  );
});

test("profile selection preserves an authenticated legacy profile as fallback", async (t) => {
  const root = await createTempRoot(t);
  const modernProfileDir = path.join(root, "modern");
  const legacyProfileDir = path.join(root, "legacy");
  await fs.mkdir(modernProfileDir, { recursive: true });
  await writeModernCookieDb(legacyProfileDir);

  assert.equal(
    await selectProfileDir(modernProfileDir, legacyProfileDir),
    legacyProfileDir
  );
});

test("profile selection ignores an empty legacy directory", async (t) => {
  const root = await createTempRoot(t);
  const modernProfileDir = path.join(root, "modern");
  const legacyProfileDir = path.join(root, "legacy");
  await fs.mkdir(legacyProfileDir, { recursive: true });

  assert.equal(
    await selectProfileDir(modernProfileDir, legacyProfileDir),
    modernProfileDir
  );
});
