const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs/promises");
const os = require("os");
const path = require("path");
const crypto = require("crypto");

let uploadImplementation = async () => {
  throw new Error("Instagram upload test implementation was not configured");
};

const uploaderPath = require.resolve("../src/instagram-uploader");
const postServicePath = require.resolve("../src/instagram-post-service");
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
} = require("../src/instagram-post-service");

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
    path.join(os.tmpdir(), "autosocial-instagram-service-")
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
  await fs.writeFile(videoPath, "instagram-video");
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

function forceUncertainVideoMoveFailure(t) {
  const originalRename = fs.rename;
  fs.rename = async (sourcePath, destinationPath, ...args) => {
    if (
      path.basename(path.dirname(destinationPath)) === "uncertain" ||
      String(destinationPath).endsWith(".no-retry")
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

function mutateVideoAfterPreparation(t, replacement) {
  const originalRename = fs.rename;
  fs.rename = async (sourcePath, destinationPath, ...args) => {
    const result = await originalRename(sourcePath, destinationPath, ...args);
    if (String(destinationPath).endsWith(".uncertain-prepare.json")) {
      const snapshotPath = String(destinationPath).slice(
        0,
        -".uncertain-prepare.json".length
      );
      await fs.writeFile(snapshotPath, replacement);
    }
    return result;
  };
  t.after(() => {
    fs.rename = originalRename;
  });
}

function mutateClaimSnapshotAfterBinding(t) {
  const originalRename = fs.rename;
  fs.rename = async (sourcePath, destinationPath, ...args) => {
    const result = await originalRename(sourcePath, destinationPath, ...args);
    if (path.basename(destinationPath) === ".snapshot-binding.json") {
      await fs.writeFile(
        path.join(path.dirname(destinationPath), "clip.mp4"),
        "tampered-after-binding"
      );
    }
    return result;
  };
  t.after(() => {
    fs.rename = originalRename;
  });
}

async function claimMarkerNames(queue) {
  const claimsDir = path.join(queue.root, "processing", ".claims");
  try {
    return (await fs.readdir(claimsDir)).filter((name) => name.endsWith(".json"));
  } catch (error) {
    if (error.code === "ENOENT") return [];
    throw error;
  }
}

test("Instagram uncertainty is propagated and durably quarantined", async (t) => {
  const queue = await makeQueue(t);
  let uploadCalls = 0;
  const evidence = {
    evidenceType: "confirmation-timeout",
    postId: null,
  };
  uploadImplementation = async () => {
    uploadCalls += 1;
    return {
      ok: false,
      outcome: "uncertain",
      retryAllowed: false,
      clickAttempted: true,
      reason: "Instagram confirmation timed out",
      error: "Instagram confirmation timed out",
      evidence,
      screenshotPath: "instagram-evidence.png",
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
  assert.equal(metadata.platform, "instagram");
  assert.equal(metadata.outcome, "uncertain");
  assert.equal(metadata.retryAllowed, false);
  assert.equal(metadata.clickAttempted, true);
  assert.deepEqual(metadata.evidence, evidence);
  assert.equal(metadata.videoIdentity.fileName, "clip.mp4");
  assert.equal(
    metadata.videoIdentity.size,
    Buffer.byteLength("instagram-video")
  );
  assert.equal(
    metadata.videoIdentity.sha256,
    crypto.createHash("sha256").update("instagram-video").digest("hex")
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

test("Instagram preparation write failure remains an explicit recovery state", async (t) => {
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
      reason: "Instagram confirmation timed out",
    };
  };

  const result = await postNextFromQueue(queue);

  assert.equal(result.ok, false);
  assert.equal(result.durableState, "pending-quarantine-unrecorded");
  assert.equal(result.retryAllowed, false);
  assert.equal(result.preparationPath, undefined);
  assert.equal((await claimMarkerNames(queue)).length, 1);

  const nextRun = await postNextFromQueue(queue);
  assert.equal(nextRun.skipped, true);
  assert.equal(nextRun.durableState, "processing");
  assert.match(nextRun.reason, /active durable queue claim/i);
  assert.equal(uploadCalls, 1);
});

test("Instagram prepared uncertainty survives final metadata failure and blocks retry", async (t) => {
  const queue = await makeQueue(t);
  let uploadCalls = 0;
  const evidence = { evidenceType: "confirmation-timeout", postId: null };
  uploadImplementation = async () => {
    uploadCalls += 1;
    return {
      ok: false,
      outcome: "uncertain",
      retryAllowed: false,
      clickAttempted: true,
      reason: "Instagram confirmation timed out",
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
  assert.equal(nextRun.durableState, "uncertain-prepared");
  assert.equal(nextRun.retryAllowed, false);
  assert.equal(uploadCalls, 1);
});

test("Instagram prepared uncertainty blocks retry when archive and quarantine both fail", async (t) => {
  const queue = await makeQueue(t);
  let uploadCalls = 0;
  uploadImplementation = async () => {
    uploadCalls += 1;
    return {
      ok: false,
      outcome: "uncertain",
      retryAllowed: false,
      clickAttempted: true,
      reason: "Instagram confirmation timed out",
    };
  };
  forceUncertainVideoMoveFailure(t);

  const result = await postNextFromQueue(queue);
  assert.equal(result.durableState, "uncertain-prepared");
  await fs.access(result.preparationPath);
  assert.equal((await claimMarkerNames(queue)).length, 1);

  const nextRun = await postNextFromQueue(queue);
  assert.equal(nextRun.durableState, "uncertain-prepared");
  assert.equal(nextRun.retryAllowed, false);
  assert.equal(uploadCalls, 1);
});

test("Instagram prepared uncertainty rejects same-name byte replacement before archival", async (t) => {
  const queue = await makeQueue(t);
  let uploadCalls = 0;
  uploadImplementation = async () => {
    uploadCalls += 1;
    return {
      ok: false,
      outcome: "uncertain",
      retryAllowed: false,
      clickAttempted: true,
      reason: "Instagram confirmation timed out",
    };
  };
  mutateVideoAfterPreparation(t, "instagram-vide0");

  const result = await postNextFromQueue(queue);
  assert.equal(result.durableState, "uncertain-prepared");
  assert.match(result.persistenceError, /identity changed/i);
  assert.equal((await claimMarkerNames(queue)).length, 1);
  await fs.access(result.preparationPath);

  const nextRun = await postNextFromQueue(queue);
  assert.equal(nextRun.durableState, "uncertain-prepared");
  assert.equal(uploadCalls, 1);
});

test("Instagram malformed post-click result fails closed without persisting its error", async (t) => {
  const queue = await makeQueue(t);
  uploadImplementation = async () => ({
    ok: false,
    clickAttempted: true,
    error: "token=instagram-malformed-secret",
  });

  const result = await postNextFromQueue(queue);

  assert.equal(result.outcome, "uncertain");
  assert.equal(result.retryAllowed, false);
  assert.equal(result.clickAttempted, true);
  assert.match(result.reason, /ambiguous result/i);
  assert.doesNotMatch(await fs.readFile(result.metadataPath, "utf8"), /instagram-malformed-secret/);
});

test("Instagram result missing retry and click fields is uncertain, never retryable", async (t) => {
  const queue = await makeQueue(t);
  uploadImplementation = async () => ({
    ok: false,
    outcome: "failure",
    error: "token=instagram-incomplete-secret",
  });

  const result = await postNextFromQueue(queue);

  assert.equal(result.outcome, "uncertain");
  assert.equal(result.retryAllowed, false);
  assert.equal(result.clickAttempted, null);
  assert.doesNotMatch(await fs.readFile(result.metadataPath, "utf8"), /instagram-incomplete-secret/);
});

test("Instagram uncertainty cannot remain selectable after archive failure", async (t) => {
  const queue = await makeQueue(t);
  let uploadCalls = 0;
  uploadImplementation = async () => {
    uploadCalls += 1;
    return {
      ok: false,
      outcome: "uncertain",
      retryAllowed: false,
      clickAttempted: true,
      reason: "Instagram confirmation timed out",
      evidence: { evidenceType: "confirmation-timeout" },
    };
  };
  forceArchiveMoveFailure(t, path.join(queue.root, "uncertain"));

  const result = await postNextFromQueue(queue);

  assert.equal(result.outcome, "uncertain");
  assert.equal(result.retryAllowed, false);
  assert.equal(result.durableState, "pending-quarantine-prepared");
  assert.ok(result.quarantinePath.endsWith(".no-retry"));
  assert.equal(
    result.metadataPath,
    `${result.quarantinePath}.uncertain-state.json`
  );
  await Promise.all([
    fs.access(result.quarantinePath),
    fs.access(result.metadataPath),
  ]);
  assert.equal(videoNames(await fs.readdir(queue.queueDir)).length, 0);
  assert.equal((await claimMarkerNames(queue)).length, 1);

  const nextRun = await postNextFromQueue(queue);
  assert.equal(nextRun.durableState, "uncertain-prepared");
  assert.equal(nextRun.retryAllowed, false);
  assert.equal(uploadCalls, 1);
});

test("Instagram uploader rejection becomes non-retryable uncertainty", async (t) => {
  const queue = await makeQueue(t);
  uploadImplementation = async () => {
    throw new Error("synthetic close failure token=instagram-secret-marker");
  };

  const result = await postNextFromQueue(queue);

  assert.equal(result.outcome, "uncertain");
  assert.equal(result.retryAllowed, false);
  assert.equal(result.clickAttempted, null);
  assert.equal(result.durableState, "uncertain");
  assert.match(result.reason, /remote effect is unknown/i);
  const metadataText = await fs.readFile(result.metadataPath, "utf8");
  assert.doesNotMatch(metadataText, /instagram-secret-marker/);
});

test("Instagram definitive pre-click failure remains retryable in failed", async (t) => {
  const queue = await makeQueue(t);
  uploadImplementation = async () => ({
    ok: false,
    outcome: "failure",
    retryAllowed: true,
    clickAttempted: false,
    reason: "Share button unavailable",
    error: "Share button unavailable",
  });

  const result = await postNextFromQueue(queue);

  assert.equal(result.outcome, "failure");
  assert.equal(result.retryAllowed, true);
  assert.equal(result.clickAttempted, false);
  assert.equal(result.durableState, "failed");
  assert.equal(videoNames(await fs.readdir(queue.failedDir)).length, 1);
});

test("Instagram explicit post-click failure preserves no-retry evidence", async (t) => {
  const queue = await makeQueue(t);
  const evidence = { evidenceType: "operation-bound-error" };
  uploadImplementation = async () => ({
    ok: false,
    outcome: "failure",
    retryAllowed: false,
    clickAttempted: true,
    reason: "Instagram rejected the post",
    error: "Instagram rejected the post",
    evidence,
  });

  const result = await postNextFromQueue(queue);

  assert.equal(result.outcome, "failure");
  assert.equal(result.retryAllowed, false);
  assert.equal(result.clickAttempted, true);
  assert.deepEqual(result.evidence, evidence);
  assert.equal(result.durableState, "failed");
});

test("Instagram confirmed success remains archived as posted", async (t) => {
  const queue = await makeQueue(t);
  const evidence = { evidenceType: "bound-composer", postId: "post123" };
  uploadImplementation = async () => ({
    ok: true,
    outcome: "success",
    retryAllowed: false,
    clickAttempted: true,
    reason: "Instagram publication confirmed",
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

test("Instagram confirmed success cannot remain selectable after archive failure", async (t) => {
  const queue = await makeQueue(t);
  let uploadCalls = 0;
  uploadImplementation = async () => {
    uploadCalls += 1;
    return {
      ok: true,
      outcome: "success",
      retryAllowed: false,
      clickAttempted: true,
      reason: "Instagram publication confirmed",
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
  assert.equal((await claimMarkerNames(queue)).length, 1);

  const nextRun = await postNextFromQueue(queue);
  assert.equal(nextRun.skipped, true);
  assert.equal(uploadCalls, 1);
});

test("Instagram durable claim permits only one concurrent upload", async (t) => {
  const queue = await makeQueue(t);
  let uploadCalls = 0;
  uploadImplementation = async () => {
    uploadCalls += 1;
    await new Promise((resolve) => setTimeout(resolve, 25));
    return {
      ok: true,
      outcome: "success",
      retryAllowed: false,
      clickAttempted: true,
      reason: "Instagram publication confirmed",
    };
  };

  const results = await Promise.all([
    postNextFromQueue({ ...queue, source: "concurrent-a" }),
    postNextFromQueue({ ...queue, source: "concurrent-b" }),
  ]);

  assert.equal(uploadCalls, 1);
  assert.equal(
    results.filter((result) => result.durableState === "posted").length,
    1
  );
  assert.equal(videoNames(await fs.readdir(queue.postedDir)).length, 1);
  assert.equal((await claimMarkerNames(queue)).length, 0);
});

test("Instagram uploader receives only claim-owned video and sidecar caption", async (t) => {
  const queue = await makeQueue(t);
  let observed;
  uploadImplementation = async (options) => {
    observed = {
      ...options,
      videoBytes: await fs.readFile(options.videoPath, "utf8"),
    };
    return {
      ok: true,
      outcome: "success",
      retryAllowed: false,
      clickAttempted: true,
      reason: "Instagram publication confirmed",
    };
  };

  const result = await postNextFromQueue({ ...queue, source: "scheduler" });

  assert.equal(result.ok, true);
  assert.equal(observed.videoBytes, "instagram-video");
  assert.equal(observed.caption, "private caption fixture");
  assert.notEqual(path.resolve(observed.videoPath), path.resolve(queue.videoPath));
  assert.equal(path.basename(observed.videoPath), "clip.mp4");
  assert.equal(path.basename(path.dirname(path.dirname(observed.videoPath))), "processing");
  await assert.rejects(fs.access(queue.videoPath));
  await assert.rejects(fs.access(queue.captionPath));
});

test("Instagram changed claim snapshot fails closed and retains recovery evidence", async (t) => {
  const queue = await makeQueue(t);
  let uploadCalls = 0;
  uploadImplementation = async () => {
    uploadCalls += 1;
    throw new Error("uploader must not run");
  };
  mutateClaimSnapshotAfterBinding(t);

  const result = await postNextFromQueue(queue);

  assert.equal(result.ok, false);
  assert.equal(result.outcome, "failure");
  assert.equal(result.retryAllowed, false);
  assert.equal(result.clickAttempted, false);
  assert.equal(result.durableState, "processing");
  assert.match(result.reason, /snapshot integrity validation failed/i);
  assert.equal(uploadCalls, 0);
  assert.equal((await claimMarkerNames(queue)).length, 1);
  assert.equal(videoNames(await fs.readdir(queue.queueDir)).length, 0);
});

test("Instagram manual file path is rejected before uploader invocation", async (t) => {
  const queue = await makeQueue(t);
  let uploadCalls = 0;
  uploadImplementation = async () => {
    uploadCalls += 1;
    throw new Error("uploader must not run");
  };

  const result = await postFromManualInput(
    queue.videoPath,
    "manual caption must be ignored"
  );

  assert.equal(result.ok, false);
  assert.equal(result.outcome, "failure");
  assert.equal(result.retryAllowed, false);
  assert.equal(result.clickAttempted, false);
  assert.match(result.reason, /pending queue/i);
  assert.equal(uploadCalls, 0);
  await fs.access(queue.videoPath);
  await fs.access(queue.captionPath);
});
