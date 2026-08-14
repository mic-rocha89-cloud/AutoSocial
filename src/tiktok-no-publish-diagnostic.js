const crypto = require("node:crypto");
const fs = require("node:fs");
const fsp = require("node:fs/promises");
const path = require("node:path");
const { execFileSync } = require("node:child_process");
const { chromium } = require("playwright");

const { config } = require("./config");
const {
  getPlatformProfileDir,
  hasSavedPlatformSession,
} = require("./account-manager");
const tiktokUploader = require("./tiktok-uploader")._private;

const AUTHORIZATION_VALUE = "PHASE-A-REAL-UPLOAD-NO-PUBLISH";
const EXPECTED_ACCOUNT_ID = "qa-tiktok";
const EXPECTED_BRANCH = "fix/tiktok-publish-readiness-confirmation";
const EXPECTED_VIEWPORT = Object.freeze({ width: 1400, height: 1000 });
const EXACT_UPLOAD_URL = "https://www.tiktok.com/tiktokstudio/upload";
const READINESS_MAX_WAIT_MS = 12 * 60 * 1000;
const READINESS_POLL_INTERVAL_MS = 5000;
const READINESS_STABLE_POLLS = 2;
const SUPPORTED_VIDEO_EXTENSIONS = new Set([
  ".mp4",
  ".mov",
  ".webm",
  ".avi",
  ".mkv",
]);

function normalizePathForComparison(value) {
  const resolved = path.resolve(value);
  return process.platform === "win32" ? resolved.toLowerCase() : resolved;
}

function isPathInside(candidatePath, parentPath) {
  const candidate = normalizePathForComparison(candidatePath);
  const parent = normalizePathForComparison(parentPath);
  const relative = path.relative(parent, candidate);
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

function validateNoPublishDiagnosticOptions(options, { projectRoot = config.projectRoot } = {}) {
  if (!options || typeof options !== "object") {
    throw new Error("Diagnostic options are required.");
  }
  if (options.authorization !== AUTHORIZATION_VALUE) {
    throw new Error("Explicit Phase A no-publish authorization is required.");
  }
  if (options.accountId !== EXPECTED_ACCOUNT_ID) {
    throw new Error(`Diagnostic account must be exactly ${EXPECTED_ACCOUNT_ID}.`);
  }
  if (options.expectedBranch !== EXPECTED_BRANCH) {
    throw new Error(`Expected branch must be exactly ${EXPECTED_BRANCH}.`);
  }
  if (!/^[0-9a-f]{40}$/.test(String(options.expectedHead || ""))) {
    throw new Error("Expected HEAD must be a full lowercase 40-character Git SHA.");
  }
  if (!/^[0-9a-f]{64}$/.test(String(options.expectedSha256 || ""))) {
    throw new Error("Expected source SHA-256 must be a lowercase 64-character digest.");
  }
  if (!Number.isSafeInteger(options.expectedSize) || options.expectedSize <= 0) {
    throw new Error("Expected source size must be a positive integer.");
  }

  const sourcePath = path.resolve(String(options.sourcePath || ""));
  if (!SUPPORTED_VIDEO_EXTENSIONS.has(path.extname(sourcePath).toLowerCase())) {
    throw new Error("Diagnostic source must use a supported video extension.");
  }
  const queueRoot = path.resolve(projectRoot, "queue");
  if (isPathInside(sourcePath, queueRoot)) {
    throw new Error("Diagnostic source must not come from the managed queue tree.");
  }

  const localRoot = path.resolve(projectRoot, ".local");
  const outputDir = path.resolve(String(options.outputDir || ""));
  if (
    normalizePathForComparison(path.dirname(outputDir)) !==
      normalizePathForComparison(localRoot) ||
    !path.basename(outputDir).startsWith("qa-tiktok-no-publish-")
  ) {
    throw new Error(
      "Diagnostic output must be a new qa-tiktok-no-publish-* directory directly under .local."
    );
  }

  return {
    ...options,
    outputDir,
    projectRoot: path.resolve(projectRoot),
    queueRoot,
    sourcePath,
  };
}

function runGit(projectRoot, args) {
  return execFileSync("git", args, {
    cwd: projectRoot,
    encoding: "utf8",
    windowsHide: true,
  }).trim();
}

async function getGitState(projectRoot) {
  return {
    branch: runGit(projectRoot, ["branch", "--show-current"]),
    head: runGit(projectRoot, ["rev-parse", "HEAD"]),
    trackedStatus: runGit(projectRoot, [
      "status",
      "--porcelain",
      "--untracked-files=no",
    ]),
  };
}

async function hashFileSha256(filePath) {
  const hash = crypto.createHash("sha256");
  await new Promise((resolve, reject) => {
    const stream = fs.createReadStream(filePath);
    stream.on("data", (chunk) => hash.update(chunk));
    stream.on("error", reject);
    stream.on("end", resolve);
  });
  return hash.digest("hex");
}

async function inspectSourceIdentity(sourcePath) {
  const stat = await fsp.stat(sourcePath);
  if (!stat.isFile() || stat.size <= 0) {
    throw new Error("Diagnostic source must be a non-empty regular file.");
  }
  return {
    fileName: path.basename(sourcePath),
    sha256: await hashFileSha256(sourcePath),
    size: stat.size,
  };
}

async function assertSourceIsIndependentFromQueue(sourcePath, queueRoot) {
  const sourceRealPath = await fsp.realpath(sourcePath);
  let queueRealPath = queueRoot;
  try {
    queueRealPath = await fsp.realpath(queueRoot);
  } catch (error) {
    if (error.code !== "ENOENT") {
      throw error;
    }
  }
  if (isPathInside(sourceRealPath, queueRealPath)) {
    throw new Error("Diagnostic source resolves inside the managed queue tree.");
  }

  const sourceStat = await fsp.stat(sourceRealPath);
  async function visit(currentPath) {
    let children;
    try {
      children = await fsp.readdir(currentPath, { withFileTypes: true });
    } catch (error) {
      if (error.code === "ENOENT") {
        return false;
      }
      throw error;
    }
    for (const child of children) {
      const childPath = path.join(currentPath, child.name);
      if (child.isDirectory()) {
        if (await visit(childPath)) {
          return true;
        }
        continue;
      }
      if (!child.isFile() && !child.isSymbolicLink()) {
        continue;
      }
      let candidateStat;
      let candidateRealPath;
      try {
        candidateStat = await fsp.stat(childPath);
        candidateRealPath = await fsp.realpath(childPath);
      } catch {
        continue;
      }
      if (
        normalizePathForComparison(candidateRealPath) ===
          normalizePathForComparison(sourceRealPath) ||
        (sourceStat.ino !== 0 &&
          candidateStat.ino === sourceStat.ino &&
          candidateStat.dev === sourceStat.dev)
      ) {
        return true;
      }
    }
    return false;
  }

  if (await visit(queueRoot)) {
    throw new Error("Diagnostic source is aliased by the managed queue tree.");
  }
}

function assertSourceIdentity(identity, options, phase) {
  if (
    identity.size !== options.expectedSize ||
    identity.sha256 !== options.expectedSha256
  ) {
    throw new Error(`Approved source identity changed at ${phase}.`);
  }
}

async function captureQueueSnapshot(queueRoot) {
  const entries = [];

  async function visit(currentPath) {
    let children;
    try {
      children = await fsp.readdir(currentPath, { withFileTypes: true });
    } catch (error) {
      if (error.code === "ENOENT") {
        return;
      }
      throw error;
    }

    children.sort((left, right) => left.name.localeCompare(right.name));
    for (const child of children) {
      const childPath = path.join(currentPath, child.name);
      const relativePath = path
        .relative(queueRoot, childPath)
        .split(path.sep)
        .join("/");
      const stat = await fsp.lstat(childPath);
      const entry = {
        path: relativePath,
        type: child.isDirectory()
          ? "directory"
          : child.isFile()
            ? "file"
            : child.isSymbolicLink()
              ? "symlink"
              : "other",
        size: stat.size,
        mtimeMs: stat.mtimeMs,
      };
      if (child.isSymbolicLink()) {
        entry.linkTarget = await fsp.readlink(childPath);
      }
      entries.push(entry);
      if (child.isDirectory()) {
        await visit(childPath);
      }
    }
  }

  await visit(queueRoot);
  const digest = crypto
    .createHash("sha256")
    .update(JSON.stringify(entries))
    .digest("hex");
  return {
    schemaVersion: 1,
    mode: "path-type-size-mtime",
    digest,
    entryCount: entries.length,
    fileCount: entries.filter(({ type }) => type === "file").length,
  };
}

function sanitizeRequestUrl(value) {
  try {
    const parsed = new URL(value);
    return `${parsed.origin}${parsed.pathname}`;
  } catch {
    return "unparseable-url";
  }
}

function getTikTokRequestOrigin(value) {
  try {
    const parsed = new URL(value);
    const hostname = parsed.hostname.toLowerCase();
    if (hostname === "tiktok.com" || hostname.endsWith(".tiktok.com")) {
      return parsed.origin;
    }
  } catch {
    return null;
  }
  return null;
}

async function installNoPublishGuards(
  page,
  { isLikelyPublishRequest = tiktokUploader.isLikelyPublishApiResponse } = {}
) {
  const blockedPublishRequests = [];
  const guardErrors = [];

  await page.addInitScript(() => {
    const state = { blockedClickCount: 0 };
    Object.defineProperty(window, "__autoSocialNoPublishGuard", {
      configurable: false,
      enumerable: false,
      value: state,
      writable: false,
    });
    window.addEventListener(
      "click",
      (event) => {
        state.blockedClickCount += 1;
        event.preventDefault();
        event.stopImmediatePropagation();
        event.stopPropagation();
      },
      true
    );
  });

  const routeHandler = async (route) => {
    const request = route.request();
    const candidate = {
      request: () => request,
      url: () => request.url(),
    };
    let shouldBlock = false;
    try {
      const requestOrigin = getTikTokRequestOrigin(request.url());
      shouldBlock = Boolean(
        requestOrigin && isLikelyPublishRequest(candidate, requestOrigin)
      );
    } catch (error) {
      guardErrors.push(error.message);
      await route.abort("blockedbyclient");
      return;
    }
    if (shouldBlock) {
      blockedPublishRequests.push({
        method: request.method().toUpperCase(),
        url: sanitizeRequestUrl(request.url()),
      });
      await route.abort("blockedbyclient");
      return;
    }
    await route.continue();
  };

  await page.route("**/*", routeHandler);

  return {
    async dispose() {
      await page.unroute("**/*", routeHandler).catch(() => {});
    },
    async getState() {
      const frames =
        typeof page.frames === "function" ? page.frames() : [page];
      const frameStates = await Promise.all(
        frames.map((frame) =>
          frame
            .evaluate(() => ({
              blockedClickCount:
                window.__autoSocialNoPublishGuard?.blockedClickCount ?? null,
            }))
            .catch(() => ({ blockedClickCount: null }))
        )
      );
      const frameCounts = frameStates.map(({ blockedClickCount }) =>
        Number.isInteger(blockedClickCount) && blockedClickCount >= 0
          ? blockedClickCount
          : null
      );
      return {
        blockedClickCount: frameCounts.includes(null)
          ? null
          : frameCounts.reduce((total, count) => total + count, 0),
        guardedFrameCount: frameCounts.length,
        blockedPublishRequestCount: blockedPublishRequests.length,
        blockedPublishRequests: [...blockedPublishRequests],
        guardErrors: [...guardErrors],
      };
    },
  };
}

async function writeJsonAtomically(filePath, value) {
  const temporaryPath = `${filePath}.${crypto.randomUUID()}.tmp`;
  await fsp.writeFile(temporaryPath, `${JSON.stringify(value, null, 2)}\n`, "utf8");
  await fsp.rename(temporaryPath, filePath);
}

async function ensureNewOutputDirectory(outputDir) {
  const localRoot = path.dirname(outputDir);
  const projectRoot = path.dirname(localRoot);
  await fsp.mkdir(localRoot, { recursive: true });
  const [realProjectRoot, realLocalRoot] = await Promise.all([
    fsp.realpath(projectRoot),
    fsp.realpath(localRoot),
  ]);
  if (
    normalizePathForComparison(realLocalRoot) !==
    normalizePathForComparison(path.join(realProjectRoot, ".local"))
  ) {
    throw new Error("Diagnostic output parent must not redirect outside .local.");
  }
  try {
    await fsp.lstat(outputDir);
    throw new Error("Diagnostic output directory already exists.");
  } catch (error) {
    if (error.code !== "ENOENT") {
      throw error;
    }
  }
  await fsp.mkdir(outputDir);
}

function assertExactUploadPage(pageUrl) {
  let parsed;
  try {
    parsed = new URL(pageUrl);
  } catch {
    throw new Error("TikTok diagnostic did not reach a valid URL.");
  }
  if (
    parsed.origin !== "https://www.tiktok.com" ||
    parsed.pathname !== "/tiktokstudio/upload"
  ) {
    throw new Error("TikTok diagnostic did not reach the exact Studio upload page.");
  }
}

async function defaultLaunchPersistentContext(profileDir) {
  return chromium.launchPersistentContext(profileDir, {
    headless: false,
    viewport: EXPECTED_VIEWPORT,
    locale: config.browserLocale,
    timezoneId: config.timezone,
    serviceWorkers: "block",
    args: ["--disable-blink-features=AutomationControlled"],
  });
}

function safeResolutionResult(resolved) {
  return {
    status: resolved?.status || "unavailable",
    count:
      resolved?.status === "unique"
        ? 1
        : Number.isInteger(resolved?.count)
          ? resolved.count
          : null,
    reason: resolved?.reason || "",
    ...(resolved?.diagnostics ? { diagnostics: resolved.diagnostics } : {}),
  };
}

async function runTikTokNoPublishDiagnostic(options, overrides = {}) {
  const validated = validateNoPublishDiagnosticOptions(options, {
    projectRoot: overrides.projectRoot || config.projectRoot,
  });
  const dependencies = {
    captureQueueSnapshot,
    getGitState,
    getPlatformProfileDir,
    hasSavedPlatformSession,
    inspectSourceIdentity,
    installNoPublishGuards,
    launchPersistentContext: defaultLaunchPersistentContext,
    uploader: {
      collectTikTokPublishTargetResolutionDiagnostics:
        tiktokUploader.collectTikTokPublishTargetResolutionDiagnostics,
      findUniquePublishTarget: tiktokUploader.findUniquePublishTarget,
      prepareTikTokPublishTargetForQualification:
        tiktokUploader.prepareTikTokPublishTargetForQualification,
      waitForTikTokPublishReadiness:
        tiktokUploader.waitForTikTokPublishReadiness,
    },
    ...overrides,
  };
  dependencies.uploader = {
    collectTikTokPublishTargetResolutionDiagnostics:
      tiktokUploader.collectTikTokPublishTargetResolutionDiagnostics,
    findUniquePublishTarget: tiktokUploader.findUniquePublishTarget,
    prepareTikTokPublishTargetForQualification:
      tiktokUploader.prepareTikTokPublishTargetForQualification,
    waitForTikTokPublishReadiness:
      tiktokUploader.waitForTikTokPublishReadiness,
    ...(overrides.uploader || {}),
  };

  const git = await dependencies.getGitState(validated.projectRoot);
  if (
    git.branch !== validated.expectedBranch ||
    git.head !== validated.expectedHead ||
    git.trackedStatus !== ""
  ) {
    throw new Error("Git branch, HEAD, or tracked cleanliness preflight failed.");
  }
  if (
    !(await dependencies.hasSavedPlatformSession(
      "tiktok",
      validated.accountId
    ))
  ) {
    throw new Error("The qa-tiktok account has no saved TikTok session.");
  }

  const sourceBefore = await dependencies.inspectSourceIdentity(
    validated.sourcePath
  );
  await assertSourceIsIndependentFromQueue(
    validated.sourcePath,
    validated.queueRoot
  );
  assertSourceIdentity(sourceBefore, validated, "preflight");
  const queueBefore = await dependencies.captureQueueSnapshot(
    validated.queueRoot
  );
  await ensureNewOutputDirectory(validated.outputDir);

  const reportPath = path.join(validated.outputDir, "report.json");
  const transitionsPath = path.join(
    validated.outputDir,
    "readiness-transitions.json"
  );
  const report = {
    schemaVersion: 1,
    diagnostic: "tiktok-phase-a-no-publish",
    status: "running",
    startedAt: new Date().toISOString(),
    finishedAt: null,
    git,
    accountId: validated.accountId,
    profileId: `${validated.accountId}/tiktok`,
    viewport: EXPECTED_VIEWPORT,
    source: sourceBefore,
    readiness: {
      maxWaitMs: READINESS_MAX_WAIT_MS,
      pollIntervalMs: READINESS_POLL_INTERVAL_MS,
      requiredStablePolls: READINESS_STABLE_POLLS,
      transitions: [],
      result: null,
    },
    beforePreparation: null,
    preparation: null,
    afterPreparation: null,
    resolution: null,
    clickAttempted: false,
    publishRequestAttempted: false,
    runOnceAttempted: false,
    queueMutated: false,
    queue: { before: queueBefore, after: null },
    safetyGuard: null,
    artifacts: [],
  };

  let context = null;
  let page = null;
  let guard = null;
  let runtimeError = null;

  const writeArtifact = async (fileName, value) => {
    await writeJsonAtomically(path.join(validated.outputDir, fileName), value);
    report.artifacts.push(fileName);
  };
  const captureScreenshot = async (fileName) => {
    await page.screenshot({
      path: path.join(validated.outputDir, fileName),
      fullPage: false,
    });
    report.artifacts.push(fileName);
  };
  const checkpoint = async () => {
    await writeJsonAtomically(
      transitionsPath,
      report.readiness.transitions
    );
    await writeJsonAtomically(reportPath, report);
  };

  await checkpoint();

  try {
    const profileDir = await dependencies.getPlatformProfileDir(
      "tiktok",
      validated.accountId
    );
    const expectedProfileDir = path.resolve(
      validated.projectRoot,
      ".profiles",
      EXPECTED_ACCOUNT_ID,
      "tiktok"
    );
    if (
      normalizePathForComparison(profileDir) !==
      normalizePathForComparison(expectedProfileDir)
    ) {
      throw new Error("Saved TikTok profile path did not match qa-tiktok.");
    }
    context = await dependencies.launchPersistentContext(profileDir);
    const contextPages = context.pages();
    if (contextPages.length !== 1) {
      throw new Error(
        `Expected exactly one saved-session page, observed ${contextPages.length}.`
      );
    }
    page = contextPages[0];
    guard = await dependencies.installNoPublishGuards(page);

    await page.goto(EXACT_UPLOAD_URL, { waitUntil: "domcontentloaded" });
    assertExactUploadPage(page.url());

    const fileInputs = page.locator('input[type="file"]');
    const fileInputCount = await fileInputs.count();
    if (fileInputCount !== 1) {
      throw new Error(
        `Expected exactly one TikTok file input, observed ${fileInputCount}.`
      );
    }
    const fileInput = fileInputs.first();
    await fileInput.waitFor({ state: "attached", timeout: 120000 });
    await fileInput.setInputFiles(validated.sourcePath);
    await captureScreenshot("input-assigned.png");

    const sourceAfterAssignment = await dependencies.inspectSourceIdentity(
      validated.sourcePath
    );
    assertSourceIdentity(sourceAfterAssignment, validated, "post-assignment");
    await checkpoint();

    const readiness = await dependencies.uploader.waitForTikTokPublishReadiness(
      page,
      {
        maxWaitMs: READINESS_MAX_WAIT_MS,
        pollIntervalMs: READINESS_POLL_INTERVAL_MS,
        requiredStablePolls: READINESS_STABLE_POLLS,
        onTransition: async (transition) => {
          report.readiness.transitions.push({ ...transition });
          await checkpoint();
        },
      }
    );
    report.readiness.result = readiness;
    await checkpoint();
    if (!readiness.ok) {
      throw new Error(`TikTok readiness did not become safe: ${readiness.reason}`);
    }

    await captureScreenshot("before-preparation.png");
    report.beforePreparation =
      await dependencies.uploader.collectTikTokPublishTargetResolutionDiagnostics(
        page
      );
    await writeArtifact("before-preparation.json", report.beforePreparation);
    await checkpoint();

    report.preparation =
      await dependencies.uploader.prepareTikTokPublishTargetForQualification(
        page
      );
    await writeArtifact("preparation.json", report.preparation);
    await captureScreenshot("after-preparation.png");

    report.afterPreparation =
      await dependencies.uploader.collectTikTokPublishTargetResolutionDiagnostics(
        page
      );
    await writeArtifact("after-preparation.json", report.afterPreparation);
    await checkpoint();

    const resolved = await dependencies.uploader.findUniquePublishTarget(page, {
      maxPolls: 6,
      pollIntervalMs: 2000,
    });
    report.resolution = safeResolutionResult(resolved);
    try {
      report.resolution.diagnostics =
        await dependencies.uploader.collectTikTokPublishTargetResolutionDiagnostics(
          page
        );
    } finally {
      if (resolved?.status === "unique" && resolved.target?.handle) {
        await resolved.target.handle.dispose().catch(() => {});
      }
    }
    await writeArtifact("resolution.json", report.resolution);
    await captureScreenshot("resolution.png");
    await checkpoint();

    report.safetyGuard = await guard.getState();
    report.clickAttempted = report.safetyGuard.blockedClickCount !== 0;
    report.publishRequestAttempted =
      report.safetyGuard.blockedPublishRequestCount !== 0;
    if (
      report.safetyGuard.blockedClickCount !== 0 ||
      report.safetyGuard.blockedPublishRequestCount !== 0 ||
      report.safetyGuard.guardErrors.length !== 0
    ) {
      throw new Error("The no-publish safety guard observed a blocked action.");
    }

    const sourceFinal = await dependencies.inspectSourceIdentity(
      validated.sourcePath
    );
    assertSourceIdentity(sourceFinal, validated, "finalization");
    const queueAfter = await dependencies.captureQueueSnapshot(
      validated.queueRoot
    );
    report.queue.after = queueAfter;
    report.queueMutated = queueBefore.digest !== queueAfter.digest;
    if (report.queueMutated) {
      throw new Error("Managed queue metadata changed during the diagnostic.");
    }

    report.status = "completed-without-publish";
  } catch (error) {
    runtimeError = error;
    report.status = "failed-closed";
    report.failure = { name: error.name, message: error.message };
    if (page) {
      await page
        .screenshot({
          path: path.join(validated.outputDir, "failure.png"),
          fullPage: false,
        })
        .then(() => report.artifacts.push("failure.png"))
        .catch(() => {});
    }
  } finally {
    if (guard) {
      if (!report.safetyGuard) {
        report.safetyGuard = await guard.getState().catch(() => null);
      }
      if (report.safetyGuard) {
        report.clickAttempted =
          report.safetyGuard.blockedClickCount !== 0;
        report.publishRequestAttempted =
          report.safetyGuard.blockedPublishRequestCount !== 0;
      }
      await guard.dispose();
    }
    if (context) {
      await context.close().catch(() => {});
    }
    if (!report.queue.after) {
      report.queue.after = await dependencies
        .captureQueueSnapshot(validated.queueRoot)
        .catch(() => null);
      if (report.queue.after) {
        report.queueMutated =
          queueBefore.digest !== report.queue.after.digest;
      }
    }
    report.finishedAt = new Date().toISOString();
    await writeJsonAtomically(transitionsPath, report.readiness.transitions);
    if (!report.artifacts.includes("readiness-transitions.json")) {
      report.artifacts.push("readiness-transitions.json");
    }
    await writeJsonAtomically(reportPath, report);
  }

  return {
    ok: runtimeError === null,
    report,
    reportPath,
    ...(runtimeError ? { error: runtimeError.message } : {}),
  };
}

module.exports = {
  AUTHORIZATION_VALUE,
  EXPECTED_ACCOUNT_ID,
  EXPECTED_BRANCH,
  EXPECTED_VIEWPORT,
  captureQueueSnapshot,
  installNoPublishGuards,
  runTikTokNoPublishDiagnostic,
  validateNoPublishDiagnosticOptions,
  _private: {
    assertExactUploadPage,
    assertSourceIsIndependentFromQueue,
    assertSourceIdentity,
    getGitState,
    hashFileSha256,
    inspectSourceIdentity,
    isPathInside,
    getTikTokRequestOrigin,
    safeResolutionResult,
    sanitizeRequestUrl,
  },
};
