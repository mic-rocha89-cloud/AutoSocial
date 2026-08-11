const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs/promises");
const os = require("os");
const path = require("path");

const {
  assertClaimSnapshotReady,
  claimQueuedItem,
  getClaimMarkerPath,
  getNextQueuedItem,
  getQueueStateDirs,
  listQueueVideos,
} = require("../src/queue");

async function makeTempDir() {
  return fs.mkdtemp(path.join(os.tmpdir(), "autosocial-queue-"));
}

test("listQueueVideos returns only supported videos in sorted order", async () => {
  const dir = await makeTempDir();
  await fs.writeFile(path.join(dir, "b.mov"), "");
  await fs.writeFile(path.join(dir, "a.mp4"), "");
  await fs.writeFile(path.join(dir, "notes.txt"), "");

  const videos = await listQueueVideos(dir);

  assert.deepEqual(
    videos.map((filePath) => path.basename(filePath)),
    ["a.mp4", "b.mov"]
  );
});

test("getNextQueuedItem defers caption reads until after durable claim", async () => {
  const dir = await makeTempDir();
  const videoPath = path.join(dir, "clip.mp4");
  await fs.writeFile(videoPath, "");
  await fs.writeFile(path.join(dir, "clip.txt"), "txt caption");
  await fs.writeFile(path.join(dir, "clip.description"), "description caption");

  const item = await getNextQueuedItem(dir);

  assert.equal(item.videoPath, videoPath);
  assert.equal(item.caption, undefined);
  assert.deepEqual(
    item.captionPaths.map((filePath) => path.basename(filePath)),
    ["clip.description", "clip.txt"]
  );
});

test("claimQueuedItem atomically removes a selected video from pending", async () => {
  const root = await makeTempDir();
  const pending = path.join(root, "pending");
  await fs.mkdir(pending);
  const videoPath = path.join(pending, "clip.mp4");
  await fs.writeFile(videoPath, "video");
  await fs.writeFile(path.join(pending, "clip.description"), "caption");

  const item = await getNextQueuedItem(pending);
  const claim = await claimQueuedItem(item, pending);
  const stateDirs = getQueueStateDirs(pending);
  const markerPath = getClaimMarkerPath(videoPath, pending);
  const manifest = JSON.parse(await fs.readFile(markerPath, "utf8"));

  await assert.rejects(fs.access(videoPath));
  await assert.rejects(fs.access(path.join(pending, "clip.description")));
  assert.equal(path.dirname(path.dirname(claim.videoPath)), stateDirs.processing);
  assert.equal(await fs.readFile(claim.videoPath, "utf8"), "video");
  assert.equal(claim.caption, "caption");
  assert.deepEqual(
    claim.captionPaths.map((filePath) => path.basename(filePath)),
    ["clip.description"]
  );
  assert.equal(await fs.readFile(claim.captionPaths[0], "utf8"), "caption");
  assert.equal(claim.claimMarkerPath, markerPath);
  assert.equal(manifest.claimId, claim.claimId);
  assert.equal(manifest.item.originalPath, videoPath);
  assert.equal(manifest.item.snapshotPath, claim.videoPath);
  assert.equal(manifest.bindingPath, claim.snapshotBindingPath);
  assert.deepEqual(
    manifest.sidecars.map(({ originalPath, present }) => ({
      name: path.basename(originalPath),
      present,
    })),
    [
      { name: "clip.description", present: true },
      { name: "clip.txt", present: false },
    ]
  );
  assert.equal(await getNextQueuedItem(pending), null);
  assert.equal((await listQueueVideos(pending)).length, 0);
  assert.equal(await assertClaimSnapshotReady(claim), true);
});

test("queue source creates and checks the durable claim before any rename", async () => {
  const source = await fs.readFile(require.resolve("../src/queue"), "utf8");
  const claimStart = source.indexOf("async function claimQueuedItem");
  const claimEnd = source.indexOf("\nmodule.exports", claimStart);
  const claimSource = source.slice(claimStart, claimEnd);
  const markerIndex = claimSource.indexOf(
    "await createClaimMarker(claimMarkerPath, manifest)"
  );
  const renameIndex = claimSource.indexOf("await fs.rename(");
  const catchIndex = claimSource.indexOf("} catch (error) {");

  assert.ok(markerIndex >= 0);
  assert.ok(markerIndex < renameIndex);
  assert.ok(catchIndex >= 0);
  assert.match(
    source,
    /if \(!\(await hasActiveClaim\(videoPath, dir\)\)\)/
  );
  assert.doesNotMatch(
    claimSource.slice(catchIndex),
    /fs\.rename\(snapshotVideoPath,\s*item\.videoPath/
  );
});

test("valid snapshot remains bound when original video and sidecar names are replaced", async () => {
  const root = await makeTempDir();
  const pending = path.join(root, "pending");
  await fs.mkdir(pending);
  const videoPath = path.join(pending, "clip.mp4");
  const captionPath = path.join(pending, "clip.description");
  await fs.writeFile(videoPath, "claimed-video");
  await fs.writeFile(captionPath, "claimed-caption");

  const claim = await claimQueuedItem(
    await getNextQueuedItem(pending),
    pending
  );
  await fs.writeFile(videoPath, "replacement-video");
  await fs.writeFile(captionPath, "replacement-caption");

  assert.equal(await fs.readFile(claim.videoPath, "utf8"), "claimed-video");
  assert.equal(
    await fs.readFile(claim.captionPaths[0], "utf8"),
    "claimed-caption"
  );
  assert.equal(claim.caption, "claimed-caption");
  assert.equal(await assertClaimSnapshotReady(claim), true);
  assert.equal(await getNextQueuedItem(pending), null);
});

test("writes through pre-claim producer handles cannot change completed snapshots", async () => {
  const root = await makeTempDir();
  const pending = path.join(root, "pending");
  await fs.mkdir(pending);
  const videoPath = path.join(pending, "clip.mp4");
  const captionPath = path.join(pending, "clip.description");
  await fs.writeFile(videoPath, "video-before-snapshot");
  await fs.writeFile(captionPath, "caption-before-snapshot");
  const videoProducer = await fs.open(videoPath, "a");
  const captionProducer = await fs.open(captionPath, "a");

  try {
    const claim = await claimQueuedItem(
      await getNextQueuedItem(pending),
      pending
    );
    await videoProducer.writeFile("-video-after-snapshot");
    await captionProducer.writeFile("-caption-after-snapshot");

    assert.equal(
      await fs.readFile(claim.videoPath, "utf8"),
      "video-before-snapshot"
    );
    assert.equal(
      await fs.readFile(claim.captionPaths[0], "utf8"),
      "caption-before-snapshot"
    );
    assert.equal(claim.caption, "caption-before-snapshot");
    assert.equal(await assertClaimSnapshotReady(claim), true);
  } finally {
    await videoProducer.close();
    await captionProducer.close();
  }
});

test("snapshot evidence from another claim is rejected", async () => {
  const root = await makeTempDir();
  const pending = path.join(root, "pending");
  await fs.mkdir(pending);
  await fs.writeFile(path.join(pending, "clip.mp4"), "video");

  const claim = await claimQueuedItem(
    await getNextQueuedItem(pending),
    pending
  );

  await assert.rejects(
    assertClaimSnapshotReady({ ...claim, claimId: "different-claim" }),
    (error) =>
      error.code === "EQUEUEINTEGRITY" && error.requiresRecovery === true
  );
});

test("same-name video replacement between selection and claim fails closed", async () => {
  const root = await makeTempDir();
  const pending = path.join(root, "pending");
  await fs.mkdir(pending);
  const videoPath = path.join(pending, "clip.mp4");
  await fs.writeFile(videoPath, "selected-video");
  const item = await getNextQueuedItem(pending);
  const originalLink = fs.link;
  let replacementInjected = false;

  fs.link = async (sourcePath, targetPath) => {
    await originalLink(sourcePath, targetPath);
    if (!replacementInjected) {
      replacementInjected = true;
      await fs.unlink(videoPath);
      await fs.writeFile(videoPath, "same-name-replacement");
    }
  };

  try {
    await assert.rejects(
      claimQueuedItem(item, pending),
      (error) =>
        error.code === "EQUEUEINTEGRITY" && error.requiresRecovery === true
    );
  } finally {
    fs.link = originalLink;
  }

  assert.equal(replacementInjected, true);
  assert.equal(await getNextQueuedItem(pending), null);
});

test("video mutation during snapshot formation fails closed", async () => {
  const root = await makeTempDir();
  const pending = path.join(root, "pending");
  await fs.mkdir(pending);
  const videoPath = path.join(pending, "clip.mp4");
  await fs.writeFile(videoPath, Buffer.alloc(2 * 1024 * 1024, 0x41));
  const item = await getNextQueuedItem(pending);
  const originalOpen = fs.open;
  let mutationInjected = false;

  fs.open = async (...args) => {
    const handle = await originalOpen(...args);
    const [filePath, flags] = args;
    if (
      !mutationInjected &&
      flags === "r" &&
      path.basename(filePath) === ".claim-source-video"
    ) {
      return new Proxy(handle, {
        get(target, property) {
          if (property === "read") {
            return async (...readArgs) => {
              const result = await target.read(...readArgs);
              if (!mutationInjected && result.bytesRead > 0) {
                mutationInjected = true;
                await fs.appendFile(filePath, "MUTATION");
              }
              return result;
            };
          }
          const value = target[property];
          return typeof value === "function" ? value.bind(target) : value;
        },
      });
    }
    return handle;
  };

  try {
    await assert.rejects(
      claimQueuedItem(item, pending),
      (error) =>
        error.code === "EQUEUEINTEGRITY" && error.requiresRecovery === true
    );
  } finally {
    fs.open = originalOpen;
  }

  assert.equal(mutationInjected, true);
  assert.equal(await getNextQueuedItem(pending), null);
});

test("same-name sidecar replacement during claim fails closed", async () => {
  const root = await makeTempDir();
  const pending = path.join(root, "pending");
  await fs.mkdir(pending);
  const videoPath = path.join(pending, "clip.mp4");
  const captionPath = path.join(pending, "clip.description");
  await fs.writeFile(videoPath, "video");
  await fs.writeFile(captionPath, "caption-A");
  const item = await getNextQueuedItem(pending);
  const originalRename = fs.rename;
  let replacementInjected = false;

  fs.rename = async (sourcePath, targetPath) => {
    await originalRename(sourcePath, targetPath);
    if (!replacementInjected && sourcePath === videoPath) {
      replacementInjected = true;
      await fs.unlink(captionPath);
      await fs.writeFile(captionPath, "caption-B");
    }
  };

  try {
    await assert.rejects(
      claimQueuedItem(item, pending),
      (error) =>
        error.code === "EQUEUEINTEGRITY" && error.requiresRecovery === true
    );
  } finally {
    fs.rename = originalRename;
  }

  assert.equal(replacementInjected, true);
  assert.equal(await getNextQueuedItem(pending), null);
});

test("sidecar content changed after rename but before snapshot fails closed", async () => {
  const root = await makeTempDir();
  const pending = path.join(root, "pending");
  await fs.mkdir(pending);
  const videoPath = path.join(pending, "clip.mp4");
  const captionPath = path.join(pending, "clip.description");
  await fs.writeFile(videoPath, "video");
  await fs.writeFile(captionPath, "caption-A");
  const item = await getNextQueuedItem(pending);
  const originalOpen = fs.open;
  let mutationInjected = false;
  let claimedVideoOpenCount = 0;

  fs.open = async (...args) => {
    const [filePath, flags] = args;
    const handle = await originalOpen(...args);
    if (
      !mutationInjected &&
      flags === "r" &&
      path.basename(filePath) === ".claim-source-video"
    ) {
      claimedVideoOpenCount += 1;
      if (claimedVideoOpenCount === 2) {
        mutationInjected = true;
        await fs.writeFile(
          path.join(path.dirname(filePath), ".claim-source-sidecar-0"),
          "caption-B"
        );
      }
    }
    return handle;
  };

  try {
    await assert.rejects(
      claimQueuedItem(item, pending),
      (error) =>
        error.code === "EQUEUEINTEGRITY" && error.requiresRecovery === true
    );
  } finally {
    fs.open = originalOpen;
  }

  assert.equal(mutationInjected, true);
  assert.equal(await getNextQueuedItem(pending), null);
});

test("late sidecar creation during claim fails closed", async () => {
  const root = await makeTempDir();
  const pending = path.join(root, "pending");
  await fs.mkdir(pending);
  const videoPath = path.join(pending, "clip.mp4");
  const captionPath = path.join(pending, "clip.description");
  await fs.writeFile(videoPath, "video");
  const item = await getNextQueuedItem(pending);
  const originalRename = fs.rename;
  let lateSidecarInjected = false;

  fs.rename = async (sourcePath, targetPath) => {
    await originalRename(sourcePath, targetPath);
    if (!lateSidecarInjected && sourcePath === videoPath) {
      lateSidecarInjected = true;
      await fs.writeFile(captionPath, "late caption");
    }
  };

  try {
    await assert.rejects(
      claimQueuedItem(item, pending),
      (error) =>
        error.code === "EQUEUEINTEGRITY" && error.requiresRecovery === true
    );
  } finally {
    fs.rename = originalRename;
  }

  assert.equal(lateSidecarInjected, true);
  assert.equal(await getNextQueuedItem(pending), null);
});

test("sidecar created after a completed claim is not adopted by that claim", async () => {
  const root = await makeTempDir();
  const pending = path.join(root, "pending");
  await fs.mkdir(pending);
  const videoPath = path.join(pending, "clip.mp4");
  const captionPath = path.join(pending, "clip.description");
  await fs.writeFile(videoPath, "video");

  const claim = await claimQueuedItem(
    await getNextQueuedItem(pending),
    pending
  );
  await fs.writeFile(captionPath, "late caption");

  assert.equal(claim.caption, "");
  assert.deepEqual(claim.captionPaths, []);
  assert.equal(await assertClaimSnapshotReady(claim), true);
});
