const fs = require("fs/promises");
const path = require("path");
const crypto = require("crypto");
const { createReadStream } = require("fs");
const { config } = require("./config");
const {
  assertClaimSnapshotReady,
  claimQueuedItem,
  completeQueuedClaim,
  getNextQueuedItem,
  getQueueStateDirs,
} = require("./queue");
const { uploadVideo } = require("./instagram-uploader");
const {
  ensureDirectories,
  fileExists,
  moveWithTimestamp,
  writeJsonAtomically,
} = require("./fs-utils");

const UNCERTAIN_PREPARE_SUFFIX = ".uncertain-prepare.json";

function normalizeUploadResult(rawResult) {
  const hasBooleanOk = typeof rawResult?.ok === "boolean";
  const declaredOk = rawResult?.ok === true;
  const declaredOutcome = rawResult?.outcome;
  const hasKnownOutcome = ["success", "failure", "uncertain"].includes(
    declaredOutcome
  );
  const hasConsistentOutcome =
    hasKnownOutcome && (declaredOutcome === "success") === declaredOk;
  const declaredClickAttempted =
    typeof rawResult?.clickAttempted === "boolean"
      ? rawResult.clickAttempted
      : null;
  const hasValidClickState =
    typeof rawResult?.clickAttempted === "boolean" ||
    (declaredOutcome === "uncertain" && rawResult?.clickAttempted === null);
  const hasBooleanRetry = typeof rawResult?.retryAllowed === "boolean";
  const hasConsistentRetry =
    hasBooleanRetry &&
    (declaredOutcome === "success" || declaredOutcome === "uncertain"
      ? rawResult.retryAllowed === false
      : true);
  const hasConsistentClick =
    hasValidClickState &&
    (declaredOutcome === "success" ? declaredClickAttempted === true : true);
  const unsafeRetryAfterClick =
    declaredClickAttempted === true && rawResult?.retryAllowed !== false;
  if (
    !hasBooleanOk ||
    !hasConsistentOutcome ||
    !hasConsistentRetry ||
    !hasConsistentClick ||
    unsafeRetryAfterClick
  ) {
    return {
      ok: false,
      outcome: "uncertain",
      retryAllowed: false,
      clickAttempted: declaredClickAttempted,
      reason:
        "Instagram uploader returned an ambiguous result; remote effect is unknown.",
      evidence: rawResult?.evidence,
      screenshotPath: rawResult?.screenshotPath,
    };
  }

  const outcome = declaredOutcome;
  const ok = declaredOk && outcome === "success";
  const retryAllowed =
    outcome === "uncertain" || ok
      ? false
      : typeof rawResult?.retryAllowed === "boolean"
        ? rawResult.retryAllowed
        : !ok;
  const clickAttempted =
    typeof rawResult?.clickAttempted === "boolean"
      ? rawResult.clickAttempted
      : outcome === "uncertain"
        ? null
        : false;
  const reason =
    rawResult?.reason ||
    rawResult?.error ||
    (ok ? "Instagram upload completed." : "Instagram upload failed.");
  return {
    ...rawResult,
    ok,
    outcome,
    retryAllowed,
    clickAttempted,
    reason,
  };
}

function getPropagatedResult(result) {
  return {
    outcome: result.outcome,
    retryAllowed: result.retryAllowed,
    clickAttempted: result.clickAttempted,
    reason: result.reason,
    evidence: result.evidence,
    screenshotPath: result.screenshotPath,
  };
}

async function finalizeClaimedFiles(videoPath, captionPaths, targetDir, claimDir) {
  try {
    const movedVideo = await moveWithTimestamp(videoPath, targetDir);
    const movedCaptions = [];
    for (const captionPath of captionPaths) {
      movedCaptions.push(await moveWithTimestamp(captionPath, targetDir));
    }
    return {
      movedVideo,
      movedCaption: movedCaptions[0] || null,
      durableState: path.basename(targetDir),
      terminalFilesReady: true,
    };
  } catch (error) {
    return {
      movedVideo: null,
      movedCaption: null,
      durableState: claimDir ? "processing" : "source",
      terminalFilesReady: false,
      persistenceError: error.message,
    };
  }
}

async function finalizeClaimedCaptions(captionPaths, targetDir) {
  const movedCaptions = [];
  try {
    for (const captionPath of captionPaths) {
      movedCaptions.push(await moveWithTimestamp(captionPath, targetDir));
    }
    return {
      movedCaption: movedCaptions[0] || null,
      terminalFilesReady: true,
      persistenceError: null,
    };
  } catch (error) {
    return {
      movedCaption: movedCaptions[0] || null,
      terminalFilesReady: false,
      persistenceError: error.message,
    };
  }
}

async function closeDurableClaim(finalized, claimDir, claimMarkerPath) {
  if (!finalized.terminalFilesReady) return finalized;
  try {
    await completeQueuedClaim({ claimDir, claimMarkerPath });
    return finalized;
  } catch (error) {
    return {
      ...finalized,
      durableState: "processing",
      persistenceError: error.message,
    };
  }
}

async function makePendingVideoNonSelectable(videoPath) {
  const quarantinePath = `${videoPath}.${Date.now()}-${process.pid}.no-retry`;
  try {
    await fs.rename(videoPath, quarantinePath);
    return { quarantinePath, persistenceError: null };
  } catch (error) {
    return { quarantinePath: null, persistenceError: error.message };
  }
}

async function hashFileSha256(filePath) {
  return new Promise((resolve, reject) => {
    const hash = crypto.createHash("sha256");
    const stream = createReadStream(filePath);
    stream.on("error", reject);
    stream.on("data", (chunk) => hash.update(chunk));
    stream.on("end", () => resolve(hash.digest("hex")));
  });
}

function sameStableStat(left, right) {
  return (
    left.dev === right.dev &&
    left.ino === right.ino &&
    left.size === right.size &&
    left.mtimeNs === right.mtimeNs &&
    left.ctimeNs === right.ctimeNs
  );
}

async function inspectStableVideoIdentity(filePath) {
  const before = await fs.lstat(filePath, { bigint: true });
  if (!before.isFile()) {
    throw new Error("Instagram uncertain source is not a regular file.");
  }
  const sha256 = await hashFileSha256(filePath);
  const after = await fs.lstat(filePath, { bigint: true });
  if (!after.isFile() || !sameStableStat(before, after)) {
    throw new Error("Instagram uncertain source changed while it was inspected.");
  }
  const size = Number(after.size);
  if (!Number.isSafeInteger(size) || size < 0) {
    throw new Error("Instagram uncertain source size cannot be represented safely.");
  }
  return {
    fileName: path.basename(filePath),
    size,
    sha256,
    dev: after.dev.toString(),
    ino: after.ino.toString(),
  };
}

function sameVideoIdentity(expected, actual) {
  return (
    expected.fileName === actual.fileName &&
    expected.size === actual.size &&
    expected.sha256 === actual.sha256 &&
    expected.dev === actual.dev &&
    expected.ino === actual.ino
  );
}

async function buildUncertainPreparation(videoPath, result, source) {
  const videoIdentity = await inspectStableVideoIdentity(videoPath);
  const sha256 = videoIdentity.sha256;
  const parsed = path.parse(path.basename(videoPath));
  const safeStem =
    parsed.name.replace(/[^\w.-]/g, "_").slice(0, 64) || "video";
  const nonce = crypto.randomUUID().slice(0, 8);
  const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
  return {
    schemaVersion: 1,
    platform: "instagram",
    state: "uncertain-prepared",
    outcome: "uncertain",
    retryAllowed: false,
    clickAttempted: result.clickAttempted,
    reason: result.reason,
    evidence: result.evidence || null,
    source: source || null,
    preparedAt: new Date().toISOString(),
    videoIdentity,
    archiveFileName: `${timestamp}_${safeStem}_${sha256.slice(0, 12)}_${nonce}${parsed.ext}`,
    quarantineFileName: `${safeStem}_${sha256.slice(0, 12)}_${nonce}${parsed.ext}.no-retry`,
  };
}

async function prepareUncertainMetadata(videoPath, result, source) {
  const preparationPath = `${videoPath}${UNCERTAIN_PREPARE_SUFFIX}`;
  let prepared;
  try {
    prepared = await buildUncertainPreparation(videoPath, result, source);
    await writeJsonAtomically(preparationPath, prepared);
    return { preparationPath, prepared, persistenceError: null };
  } catch (error) {
    return {
      preparationPath: null,
      prepared: prepared || null,
      persistenceError: error.message,
    };
  }
}

async function writeUncertainMetadata(targetVideoPath, prepared) {
  const metadataPath = `${targetVideoPath}.uncertain-state.json`;
  try {
    await writeJsonAtomically(metadataPath, {
      ...prepared,
      state: "uncertain",
      finalizedAt: new Date().toISOString(),
    });
    return { metadataPath, persistenceError: null };
  } catch (error) {
    return { metadataPath: null, persistenceError: error.message };
  }
}

function getPreparedUncertainResult(metadata, preparationPath) {
  const valid =
    metadata &&
    metadata.schemaVersion === 1 &&
    metadata.platform === "instagram" &&
    metadata.state === "uncertain-prepared" &&
    metadata.outcome === "uncertain" &&
    metadata.retryAllowed === false &&
    Number.isSafeInteger(metadata.videoIdentity?.size) &&
    metadata.videoIdentity.size >= 0 &&
    /^[a-f0-9]{64}$/.test(metadata.videoIdentity?.sha256 || "") &&
    typeof metadata.videoIdentity.dev === "string" &&
    typeof metadata.videoIdentity.ino === "string";
  return {
    ok: false,
    skipped: true,
    outcome: "uncertain",
    retryAllowed: false,
    clickAttempted: valid ? metadata.clickAttempted : null,
    reason: valid
      ? metadata.reason
      : "Instagram has an invalid prepared uncertain state; manual reconciliation is required.",
    evidence: valid ? metadata.evidence : undefined,
    durableState: "uncertain-prepared",
    preparationPath,
    error:
      "Instagram has a prepared uncertain publication; no upload or retry was attempted.",
  };
}

async function readPreparedUncertainResult(preparationPath) {
  try {
    const metadata = JSON.parse(await fs.readFile(preparationPath, "utf8"));
    return getPreparedUncertainResult(metadata, preparationPath);
  } catch {
    return getPreparedUncertainResult(null, preparationPath);
  }
}

async function findPreparedUncertainResult(queueDir) {
  let entries;
  try {
    entries = await fs.readdir(queueDir, { withFileTypes: true });
  } catch (error) {
    if (error.code === "ENOENT") return null;
    throw error;
  }
  const preparation = entries
    .filter(
      (entry) => entry.isFile() && entry.name.endsWith(UNCERTAIN_PREPARE_SUFFIX)
    )
    .map((entry) => entry.name)
    .sort()[0];
  return preparation
    ? readPreparedUncertainResult(path.join(queueDir, preparation))
    : null;
}

async function findPreparedUncertainResultInProcessing(processingDir) {
  let entries;
  try {
    entries = await fs.readdir(processingDir, { withFileTypes: true });
  } catch (error) {
    if (error.code === "ENOENT") return null;
    throw error;
  }
  const claimDirs = entries
    .filter((entry) => entry.isDirectory() && entry.name !== ".claims")
    .map((entry) => entry.name)
    .sort();
  for (const claimDirName of claimDirs) {
    const claimDir = path.join(processingDir, claimDirName);
    const prepared = await findPreparedUncertainResult(claimDir);
    if (prepared) return prepared;
  }
  return null;
}

async function findActiveClaimRecoveryResult(processingDir) {
  let entries;
  try {
    entries = await fs.readdir(processingDir, { withFileTypes: true });
  } catch (error) {
    if (error.code === "ENOENT") return null;
    throw error;
  }
  const claimDir = entries
    .filter((entry) => entry.isDirectory() && entry.name !== ".claims")
    .map((entry) => entry.name)
    .sort()[0];
  if (!claimDir) return null;
  return {
    ok: false,
    skipped: true,
    outcome: "failure",
    retryAllowed: false,
    clickAttempted: false,
    reason:
      "Instagram has an active durable queue claim; manual recovery is required before another upload.",
    durableState: "processing",
    error:
      "Instagram has an active durable queue claim; no upload or retry was attempted.",
  };
}

async function movePreparedUncertainVideo(videoPath, uncertainDir, prepared) {
  let currentIdentity;
  try {
    currentIdentity = await inspectStableVideoIdentity(videoPath);
    if (!sameVideoIdentity(prepared.videoIdentity, currentIdentity)) {
      throw new Error(
        "Instagram uncertain source identity changed before archival."
      );
    }
  } catch (error) {
    return {
      movedVideo: null,
      quarantinePath: null,
      identityVerified: false,
      persistenceError: error.message,
    };
  }

  const archivePath = path.join(uncertainDir, prepared.archiveFileName);
  try {
    await fs.rename(videoPath, archivePath);
    const archivedIdentity = await inspectStableVideoIdentity(archivePath);
    if (
      !sameVideoIdentity(
        prepared.videoIdentity,
        { ...archivedIdentity, fileName: prepared.videoIdentity.fileName }
      )
    ) {
      throw new Error(
        "Instagram archived uncertain video does not match its prepared identity."
      );
    }
    return {
      movedVideo: archivePath,
      quarantinePath: null,
      identityVerified: true,
      persistenceError: null,
    };
  } catch (archiveError) {
    if (await fileExists(archivePath)) {
      return {
        movedVideo: archivePath,
        quarantinePath: null,
        identityVerified: false,
        persistenceError: archiveError.message,
      };
    }
    const quarantinePath = path.join(
      path.dirname(videoPath),
      prepared.quarantineFileName
    );
    try {
      await fs.rename(videoPath, quarantinePath);
      const quarantinedIdentity = await inspectStableVideoIdentity(quarantinePath);
      if (
        !sameVideoIdentity(
          prepared.videoIdentity,
          { ...quarantinedIdentity, fileName: prepared.videoIdentity.fileName }
        )
      ) {
        throw new Error(
          "Instagram quarantined uncertain video does not match its prepared identity."
        );
      }
      return {
        movedVideo: null,
        quarantinePath,
        identityVerified: true,
        persistenceError: archiveError.message,
      };
    } catch (quarantineError) {
      return {
        movedVideo: null,
        quarantinePath: (await fileExists(quarantinePath))
          ? quarantinePath
          : null,
        identityVerified: false,
        persistenceError: `${archiveError.message}; ${quarantineError.message}`,
      };
    }
  }
}

async function postSingleVideo({
  videoPath,
  caption,
  captionPaths,
  postedDir,
  failedDir,
  uncertainDir,
  claimDir,
  claimMarkerPath,
  snapshotBindingPath,
  claimId,
  accountId,
  source,
}) {
  const posted = postedDir || config.instagramPostedDir;
  const failed = failedDir || config.instagramFailedDir;
  const uncertain = uncertainDir || path.join(path.dirname(failed), "uncertain");
  await ensureDirectories([posted, failed, uncertain]);

  const existingPreparationPath = `${videoPath}${UNCERTAIN_PREPARE_SUFFIX}`;
  if (await fileExists(existingPreparationPath)) {
    return readPreparedUncertainResult(existingPreparationPath);
  }

  try {
    await assertClaimSnapshotReady({
      videoPath,
      caption,
      captionPaths,
      claimDir,
      claimMarkerPath,
      snapshotBindingPath,
      claimId,
    });
  } catch (error) {
    return {
      ok: false,
      outcome: "failure",
      retryAllowed: false,
      clickAttempted: false,
      reason: `Instagram claim snapshot integrity validation failed: ${error.message}`,
      error: `Instagram claim snapshot integrity validation failed: ${error.message}`,
      durableState: "processing",
    };
  }

  let rawResult;
  try {
    rawResult = await uploadVideo({ videoPath, caption, accountId });
  } catch {
    rawResult = {
      ok: false,
      outcome: "uncertain",
      retryAllowed: false,
      clickAttempted: null,
      reason:
        "Instagram uploader exited without a final result; remote effect is unknown.",
      error:
        "Instagram uploader exited without a final result; remote effect is unknown.",
    };
  }
  const result = normalizeUploadResult(rawResult);
  const propagated = getPropagatedResult(result);

  if (result.ok) {
    let finalized = await finalizeClaimedFiles(
      videoPath,
      captionPaths,
      posted,
      claimDir
    );
    finalized = await closeDurableClaim(finalized, claimDir, claimMarkerPath);
    if (!finalized.terminalFilesReady || finalized.durableState === "processing") {
      return {
        ok: false,
        ...propagated,
        ...finalized,
        error: "Video posted, but could not archive file from Instagram queue.",
      };
    }
    return {
      ok: true,
      ...propagated,
      ...finalized,
    };
  }

  if (result.outcome === "uncertain") {
    const preparation = await prepareUncertainMetadata(videoPath, result, source);
    const transition = preparation.preparationPath
      ? await movePreparedUncertainVideo(videoPath, uncertain, preparation.prepared)
      : await makePendingVideoNonSelectable(videoPath).then((quarantine) => ({
          movedVideo: null,
          ...quarantine,
        }));
    const durableVideoPath =
      transition.movedVideo || transition.quarantinePath;
    const captionTransition = durableVideoPath
      ? await finalizeClaimedCaptions(captionPaths, uncertain)
      : {
          movedCaption: null,
          terminalFilesReady: false,
          persistenceError: null,
        };
    const metadata =
      durableVideoPath && preparation.prepared && transition.identityVerified
        ? await writeUncertainMetadata(durableVideoPath, preparation.prepared)
        : { metadataPath: null, persistenceError: null };
    const terminalEvidenceReady = Boolean(
      transition.movedVideo &&
        captionTransition.terminalFilesReady &&
        metadata.metadataPath
    );
    let cleanupError = null;
    if (terminalEvidenceReady && preparation.preparationPath) {
      try {
        await fs.unlink(preparation.preparationPath);
      } catch (error) {
        cleanupError = error.message;
      }
    }
    const fullyRecorded = terminalEvidenceReady && !cleanupError;
    const preparationStillActive = Boolean(
      preparation.preparationPath && !fullyRecorded
    );
    let finalized = {
      ok: false,
      ...propagated,
      retryAllowed: false,
      durableState: transition.movedVideo
        ? fullyRecorded
          ? "uncertain"
          : "uncertain-prepared"
        : transition.quarantinePath
          ? fullyRecorded
            ? "pending-quarantine"
            : preparationStillActive
              ? "pending-quarantine-prepared"
              : "pending-quarantine-unrecorded"
          : preparationStillActive
            ? "uncertain-prepared"
            : "pending",
      movedVideo: transition.movedVideo,
      movedCaption: captionTransition.movedCaption,
      quarantinePath: transition.quarantinePath,
      metadataPath: metadata.metadataPath || preparation.preparationPath,
      preparationPath: preparationStillActive
        ? preparation.preparationPath
        : undefined,
      persistenceError:
        preparation.persistenceError ||
        transition.persistenceError ||
        captionTransition.persistenceError ||
        metadata.persistenceError ||
        cleanupError ||
        undefined,
      error: result.error || result.reason,
    };
    if (fullyRecorded) {
      finalized = await closeDurableClaim(
        { ...finalized, terminalFilesReady: true },
        claimDir,
        claimMarkerPath
      );
    }
    return finalized;
  }

  let finalized = await finalizeClaimedFiles(
    videoPath,
    captionPaths,
    failed,
    claimDir
  );
  finalized = await closeDurableClaim(finalized, claimDir, claimMarkerPath);
  return {
    ok: false,
    ...propagated,
    ...finalized,
    error: result.error || result.reason,
  };
}

async function postNextFromQueue({ source, queueDir, postedDir, failedDir, accountId } = {}) {
  const queue = queueDir || config.instagramQueueDir;
  const posted = postedDir || config.instagramPostedDir;
  const failed = failedDir || config.instagramFailedDir;
  const stateDirs = getQueueStateDirs(queue);
  try {
    await ensureDirectories([
      queue,
      posted,
      failed,
      stateDirs.processing,
      stateDirs.uncertain,
    ]);
  } catch (error) {
    return {
      ok: false,
      skipped: true,
      outcome: "failure",
      retryAllowed: false,
      clickAttempted: false,
      reason:
        "Instagram queue safety directories are unavailable; posting was aborted before selection.",
      error: `Instagram queue safety directories are unavailable: ${error.message}`,
    };
  }

  try {
    const preparedResult =
      (await findPreparedUncertainResult(queue)) ||
      (await findPreparedUncertainResultInProcessing(stateDirs.processing));
    if (preparedResult) return preparedResult;
    const activeClaimResult = await findActiveClaimRecoveryResult(
      stateDirs.processing
    );
    if (activeClaimResult) return activeClaimResult;
  } catch (error) {
    return {
      ok: false,
      skipped: true,
      outcome: "failure",
      retryAllowed: false,
      clickAttempted: false,
      reason:
        "Instagram queue recovery state could not be inspected; posting was aborted.",
      error: `Instagram queue recovery state could not be inspected: ${error.message}`,
    };
  }

  let nextItem;
  try {
    nextItem = await getNextQueuedItem(queue);
  } catch (error) {
    return {
      ok: false,
      outcome: "failure",
      retryAllowed: false,
      clickAttempted: false,
      reason: `Could not bind the selected Instagram queue item: ${error.message}`,
      error: `Could not bind the selected Instagram queue item: ${error.message}`,
    };
  }
  if (!nextItem) {
    return { ok: true, skipped: true, reason: "Instagram queue is empty." };
  }

  let claimedItem;
  try {
    claimedItem = await claimQueuedItem(nextItem, queue);
  } catch (error) {
    return {
      ok: false,
      outcome: "failure",
      retryAllowed: error.requiresRecovery !== true,
      clickAttempted: false,
      reason: `Could not atomically claim the Instagram queue item: ${error.message}`,
      error: `Could not atomically claim the Instagram queue item: ${error.message}`,
    };
  }

  return postSingleVideo({
    ...claimedItem,
    source,
    postedDir: posted,
    failedDir: failed,
    uncertainDir: stateDirs.uncertain,
    accountId,
  });
}

async function postFromManualInput() {
  const reason =
    "Direct Instagram posting by file path is disabled. " +
    "Place the video and caption sidecar in the Instagram pending queue and use the managed queue lifecycle.";
  return {
    ok: false,
    skipped: false,
    outcome: "failure",
    retryAllowed: false,
    clickAttempted: false,
    reason,
    error: reason,
  };
}

module.exports = {
  postNextFromQueue,
  postFromManualInput,
};
