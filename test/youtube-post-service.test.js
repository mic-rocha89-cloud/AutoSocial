const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs/promises");
const os = require("os");
const path = require("path");
const crypto = require("crypto");

let uploadImplementation = async () => {
  throw new Error("YouTube upload test implementation was not configured");
};

const uploaderPath = require.resolve("../src/youtube-uploader");
const postServicePath = require.resolve("../src/youtube-post-service");
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
  postNextFromQueue,
  postFromManualInput,
} = require("../src/youtube-post-service");

test.after(() => {
  delete require.cache[postServicePath];
  if (originalUploaderModule) {
    require.cache[uploaderPath] = originalUploaderModule;
  } else {
    delete require.cache[uploaderPath];
  }
});

async function makeQueue(t) {
  const root = await fs.mkdtemp(
    path.join(os.tmpdir(), "autosocial-youtube-service-")
  );
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const queueDir = path.join(root, "pending");
  const postedDir = path.join(root, "posted");
  const failedDir = path.join(root, "failed");
  await Promise.all(
    [queueDir, postedDir, failedDir].map((dir) =>
      fs.mkdir(dir, { recursive: true })
    )
  );
  const videoPath = path.join(queueDir, "clip.mp4");
  const captionPath = path.join(queueDir, "clip.description");
  await fs.writeFile(videoPath, "youtube-video");
  await fs.writeFile(captionPath, "private caption fixture");
  return { root, queueDir, postedDir, failedDir, videoPath, captionPath };
}

function videoNames(entries) {
  return entries.filter((name) => /\.(mp4|mov|webm|avi|mkv)$/i.test(name));
}

function forceArchiveMoveFailure(t, targetDir) {
  const originalRename = fs.rename;
  const originalCopyFile = fs.copyFile;
  const archiveError = () => {
    const error = new Error("synthetic archive failure");
    error.code = "EPERM";
    return error;
  };
  fs.rename = async (sourcePath, destinationPath, ...args) => {
    if (path.dirname(destinationPath) === targetDir) {
      throw archiveError();
    }
    return originalRename(sourcePath, destinationPath, ...args);
  };
  fs.copyFile = async (sourcePath, destinationPath, ...args) => {
    if (path.dirname(destinationPath) === targetDir) {
      throw archiveError();
    }
    return originalCopyFile(sourcePath, destinationPath, ...args);
  };
  t.after(() => {
    fs.rename = originalRename;
    fs.copyFile = originalCopyFile;
  });
}

function forceFinalMetadataFailure(t) {
  const originalRename = fs.rename;
  fs.rename = async (sourcePath, destinationPath, ...args) => {
    if (String(destinationPath).endsWith(".uncertain-state.json")) {
      const error = new Error("synthetic final metadata failure");
      error.code = "EPERM";
      throw error;
    }
    return originalRename(sourcePath, destinationPath, ...args);
  };
  t.after(() => {
    fs.rename = originalRename;
  });
}

function forcePreparationMetadataFailure(t) {
  const originalRename = fs.rename;
  fs.rename = async (sourcePath, destinationPath, ...args) => {
    if (String(destinationPath).endsWith(".uncertain-prepare.json")) {
      const error = new Error("synthetic preparation metadata failure");
      error.code = "EPERM";
      throw error;
    }
    return originalRename(sourcePath, destinationPath, ...args);
  };
  t.after(() => {
    fs.rename = originalRename;
  });
}

function forceUncertainVideoMoveFailure(t, videoPath) {
  const originalRename = fs.rename;
  fs.rename = async (sourcePath, destinationPath, ...args) => {
    if (
      path.basename(sourcePath) === path.basename(videoPath) &&
      path.dirname(sourcePath) !== path.dirname(videoPath)
    ) {
      const error = new Error("synthetic uncertain video transition failure");
      error.code = "EPERM";
      throw error;
    }
    return originalRename(sourcePath, destinationPath, ...args);
  };
  t.after(() => {
    fs.rename = originalRename;
  });
}

function mutateVideoAfterPreparation(t, videoPath, replacement) {
  const originalRename = fs.rename;
  fs.rename = async (sourcePath, destinationPath, ...args) => {
    const result = await originalRename(sourcePath, destinationPath, ...args);
    if (String(destinationPath).endsWith(".uncertain-prepare.json")) {
      const snapshotPath = String(destinationPath).slice(
        0,
        -".uncertain-prepare.json".length
      );
      assert.equal(path.basename(snapshotPath), path.basename(videoPath));
      await fs.writeFile(snapshotPath, replacement);
    }
    return result;
  };
  t.after(() => {
    fs.rename = originalRename;
  });
}

function mutateClaimSnapshotAfterBinding(t, replacement) {
  const originalRename = fs.rename;
  fs.rename = async (sourcePath, destinationPath, ...args) => {
    const result = await originalRename(sourcePath, destinationPath, ...args);
    if (path.basename(destinationPath) === ".snapshot-binding.json") {
      const entries = await fs.readdir(path.dirname(destinationPath));
      const snapshotName = entries.find((name) => /\.mp4$/i.test(name));
      await fs.writeFile(
        path.join(path.dirname(destinationPath), snapshotName),
        replacement
      );
    }
    return result;
  };
  t.after(() => {
    fs.rename = originalRename;
  });
}

async function getClaimEvidence(root) {
  const processingDir = path.join(root, "processing");
  const claimMarkerDir = path.join(processingDir, ".claims");
  const processingEntries = await fs.readdir(processingDir, {
    withFileTypes: true,
  });
  const claimDirs = processingEntries.filter(
    (entry) => entry.isDirectory() && entry.name !== ".claims"
  );
  const markers = await fs.readdir(claimMarkerDir);
  return { claimDirs, markers };
}

function synchronizeClaimMarkerRace(t) {
  const originalAccess = fs.access;
  const originalLink = fs.link;
  let accessArrivals = 0;
  let releaseAccess;
  const accessBarrier = new Promise((resolve) => {
    releaseAccess = resolve;
  });
  let linkArrivals = 0;
  let releaseLinks;
  const linkBarrier = new Promise((resolve) => {
    releaseLinks = resolve;
  });
  const isClaimMarker = (filePath) =>
    path.basename(path.dirname(String(filePath))) === ".claims" &&
    String(filePath).endsWith(".json");

  fs.access = async (filePath, ...args) => {
    if (isClaimMarker(filePath) && accessArrivals < 2) {
      accessArrivals += 1;
      if (accessArrivals === 2) releaseAccess();
      await accessBarrier;
    }
    return originalAccess(filePath, ...args);
  };
  fs.link = async (sourcePath, destinationPath, ...args) => {
    if (isClaimMarker(destinationPath) && linkArrivals < 2) {
      linkArrivals += 1;
      if (linkArrivals === 2) releaseLinks();
      await linkBarrier;
    }
    return originalLink(sourcePath, destinationPath, ...args);
  };
  t.after(() => {
    fs.access = originalAccess;
    fs.link = originalLink;
  });
}

test("YouTube queue claim is exclusive and uploader receives only bound snapshots", async (t) => {
  const queue = await makeQueue(t);
  let uploadCalls = 0;
  let releaseUpload;
  let signalUploadStarted;
  const uploadStarted = new Promise((resolve) => {
    signalUploadStarted = resolve;
  });
  const uploadReleased = new Promise((resolve) => {
    releaseUpload = resolve;
  });
  uploadImplementation = async ({ videoPath, caption }) => {
    uploadCalls += 1;
    assert.notEqual(videoPath, queue.videoPath);
    assert.equal(path.dirname(path.dirname(videoPath)), path.join(queue.root, "processing"));
    assert.equal(await fs.readFile(videoPath, "utf8"), "youtube-video");
    assert.equal(caption, "private caption fixture");
    await assert.rejects(fs.access(queue.videoPath), { code: "ENOENT" });
    await assert.rejects(fs.access(queue.captionPath), { code: "ENOENT" });
    signalUploadStarted();
    await uploadReleased;
    return {
      ok: true,
      outcome: "success",
      retryAllowed: false,
      clickAttempted: true,
      reason: "YouTube publication confirmed",
    };
  };

  const firstRun = postNextFromQueue({ ...queue, source: "scheduler" });
  await uploadStarted;
  const concurrentRun = await postNextFromQueue({ ...queue, source: "scheduler" });
  assert.equal(concurrentRun.skipped, true);
  assert.equal(uploadCalls, 1);

  releaseUpload();
  const result = await firstRun;
  assert.equal(result.ok, true);
  assert.equal(result.durableState, "posted");
  assert.equal(uploadCalls, 1);
  const claimEvidence = await getClaimEvidence(queue.root);
  assert.equal(claimEvidence.claimDirs.length, 0);
  assert.equal(claimEvidence.markers.length, 0);
});

test("YouTube atomic marker collision permits exactly one uploader", async (t) => {
  const queue = await makeQueue(t);
  synchronizeClaimMarkerRace(t);
  let uploadCalls = 0;
  uploadImplementation = async () => {
    uploadCalls += 1;
    await new Promise((resolve) => setTimeout(resolve, 25));
    return {
      ok: true,
      outcome: "success",
      retryAllowed: false,
      clickAttempted: true,
      reason: "YouTube publication confirmed",
    };
  };

  const results = await Promise.all([
    postNextFromQueue({ ...queue, source: "concurrent-a" }),
    postNextFromQueue({ ...queue, source: "concurrent-b" }),
  ]);

  assert.equal(uploadCalls, 1);
  assert.equal(results.filter((result) => result.ok === true).length, 1);
  const rejected = results.find((result) => result.ok === false);
  assert.equal(rejected.retryAllowed, false);
  assert.equal(rejected.clickAttempted, false);
  assert.match(rejected.reason, /atomically claim/i);
  assert.equal(videoNames(await fs.readdir(queue.postedDir)).length, 1);
});

test("YouTube snapshot integrity failure retains the durable claim and never uploads", async (t) => {
  const queue = await makeQueue(t);
  let uploadCalls = 0;
  uploadImplementation = async () => {
    uploadCalls += 1;
    throw new Error("uploader must not run");
  };
  mutateClaimSnapshotAfterBinding(t, "tampered-youtube-video");

  const result = await postNextFromQueue(queue);

  assert.equal(result.ok, false);
  assert.equal(result.durableState, "processing");
  assert.equal(result.retryAllowed, false);
  assert.equal(result.clickAttempted, false);
  assert.match(result.reason, /snapshot integrity validation failed/i);
  assert.equal(uploadCalls, 0);
  const claimEvidence = await getClaimEvidence(queue.root);
  assert.equal(claimEvidence.claimDirs.length, 1);
  assert.equal(claimEvidence.markers.length, 1);
  const nextRun = await postNextFromQueue(queue);
  assert.equal(nextRun.skipped, true);
  assert.equal(uploadCalls, 0);
});

test("YouTube manual path is fail closed and directs callers to the managed queue", async () => {
  let uploadCalls = 0;
  uploadImplementation = async () => {
    uploadCalls += 1;
    throw new Error("uploader must not run");
  };

  const result = await postFromManualInput("C:\\does-not-exist\\clip.mp4", "caption");

  assert.equal(result.ok, false);
  assert.equal(result.outcome, "failure");
  assert.equal(result.retryAllowed, false);
  assert.equal(result.clickAttempted, false);
  assert.match(result.reason, /pending queue/i);
  assert.equal(uploadCalls, 0);
});

test("YouTube uncertainty is propagated and durably quarantined", async (t) => {
  const queue = await makeQueue(t);
  let uploadCalls = 0;
  const evidence = {
    evidenceType: "confirmation-timeout",
    expectedVideoId: null,
  };
  uploadImplementation = async () => {
    uploadCalls += 1;
    return {
      ok: false,
      outcome: "uncertain",
      retryAllowed: false,
      clickAttempted: true,
      reason: "YouTube confirmation timed out",
      error: "YouTube confirmation timed out",
      evidence,
      screenshotPath: "youtube-evidence.png",
    };
  };

  const result = await postNextFromQueue({ ...queue, source: "scheduler" });

  assert.equal(result.ok, false);
  assert.equal(result.outcome, "uncertain");
  assert.equal(result.retryAllowed, false);
  assert.equal(result.clickAttempted, true);
  assert.deepEqual(result.evidence, evidence);
  assert.equal(result.durableState, "uncertain");
  assert.equal(uploadCalls, 1);
  assert.equal(videoNames(await fs.readdir(queue.failedDir)).length, 0);
  assert.equal(videoNames(await fs.readdir(queue.queueDir)).length, 0);

  const uncertainDir = path.join(queue.root, "uncertain");
  const entries = await fs.readdir(uncertainDir);
  assert.equal(videoNames(entries).length, 1);
  assert.equal(entries.filter((name) => name.endsWith(".description")).length, 1);
  const metadataName = entries.find((name) =>
    name.endsWith(".uncertain-state.json")
  );
  assert.ok(metadataName);
  const metadataText = await fs.readFile(
    path.join(uncertainDir, metadataName),
    "utf8"
  );
  const metadata = JSON.parse(metadataText);
  assert.equal(metadata.platform, "youtube");
  assert.equal(metadata.outcome, "uncertain");
  assert.equal(metadata.retryAllowed, false);
  assert.equal(metadata.clickAttempted, true);
  assert.deepEqual(metadata.evidence, evidence);
  assert.equal(metadata.videoIdentity.fileName, "clip.mp4");
  assert.equal(
    metadata.videoIdentity.size,
    Buffer.byteLength("youtube-video")
  );
  assert.equal(
    metadata.videoIdentity.sha256,
    crypto.createHash("sha256").update("youtube-video").digest("hex")
  );
  assert.equal(typeof metadata.videoIdentity.dev, "string");
  assert.equal(typeof metadata.videoIdentity.ino, "string");
  assert.doesNotMatch(metadataText, /private caption fixture/);
  assert.equal(
    (await fs.readdir(queue.queueDir)).filter((name) =>
      name.endsWith(".uncertain-prepare.json")
    ).length,
    0
  );

  const nextRun = await postNextFromQueue(queue);
  assert.equal(nextRun.skipped, true);
  assert.equal(uploadCalls, 1);
});

test("YouTube preparation write failure remains an explicit recovery state", async (t) => {
  const queue = await makeQueue(t);
  forcePreparationMetadataFailure(t);
  let uploadCalls = 0;
  uploadImplementation = async () => {
    uploadCalls += 1;
    return {
      ok: false,
      outcome: "uncertain",
      retryAllowed: false,
      clickAttempted: true,
      reason: "YouTube confirmation timed out",
    };
  };

  const result = await postNextFromQueue(queue);

  assert.equal(result.ok, false);
  assert.equal(result.durableState, "processing-unrecorded");
  assert.equal(result.retryAllowed, false);
  assert.equal(result.preparationPath, undefined);
  assert.equal((await getClaimEvidence(queue.root)).markers.length, 1);

  const nextRun = await postNextFromQueue(queue);
  assert.equal(nextRun.skipped, true);
  assert.equal(nextRun.durableState, "processing");
  assert.match(nextRun.reason, /active durable queue claim/i);
  assert.equal(uploadCalls, 1);
});

test("YouTube prepared uncertainty survives final metadata failure and blocks retry", async (t) => {
  const queue = await makeQueue(t);
  let uploadCalls = 0;
  const evidence = {
    evidenceType: "confirmation-timeout",
    expectedVideoId: null,
  };
  uploadImplementation = async () => {
    uploadCalls += 1;
    return {
      ok: false,
      outcome: "uncertain",
      retryAllowed: false,
      clickAttempted: true,
      reason: "YouTube confirmation timed out",
      evidence,
    };
  };
  forceFinalMetadataFailure(t);

  const result = await postNextFromQueue({ ...queue, source: "scheduler" });

  assert.equal(result.durableState, "uncertain-prepared");
  assert.equal(result.retryAllowed, false);
  assert.equal(result.metadataPath, result.preparationPath);
  const preparedText = await fs.readFile(result.preparationPath, "utf8");
  const prepared = JSON.parse(preparedText);
  assert.equal(prepared.state, "uncertain-prepared");
  assert.deepEqual(prepared.evidence, evidence);
  assert.equal(prepared.videoIdentity.fileName, "clip.mp4");
  assert.match(prepared.videoIdentity.sha256, /^[a-f0-9]{64}$/);
  assert.doesNotMatch(preparedText, /private caption fixture/);
  assert.equal(
    videoNames(await fs.readdir(path.join(queue.root, "uncertain"))).length,
    1
  );

  const nextRun = await postNextFromQueue(queue);
  assert.equal(nextRun.skipped, true);
  assert.equal(uploadCalls, 1);
  const claimEvidence = await getClaimEvidence(queue.root);
  assert.equal(claimEvidence.claimDirs.length, 1);
  assert.equal(claimEvidence.markers.length, 1);
});

test("YouTube prepared uncertainty blocks retry when archive and quarantine both fail", async (t) => {
  const queue = await makeQueue(t);
  let uploadCalls = 0;
  uploadImplementation = async () => {
    uploadCalls += 1;
    return {
      ok: false,
      outcome: "uncertain",
      retryAllowed: false,
      clickAttempted: true,
      reason: "YouTube confirmation timed out",
    };
  };
  forceUncertainVideoMoveFailure(t, queue.videoPath);

  const result = await postNextFromQueue(queue);
  assert.equal(result.durableState, "uncertain-prepared");
  await fs.access(result.preparationPath);
  await assert.rejects(fs.access(queue.videoPath), { code: "ENOENT" });

  const nextRun = await postNextFromQueue(queue);
  assert.equal(nextRun.skipped, true);
  assert.equal(uploadCalls, 1);
  const claimEvidence = await getClaimEvidence(queue.root);
  assert.equal(claimEvidence.claimDirs.length, 1);
  assert.equal(claimEvidence.markers.length, 1);
});

test("YouTube prepared uncertainty rejects same-name byte replacement before archival", async (t) => {
  const queue = await makeQueue(t);
  let uploadCalls = 0;
  uploadImplementation = async () => {
    uploadCalls += 1;
    return {
      ok: false,
      outcome: "uncertain",
      retryAllowed: false,
      clickAttempted: true,
      reason: "YouTube confirmation timed out",
    };
  };
  mutateVideoAfterPreparation(t, queue.videoPath, "youtube-vide0");

  const result = await postNextFromQueue(queue);
  assert.equal(result.durableState, "uncertain-prepared");
  assert.match(result.persistenceError, /identity changed/i);
  await assert.rejects(fs.access(queue.videoPath), { code: "ENOENT" });
  await fs.access(result.preparationPath);

  const nextRun = await postNextFromQueue(queue);
  assert.equal(nextRun.skipped, true);
  assert.equal(uploadCalls, 1);
});

test("YouTube malformed post-click result fails closed without persisting its error", async (t) => {
  const queue = await makeQueue(t);
  uploadImplementation = async () => ({
    ok: false,
    clickAttempted: true,
    error: "token=youtube-malformed-secret",
  });

  const result = await postNextFromQueue(queue);

  assert.equal(result.outcome, "uncertain");
  assert.equal(result.retryAllowed, false);
  assert.equal(result.clickAttempted, true);
  assert.match(result.reason, /ambiguous result/i);
  assert.doesNotMatch(await fs.readFile(result.metadataPath, "utf8"), /youtube-malformed-secret/);
});

test("YouTube result missing retry and click fields is uncertain, never retryable", async (t) => {
  const queue = await makeQueue(t);
  uploadImplementation = async () => ({
    ok: false,
    outcome: "failure",
    error: "token=youtube-incomplete-secret",
  });

  const result = await postNextFromQueue(queue);

  assert.equal(result.outcome, "uncertain");
  assert.equal(result.retryAllowed, false);
  assert.equal(result.clickAttempted, null);
  assert.doesNotMatch(await fs.readFile(result.metadataPath, "utf8"), /youtube-incomplete-secret/);
});

test("YouTube uncertainty cannot remain selectable after archive failure", async (t) => {
  const queue = await makeQueue(t);
  let uploadCalls = 0;
  uploadImplementation = async () => {
    uploadCalls += 1;
    return {
      ok: false,
      outcome: "uncertain",
      retryAllowed: false,
      clickAttempted: true,
      reason: "YouTube confirmation timed out",
      evidence: { evidenceType: "confirmation-timeout" },
    };
  };
  forceArchiveMoveFailure(t, path.join(queue.root, "uncertain"));

  const result = await postNextFromQueue(queue);

  assert.equal(result.outcome, "uncertain");
  assert.equal(result.retryAllowed, false);
  assert.equal(result.durableState, "uncertain-prepared");
  assert.ok(result.quarantinePath.endsWith(".no-retry"));
  assert.equal(
    result.metadataPath,
    result.preparationPath
  );
  await Promise.all([
    fs.access(result.quarantinePath),
    fs.access(result.metadataPath),
  ]);
  assert.equal(videoNames(await fs.readdir(queue.queueDir)).length, 0);

  const nextRun = await postNextFromQueue(queue);
  assert.equal(nextRun.skipped, true);
  assert.equal(uploadCalls, 1);
  const claimEvidence = await getClaimEvidence(queue.root);
  assert.equal(claimEvidence.claimDirs.length, 1);
  assert.equal(claimEvidence.markers.length, 1);
});

test("YouTube uploader rejection becomes non-retryable uncertainty", async (t) => {
  const queue = await makeQueue(t);
  uploadImplementation = async () => {
    throw new Error("synthetic close failure token=youtube-secret-marker");
  };

  const result = await postNextFromQueue(queue);

  assert.equal(result.outcome, "uncertain");
  assert.equal(result.retryAllowed, false);
  assert.equal(result.clickAttempted, null);
  assert.equal(result.durableState, "uncertain");
  assert.match(result.reason, /remote effect is unknown/i);
  const metadataText = await fs.readFile(result.metadataPath, "utf8");
  assert.doesNotMatch(metadataText, /youtube-secret-marker/);
});

test("YouTube definitive pre-click failure remains retryable in failed", async (t) => {
  const queue = await makeQueue(t);
  uploadImplementation = async () => ({
    ok: false,
    outcome: "failure",
    retryAllowed: true,
    clickAttempted: false,
    reason: "Publish button unavailable",
    error: "Publish button unavailable",
  });

  const result = await postNextFromQueue(queue);

  assert.equal(result.outcome, "failure");
  assert.equal(result.retryAllowed, true);
  assert.equal(result.clickAttempted, false);
  assert.equal(result.durableState, "failed");
  assert.equal(videoNames(await fs.readdir(queue.failedDir)).length, 1);
});

test("YouTube explicit post-click failure preserves no-retry evidence", async (t) => {
  const queue = await makeQueue(t);
  const evidence = { evidenceType: "operation-bound-error" };
  uploadImplementation = async () => ({
    ok: false,
    outcome: "failure",
    retryAllowed: false,
    clickAttempted: true,
    reason: "YouTube rejected the publication",
    error: "YouTube rejected the publication",
    evidence,
  });

  const result = await postNextFromQueue(queue);

  assert.equal(result.outcome, "failure");
  assert.equal(result.retryAllowed, false);
  assert.equal(result.clickAttempted, true);
  assert.deepEqual(result.evidence, evidence);
  assert.equal(result.durableState, "failed");
});

test("YouTube confirmed success remains archived as posted", async (t) => {
  const queue = await makeQueue(t);
  const evidence = { evidenceType: "upload-surface", videoId: "AbCdEfGhI12" };
  uploadImplementation = async () => ({
    ok: true,
    outcome: "success",
    retryAllowed: false,
    clickAttempted: true,
    reason: "YouTube publication confirmed",
    evidence,
  });

  const result = await postNextFromQueue(queue);

  assert.equal(result.ok, true);
  assert.equal(result.outcome, "success");
  assert.equal(result.retryAllowed, false);
  assert.equal(result.clickAttempted, true);
  assert.deepEqual(result.evidence, evidence);
  assert.equal(result.durableState, "posted");
  assert.equal(videoNames(await fs.readdir(queue.postedDir)).length, 1);
});

test("YouTube confirmed success cannot remain selectable after archive failure", async (t) => {
  const queue = await makeQueue(t);
  let uploadCalls = 0;
  uploadImplementation = async () => {
    uploadCalls += 1;
    return {
      ok: true,
      outcome: "success",
      retryAllowed: false,
      clickAttempted: true,
      reason: "YouTube publication confirmed",
    };
  };
  forceArchiveMoveFailure(t, queue.postedDir);

  const result = await postNextFromQueue(queue);

  assert.equal(result.ok, false);
  assert.equal(result.outcome, "success");
  assert.equal(result.retryAllowed, false);
  assert.equal(result.durableState, "processing");
  assert.equal(result.quarantinePath, undefined);
  assert.equal(videoNames(await fs.readdir(queue.queueDir)).length, 0);

  const nextRun = await postNextFromQueue(queue);
  assert.equal(nextRun.skipped, true);
  assert.equal(uploadCalls, 1);
  const claimEvidence = await getClaimEvidence(queue.root);
  assert.equal(claimEvidence.claimDirs.length, 1);
  assert.equal(claimEvidence.markers.length, 1);
});
