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
const FILE_INPUT_WAIT_TIMEOUT_MS = 120000;
const MAX_BINDING_CAPTURE_BODY_BYTES = 1024 * 1024;
const MAX_BINDING_CAPTURE_OBSERVATIONS = 128;
const MAX_BINDING_CAPTURE_CANDIDATES = 128;
const MAX_BINDING_CAPTURE_ITEMS_PER_PHASE = 64;
const MAX_BINDING_CAPTURE_NODES = 512;
const MAX_BINDING_CAPTURE_DEPTH = 8;
const MAX_BINDING_CAPTURE_PATH_LENGTH = 512;
const MAX_BINDING_CAPTURE_PATH_SEGMENTS = 12;
const BINDING_CAPTURE_SETTLE_MS = 2000;
const BINDING_CAPTURE_PHASES = new Set(["page-load", "post-assignment"]);
const BINDING_CAPTURE_RESOURCE_TYPES = new Set([
  "document",
  "eventsource",
  "fetch",
  "font",
  "image",
  "manifest",
  "media",
  "other",
  "script",
  "stylesheet",
  "texttrack",
  "websocket",
  "xhr",
]);
const BINDING_CAPTURE_SAFE_PATH_TOKENS = new Set([
  "api",
  "apply",
  "auth",
  "aweme",
  "check",
  "commit",
  "content",
  "create",
  "creator",
  "detail",
  "draft",
  "init",
  "item",
  "list",
  "material",
  "media",
  "mget",
  "post",
  "project",
  "publish",
  "save",
  "status",
  "studio",
  "submit",
  "task",
  "tiktok",
  "update",
  "upload",
  "user",
  "video",
  "web",
]);
const OPERATION_BINDING_FIELDS = new Map([
  ["project_id", "project"],
  ["projectId", "project"],
  ["video_id", "video"],
  ["videoId", "video"],
  ["upload_id", "upload"],
  ["uploadId", "upload"],
]);
const BINDING_CAPTURE_METHODS = new Set(["POST", "PUT", "PATCH"]);
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

function normalizeOperationBindingValue(value) {
  const normalized =
    typeof value === "number" && Number.isSafeInteger(value) && value >= 0
      ? String(value)
      : typeof value === "string"
        ? value.trim()
        : "";
  return /^[A-Za-z0-9._:-]{1,128}$/.test(normalized) ? normalized : null;
}

function collectOperationBindings(
  value,
  bindings = new Map(),
  state = { nodes: 0 },
  depth = 0
) {
  if (
    value === null ||
    value === undefined ||
    depth > MAX_BINDING_CAPTURE_DEPTH ||
    state.nodes >= MAX_BINDING_CAPTURE_NODES
  ) {
    return bindings;
  }
  state.nodes += 1;
  if (Array.isArray(value)) {
    for (const item of value) {
      if (state.nodes >= MAX_BINDING_CAPTURE_NODES) {
        break;
      }
      collectOperationBindings(item, bindings, state, depth + 1);
    }
    return bindings;
  }
  if (typeof value !== "object") {
    return bindings;
  }
  for (const [key, nestedValue] of Object.entries(value)) {
    if (state.nodes >= MAX_BINDING_CAPTURE_NODES) {
      break;
    }
    const kind = OPERATION_BINDING_FIELDS.get(key);
    if (kind) {
      const normalized = normalizeOperationBindingValue(nestedValue);
      if (normalized) {
        const values = bindings.get(kind) || new Set();
        values.add(normalized);
        bindings.set(kind, values);
      }
    }
    collectOperationBindings(nestedValue, bindings, state, depth + 1);
  }
  return bindings;
}

function mergeOperationBindings(target, source) {
  for (const [kind, sourceValues] of source) {
    const targetValues = target.get(kind) || new Set();
    for (const value of sourceValues) {
      targetValues.add(value);
    }
    target.set(kind, targetValues);
  }
  return target;
}

function parseBoundedRequestPayload(request) {
  try {
    if (typeof request.postDataBuffer === "function") {
      const buffer = request.postDataBuffer();
      if (
        buffer &&
        Number.isSafeInteger(buffer.length) &&
        buffer.length > MAX_BINDING_CAPTURE_BODY_BYTES
      ) {
        return null;
      }
    }
  } catch {
    return null;
  }
  try {
    if (typeof request.postDataJSON === "function") {
      const parsed = request.postDataJSON();
      if (parsed && typeof parsed === "object") {
        return parsed;
      }
    }
  } catch {
    // Fall through to the bounded raw parser.
  }
  let raw = null;
  try {
    raw = typeof request.postData === "function" ? request.postData() : null;
  } catch {
    return null;
  }
  if (
    typeof raw !== "string" ||
    raw.length === 0 ||
    Buffer.byteLength(raw, "utf8") > MAX_BINDING_CAPTURE_BODY_BYTES
  ) {
    return null;
  }
  try {
    return JSON.parse(raw);
  } catch {
    try {
      return Object.fromEntries(new URLSearchParams(raw));
    } catch {
      return null;
    }
  }
}

function getRequestOperationBindings(request) {
  const bindings = new Map();
  try {
    const parsedUrl = new URL(request.url());
    for (const [key, value] of parsedUrl.searchParams) {
      const kind = OPERATION_BINDING_FIELDS.get(key);
      const normalized = normalizeOperationBindingValue(value);
      if (kind && normalized) {
        const values = bindings.get(kind) || new Set();
        values.add(normalized);
        bindings.set(kind, values);
      }
    }
  } catch {
    // The transport classifier rejects non-TikTok/unparseable URLs.
  }
  const payload = parseBoundedRequestPayload(request);
  if (payload) {
    mergeOperationBindings(bindings, collectOperationBindings(payload));
  }
  return bindings;
}

function fingerprintOperationBindings(bindings, secret) {
  const result = [];
  for (const [kind, values] of [...bindings.entries()].sort()) {
    for (const value of [...values].sort()) {
      result.push({
        kind,
        fingerprint: crypto
          .createHmac("sha256", secret)
          .update(`${kind}\0${value}`)
          .digest("hex"),
      });
    }
  }
  return result;
}

function matchFingerprintedBindings(requestBindings, responseBindings) {
  const responseKeys = new Set(
    responseBindings.map(({ kind, fingerprint }) => `${kind}\0${fingerprint}`)
  );
  return requestBindings.filter(({ kind, fingerprint }) =>
    responseKeys.has(`${kind}\0${fingerprint}`)
  );
}

function normalizeBindingCapturePhase(value) {
  const phase = String(value || "");
  if (!BINDING_CAPTURE_PHASES.has(phase)) {
    throw new Error("Unsupported operation-binding capture phase.");
  }
  return phase;
}

function classifyBindingCapturePathLength(length) {
  if (!Number.isSafeInteger(length) || length < 0) {
    return "unavailable";
  }
  if (length === 0) {
    return "empty";
  }
  if (length <= 31) {
    return "1-31";
  }
  if (length <= 63) {
    return "32-63";
  }
  if (length <= 127) {
    return "64-127";
  }
  if (length <= 255) {
    return "128-255";
  }
  if (length <= MAX_BINDING_CAPTURE_PATH_LENGTH) {
    return "256-512";
  }
  return "oversize";
}

function classifyBindingCaptureSegmentCount(count) {
  if (!Number.isSafeInteger(count) || count < 0) {
    return "unavailable";
  }
  if (count === 0) {
    return "empty";
  }
  if (count <= 2) {
    return "1-2";
  }
  if (count <= 4) {
    return "3-4";
  }
  if (count <= 8) {
    return "5-8";
  }
  if (count <= MAX_BINDING_CAPTURE_PATH_SEGMENTS) {
    return "9-12";
  }
  return "13-plus";
}

function classifyBindingCapturePathSegment(value) {
  const normalized = String(value || "").toLowerCase();
  if (BINDING_CAPTURE_SAFE_PATH_TOKENS.has(normalized)) {
    return normalized;
  }
  if (/^v[0-9]{1,2}$/.test(normalized)) {
    return "version";
  }
  if (/^[0-9]{1,20}$/.test(normalized)) {
    return "numeric";
  }
  if (
    /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(
      normalized
    )
  ) {
    return "uuid";
  }
  if (/^[0-9a-f]{16,64}$/.test(normalized)) {
    return "hex-opaque";
  }
  return "opaque";
}

function classifyBindingCaptureOrigin(hostname) {
  const normalized = String(hostname || "").toLowerCase();
  if (normalized === "tiktok.com" || normalized.endsWith(".tiktok.com")) {
    return "suffix-tiktok-com";
  }
  if (
    normalized === "tiktokcdn.com" ||
    normalized.endsWith(".tiktokcdn.com")
  ) {
    return "suffix-tiktokcdn-com";
  }
  if (normalized === "tiktokv.com" || normalized.endsWith(".tiktokv.com")) {
    return "suffix-tiktokv-com";
  }
  if (
    normalized === "byteoversea.com" ||
    normalized.endsWith(".byteoversea.com")
  ) {
    return "suffix-byteoversea-com";
  }
  if (
    normalized === "ibytedtos.com" ||
    normalized.endsWith(".ibytedtos.com")
  ) {
    return "suffix-ibytedtos-com";
  }
  if (
    normalized === "ibyteimg.com" ||
    normalized.endsWith(".ibyteimg.com")
  ) {
    return "suffix-ibyteimg-com";
  }
  if (normalized === "muscdn.com" || normalized.endsWith(".muscdn.com")) {
    return "suffix-muscdn-com";
  }
  return "cross-origin-other";
}

function getBindingCaptureRequestContext(request) {
  let resourceTypeClass = "unavailable";
  try {
    if (typeof request.resourceType === "function") {
      const resourceType = String(request.resourceType()).toLowerCase();
      resourceTypeClass = BINDING_CAPTURE_RESOURCE_TYPES.has(resourceType)
        ? resourceType
        : "unknown";
    }
  } catch {
    resourceTypeClass = "unavailable";
  }

  let navigationClass = "unavailable";
  try {
    if (typeof request.isNavigationRequest === "function") {
      navigationClass = request.isNavigationRequest()
        ? "navigation"
        : "non-navigation";
    }
  } catch {
    navigationClass = "unavailable";
  }

  let frameClass = "unavailable";
  try {
    if (typeof request.frame === "function") {
      const frame = request.frame();
      if (frame) {
        frameClass =
          typeof frame.parentFrame === "function" && frame.parentFrame()
            ? "child-frame"
            : "main-frame";
      }
    }
  } catch {
    frameClass = "worker-or-unavailable";
  }

  return { frameClass, navigationClass, resourceTypeClass };
}

function getSanitizedBindingCaptureTransportMetadata(request) {
  const requestContext = getBindingCaptureRequestContext(request);
  try {
    const parsed = new URL(request.url());
    const pathLengthClass = classifyBindingCapturePathLength(
      parsed.pathname.length
    );
    if (parsed.pathname.length > MAX_BINDING_CAPTURE_PATH_LENGTH) {
      return {
        originClass: classifyBindingCaptureOrigin(parsed.hostname),
        pathLengthClass,
        pathSegmentCountClass: "not-inspected",
        pathShape: ["oversize"],
        pathShapeTruncated: true,
        ...requestContext,
      };
    }
    const segments = parsed.pathname.split("/").filter(Boolean);
    const pathSegmentCountClass = classifyBindingCaptureSegmentCount(
      segments.length
    );
    return {
      originClass: classifyBindingCaptureOrigin(parsed.hostname),
      pathLengthClass,
      pathSegmentCountClass,
      pathShape: segments
        .slice(0, MAX_BINDING_CAPTURE_PATH_SEGMENTS)
        .map(classifyBindingCapturePathSegment),
      pathShapeTruncated:
        segments.length > MAX_BINDING_CAPTURE_PATH_SEGMENTS,
      ...requestContext,
    };
  } catch {
    return {
      originClass: "unparseable",
      pathLengthClass: "unavailable",
      pathSegmentCountClass: "unavailable",
      pathShape: ["unparseable"],
      pathShapeTruncated: false,
      ...requestContext,
    };
  }
}

function classifyBindingCaptureTransport(request) {
  let method = "UNKNOWN";
  try {
    method = String(request.method()).toUpperCase();
  } catch {
    return {
      eligible: false,
      method,
      mutation: false,
      reason: "method-unavailable",
    };
  }
  if (!BINDING_CAPTURE_METHODS.has(method)) {
    return {
      eligible: false,
      method,
      mutation: false,
      reason: "method-not-observed",
    };
  }
  let parsed;
  try {
    parsed = new URL(request.url());
  } catch {
    return {
      eligible: false,
      method,
      mutation: true,
      reason: "unparseable-url",
    };
  }
  if (!getTikTokRequestOrigin(parsed.href)) {
    return {
      eligible: false,
      method,
      mutation: true,
      reason: "origin-not-allowed",
    };
  }
  if (!/(?:upload|project|video|commit)/i.test(parsed.pathname)) {
    return {
      eligible: false,
      method,
      mutation: true,
      reason: "path-not-recognized",
    };
  }
  return {
    eligible: true,
    method,
    mutation: true,
    reason: "eligible",
  };
}

function fingerprintTransportEndpoint(request, secret) {
  let endpoint = "unparseable-url";
  try {
    const parsed = new URL(request.url());
    endpoint = `${parsed.protocol}//${parsed.host.toLowerCase()}${parsed.pathname}`;
  } catch {
    // Never fingerprint the raw unparseable value because it may contain secrets.
  }
  return crypto
    .createHmac("sha256", secret)
    .update(`transport\0${endpoint}`)
    .digest("hex");
}

function getBindingCaptureOutcome(
  observations,
  candidateObservations,
  transportSummary
) {
  if (observations.some(({ matchedBindings }) => matchedBindings.length > 0)) {
    return "matched-binding";
  }
  if (observations.length > 0) {
    return "eligible-without-match";
  }
  if (candidateObservations.length > 0) {
    return "candidate-observed-non-authoritative";
  }
  if (transportSummary.mutationRequestCount > 0) {
    return "no-eligible-transport";
  }
  return "no-mutating-transport";
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
  const bindingCaptureSecret = crypto.randomBytes(32);
  const bindingCaptureObservations = [];
  const bindingCaptureCandidateObservations = [];
  const observedBindingRequests = new WeakMap();
  const pendingBindingResponses = new Set();
  let bindingCaptureEnabled = false;
  let bindingCapturePhase = "inactive";
  let bindingCaptureOverflowCount = 0;
  let bindingCaptureCandidateOverflowCount = 0;
  const bindingCaptureTransportSummary = {
    observedRequestCount: 0,
    mutationRequestCount: 0,
    eligibleRequestCount: 0,
    ignoredMethodCount: 0,
    rejectedOriginCount: 0,
    rejectedPathCount: 0,
    unparseableUrlCount: 0,
    phaseCounts: {},
  };

  const getPhaseCounts = () => {
    if (!bindingCaptureTransportSummary.phaseCounts[bindingCapturePhase]) {
      bindingCaptureTransportSummary.phaseCounts[bindingCapturePhase] = {
        observedRequestCount: 0,
        mutationRequestCount: 0,
        eligibleRequestCount: 0,
        candidateRequestCount: 0,
      };
    }
    return bindingCaptureTransportSummary.phaseCounts[bindingCapturePhase];
  };

  const createBindingObservation = (request, transport, candidate) => ({
    phase: bindingCapturePhase,
    method: transport.method,
    endpointFingerprint: fingerprintTransportEndpoint(
      request,
      bindingCaptureSecret
    ),
    ...(candidate
      ? {
          rejectionReason: transport.reason,
        }
      : { transportClass: "eligible-tiktok-operation" }),
    transportMetadata: getSanitizedBindingCaptureTransportMetadata(request),
    status: null,
    requestBindings: fingerprintOperationBindings(
      getRequestOperationBindings(request),
      bindingCaptureSecret
    ),
    responseBindings: [],
    matchedBindings: [],
    responseBodyClass: "not-observed",
  });

  const hasCaptureCapacity = (observations, maximum) =>
    observations.length < maximum &&
    observations.filter(({ phase }) => phase === bindingCapturePhase).length <
      MAX_BINDING_CAPTURE_ITEMS_PER_PHASE;

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
    if (bindingCaptureEnabled) {
      const transport = classifyBindingCaptureTransport(request);
      const phaseCounts = getPhaseCounts();
      bindingCaptureTransportSummary.observedRequestCount += 1;
      phaseCounts.observedRequestCount += 1;
      if (!transport.mutation) {
        bindingCaptureTransportSummary.ignoredMethodCount += 1;
      } else {
        bindingCaptureTransportSummary.mutationRequestCount += 1;
        phaseCounts.mutationRequestCount += 1;
        if (transport.eligible) {
          bindingCaptureTransportSummary.eligibleRequestCount += 1;
          phaseCounts.eligibleRequestCount += 1;
          if (
            !hasCaptureCapacity(
              bindingCaptureObservations,
              MAX_BINDING_CAPTURE_OBSERVATIONS
            )
          ) {
            bindingCaptureOverflowCount += 1;
          } else {
            const observation = createBindingObservation(
              request,
              transport,
              false
            );
            bindingCaptureObservations.push(observation);
            observedBindingRequests.set(request, observation);
          }
        } else {
          phaseCounts.candidateRequestCount += 1;
          if (transport.reason === "origin-not-allowed") {
            bindingCaptureTransportSummary.rejectedOriginCount += 1;
          } else if (transport.reason === "path-not-recognized") {
            bindingCaptureTransportSummary.rejectedPathCount += 1;
          } else if (transport.reason === "unparseable-url") {
            bindingCaptureTransportSummary.unparseableUrlCount += 1;
          }
          if (
            !hasCaptureCapacity(
              bindingCaptureCandidateObservations,
              MAX_BINDING_CAPTURE_CANDIDATES
            )
          ) {
            bindingCaptureCandidateOverflowCount += 1;
          } else {
            const observation = createBindingObservation(
              request,
              transport,
              true
            );
            bindingCaptureCandidateObservations.push(observation);
            observedBindingRequests.set(request, observation);
          }
        }
      }
    }
    await route.continue();
  };

  const responseHandler = (response) => {
    const request = response.request();
    const observation = observedBindingRequests.get(request);
    if (!observation) {
      return;
    }
    observation.status = response.status();
    if (observation.status < 200 || observation.status >= 300) {
      observation.responseBodyClass = "non-success-status";
      return;
    }
    const isCandidate = Boolean(observation.rejectionReason);
    if (isCandidate) {
      observation.responseBodyClass =
        observation.requestBindings.length === 0
          ? "request-binding-missing"
          : "candidate-metadata-only";
      return;
    }
    const task = Promise.resolve()
      .then(async () => {
        const headers =
          typeof response.headers === "function"
            ? await response.headers()
            : {};
        const contentType = String(headers?.["content-type"] || "");
        const contentLengthValue = headers?.["content-length"];
        const contentLength = Number(contentLengthValue);
        if (contentType && !/\bjson\b/i.test(contentType)) {
          observation.responseBodyClass = "non-json";
          return;
        }
        if (
          Number.isFinite(contentLength) &&
          contentLength > MAX_BINDING_CAPTURE_BODY_BYTES
        ) {
          observation.responseBodyClass = "oversize";
          return;
        }
        if (typeof response.json !== "function") {
          observation.responseBodyClass = "unavailable";
          return;
        }
        const payload = await response.json();
        observation.responseBindings = fingerprintOperationBindings(
          collectOperationBindings(payload),
          bindingCaptureSecret
        );
        observation.matchedBindings = matchFingerprintedBindings(
          observation.requestBindings,
          observation.responseBindings
        );
        observation.responseBodyClass = "json-inspected";
      })
      .catch(() => {
        observation.responseBodyClass = "unparseable-json";
      })
      .finally(() => pendingBindingResponses.delete(task));
    pendingBindingResponses.add(task);
  };

  await page.route("**/*", routeHandler);
  if (typeof page.on === "function") {
    page.on("response", responseHandler);
  }

  return {
    beginOperationBindingCapture(phase) {
      bindingCapturePhase = normalizeBindingCapturePhase(phase);
      bindingCaptureEnabled = true;
    },
    setOperationBindingCapturePhase(phase) {
      if (!bindingCaptureEnabled) {
        throw new Error("Operation-binding capture is not active.");
      }
      bindingCapturePhase = normalizeBindingCapturePhase(phase);
    },
    stopOperationBindingCapture() {
      bindingCaptureEnabled = false;
      bindingCapturePhase = "inactive";
    },
    async dispose() {
      bindingCaptureEnabled = false;
      bindingCapturePhase = "inactive";
      await page.unroute("**/*", routeHandler).catch(() => {});
      if (typeof page.off === "function") {
        page.off("response", responseHandler);
      }
      await Promise.allSettled([...pendingBindingResponses]);
      for (let index = 0; index < bindingCaptureSecret.length; index += 1) {
        bindingCaptureSecret[index] = 0;
      }
    },
    async getState() {
      await Promise.allSettled([...pendingBindingResponses]);
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
        operationBindingCapture: {
          captureOutcome: getBindingCaptureOutcome(
            bindingCaptureObservations,
            bindingCaptureCandidateObservations,
            bindingCaptureTransportSummary
          ),
          observationCount: bindingCaptureObservations.length,
          overflowCount: bindingCaptureOverflowCount,
          candidateObservationCount:
            bindingCaptureCandidateObservations.length,
          candidateOverflowCount: bindingCaptureCandidateOverflowCount,
          transportSummary: {
            ...bindingCaptureTransportSummary,
            phaseCounts: Object.fromEntries(
              Object.entries(
                bindingCaptureTransportSummary.phaseCounts
              ).map(([phase, counts]) => [phase, { ...counts }])
            ),
          },
          observations: bindingCaptureObservations.map((observation) => ({
            ...observation,
            requestBindings: observation.requestBindings.map((binding) => ({
              ...binding,
            })),
            responseBindings: observation.responseBindings.map((binding) => ({
              ...binding,
            })),
            matchedBindings: observation.matchedBindings.map((binding) => ({
              ...binding,
            })),
          })),
          candidateObservations: bindingCaptureCandidateObservations.map(
            (observation) => ({
              ...observation,
              requestBindings: observation.requestBindings.map((binding) => ({
                ...binding,
              })),
              responseBindings: observation.responseBindings.map(
                (binding) => ({ ...binding })
              ),
              matchedBindings: observation.matchedBindings.map((binding) => ({
                ...binding,
              })),
            })
          ),
        },
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

async function waitForUniqueTikTokFileInput(
  page,
  { timeoutMs = FILE_INPUT_WAIT_TIMEOUT_MS } = {}
) {
  const fileInputs = page.locator('input[type="file"]');
  try {
    await fileInputs.first().waitFor({ state: "attached", timeout: timeoutMs });
  } catch (error) {
    assertExactUploadPage(page.url());
    const observedCount = await fileInputs.count().catch(() => null);
    const failure = new Error(
      `Expected exactly one TikTok file input after a bounded wait, observed ${
        Number.isInteger(observedCount) ? observedCount : "unknown"
      }.`
    );
    failure.cause = error;
    throw failure;
  }

  assertExactUploadPage(page.url());
  const fileInputCount = await fileInputs.count();
  if (fileInputCount !== 1) {
    throw new Error(
      `Expected exactly one TikTok file input, observed ${fileInputCount}.`
    );
  }
  return fileInputs;
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
    schemaVersion: 3,
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
    operationBindingCapture: null,
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
    if (typeof guard.beginOperationBindingCapture === "function") {
      guard.beginOperationBindingCapture("page-load");
    }

    await page.goto(EXACT_UPLOAD_URL, { waitUntil: "domcontentloaded" });
    assertExactUploadPage(page.url());

    const fileInput = await waitForUniqueTikTokFileInput(page);
    if (typeof guard.setOperationBindingCapturePhase === "function") {
      guard.setOperationBindingCapturePhase("post-assignment");
    } else if (typeof guard.beginOperationBindingCapture === "function") {
      guard.beginOperationBindingCapture("post-assignment");
    }
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

    if (typeof guard.stopOperationBindingCapture === "function") {
      guard.stopOperationBindingCapture();
    }
    if (typeof page.waitForTimeout === "function") {
      await page.waitForTimeout(BINDING_CAPTURE_SETTLE_MS);
    }
    report.safetyGuard = await guard.getState();
    report.operationBindingCapture =
      report.safetyGuard.operationBindingCapture || null;
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
        report.operationBindingCapture =
          report.safetyGuard.operationBindingCapture || null;
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
    collectOperationBindings,
    getRequestOperationBindings,
    hashFileSha256,
    inspectSourceIdentity,
    isPathInside,
    getTikTokRequestOrigin,
    safeResolutionResult,
    sanitizeRequestUrl,
    normalizeOperationBindingValue,
    waitForUniqueTikTokFileInput,
  },
};
