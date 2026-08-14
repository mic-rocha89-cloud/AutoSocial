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
  const page = {
    async addInitScript() {
      events.push("guard:click");
    },
    async evaluate() {
      return { blockedClickCount: 0 };
    },
    async goto(url) {
      events.push(`goto:${url}`);
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
        },
        async waitFor() {
          events.push("input:attached");
        },
      };
    },
    async route() {
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
