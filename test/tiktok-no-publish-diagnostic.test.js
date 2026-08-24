const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const { chromium } = require("playwright");

const {
  AUTHORIZATION_VALUE,
  EXPECTED_ACCOUNT_ID,
  captureQueueSnapshot,
  installNoPublishGuards,
  runTikTokNoPublishDiagnostic,
  validateNoPublishDiagnosticOptions,
  _private,
} = require("../src/tiktok-no-publish-diagnostic");

async function createTemporaryDiagnosticTree() {
  const projectRoot = await fs.mkdtemp(
    path.join(os.tmpdir(), "autosocial-no-publish-")
  );
  const localRoot = path.join(projectRoot, ".local");
  const queueRoot = path.join(projectRoot, "queue");
  const sourcePath = path.join(projectRoot, "approved-source.mp4");
  await fs.mkdir(localRoot);
  await fs.mkdir(queueRoot);
  await fs.writeFile(sourcePath, "approved diagnostic bytes", "utf8");
  return { localRoot, projectRoot, queueRoot, sourcePath };
}

function validOptions(tree) {
  return {
    accountId: EXPECTED_ACCOUNT_ID,
    authorization: AUTHORIZATION_VALUE,
    expectedBranch: "fix/tiktok-publish-readiness-confirmation",
    expectedHead: "87e4f7892db287dd77f8bc756953f3acfe580eba",
    expectedSha256:
      "505cf052cbd6bbb452baeefbbfa7a442da2fc8039b7d549ee893af051f62e6fd",
    expectedSize: 25,
    outputDir: path.join(
      tree.localRoot,
      "qa-tiktok-no-publish-2026-08-14T01-00-00-000Z"
    ),
    sourcePath: tree.sourcePath,
  };
}

test("TikTok no-publish options require explicit and bounded authorization", async () => {
  const tree = await createTemporaryDiagnosticTree();
  try {
    const options = validOptions(tree);
    assert.doesNotThrow(() =>
      validateNoPublishDiagnosticOptions(options, {
        projectRoot: tree.projectRoot,
      })
    );

    for (const invalid of [
      { ...options, authorization: "" },
      { ...options, accountId: "default" },
      { ...options, expectedHead: "87e4f78" },
      { ...options, expectedSha256: "not-a-hash" },
      { ...options, expectedSize: 0 },
      { ...options, outputDir: path.join(tree.projectRoot, "report") },
      {
        ...options,
        sourcePath: path.join(tree.queueRoot, "reused.mp4"),
      },
    ]) {
      assert.throws(() =>
        validateNoPublishDiagnosticOptions(invalid, {
          projectRoot: tree.projectRoot,
        })
      );
    }
  } finally {
    await fs.rm(tree.projectRoot, { recursive: true, force: true });
  }
});

test("TikTok no-publish guards block DOM actions and publish API requests", async () => {
  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage();
  try {
    const guard = await installNoPublishGuards(page);
    await page.goto(
      "data:text/html,<button id='safe'>Safe</button><button data-e2e='post_video_button'>Post</button>"
    );
    await page.evaluate(() => {
      window.safeActionCount = 0;
      document.querySelector("#safe").addEventListener("click", () => {
        window.safeActionCount += 1;
      });
    });

    await page.locator("#safe").dispatchEvent("click");
    await page
      .locator('[data-e2e="post_video_button"]')
      .dispatchEvent("click");

    const state = await guard.getState();
    assert.equal(await page.evaluate(() => window.safeActionCount), 0);
    assert.equal(state.blockedClickCount, 2);
    assert.equal(state.guardedFrameCount, 1);
    assert.equal(state.blockedPublishRequestCount, 0);
    await guard.dispose();
  } finally {
    await page.close();
    await browser.close();
  }
});

test("TikTok no-publish network guard aborts a classified request locally", async () => {
  let routeHandler = null;
  const page = {
    async addInitScript() {},
    async evaluate() {
      return { blockedClickCount: 0 };
    },
    async route(_pattern, handler) {
      routeHandler = handler;
    },
    async unroute() {},
  };
  const guard = await installNoPublishGuards(page, {
    isLikelyPublishRequest: () => true,
  });
  let aborted = false;
  let continued = false;
  await routeHandler({
    async abort() {
      aborted = true;
    },
    async continue() {
      continued = true;
    },
    request() {
      return {
        method: () => "POST",
        postData: () => "video_id=fixture",
        url: () => "https://upload.tiktok.com/aweme/v1/commit",
      };
    },
  });
  const state = await guard.getState();
  assert.equal(aborted, true);
  assert.equal(continued, false);
  assert.equal(state.blockedPublishRequestCount, 1);
  assert.deepEqual(state.blockedPublishRequests, [
    {
      method: "POST",
      url: "https://upload.tiktok.com/aweme/v1/commit",
    },
  ]);
  await guard.dispose();
});

test("TikTok no-publish guard records only fingerprinted operation bindings", async () => {
  let routeHandler = null;
  let responseHandler = null;
  const page = {
    async addInitScript() {},
    frames() {
      return [this];
    },
    async evaluate() {
      return { blockedClickCount: 0 };
    },
    async route(_pattern, handler) {
      routeHandler = handler;
    },
    async unroute() {},
    on(event, handler) {
      if (event === "response") {
        responseHandler = handler;
      }
    },
    off() {},
  };
  const guard = await installNoPublishGuards(page, {
    isLikelyPublishRequest: () => false,
  });
  guard.beginOperationBindingCapture("post-assignment");

  const request = {
    method: () => "POST",
    postDataJSON: () => ({
      upload_id: "secret-upload-id",
      project_id: "secret-project-id",
      caption: "private caption",
      access_token: "private-token",
    }),
    postData: () =>
      JSON.stringify({ upload_id: "must-not-be-persisted" }),
    url: () =>
      "https://upload.tiktok.com/video/secret-path-id/upload?project_id=secret-project-id&session_token=private-query-token",
  };
  let continued = false;
  await routeHandler({
    async abort() {
      assert.fail("binding transport must not be aborted");
    },
    async continue() {
      continued = true;
    },
    request: () => request,
  });
  responseHandler({
    headers: async () => ({ "content-type": "application/json" }),
    json: async () => ({
      data: {
        upload_id: "secret-upload-id",
        project_id: "secret-project-id",
        video_id: "server-video-id",
      },
      token: "private-response-token",
    }),
    request: () => request,
    status: () => 200,
  });

  const state = await guard.getState();
  assert.equal(continued, true);
  assert.equal(state.operationBindingCapture.observationCount, 1);
  assert.equal(state.operationBindingCapture.overflowCount, 0);
  assert.equal(state.operationBindingCapture.captureOutcome, "matched-binding");
  assert.equal(state.operationBindingCapture.candidateObservationCount, 0);
  const [observation] = state.operationBindingCapture.observations;
  assert.equal(observation.phase, "post-assignment");
  assert.equal(observation.method, "POST");
  assert.equal(observation.transportClass, "eligible-tiktok-operation");
  assert.match(observation.endpointFingerprint, /^[0-9a-f]{64}$/);
  assert.equal("url" in observation, false);
  assert.equal(observation.status, 200);
  assert.deepEqual(
    observation.requestBindings.map(({ kind }) => kind),
    ["project", "upload"]
  );
  assert.deepEqual(
    observation.responseBindings.map(({ kind }) => kind),
    ["project", "upload", "video"]
  );
  assert.deepEqual(
    observation.matchedBindings.map(({ kind }) => kind),
    ["project", "upload"]
  );
  for (const binding of [
    ...observation.requestBindings,
    ...observation.responseBindings,
    ...observation.matchedBindings,
  ]) {
    assert.match(binding.fingerprint, /^[0-9a-f]{64}$/);
    assert.deepEqual(Object.keys(binding).sort(), ["fingerprint", "kind"]);
  }
  const serialized = JSON.stringify(state);
  for (const secret of [
    "secret-upload-id",
    "secret-project-id",
    "secret-path-id",
    "server-video-id",
    "private caption",
    "private-token",
    "private-query-token",
    "private-response-token",
    "must-not-be-persisted",
  ]) {
    assert.doesNotMatch(serialized, new RegExp(secret));
  }
  await guard.dispose();
});

test("TikTok no-publish guard triages rejected transports without persisting secrets", async () => {
  let routeHandler = null;
  let responseHandler = null;
  let candidateHeaderReadCount = 0;
  let candidateBodyReadCount = 0;
  const page = {
    async addInitScript() {},
    frames() {
      return [this];
    },
    async evaluate() {
      return { blockedClickCount: 0 };
    },
    async route(_pattern, handler) {
      routeHandler = handler;
    },
    async unroute() {},
    on(event, handler) {
      if (event === "response") {
        responseHandler = handler;
      }
    },
    off() {},
  };
  const guard = await installNoPublishGuards(page, {
    isLikelyPublishRequest: () => false,
  });
  guard.beginOperationBindingCapture("page-load");

  const requests = [
    {
      method: () => "POST",
      postDataJSON: () => ({ project_id: "private-project-id" }),
      resourceType: () => "xhr",
      isNavigationRequest: () => false,
      frame: () => ({ parentFrame: () => ({}) }),
      url: () =>
        "https://secret-upload.example-cdn.test/private-secret-segment/123?token=private-query-token",
    },
    {
      method: () => "POST",
      postDataJSON: () => ({ upload_id: "private-upload-id" }),
      resourceType: () => "fetch",
      isNavigationRequest: () => false,
      frame: () => ({ parentFrame: () => null }),
      url: () => "https://www.tiktok.com/aweme/v1/create?token=private-token",
    },
    {
      method: () => "POST",
      postDataJSON: () => ({ video_id: "private-video-id" }),
      resourceType: () => "private-resource-type",
      isNavigationRequest: () => {
        throw new Error("private-navigation-error");
      },
      frame: () => {
        throw new Error("private-frame-error");
      },
      url: () => "not a url with private-path-token",
    },
    {
      method: () => "POST",
      postDataJSON: () => ({ event: "private-analytics-event" }),
      url: () => "https://analytics.example.test/event",
    },
    {
      method: () => "GET",
      postDataJSON: () => null,
      url: () => "https://upload.tiktok.com/video/upload",
    },
  ];

  for (const request of requests) {
    await routeHandler({
      async abort() {
        assert.fail("diagnostic candidates must not be blocked");
      },
      async continue() {},
      request: () => request,
    });
    if (request !== requests[4]) {
      responseHandler({
        headers: async () => {
          candidateHeaderReadCount += 1;
          if (request === requests[0]) {
            return {
              "content-type": "application/json",
              "content-length": "128",
              "content-encoding": "gzip",
            };
          }
          if (request === requests[1]) {
            return { "content-type": "application/json" };
          }
          return {
            "content-type": "application/json",
            "content-length": String(2 * 1024 * 1024),
          };
        },
        json: async () => {
          candidateBodyReadCount += 1;
          return {
            data: request.postDataJSON(),
            padding: "x".repeat(2 * 1024 * 1024),
            token: "private-response-token",
          };
        },
        request: () => request,
        status: () => 200,
      });
    }
  }

  const state = await guard.getState();
  const capture = state.operationBindingCapture;
  assert.equal(
    capture.captureOutcome,
    "candidate-observed-non-authoritative"
  );
  assert.equal(capture.observationCount, 0);
  assert.equal(capture.candidateObservationCount, 4);
  assert.equal(capture.candidateOverflowCount, 0);
  assert.equal(candidateHeaderReadCount, 0);
  assert.equal(candidateBodyReadCount, 0);
  assert.deepEqual(
    capture.candidateObservations.map(({ rejectionReason }) => rejectionReason),
    [
      "origin-not-allowed",
      "path-not-recognized",
      "unparseable-url",
      "origin-not-allowed",
    ]
  );
  for (const candidate of capture.candidateObservations.slice(0, 3)) {
    assert.equal(candidate.phase, "page-load");
    assert.match(candidate.endpointFingerprint, /^[0-9a-f]{64}$/);
    assert.equal("url" in candidate, false);
    assert.equal(candidate.status, 200);
    assert.equal(candidate.responseBodyClass, "candidate-metadata-only");
    assert.equal(candidate.responseBindings.length, 0);
    assert.equal(candidate.matchedBindings.length, 0);
  }
  assert.equal(
    capture.candidateObservations[3].responseBodyClass,
    "request-binding-missing"
  );
  assert.equal(capture.candidateObservations[3].matchedBindings.length, 0);
  assert.deepEqual(capture.candidateObservations[0].transportMetadata, {
    originClass: "cross-origin-other",
    pathLengthClass: "1-31",
    pathSegmentCountClass: "1-2",
    pathShape: ["opaque", "numeric"],
    pathShapeTruncated: false,
    frameClass: "child-frame",
    navigationClass: "non-navigation",
    resourceTypeClass: "xhr",
  });
  assert.deepEqual(capture.candidateObservations[1].transportMetadata, {
    originClass: "suffix-tiktok-com",
    pathLengthClass: "1-31",
    pathSegmentCountClass: "3-4",
    pathShape: ["aweme", "version", "create"],
    pathShapeTruncated: false,
    frameClass: "main-frame",
    navigationClass: "non-navigation",
    resourceTypeClass: "fetch",
  });
  assert.deepEqual(capture.candidateObservations[2].transportMetadata, {
    originClass: "unparseable",
    pathLengthClass: "unavailable",
    pathSegmentCountClass: "unavailable",
    pathShape: ["unparseable"],
    pathShapeTruncated: false,
    frameClass: "worker-or-unavailable",
    navigationClass: "unavailable",
    resourceTypeClass: "unknown",
  });
  assert.deepEqual(capture.transportSummary, {
    observedRequestCount: 5,
    mutationRequestCount: 4,
    eligibleRequestCount: 0,
    ignoredMethodCount: 1,
    rejectedOriginCount: 2,
    rejectedPathCount: 1,
    unparseableUrlCount: 1,
    phaseCounts: {
      "page-load": {
        observedRequestCount: 5,
        mutationRequestCount: 4,
        eligibleRequestCount: 0,
        candidateRequestCount: 4,
      },
    },
  });

  const serialized = JSON.stringify(state);
  for (const secret of [
    "secret-upload.example-cdn.test",
    "private-project-id",
    "private-upload-id",
    "private-video-id",
    "private-query-token",
    "private-token",
    "private-path-token",
    "private-secret-segment",
    "private-resource-type",
    "private-navigation-error",
    "private-frame-error",
    "private-response-token",
    "private-analytics-event",
  ]) {
    assert.doesNotMatch(serialized, new RegExp(secret));
  }
  await guard.dispose();
});

test("TikTok no-publish metadata taxonomy is bounded and fixed-vocabulary", async () => {
  let routeHandler = null;
  const page = {
    async addInitScript() {},
    frames() {
      return [this];
    },
    async evaluate() {
      return { blockedClickCount: 0 };
    },
    async route(_pattern, handler) {
      routeHandler = handler;
    },
    async unroute() {},
    on() {},
    off() {},
  };
  const guard = await installNoPublishGuards(page, {
    isLikelyPublishRequest: () => false,
  });
  guard.beginOperationBindingCapture("post-assignment");

  const requests = [
    {
      method: () => "POST",
      postDataJSON: () => ({}),
      resourceType: () => "private-resource-type",
      isNavigationRequest: () => false,
      frame: () => {
        throw new Error("private-worker-value");
      },
      url: () =>
        `https://assets.tiktokcdn.com/api/v12/private-secret/${"x".repeat(600)}?token=private-query-token`,
    },
    {
      method: () => "POST",
      postDataJSON: () => ({}),
      resourceType: () => "xhr",
      isNavigationRequest: () => true,
      frame: () => ({ parentFrame: () => null }),
      url: () =>
        "https://www.tiktok.com/api/v1/item/create/status/check/content/media/detail/list/save/update/auth/user?token=private-token",
    },
  ];
  for (const request of requests) {
    await routeHandler({
      async abort() {
        assert.fail("metadata-only candidates must not be blocked");
      },
      async continue() {},
      request: () => request,
    });
  }

  const capture = (await guard.getState()).operationBindingCapture;
  assert.equal(capture.observationCount, 0);
  assert.equal(capture.candidateObservationCount, 2);
  assert.deepEqual(capture.candidateObservations[0].transportMetadata, {
    originClass: "suffix-tiktokcdn-com",
    pathLengthClass: "oversize",
    pathSegmentCountClass: "not-inspected",
    pathShape: ["oversize"],
    pathShapeTruncated: true,
    frameClass: "worker-or-unavailable",
    navigationClass: "non-navigation",
    resourceTypeClass: "unknown",
  });
  assert.deepEqual(capture.candidateObservations[1].transportMetadata, {
    originClass: "suffix-tiktok-com",
    pathLengthClass: "64-127",
    pathSegmentCountClass: "13-plus",
    pathShape: [
      "api",
      "version",
      "item",
      "create",
      "status",
      "check",
      "content",
      "media",
      "detail",
      "list",
      "save",
      "update",
    ],
    pathShapeTruncated: true,
    frameClass: "main-frame",
    navigationClass: "navigation",
    resourceTypeClass: "xhr",
  });
  const serialized = JSON.stringify(capture);
  for (const secret of [
    "private-secret",
    "private-query-token",
    "private-token",
    "private-resource-type",
    "private-worker-value",
    "xxxxxxxxxxxxxxxx",
  ]) {
    assert.doesNotMatch(serialized, new RegExp(secret));
  }
  await guard.dispose();
});

test("TikTok no-publish guard reserves candidate capacity for post-assignment", async () => {
  let routeHandler = null;
  const page = {
    async addInitScript() {},
    frames() {
      return [this];
    },
    async evaluate() {
      return { blockedClickCount: 0 };
    },
    async route(_pattern, handler) {
      routeHandler = handler;
    },
    async unroute() {},
    on() {},
    off() {},
  };
  const guard = await installNoPublishGuards(page, {
    isLikelyPublishRequest: () => false,
  });
  const emitCandidate = async (index) => {
    const request = {
      method: () => "POST",
      postDataJSON: () => ({}),
      url: () => `https://candidate-${index}.example.test/opaque`,
    };
    await routeHandler({
      async abort() {
        assert.fail("diagnostic candidates must not be blocked");
      },
      async continue() {},
      request: () => request,
    });
  };

  guard.beginOperationBindingCapture("page-load");
  for (let index = 0; index < 65; index += 1) {
    await emitCandidate(index);
  }
  guard.setOperationBindingCapturePhase("post-assignment");
  await emitCandidate("post-assignment");

  const capture = (await guard.getState()).operationBindingCapture;
  assert.equal(capture.candidateObservationCount, 65);
  assert.equal(capture.candidateOverflowCount, 1);
  assert.equal(
    capture.candidateObservations.at(-1).phase,
    "post-assignment"
  );
  assert.equal(capture.transportSummary.mutationRequestCount, 66);
  assert.equal(
    capture.transportSummary.phaseCounts["page-load"].candidateRequestCount,
    65
  );
  assert.equal(
    capture.transportSummary.phaseCounts["post-assignment"]
      .candidateRequestCount,
    1
  );
  await guard.dispose();
});

test("TikTok diagnostic source cannot alias a managed queue file", async () => {
  const tree = await createTemporaryDiagnosticTree();
  try {
    const queueAlias = path.join(tree.queueRoot, "source-alias.mp4");
    await fs.link(tree.sourcePath, queueAlias);
    await assert.rejects(() =>
      _private.assertSourceIsIndependentFromQueue(
        tree.sourcePath,
        tree.queueRoot
      )
    );
  } finally {
    await fs.rm(tree.projectRoot, { recursive: true, force: true });
  }
});

test("queue snapshots are read only and detect metadata changes", async () => {
  const tree = await createTemporaryDiagnosticTree();
  try {
    const queueFile = path.join(tree.queueRoot, "pending.mp4");
    await fs.writeFile(queueFile, "one", "utf8");
    const before = await captureQueueSnapshot(tree.queueRoot);
    const unchanged = await captureQueueSnapshot(tree.queueRoot);
    assert.equal(before.digest, unchanged.digest);
    assert.equal(before.fileCount, 1);

    await fs.writeFile(queueFile, "changed", "utf8");
    const after = await captureQueueSnapshot(tree.queueRoot);
    assert.notEqual(before.digest, after.digest);
  } finally {
    await fs.rm(tree.projectRoot, { recursive: true, force: true });
  }
});

test("TikTok file input hydration is bounded and remains fail closed", async () => {
  let hydrated = false;
  const uniqueInputs = {
    async count() {
      assert.equal(hydrated, true);
      return 1;
    },
    first() {
      return {
        async waitFor(options) {
          assert.deepEqual(options, { state: "attached", timeout: 25 });
          hydrated = true;
        },
      };
    },
  };
  const uniquePage = {
    locator(selector) {
      assert.equal(selector, 'input[type="file"]');
      return uniqueInputs;
    },
    url() {
      return "https://www.tiktok.com/tiktokstudio/upload";
    },
  };
  assert.equal(
    await _private.waitForUniqueTikTokFileInput(uniquePage, { timeoutMs: 25 }),
    uniqueInputs
  );

  const duplicatePage = {
    locator() {
      return {
        async count() {
          return 2;
        },
        first() {
          return { async waitFor() {} };
        },
      };
    },
    url: uniquePage.url,
  };
  await assert.rejects(
    () =>
      _private.waitForUniqueTikTokFileInput(duplicatePage, { timeoutMs: 25 }),
    /exactly one TikTok file input, observed 2/i
  );

  const wrongPage = {
    locator() {
      return {
        async count() {
          return 1;
        },
        first() {
          return { async waitFor() {} };
        },
      };
    },
    url() {
      return "https://www.tiktok.com/login";
    },
  };
  await assert.rejects(
    () => _private.waitForUniqueTikTokFileInput(wrongPage, { timeoutMs: 25 }),
    /exact Studio upload page/i
  );

  const missingPage = {
    locator() {
      return {
        async count() {
          return 0;
        },
        first() {
          return {
            async waitFor() {
              throw new Error("fixture timeout");
            },
          };
        },
      };
    },
    url: uniquePage.url,
  };
  await assert.rejects(
    () => _private.waitForUniqueTikTokFileInput(missingPage, { timeoutMs: 25 }),
    /bounded wait, observed 0/i
  );
});

test("TikTok diagnostic reaches resolution and records zero publication actions", async () => {
  const tree = await createTemporaryDiagnosticTree();
  const events = [];
  let routeHandler = null;
  const emitDiagnosticRequest = async (phaseLabel) => {
    const request = {
      method: () => "PUT",
      postDataJSON: () => ({}),
      url: () => `https://upload.tiktok.com/video/${phaseLabel}`,
    };
    await routeHandler({
      async abort() {
        assert.fail("diagnostic transport must not be blocked");
      },
      async continue() {
        events.push(`request:${phaseLabel}`);
      },
      request: () => request,
    });
  };
  const page = {
    async addInitScript() {
      events.push("guard:click");
    },
    async evaluate() {
      return { blockedClickCount: 0 };
    },
    async goto(url) {
      events.push(`goto:${url}`);
      await emitDiagnosticRequest("page-load-request");
    },
    locator(selector) {
      assert.equal(selector, 'input[type="file"]');
      return {
        async count() {
          assert.ok(
            events.includes("input:attached"),
            "file input uniqueness must be checked only after bounded hydration"
          );
          return 1;
        },
        first() {
          return this;
        },
        async setInputFiles(filePath) {
          events.push(`input:${path.basename(filePath)}`);
          await emitDiagnosticRequest("post-assignment-request");
        },
        async waitFor() {
          events.push("input:attached");
        },
      };
    },
    async route(_pattern, handler) {
      routeHandler = handler;
      events.push("guard:network");
    },
    async screenshot({ path: screenshotPath }) {
      await fs.writeFile(screenshotPath, "fixture screenshot", "utf8");
      events.push(`screenshot:${path.basename(screenshotPath)}`);
    },
    async unroute() {
      events.push("guard:disposed");
    },
    url() {
      return "https://www.tiktok.com/tiktokstudio/upload";
    },
  };
  const context = {
    async close() {
      events.push("context:closed");
    },
    pages() {
      return [page];
    },
  };
  const readinessEvidence = {
    phase: "ready",
    reasonCode: "checks-safe-and-stable",
    polls: 5,
    stablePolls: 2,
  };
  const options = validOptions(tree);

  try {
    const result = await runTikTokNoPublishDiagnostic(options, {
      projectRoot: tree.projectRoot,
      getGitState: async () => ({
        branch: options.expectedBranch,
        head: options.expectedHead,
        trackedStatus: "",
      }),
      getPlatformProfileDir: async () =>
        path.join(tree.projectRoot, ".profiles", "qa-tiktok", "tiktok"),
      hasSavedPlatformSession: async () => true,
      launchPersistentContext: async () => context,
      uploader: {
        async collectTikTokPublishTargetResolutionDiagnostics() {
          events.push("diagnostics");
          return { schemaVersion: 1, directPostCount: 1, finalTargetCount: 1 };
        },
        async findUniquePublishTarget() {
          events.push("resolution");
          return {
            status: "unique",
            target: {
              handle: {
                async dispose() {
                  events.push("target:disposed");
                },
              },
            },
          };
        },
        async prepareTikTokPublishTargetForQualification() {
          events.push("preparation");
          return {
            ok: true,
            outcome: "prepared",
            retryAllowed: true,
            clickAttempted: false,
          };
        },
        async waitForTikTokPublishReadiness(_page, readinessOptions) {
          await readinessOptions.onTransition({
            phase: "hydrating-check-structure",
            polls: 1,
            clickAttempted: false,
          });
          await readinessOptions.onTransition({
            phase: "ready",
            polls: 4,
            clickAttempted: false,
          });
          events.push("readiness");
          return {
            ok: true,
            outcome: "ready",
            retryAllowed: true,
            clickAttempted: false,
            evidence: readinessEvidence,
          };
        },
      },
    });

    assert.equal(result.ok, true, JSON.stringify(result));
    assert.equal(result.report.status, "completed-without-publish");
    assert.equal(result.report.clickAttempted, false);
    assert.equal(result.report.runOnceAttempted, false);
    assert.equal(result.report.publishRequestAttempted, false);
    assert.equal(result.report.queueMutated, false);
    assert.equal(result.report.schemaVersion, 3);
    assert.equal(
      result.report.operationBindingCapture.captureOutcome,
      "eligible-without-match"
    );
    assert.deepEqual(
      result.report.operationBindingCapture.observations.map(({ phase }) =>
        phase
      ),
      ["page-load", "post-assignment"]
    );
    assert.deepEqual(
      result.report.readiness.transitions.map(({ phase }) => phase),
      ["hydrating-check-structure", "ready"]
    );
    assert.equal(result.report.resolution.status, "unique");
    assert.ok(
      events.indexOf("input:attached") <
        events.indexOf("input:approved-source.mp4")
    );
    assert.ok(events.indexOf("readiness") < events.indexOf("preparation"));
    assert.ok(events.indexOf("preparation") < events.indexOf("resolution"));
    assert.ok(events.includes("target:disposed"));
    assert.ok(events.includes("context:closed"));

    const persisted = JSON.parse(
      await fs.readFile(path.join(options.outputDir, "report.json"), "utf8")
    );
    assert.equal(persisted.status, "completed-without-publish");
    assert.equal(persisted.source.sha256, options.expectedSha256);
    assert.equal(persisted.source.size, options.expectedSize);
  } finally {
    await fs.rm(tree.projectRoot, { recursive: true, force: true });
  }
});

test("TikTok diagnostic fails closed and preserves blocked-action evidence", async () => {
  const tree = await createTemporaryDiagnosticTree();
  const options = validOptions(tree);
  let preparationReached = false;
  const page = {
    async goto() {},
    locator() {
      return {
        async count() {
          return 1;
        },
        first() {
          return this;
        },
        async setInputFiles() {},
        async waitFor() {},
      };
    },
    async screenshot({ path: screenshotPath }) {
      await fs.writeFile(screenshotPath, "fixture screenshot", "utf8");
    },
    url() {
      return "https://www.tiktok.com/tiktokstudio/upload";
    },
  };
  try {
    const result = await runTikTokNoPublishDiagnostic(options, {
      projectRoot: tree.projectRoot,
      getGitState: async () => ({
        branch: options.expectedBranch,
        head: options.expectedHead,
        trackedStatus: "",
      }),
      getPlatformProfileDir: async () =>
        path.join(tree.projectRoot, ".profiles", "qa-tiktok", "tiktok"),
      hasSavedPlatformSession: async () => true,
      installNoPublishGuards: async () => ({
        async dispose() {},
        async getState() {
          return {
            blockedClickCount: 1,
            guardedFrameCount: 1,
            blockedPublishRequestCount: 1,
            blockedPublishRequests: [
              { method: "POST", url: "https://www.tiktok.com/api/publish" },
            ],
            guardErrors: [],
          };
        },
      }),
      launchPersistentContext: async () => ({
        async close() {},
        pages() {
          return [page];
        },
      }),
      uploader: {
        async collectTikTokPublishTargetResolutionDiagnostics() {
          preparationReached = true;
          return null;
        },
        async findUniquePublishTarget() {
          preparationReached = true;
          return null;
        },
        async prepareTikTokPublishTargetForQualification() {
          preparationReached = true;
          return null;
        },
        async waitForTikTokPublishReadiness() {
          return {
            ok: false,
            outcome: "failure",
            retryAllowed: true,
            clickAttempted: false,
            reason: "fixture readiness failure",
          };
        },
      },
    });

    assert.equal(result.ok, false);
    assert.equal(result.report.status, "failed-closed");
    assert.equal(result.report.clickAttempted, true);
    assert.equal(result.report.publishRequestAttempted, true);
    assert.equal(result.report.runOnceAttempted, false);
    assert.equal(result.report.queueMutated, false);
    assert.equal(preparationReached, false);
    assert.match(result.error, /readiness did not become safe/i);
  } finally {
    await fs.rm(tree.projectRoot, { recursive: true, force: true });
  }
});

test("production diagnostic files contain no interaction or queue sinks", async () => {
  const files = [
    path.resolve(__dirname, "..", "src", "tiktok-no-publish-diagnostic.js"),
    path.resolve(__dirname, "..", "scripts", "diagnose-tiktok-no-publish.js"),
  ];
  const forbidden = [
    /\.click\s*\(/,
    /\bdispatchEvent\s*\(/,
    /\bmouse\.click\s*\(/,
    /\bkeyboard\./,
    /\.fill\s*\(/,
    /\.focus\s*\(/,
    /\.hover\s*\(/,
    /\.press\s*\(/,
    /\.type\s*\(/,
    /\.selectOption\s*\(/,
    /\.setChecked\s*\(/,
    /\bscrollTop\b/,
    /\bscrollTo\s*\(/,
    /clickPublishOnce/,
    /publishFailClosed/,
    /postSingleVideo/,
    /claimQueuedItem/,
    /run-once/i,
    /daemon-controller/,
    /post-service/,
    /(?:require|import).*queue/,
  ];

  for (const filePath of files) {
    const source = await fs.readFile(filePath, "utf8");
    for (const pattern of forbidden) {
      assert.doesNotMatch(source, pattern, `${path.basename(filePath)}: ${pattern}`);
    }
  }

  const diagnosticSource = await fs.readFile(files[0], "utf8");
  assert.equal((diagnosticSource.match(/setInputFiles\s*\(/g) || []).length, 1);
  assert.equal(
    (
      diagnosticSource.match(
        /prepareTikTokPublishTargetForQualification\s*\(/g
      ) || []
    ).length,
    1
  );
  const packageJson = JSON.parse(
    await fs.readFile(path.resolve(__dirname, "..", "package.json"), "utf8")
  );
  assert.equal(
    packageJson.scripts["diagnose:tiktok:no-publish"],
    "node scripts/diagnose-tiktok-no-publish.js"
  );
});
