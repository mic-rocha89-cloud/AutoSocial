const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs/promises");
const os = require("os");
const path = require("path");

const { moveWithTimestamp, writeJsonAtomically } = require("../src/fs-utils");

async function makeTempDir() {
  return fs.mkdtemp(path.join(os.tmpdir(), "autosocial-fs-"));
}

test("moveWithTimestamp archives a file without losing content", async () => {
  const root = await makeTempDir();
  const source = path.join(root, "source video.mp4");
  const archiveDir = path.join(root, "posted");
  await fs.mkdir(archiveDir);
  await fs.writeFile(source, "video-content");

  const archivedPath = await moveWithTimestamp(source, archiveDir);

  assert.equal(await fs.readFile(archivedPath, "utf8"), "video-content");
  await assert.rejects(fs.access(source));
  assert.equal(path.dirname(archivedPath), archiveDir);
  assert.match(path.basename(archivedPath), /source_video_[a-f0-9]{8}\.mp4$/);
});

test("writeJsonAtomically persists complete JSON without leaving a temp file", async () => {
  const root = await makeTempDir();
  const target = path.join(root, "uncertain", "claim.json");

  await writeJsonAtomically(target, {
    outcome: "uncertain",
    retryAllowed: false,
  });

  assert.deepEqual(JSON.parse(await fs.readFile(target, "utf8")), {
    outcome: "uncertain",
    retryAllowed: false,
  });
  assert.deepEqual(
    (await fs.readdir(path.dirname(target))).sort(),
    ["claim.json"]
  );
});
