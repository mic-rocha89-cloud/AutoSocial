const fs = require("fs/promises");
const path = require("path");
const { config } = require("./config");
const {
  assertClaimSnapshotReady,
  claimQueuedItem,
  completeQueuedClaim,
  getNextQueuedItem,
  getQueueStateDirs,
} = require("./queue");
const { uploadVideo } = require("./tiktok-uploader");
const {
  ensureDirectories,
  moveWithTimestamp,
  writeJsonAtomically,
} = require("./fs-utils");

function normalizeUploadResult(result) {
  const ok = result?.ok === true;
  const outcome = result?.outcome || (ok ? "success" : "failure");
  const retryAllowed =
    typeof result?.retryAllowed === "boolean"
      ? result.retryAllowed
      : !ok;
  const reason =
    result?.reason ||
    result?.error ||
    (ok ? "Upload completed." : "Upload failed.");
  return {
    ...result,
    ok,
    outcome,
    retryAllowed,
    reason,
  };
}

async function finalizeClaimedFiles(videoPath, sidecarPaths, targetDir, claimDir) {
  try {
    const movedVideo = await moveWithTimestamp(videoPath, targetDir);
    const movedCaptions = [];
    for (const sidecarPath of sidecarPaths) {
      movedCaptions.push(await moveWithTimestamp(sidecarPath, targetDir));
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

async function closeDurableClaim(finalized, claimDir, claimMarkerPath) {
  if (!finalized.terminalFilesReady) {
    return finalized;
  }

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

async function postSingleVideo({
  videoPath,
  originalVideoPath,
  caption,
  captionPaths,
  source,
  postedDir,
  failedDir,
  uncertainDir,
  claimDir,
  claimMarkerPath,
  snapshotBindingPath,
  claimId,
  claimedAt,
  accountId,
}) {
  const posted = postedDir || config.postedDir;
  const failed = failedDir || config.failedDir;
  const uncertain =
    uncertainDir || path.join(path.dirname(failed), "uncertain");
  await ensureDirectories([posted, failed, uncertain]);

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
      reason: `Claim snapshot integrity validation failed: ${error.message}`,
      error: `Claim snapshot integrity validation failed: ${error.message}`,
      durableState: "processing",
    };
  }

  let rawResult;
  try {
    rawResult = await uploadVideo({ videoPath, caption, source, accountId });
  } catch (error) {
    rawResult = {
      ok: false,
      outcome: "uncertain",
      retryAllowed: false,
      reason:
        "TikTok uploader threw after the queue item was claimed; " +
        `remote effect is unknown. ${error.message}`,
      error: error.message,
    };
  }
  const result = normalizeUploadResult(rawResult);
  const sidecarPaths = captionPaths;
  const propagated = {
    outcome: result.outcome,
    retryAllowed: result.retryAllowed,
    reason: result.reason,
    evidence: result.evidence,
    clickAttempted: result.clickAttempted,
    screenshotPath: result.screenshotPath,
  };

  if (result.ok) {
    let finalized = await finalizeClaimedFiles(
      videoPath,
      sidecarPaths,
      posted,
      claimDir
    );
    finalized = await closeDurableClaim(
      finalized,
      claimDir,
      claimMarkerPath
    );
    if (!finalized.movedVideo) {
      return {
        ok: false,
        ...propagated,
        ...finalized,
        error: "Video posted, but could not archive file from queue.",
      };
    }
    return {
      ok: true,
      ...propagated,
      ...finalized,
    };
  }

  if (result.outcome === "uncertain") {
    let finalized = await finalizeClaimedFiles(
      videoPath,
      sidecarPaths,
      uncertain,
      claimDir
    );
    let metadataPath = null;
    let metadataError = null;
    if (finalized.terminalFilesReady) {
      metadataPath = `${finalized.movedVideo}.uncertain.json`;
      try {
        await writeJsonAtomically(metadataPath, {
          schemaVersion: 1,
          state: "uncertain",
          outcome: "uncertain",
          retryAllowed: false,
          reason: result.reason,
          evidence: result.evidence || null,
          clickAttempted:
            typeof result.clickAttempted === "boolean"
              ? result.clickAttempted
              : null,
          screenshotPath: result.screenshotPath || null,
          source: source || null,
          accountId: accountId || null,
          claimId: claimId || null,
          claimedAt: claimedAt || null,
          finalizedAt: new Date().toISOString(),
          originalVideoPath: originalVideoPath || null,
        });
      } catch (error) {
        metadataError = error.message;
        metadataPath = null;
      }
    }
    if (finalized.terminalFilesReady && !metadataError) {
      finalized = await closeDurableClaim(
        finalized,
        claimDir,
        claimMarkerPath
      );
    }

    return {
      ok: false,
      ...propagated,
      retryAllowed: false,
      ...finalized,
      metadataPath,
      persistenceError:
        finalized.persistenceError || metadataError || undefined,
      error: result.error || result.reason,
    };
  }

  let finalized = await finalizeClaimedFiles(
    videoPath,
    sidecarPaths,
    failed,
    claimDir
  );
  finalized = await closeDurableClaim(
    finalized,
    claimDir,
    claimMarkerPath
  );
  return {
    ok: false,
    ...propagated,
    ...finalized,
    error: result.error || result.reason,
  };
}

async function postNextFromQueue({ source, queueDir, postedDir, failedDir, accountId } = {}) {
  const queue = queueDir || config.queueDir;
  const posted = postedDir || config.postedDir;
  const failed = failedDir || config.failedDir;
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
        "Queue safety directories are unavailable; posting was aborted before selection.",
      error: `Queue safety directories are unavailable: ${error.message}`,
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
      reason: `Could not bind the selected queue item: ${error.message}`,
      error: `Could not bind the selected queue item: ${error.message}`,
    };
  }
  if (!nextItem) {
    return { ok: true, skipped: true, reason: "Queue is empty." };
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
      reason: `Could not atomically claim the queued video: ${error.message}`,
      error: `Could not atomically claim the queued video: ${error.message}`,
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

async function postFromManualInput(videoPath) {
  const resolvedPath = path.resolve(videoPath);
  await fs.access(resolvedPath);
  const reason =
    "Direct TikTok posting by file path is disabled. " +
    "Place the video in the TikTok pending queue and use the managed queue lifecycle.";
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
