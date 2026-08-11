const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs/promises");
const os = require("os");
const path = require("path");

let uploadImplementation = async () => {
  throw new Error("upload test implementation was not configured");
};

const uploaderPath = require.resolve("../src/tiktok-uploader");
const postServicePath = require.resolve("../src/post-service");
const originalUploaderModule = require.cache[uploaderPath];

require.cache[uploaderPath] = {
  id: uploaderPath,
  filename: uploaderPath,
  loaded: true,
  exports: {
    uploadVideo(options) {
      return uploadImplementation(options);
    },
  },
};
delete require.cache[postServicePath];

const {
  postFromManualInput,
  postNextFromQueue,
} = require("../src/post-service");

test.after(() => {
  delete require.cache[postServicePath];
  if (originalUploaderModule) {
    require.cache[uploaderPath] = originalUploaderModule;
  } else {
    delete require.cache[uploaderPath];
  }
});

async function makeQueue() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "autosocial-post-service-"));
  const queueDir = path.join(root, "pending");
  const postedDir = path.join(root, "posted");
  const failedDir = path.join(root, "failed");
  await Promise.all(
    [queueDir, postedDir, failedDir].map((dir) =>
      fs.mkdir(dir, { recursive: true })
    )
  );
  const videoPath = path.join(queueDir, "clip.mp4");
  await fs.writeFile(videoPath, "video");
  await fs.writeFile(path.join(queueDir, "clip.description"), "caption");
  return { root, queueDir, postedDir, failedDir, videoPath };
}

function videoNames(entries) {
  return entries.filter((name) => /\.(mp4|mov|webm|avi|mkv)$/i.test(name));
}

test("uncertain upload is propagated and durably quarantined", async () => {
  const queue = await makeQueue();
  let uploadCalls = 0;
  uploadImplementation = async ({ videoPath }) => {
    uploadCalls += 1;
    assert.match(videoPath, /[\\/]processing[\\/][^\\/]+[\\/]clip\.mp4$/);
    await assert.rejects(fs.access(queue.videoPath));
    return {
      ok: false,
      outcome: "uncertain",
      retryAllowed: false,
      reason: "confirmation timed out",
      error: "Publish verification failed: confirmation timed out",
      screenshotPath: "last-upload-error.png",
    };
  };

  const result = await postNextFromQueue(queue);

  assert.equal(result.ok, false);
  assert.equal(result.outcome, "uncertain");
  assert.equal(result.retryAllowed, false);
  assert.equal(result.reason, "confirmation timed out");
  assert.equal(result.durableState, "uncertain");
  assert.equal(uploadCalls, 1);

  const uncertainDir = path.join(queue.root, "uncertain");
  const uncertainEntries = await fs.readdir(uncertainDir);
  assert.equal(videoNames(uncertainEntries).length, 1);
  const metadataName = uncertainEntries.find((name) => name.endsWith(".json"));
  assert.ok(metadataName);
  const metadata = JSON.parse(
    await fs.readFile(path.join(uncertainDir, metadataName), "utf8")
  );
  assert.equal(metadata.outcome, "uncertain");
  assert.equal(metadata.retryAllowed, false);
  assert.equal(metadata.reason, "confirmation timed out");

  const nextRun = await postNextFromQueue(queue);
  assert.equal(nextRun.skipped, true);
  assert.equal(uploadCalls, 1);
});

test("finalization failure leaves an uncertain item non-selectable in processing", async () => {
  const queue = await makeQueue();
  let uploadCalls = 0;
  uploadImplementation = async () => {
    uploadCalls += 1;
    const uncertainDir = path.join(queue.root, "uncertain");
    await fs.rmdir(uncertainDir);
    await fs.writeFile(uncertainDir, "blocks directory");
    return {
      ok: false,
      outcome: "uncertain",
      retryAllowed: false,
      reason: "click outcome unknown",
      error: "click outcome unknown",
    };
  };

  const result = await postNextFromQueue(queue);

  assert.equal(result.outcome, "uncertain");
  assert.equal(result.retryAllowed, false);
  assert.equal(result.durableState, "processing");
  assert.match(result.persistenceError, /uncertain/i);
  const processingEntries = await fs.readdir(
    path.join(queue.root, "processing"),
    { withFileTypes: true }
  );
  assert.equal(
    processingEntries.filter(
      (entry) => entry.isDirectory() && entry.name !== ".claims"
    ).length,
    1
  );

  const nextRun = await postNextFromQueue(queue);
  assert.equal(nextRun.skipped, true);
  assert.equal(nextRun.retryAllowed, false);
  assert.equal(nextRun.clickAttempted, false);
  assert.equal(uploadCalls, 1);
});

test("manual TikTok posting rejects every file path without reaching uploader", async () => {
  const queue = await makeQueue();
  const arbitraryVideo = path.join(queue.root, "manual-copy.mp4");
  const processingVideo = path.join(
    queue.root,
    "processing",
    "claim-id",
    "processing.mp4"
  );
  const uncertainVideo = path.join(queue.root, "uncertain", "uncertain.mp4");
  await fs.mkdir(path.dirname(processingVideo), { recursive: true });
  await fs.mkdir(path.dirname(uncertainVideo), { recursive: true });
  await fs.writeFile(arbitraryVideo, "manual");
  await fs.writeFile(processingVideo, "processing");
  await fs.writeFile(uncertainVideo, "uncertain");

  let uploadCalls = 0;
  uploadImplementation = async () => {
    uploadCalls += 1;
    return { ok: true, outcome: "success", retryAllowed: false };
  };

  for (const videoPath of [
    arbitraryVideo,
    processingVideo,
    uncertainVideo,
  ]) {
    const result = await postFromManualInput(videoPath, "");
    assert.equal(result.ok, false);
    assert.equal(result.skipped, false);
    assert.equal(result.retryAllowed, false);
    assert.equal(result.clickAttempted, false);
    assert.match(result.reason, /managed queue lifecycle/i);
  }
  assert.equal(uploadCalls, 0);
});

test("confirmed and definitive failed uploads preserve existing destinations", async () => {
  const confirmed = await makeQueue();
  uploadImplementation = async () => ({
    ok: true,
    outcome: "success",
    retryAllowed: false,
    reason: "correlated publish response",
  });

  const success = await postNextFromQueue(confirmed);
  assert.equal(success.ok, true);
  assert.equal(success.outcome, "success");
  assert.equal(success.retryAllowed, false);
  assert.equal(videoNames(await fs.readdir(confirmed.postedDir)).length, 1);

  const failed = await makeQueue();
  uploadImplementation = async () => ({
    ok: false,
    outcome: "failure",
    retryAllowed: true,
    reason: "button unavailable",
    error: "button unavailable",
  });

  const failure = await postNextFromQueue(failed);
  assert.equal(failure.ok, false);
  assert.equal(failure.outcome, "failure");
  assert.equal(failure.retryAllowed, true);
  assert.equal(videoNames(await fs.readdir(failed.failedDir)).length, 1);
});

test("uploader receives only the claim-owned video snapshot and claimed caption", async () => {
  const queue = await makeQueue();
  const originalCaptionPath = path.join(queue.queueDir, "clip.description");
  let receivedVideoPath = null;
  let receivedCaption = null;

  uploadImplementation = async ({ videoPath, caption }) => {
    receivedVideoPath = videoPath;
    receivedCaption = caption;
    assert.match(videoPath, /[\\/]processing[\\/][^\\/]+[\\/]clip\.mp4$/);
    assert.notEqual(videoPath, queue.videoPath);
    assert.equal(await fs.readFile(videoPath, "utf8"), "video");
    assert.equal(
      (await fs.readdir(path.dirname(videoPath))).some((name) =>
        name.startsWith(".claim-source-")
      ),
      false
    );

    await fs.writeFile(queue.videoPath, "replacement-video");
    await fs.writeFile(originalCaptionPath, "replacement-caption");

    assert.equal(await fs.readFile(videoPath, "utf8"), "video");
    assert.equal(caption, "caption");
    return {
      ok: true,
      outcome: "success",
      retryAllowed: false,
      reason: "correlated publish response",
    };
  };

  const result = await postNextFromQueue(queue);

  assert.equal(result.ok, true);
  assert.equal(receivedCaption, "caption");
  assert.notEqual(receivedVideoPath, queue.videoPath);
  const postedVideo = videoNames(await fs.readdir(queue.postedDir))[0];
  assert.equal(
    await fs.readFile(path.join(queue.postedDir, postedVideo), "utf8"),
    "video"
  );
  const postedCaption = (await fs.readdir(queue.postedDir)).find((name) =>
    name.endsWith(".description")
  );
  assert.equal(
    await fs.readFile(path.join(queue.postedDir, postedCaption), "utf8"),
    "caption"
  );
  const processingEntries = await fs.readdir(path.join(queue.root, "processing"));
  assert.deepEqual(processingEntries, [".claims"]);
  assert.deepEqual(
    await fs.readdir(path.join(queue.root, "processing", ".claims")),
    []
  );
});

test("absence of sidecars remains an explicitly bound empty caption", async () => {
  const queue = await makeQueue();
  await fs.unlink(path.join(queue.queueDir, "clip.description"));
  let uploadCalls = 0;
  uploadImplementation = async ({ caption }) => {
    uploadCalls += 1;
    assert.equal(caption, "");
    return {
      ok: false,
      outcome: "failure",
      retryAllowed: true,
      reason: "button unavailable",
    };
  };

  const result = await postNextFromQueue(queue);

  assert.equal(result.ok, false);
  assert.equal(result.outcome, "failure");
  assert.equal(uploadCalls, 1);
});

test("claim-close failure preserves the already-safe terminal decision and marker", async () => {
  const queue = await makeQueue();
  const originalRmdir = fs.rmdir;
  let uploadCalls = 0;
  let closeFailureInjected = false;

  uploadImplementation = async () => {
    uploadCalls += 1;
    fs.rmdir = async (targetPath, ...args) => {
      if (
        !closeFailureInjected &&
        path.basename(path.dirname(targetPath)) === "processing" &&
        path.basename(targetPath) !== ".claims"
      ) {
        closeFailureInjected = true;
        const error = new Error("injected claim close failure");
        error.code = "EPERM";
        throw error;
      }
      return originalRmdir(targetPath, ...args);
    };
    return {
      ok: true,
      outcome: "success",
      retryAllowed: false,
      reason: "correlated publish response",
    };
  };

  let result;
  try {
    result = await postNextFromQueue(queue);
  } finally {
    fs.rmdir = originalRmdir;
  }

  assert.equal(closeFailureInjected, true);
  assert.equal(result.ok, true);
  assert.equal(result.outcome, "success");
  assert.equal(result.retryAllowed, false);
  assert.equal(result.durableState, "processing");
  assert.match(result.persistenceError, /injected claim close failure/);
  assert.equal(
    (await fs.readdir(path.join(queue.root, "processing", ".claims"))).length,
    1
  );

  await fs.writeFile(queue.videoPath, "replacement-after-close-failure");
  const nextRun = await postNextFromQueue(queue);
  assert.equal(nextRun.skipped, true);
  assert.equal(uploadCalls, 1);
});
