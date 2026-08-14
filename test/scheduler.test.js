const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs/promises");
const os = require("os");
const path = require("path");

const {
  normalizeDailyTimes,
  getLocalTimeKey,
} = require("../src/daemon-controller");

test("normalizeDailyTimes validates, pads, de-duplicates and sorts times", () => {
  assert.deepEqual(
    normalizeDailyTimes(["9:05", "21:30", "09:05", " 7:00 "]),
    ["07:00", "09:05", "21:30"]
  );
});

test("normalizeDailyTimes rejects invalid or empty schedules", () => {
  assert.throws(() => normalizeDailyTimes([]), /at least one/);
  assert.throws(() => normalizeDailyTimes(["24:00"]), /Invalid time/);
  assert.throws(() => normalizeDailyTimes(["12:99"]), /Invalid time/);
});

test("getLocalTimeKey formats a date in the requested timezone", () => {
  const date = new Date("2026-06-03T10:15:00.000Z");
  assert.equal(getLocalTimeKey(date, "Europe/Berlin"), "12:15");
  assert.equal(getLocalTimeKey(date, "UTC"), "10:15");
});

test("a new scheduler controller cannot select an uncertain item after restart", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "autosocial-scheduler-"));
  const queueDir = path.join(root, "pending");
  const postedDir = path.join(root, "posted");
  const failedDir = path.join(root, "failed");
  await Promise.all(
    [queueDir, postedDir, failedDir].map((dir) =>
      fs.mkdir(dir, { recursive: true })
    )
  );
  await fs.writeFile(path.join(queueDir, "clip.mp4"), "video");

  let uploadCalls = 0;
  const uploaderPath = require.resolve("../src/tiktok-uploader");
  const postServicePath = require.resolve("../src/post-service");
  const daemonPath = require.resolve("../src/daemon-controller");
  const originalUploader = require.cache[uploaderPath];
  const originalPostService = require.cache[postServicePath];
  const originalDaemon = require.cache[daemonPath];

  require.cache[uploaderPath] = {
    id: uploaderPath,
    filename: uploaderPath,
    loaded: true,
    exports: {
      async uploadVideo() {
        uploadCalls += 1;
        return {
          ok: false,
          outcome: "uncertain",
          retryAllowed: false,
          reason: "confirmation timed out",
          error: "confirmation timed out",
          diagnostics: {
            schemaVersion: 1,
            directPostCount: 1,
            finalTargetCount: 0,
          },
        };
      },
    },
  };
  delete require.cache[postServicePath];
  delete require.cache[daemonPath];

  try {
    const { DaemonController: TestDaemonController } = require("../src/daemon-controller");
    const controllerOptions = {
      accountId: "test",
      queueDir,
      postedDir,
      failedDir,
      statePath: path.join(root, "scheduler-state.json"),
    };

    const firstController = new TestDaemonController(controllerOptions);
    const firstResult = await firstController.runOnce("scheduler");
    assert.equal(firstResult.outcome, "uncertain");
    assert.equal(firstResult.retryAllowed, false);
    const firstStatus = await firstController.getStatus();
    assert.deepEqual(firstStatus.lastResult.diagnostics, {
      schemaVersion: 1,
      directPostCount: 1,
      finalTargetCount: 0,
    });

    const restartedController = new TestDaemonController(controllerOptions);
    const secondResult = await restartedController.runOnce("dashboard");
    assert.equal(secondResult.skipped, true);

    const watcherController = new TestDaemonController(controllerOptions);
    const watcherResult = await watcherController.runOnce("instant-post");
    assert.equal(watcherResult.skipped, true);
    assert.equal(uploadCalls, 1);
  } finally {
    delete require.cache[postServicePath];
    delete require.cache[daemonPath];
    if (originalUploader) {
      require.cache[uploaderPath] = originalUploader;
    } else {
      delete require.cache[uploaderPath];
    }
    if (originalPostService) {
      require.cache[postServicePath] = originalPostService;
    }
    if (originalDaemon) {
      require.cache[daemonPath] = originalDaemon;
    }
  }
});
