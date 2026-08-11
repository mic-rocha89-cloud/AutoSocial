const fs = require("fs/promises");
const path = require("path");
const crypto = require("crypto");
const { config } = require("./config");
const { writeJsonAtomically } = require("./fs-utils");

const VIDEO_EXTENSIONS = new Set([".mp4", ".mov", ".webm", ".avi", ".mkv"]);
const SNAPSHOT_BINDING_FILE = ".snapshot-binding.json";
const SNAPSHOT_CHUNK_SIZE = 1024 * 1024;

function getCaptionPaths(videoPath) {
  const parsed = path.parse(videoPath);
  return [
    path.join(parsed.dir, `${parsed.name}.description`),
    path.join(parsed.dir, `${parsed.name}.txt`),
  ];
}

async function listQueueVideos(queueDir) {
  const dir = queueDir || config.queueDir;
  const entries = await fs.readdir(dir, { withFileTypes: true });
  const candidates = entries
    .filter((entry) => entry.isFile())
    .filter((entry) => VIDEO_EXTENSIONS.has(path.extname(entry.name).toLowerCase()))
    .map((entry) => path.join(dir, entry.name));
  const videos = [];

  for (const videoPath of candidates) {
    if (!(await hasActiveClaim(videoPath, dir))) {
      videos.push(videoPath);
    }
  }

  videos.sort((a, b) => a.localeCompare(b));
  return videos;
}

function pickNextVideo(videos) {
  if (videos.length === 0) {
    return null;
  }
  if (config.randomQueueOrder) {
    return videos[Math.floor(Math.random() * videos.length)];
  }
  return videos[0];
}

async function getNextQueuedItem(queueDir) {
  const videos = await listQueueVideos(queueDir);
  const videoPath = pickNextVideo(videos);
  if (!videoPath) {
    return null;
  }

  const videoIdentity = await inspectStableFile(videoPath);
  return {
    videoPath,
    videoIdentity,
    captionPaths: getCaptionPaths(videoPath),
  };
}

function getQueueStateDirs(queueDir) {
  const pending = path.resolve(queueDir || config.queueDir);
  const root = path.dirname(pending);
  return {
    pending,
    processing: path.join(root, "processing"),
    claims: path.join(root, "processing", ".claims"),
    uncertain: path.join(root, "uncertain"),
  };
}

function normalizeQueueItemIdentity(videoPath) {
  const resolvedPath = path.resolve(videoPath);
  return process.platform === "win32"
    ? resolvedPath.toLowerCase()
    : resolvedPath;
}

function getClaimMarkerPath(videoPath, queueDir) {
  const stateDirs = getQueueStateDirs(queueDir || path.dirname(videoPath));
  const itemKey = crypto
    .createHash("sha256")
    .update(normalizeQueueItemIdentity(videoPath))
    .digest("hex");
  return path.join(stateDirs.claims, `${itemKey}.json`);
}

async function hasActiveClaim(videoPath, queueDir) {
  const markerPath = getClaimMarkerPath(videoPath, queueDir);
  try {
    await fs.access(markerPath);
    return true;
  } catch (error) {
    if (error.code === "ENOENT") {
      return false;
    }
    throw error;
  }
}

function makeIntegrityError(message) {
  const error = new Error(message);
  error.code = "EQUEUEINTEGRITY";
  error.requiresRecovery = true;
  return error;
}

function serializeStat(stat) {
  return {
    dev: stat.dev.toString(),
    ino: stat.ino.toString(),
    size: stat.size.toString(),
    mtimeNs: stat.mtimeNs.toString(),
    ctimeNs: stat.ctimeNs.toString(),
  };
}

function sameStat(left, right) {
  return (
    left.dev === right.dev &&
    left.ino === right.ino &&
    left.size === right.size &&
    left.mtimeNs === right.mtimeNs &&
    left.ctimeNs === right.ctimeNs
  );
}

function sameContentIdentity(left, right) {
  return (
    left.dev === right.dev &&
    left.ino === right.ino &&
    left.size === right.size &&
    left.sha256 === right.sha256
  );
}

function sameContent(left, right) {
  return left.size === right.size && left.sha256 === right.sha256;
}

function byteLengthAsNumber(size, filePath) {
  const value = Number(size);
  if (!Number.isSafeInteger(value) || value < 0) {
    throw makeIntegrityError(
      `Queue file is too large to snapshot safely: ${filePath}`
    );
  }
  return value;
}

async function hashFileHandle(handle, expectedSize, filePath) {
  const size = byteLengthAsNumber(expectedSize, filePath);
  const hash = crypto.createHash("sha256");
  const buffer = Buffer.allocUnsafe(Math.min(SNAPSHOT_CHUNK_SIZE, size || 1));
  let position = 0;

  while (position < size) {
    const length = Math.min(buffer.length, size - position);
    const { bytesRead } = await handle.read(buffer, 0, length, position);
    if (bytesRead === 0) {
      throw makeIntegrityError(
        `Queue file changed while it was being read: ${filePath}`
      );
    }
    hash.update(buffer.subarray(0, bytesRead));
    position += bytesRead;
  }

  return {
    sha256: hash.digest("hex"),
    size: String(position),
  };
}

async function inspectStableFile(filePath) {
  let handle;
  try {
    handle = await fs.open(filePath, "r");
    const beforeStat = await handle.stat({ bigint: true });
    if (!beforeStat.isFile()) {
      throw makeIntegrityError(`Queue path is not a regular file: ${filePath}`);
    }
    const before = serializeStat(beforeStat);
    const content = await hashFileHandle(handle, beforeStat.size, filePath);
    const after = serializeStat(await handle.stat({ bigint: true }));
    if (!sameStat(before, after) || content.size !== before.size) {
      throw makeIntegrityError(
        `Queue file changed while its identity was being captured: ${filePath}`
      );
    }
    return {
      path: filePath,
      ...before,
      sha256: content.sha256,
    };
  } finally {
    if (handle) {
      await handle.close().catch(() => {});
    }
  }
}

async function inspectSidecars(videoPath) {
  const sidecars = [];
  for (const originalPath of getCaptionPaths(videoPath)) {
    try {
      const observed = await inspectStableFile(originalPath);
      sidecars.push({ originalPath, present: true, observed });
    } catch (error) {
      if (error.code !== "ENOENT") {
        throw error;
      }
      sidecars.push({ originalPath, present: false, observed: null });
    }
  }
  return sidecars;
}

async function assertObservedSidecarsUnchanged(sidecars) {
  for (const sidecar of sidecars) {
    try {
      const current = await inspectStableFile(sidecar.originalPath);
      if (!sidecar.present || !sameContentIdentity(sidecar.observed, current)) {
        throw makeIntegrityError(
          `Sidecar identity or content changed before claim: ${sidecar.originalPath}`
        );
      }
    } catch (error) {
      if (error.code === "ENOENT" && !sidecar.present) {
        continue;
      }
      if (error.code === "ENOENT") {
        throw makeIntegrityError(
          `Expected sidecar disappeared before claim: ${sidecar.originalPath}`
        );
      }
      throw error;
    }
  }
}

async function assertOriginalSidecarPathsAbsent(sidecars) {
  for (const sidecar of sidecars) {
    try {
      await fs.lstat(sidecar.originalPath);
      throw makeIntegrityError(
        `A late or replacement sidecar appeared outside the current claim: ${sidecar.originalPath}`
      );
    } catch (error) {
      if (error.code !== "ENOENT") {
        throw error;
      }
    }
  }
}

async function createStableSnapshot(sourcePath, snapshotPath) {
  let sourceHandle;
  let snapshotHandle;
  let completed = false;

  try {
    sourceHandle = await fs.open(sourcePath, "r");
    const beforeStat = await sourceHandle.stat({ bigint: true });
    if (!beforeStat.isFile()) {
      throw makeIntegrityError(`Claim source is not a regular file: ${sourcePath}`);
    }
    const before = serializeStat(beforeStat);
    const size = byteLengthAsNumber(beforeStat.size, sourcePath);
    const copyHash = crypto.createHash("sha256");
    const buffer = Buffer.allocUnsafe(Math.min(SNAPSHOT_CHUNK_SIZE, size || 1));
    let position = 0;

    snapshotHandle = await fs.open(snapshotPath, "wx", 0o600);
    while (position < size) {
      const length = Math.min(buffer.length, size - position);
      const { bytesRead } = await sourceHandle.read(
        buffer,
        0,
        length,
        position
      );
      if (bytesRead === 0) {
        throw makeIntegrityError(
          `Claim source changed while snapshot was being formed: ${sourcePath}`
        );
      }
      let written = 0;
      while (written < bytesRead) {
        const result = await snapshotHandle.write(
          buffer,
          written,
          bytesRead - written,
          position + written
        );
        if (result.bytesWritten === 0) {
          throw makeIntegrityError(
            `Snapshot write made no progress for current claim: ${snapshotPath}`
          );
        }
        written += result.bytesWritten;
      }
      copyHash.update(buffer.subarray(0, bytesRead));
      position += bytesRead;
    }
    await snapshotHandle.sync();

    const afterCopy = serializeStat(await sourceHandle.stat({ bigint: true }));
    const verifiedSource = await hashFileHandle(
      sourceHandle,
      beforeStat.size,
      sourcePath
    );
    const afterVerify = serializeStat(await sourceHandle.stat({ bigint: true }));
    const copiedSha256 = copyHash.digest("hex");
    if (
      !sameStat(before, afterCopy) ||
      !sameStat(afterCopy, afterVerify) ||
      String(position) !== before.size ||
      verifiedSource.size !== before.size ||
      verifiedSource.sha256 !== copiedSha256
    ) {
      throw makeIntegrityError(
        `Claim source changed while snapshot was being formed: ${sourcePath}`
      );
    }

    await snapshotHandle.close();
    snapshotHandle = null;
    await sourceHandle.close();
    sourceHandle = null;

    const snapshot = await inspectStableFile(snapshotPath);
    if (snapshot.size !== before.size || snapshot.sha256 !== copiedSha256) {
      throw makeIntegrityError(
        `Snapshot verification failed for current claim: ${snapshotPath}`
      );
    }
    completed = true;
    return snapshot;
  } finally {
    if (snapshotHandle) {
      await snapshotHandle.close().catch(() => {});
    }
    if (sourceHandle) {
      await sourceHandle.close().catch(() => {});
    }
    if (!completed) {
      await fs.unlink(snapshotPath).catch(() => {});
    }
  }
}

function assertBindingMatches(expected, actual, label) {
  if (
    !actual ||
    path.resolve(actual.path) !== path.resolve(expected.path) ||
    actual.dev !== expected.dev ||
    actual.ino !== expected.ino ||
    actual.size !== expected.size ||
    actual.sha256 !== expected.sha256
  ) {
    throw makeIntegrityError(`${label} is not bound to the current claim.`);
  }
}

async function readCaptionFromSnapshots(sidecarBindings) {
  if (sidecarBindings.length === 0) {
    return "";
  }
  const preferred = sidecarBindings[0];
  const current = await inspectStableFile(preferred.path);
  assertBindingMatches(preferred, current, "Caption sidecar");
  const text = await fs.readFile(preferred.path, "utf8");
  const afterRead = await inspectStableFile(preferred.path);
  assertBindingMatches(preferred, afterRead, "Caption sidecar");
  return text.trim();
}

function parseJsonEvidence(text, evidencePath) {
  try {
    return JSON.parse(text);
  } catch (error) {
    throw makeIntegrityError(
      `Durable queue evidence is invalid at ${evidencePath}: ${error.message}`
    );
  }
}

async function assertClaimSnapshotReady({
  videoPath,
  caption,
  captionPaths,
  claimDir,
  claimMarkerPath,
  snapshotBindingPath,
  claimId,
}) {
  if (
    !videoPath ||
    !claimDir ||
    !claimMarkerPath ||
    !snapshotBindingPath ||
    !claimId ||
    !Array.isArray(captionPaths)
  ) {
    throw makeIntegrityError("Queue upload is missing durable snapshot evidence.");
  }

  const resolvedClaimDir = path.resolve(claimDir);
  const expectedBindingPath = path.join(
    resolvedClaimDir,
    SNAPSHOT_BINDING_FILE
  );
  if (path.resolve(snapshotBindingPath) !== expectedBindingPath) {
    throw makeIntegrityError("Snapshot evidence belongs to a different claim.");
  }
  if (
    path.dirname(path.resolve(videoPath)) !== resolvedClaimDir ||
    captionPaths.some(
      (sidecarPath) => path.dirname(path.resolve(sidecarPath)) !== resolvedClaimDir
    )
  ) {
    throw makeIntegrityError("Snapshot path is outside the current claim.");
  }

  const marker = parseJsonEvidence(
    await fs.readFile(claimMarkerPath, "utf8"),
    claimMarkerPath
  );
  const binding = parseJsonEvidence(
    await fs.readFile(snapshotBindingPath, "utf8"),
    snapshotBindingPath
  );
  if (
    marker.claimId !== claimId ||
    binding.claimId !== claimId ||
    marker.schemaVersion !== 2 ||
    marker.state !== "claim-created" ||
    binding.schemaVersion !== 1 ||
    path.resolve(marker.bindingPath || "") !== expectedBindingPath ||
    path.resolve(marker.item?.snapshotPath || "") !== path.resolve(videoPath) ||
    binding.state !== "snapshot-ready" ||
    !Array.isArray(marker.sidecars) ||
    !Array.isArray(binding.sidecars)
  ) {
    throw makeIntegrityError("Snapshot evidence belongs to a different claim.");
  }

  const expectedSidecarPaths = marker.sidecars
    .filter((sidecar) => sidecar.present)
    .map((sidecar) => path.resolve(sidecar.snapshotPath));
  if (
    expectedSidecarPaths.length !== captionPaths.length ||
    expectedSidecarPaths.some(
      (expectedPath, index) => expectedPath !== path.resolve(captionPaths[index])
    ) ||
    binding.sidecars.length !== captionPaths.length
  ) {
    throw makeIntegrityError("Claimed sidecar set does not match durable evidence.");
  }

  const video = await inspectStableFile(videoPath);
  assertBindingMatches(binding.video, video, "Video snapshot");
  for (let index = 0; index < binding.sidecars.length; index += 1) {
    const sidecar = await inspectStableFile(captionPaths[index]);
    assertBindingMatches(binding.sidecars[index], sidecar, "Caption sidecar");
  }
  const boundCaption = await readCaptionFromSnapshots(binding.sidecars);
  if (boundCaption !== caption) {
    throw makeIntegrityError(
      "Caption in memory does not match the sidecar bound to the current claim."
    );
  }
  return true;
}

async function createClaimMarker(markerPath, manifest) {
  const markerDir = path.dirname(markerPath);
  await fs.mkdir(markerDir, { recursive: true });
  const tempPath = path.join(
    markerDir,
    `.${path.basename(markerPath)}.${process.pid}.${crypto.randomUUID()}.tmp`
  );
  let handle;

  try {
    handle = await fs.open(tempPath, "wx", 0o600);
    await handle.writeFile(`${JSON.stringify(manifest, null, 2)}\n`, "utf8");
    await handle.sync();
    await handle.close();
    handle = null;
    await fs.link(tempPath, markerPath);
  } catch (error) {
    if (error.code === "EEXIST") {
      const claimedError = new Error(
        "A durable claim already exists for this queue item; recovery is required."
      );
      claimedError.code = "EQUEUECLAIMED";
      claimedError.requiresRecovery = true;
      throw claimedError;
    }
    throw error;
  } finally {
    if (handle) {
      await handle.close().catch(() => {});
    }
    await fs.unlink(tempPath).catch(() => {});
  }
}

async function completeQueuedClaim({ claimDir, claimMarkerPath }) {
  if (!claimDir || !claimMarkerPath) {
    throw new Error("Cannot complete a queue claim without its durable evidence.");
  }

  const snapshotBindingPath = path.join(claimDir, SNAPSHOT_BINDING_FILE);
  await fs.unlink(snapshotBindingPath);
  const remaining = await fs.readdir(claimDir);
  if (remaining.length > 0) {
    throw new Error(
      "Queue claim still contains unfinalized files; durable claim remains active."
    );
  }

  await fs.rmdir(claimDir);
  await fs.unlink(claimMarkerPath);
}

async function claimQueuedItem(item, queueDir) {
  if (!item?.videoPath || !item.videoIdentity) {
    throw makeIntegrityError(
      "Cannot claim a queue item without its selected file identity."
    );
  }

  const stateDirs = getQueueStateDirs(queueDir || path.dirname(item.videoPath));
  await fs.mkdir(stateDirs.processing, { recursive: true });
  const claimId = crypto.randomUUID();
  const claimDir = path.join(stateDirs.processing, claimId);
  const snapshotVideoPath = path.join(claimDir, path.basename(item.videoPath));
  const sourceVideoPath = path.join(claimDir, ".claim-source-video");
  const snapshotBindingPath = path.join(claimDir, SNAPSHOT_BINDING_FILE);
  const sidecars = await inspectSidecars(item.videoPath);
  await fs.mkdir(claimDir);
  const originalCaptionPaths = sidecars.map(({ originalPath }) => originalPath);
  const claimedAt = new Date().toISOString();
  const claimMarkerPath = getClaimMarkerPath(item.videoPath, stateDirs.pending);
  const sidecarManifest = sidecars.map((sidecar, index) => ({
    originalPath: sidecar.originalPath,
    sourcePath: path.join(claimDir, `.claim-source-sidecar-${index}`),
    snapshotPath: path.join(claimDir, path.basename(sidecar.originalPath)),
    present: sidecar.present,
  }));
  const manifest = {
    schemaVersion: 2,
    state: "claim-created",
    claimId,
    claimedAt,
    bindingPath: snapshotBindingPath,
    item: {
      originalPath: item.videoPath,
      selectedIdentity: item.videoIdentity,
      sourcePath: sourceVideoPath,
      snapshotPath: snapshotVideoPath,
    },
    sidecars: sidecarManifest,
  };
  let markerCreated = false;
  let videoSnapshot;
  const sidecarSnapshots = [];

  try {
    await createClaimMarker(claimMarkerPath, manifest);
    markerCreated = true;
    await assertObservedSidecarsUnchanged(sidecars);
    await fs.rename(item.videoPath, sourceVideoPath);
    const claimedVideoIdentity = await inspectStableFile(sourceVideoPath);
    if (!sameContentIdentity(item.videoIdentity, claimedVideoIdentity)) {
      throw makeIntegrityError(
        "The selected queue video was replaced before it could be snapshotted."
      );
    }
    for (let index = 0; index < manifest.sidecars.length; index += 1) {
      const sidecar = manifest.sidecars[index];
      if (!sidecar.present) {
        continue;
      }
      try {
        await fs.rename(sidecar.originalPath, sidecar.sourcePath);
        const claimedSource = await inspectStableFile(sidecar.sourcePath);
        if (!sameContentIdentity(sidecars[index].observed, claimedSource)) {
          throw makeIntegrityError(
            `Claimed sidecar identity or content changed: ${sidecar.originalPath}`
          );
        }
      } catch (error) {
        if (error.code === "ENOENT") {
          throw makeIntegrityError(
            `Expected sidecar disappeared after durable claim: ${sidecar.originalPath}`
          );
        }
        throw error;
      }
    }
    await assertOriginalSidecarPathsAbsent(sidecars);

    videoSnapshot = await createStableSnapshot(
      sourceVideoPath,
      snapshotVideoPath
    );
    if (!sameContent(item.videoIdentity, videoSnapshot)) {
      throw makeIntegrityError(
        "The selected queue video content changed while its snapshot was being formed."
      );
    }
    await fs.unlink(sourceVideoPath);
    for (let index = 0; index < manifest.sidecars.length; index += 1) {
      const sidecar = manifest.sidecars[index];
      if (!sidecar.present) {
        continue;
      }
      const sidecarSnapshot = await createStableSnapshot(
        sidecar.sourcePath,
        sidecar.snapshotPath
      );
      if (!sameContent(sidecars[index].observed, sidecarSnapshot)) {
        throw makeIntegrityError(
          `Claimed sidecar content changed while snapshot was being formed: ${sidecar.originalPath}`
        );
      }
      sidecarSnapshots.push(sidecarSnapshot);
      await fs.unlink(sidecar.sourcePath);
    }
    const caption = await readCaptionFromSnapshots(sidecarSnapshots);
    await writeJsonAtomically(snapshotBindingPath, {
      schemaVersion: 1,
      state: "snapshot-ready",
      claimId,
      createdAt: new Date().toISOString(),
      video: videoSnapshot,
      sidecars: sidecarSnapshots,
    });

    return {
      ...item,
      videoPath: snapshotVideoPath,
      caption,
      captionPaths: sidecarSnapshots.map((snapshot) => snapshot.path),
      originalVideoPath: item.videoPath,
      originalCaptionPaths,
      originalFileName: path.basename(item.videoPath),
      claimDir,
      claimMarkerPath,
      snapshotBindingPath,
      claimId,
      claimedAt,
      stateDirs,
    };
  } catch (error) {
    if (!markerCreated) {
      await fs.rmdir(claimDir).catch(() => {});
    } else {
      error.requiresRecovery = true;
      error.claimId = claimId;
      error.claimMarkerPath = claimMarkerPath;
    }
    throw error;
  }
}

module.exports = {
  assertClaimSnapshotReady,
  claimQueuedItem,
  completeQueuedClaim,
  getClaimMarkerPath,
  getNextQueuedItem,
  getCaptionPaths,
  getQueueStateDirs,
  listQueueVideos,
  VIDEO_EXTENSIONS,
};
