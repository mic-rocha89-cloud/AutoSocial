const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const { chromium } = require("playwright");

const { _private } = require("../src/instagram-uploader");

const {
  buildInstagramUploadFailureResult,
  clickNextButtons,
  clickShare,
  createInstagramOperationBinding,
  dismissVideoPostsAreReelsDialog,
  ensureCreateFlowInput,
  exactUiTextPattern,
  isCreateUploadReady,
  readInstagramConfirmationEvidence,
  setCaption,
  setVideoFile,
  waitForPostConfirmation,
} = _private;

test("Instagram format pattern matches Post without case sensitivity", () => {
  const pattern = exactUiTextPattern("instagramPostFormat");

  assert.equal(pattern.test("Post"), true);
  assert.equal(pattern.test(" post "), true);
  assert.equal(pattern.test("Posts"), false);
});

test("Instagram create flow follows New post, Post and Select from computer", async (t) => {
  const browser = await chromium.launch({ headless: true });
  t.after(() => browser.close());
  const page = await browser.newPage();
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "autosocial-instagram-"));
  const videoPath = path.join(tempDir, "qa-video.mp4");
  await fs.writeFile(videoPath, "local-test-video");
  t.after(() => fs.rm(tempDir, { recursive: true, force: true }));

  await page.setContent(`
    <script>
      window.instagramFlowClicks = { create: 0, post: 0, upload: 0 };
    </script>
    <a
      id="new-post"
      href="#"
      onclick="
        window.instagramFlowClicks.create += 1;
        document.querySelector('#format-menu').hidden = false;
      "
    >
      <svg aria-label="New post"></svg>
      <span hidden>Create</span>
    </a>
    <div id="format-menu" hidden>
      <div
        id="post-format"
        tabindex="0"
        onclick="
          window.instagramFlowClicks.post += 1;
          document.querySelector('#upload-step').hidden = false;
        "
      >
        <span><span>Post</span></span>
      </div>
      <a href="#">AI</a>
    </div>
    <div id="upload-step" role="dialog" hidden>
      <button
        onclick="
          window.instagramFlowClicks.upload += 1;
          const input = document.createElement('input');
          input.type = 'file';
          input.dataset.testid = 'instagram-file-input';
          document.body.appendChild(input);
        "
      >
        Select from computer
      </button>
    </div>
  `);

  const input = await ensureCreateFlowInput(page);

  assert.equal(await input.count(), 0);
  assert.equal(await isCreateUploadReady(page, input), true);
  assert.deepEqual(
    await page.evaluate(() => window.instagramFlowClicks),
    { create: 1, post: 1, upload: 0 }
  );

  await setVideoFile(page, videoPath);

  const attachedInput = page.locator(
    'input[data-testid="instagram-file-input"]'
  );
  assert.equal(await attachedInput.count(), 1);
  assert.equal(
    await attachedInput.evaluate((element) => element.files[0].name),
    "qa-video.mp4"
  );
  assert.deepEqual(
    await page.evaluate(() => window.instagramFlowClicks),
    { create: 1, post: 1, upload: 1 }
  );
});

test("Instagram composer dismisses reels notice and never clicks background Share", async (t) => {
  const browser = await chromium.launch({ headless: true });
  t.after(() => browser.close());
  const page = await browser.newPage();

  await page.setContent(`
    <script>
      window.instagramComposerClicks = {
        notice: 0,
        next: 0,
        composerShare: 0,
        backgroundShare: 0
      };

      window.advanceInstagramComposer = () => {
        window.instagramComposerClicks.next += 1;
        const stage = document.querySelector('#composer-stage');
        const next = document.querySelector('#composer-next');
        if (window.instagramComposerClicks.next === 1) {
          stage.textContent = 'Edit';
          return;
        }

        stage.textContent = 'Create new post';
        next.remove();
        const caption = document.createElement('textarea');
        caption.setAttribute('aria-label', 'Write a caption...');
        caption.id = 'composer-caption';
        document.querySelector('#composer').appendChild(caption);

        const share = document.createElement('button');
        share.id = 'composer-share';
        share.textContent = 'Share';
        share.onclick = () => {
          window.instagramComposerClicks.composerShare += 1;
        };
        document.querySelector('#composer').appendChild(share);
      };
    </script>

    <main>
      <button
        id="background-share"
        onclick="window.instagramComposerClicks.backgroundShare += 1"
      >
        Share
      </button>
    </main>

    <div id="composer" role="dialog">
      <h1 id="composer-stage">Crop</h1>
      <button id="composer-next" onclick="window.advanceInstagramComposer()">
        Next
      </button>
    </div>

    <div id="reels-notice" role="dialog" aria-modal="true">
      <h2>Video posts are now reels</h2>
      <p>Because your account is private, only your followers will see your reels.</p>
      <button
        onclick="
          window.instagramComposerClicks.notice += 1;
          document.querySelector('#reels-notice').remove();
        "
      >
        OK
      </button>
    </div>
  `);

  assert.equal((await clickShare(page)).ok, false);
  assert.equal(
    await page.evaluate(() => window.instagramComposerClicks.backgroundShare),
    0
  );

  assert.equal(await dismissVideoPostsAreReelsDialog(page), true);
  assert.equal(await page.locator("#reels-notice").count(), 0);

  const operation = await createInstagramOperationBinding(page);
  t.after(() => operation.surfaceHandle.dispose());
  assert.equal(await clickNextButtons(page, operation), 2);
  await setCaption(page, "Controlled Instagram regression caption", operation);
  assert.equal(
    await page.locator("#composer-caption").inputValue(),
    "Controlled Instagram regression caption"
  );

  const shareResult = await clickShare(page, operation);
  assert.equal(shareResult.ok, true);
  assert.equal(shareResult.clickAttempted, true);
  assert.equal(shareResult.retryAllowed, false);
  assert.deepEqual(
    await page.evaluate(() => window.instagramComposerClicks),
    {
      notice: 1,
      next: 2,
      composerShare: 1,
      backgroundShare: 0,
    }
  );
});

test("Instagram Share consumes one attempt when the click outcome is ambiguous", async (t) => {
  const browser = await chromium.launch({ headless: true });
  t.after(() => browser.close());
  const page = await browser.newPage();
  await page.setContent(`
    <script>window.instagramAmbiguousShareClicks = 0;</script>
    <div role="dialog">
      <textarea aria-label="Caption"></textarea>
      <button id="share" onclick="window.instagramAmbiguousShareClicks += 1">
        Share
      </button>
    </div>
  `);

  const operation = await createInstagramOperationBinding(page);
  t.after(() => operation.surfaceHandle.dispose());
  const sampleHandle = await page.locator("#share").elementHandle();
  const handlePrototype = Object.getPrototypeOf(sampleHandle);
  const originalClick = handlePrototype.click;
  let attempts = 0;
  handlePrototype.click = async () => {
    attempts += 1;
    throw new Error("token=instagram-click-secret");
  };

  try {
    const result = await clickShare(page, operation);
    assert.equal(result.ok, false);
    assert.equal(result.outcome, "uncertain");
    assert.equal(result.retryAllowed, false);
    assert.equal(result.clickAttempted, true);
    assert.doesNotMatch(result.reason, /instagram-click-secret/);
  } finally {
    handlePrototype.click = originalClick;
    await sampleHandle.dispose();
  }
  assert.equal(attempts, 1);
});

test("Instagram Share aborts when the final target identity changes", async (t) => {
  const browser = await chromium.launch({ headless: true });
  t.after(() => browser.close());
  const page = await browser.newPage();
  await page.setContent(`
    <script>window.instagramReplacedShareClicks = 0;</script>
    <div role="dialog" id="composer">
      <textarea aria-label="Caption"></textarea>
      <button id="share" onclick="window.instagramReplacedShareClicks += 1">
        Share
      </button>
    </div>
  `);

  const operation = await createInstagramOperationBinding(page);
  t.after(() => operation.surfaceHandle.dispose());
  const sampleHandle = await page.locator("#share").elementHandle();
  const handlePrototype = Object.getPrototypeOf(sampleHandle);
  const originalScroll = handlePrototype.scrollIntoViewIfNeeded;
  let replaced = false;
  handlePrototype.scrollIntoViewIfNeeded = async function (...args) {
    const result = await originalScroll.apply(this, args);
    if (!replaced) {
      replaced = true;
      await page.evaluate(() => {
        const original = document.querySelector("#share");
        const replacement = original.cloneNode(true);
        replacement.id = "replacement-share";
        original.replaceWith(replacement);
      });
    }
    return result;
  };

  try {
    const result = await clickShare(page, operation);
    assert.equal(result.ok, false);
    assert.equal(result.outcome, "failure");
    assert.equal(result.retryAllowed, true);
    assert.equal(result.clickAttempted, false);
    assert.match(result.reason, /identity changed/i);
  } finally {
    handlePrototype.scrollIntoViewIfNeeded = originalScroll;
    await sampleHandle.dispose();
  }
  assert.equal(
    await page.evaluate(() => window.instagramReplacedShareClicks),
    0
  );
});

test("Instagram Share requires exact visible and accessible identity", async (t) => {
  const browser = await chromium.launch({ headless: true });
  t.after(() => browser.close());
  const page = await browser.newPage();
  await page.setContent(`
    <script>window.instagramConflictingShareClicks = 0;</script>
    <div role="dialog">
      <textarea aria-label="Caption"></textarea>
      <button
        aria-label="Share"
        onclick="window.instagramConflictingShareClicks += 1"
      >Share and promote</button>
    </div>
  `);

  const operation = await createInstagramOperationBinding(page);
  t.after(() => operation.surfaceHandle.dispose());
  const result = await clickShare(page, operation);

  assert.equal(result.ok, false);
  assert.equal(result.clickAttempted, false);
  assert.equal(result.retryAllowed, true);
  assert.equal(
    await page.evaluate(() => window.instagramConflictingShareClicks),
    0
  );
});

test("Instagram Share rejects hidden text as visible identity", async (t) => {
  const browser = await chromium.launch({ headless: true });
  t.after(() => browser.close());
  const page = await browser.newPage();
  await page.setContent(`
    <script>window.instagramHiddenShareClicks = 0;</script>
    <div role="dialog">
      <textarea aria-label="Caption"></textarea>
      <button
        aria-label="Share"
        onclick="window.instagramHiddenShareClicks += 1"
      ><span hidden>Share</span></button>
    </div>
  `);

  const operation = await createInstagramOperationBinding(page);
  t.after(() => operation.surfaceHandle.dispose());
  const result = await clickShare(page, operation);

  assert.equal(result.ok, false);
  assert.equal(result.clickAttempted, false);
  assert.equal(await page.evaluate(() => window.instagramHiddenShareClicks), 0);
});

test("Instagram Share aborts when a sibling dialog appears at the final boundary", async (t) => {
  const browser = await chromium.launch({ headless: true });
  t.after(() => browser.close());
  const page = await browser.newPage();
  await page.setContent(`
    <script>window.instagramLateDialogClicks = 0;</script>
    <div role="dialog" id="composer">
      <textarea aria-label="Caption"></textarea>
      <button id="share" onclick="window.instagramLateDialogClicks += 1">
        Share
      </button>
    </div>
  `);

  const operation = await createInstagramOperationBinding(page);
  t.after(() => operation.surfaceHandle.dispose());
  const sampleHandle = await page.locator("#share").elementHandle();
  const handlePrototype = Object.getPrototypeOf(sampleHandle);
  const originalScroll = handlePrototype.scrollIntoViewIfNeeded;
  let inserted = false;
  handlePrototype.scrollIntoViewIfNeeded = async function (...args) {
    const result = await originalScroll.apply(this, args);
    if (!inserted) {
      inserted = true;
      await page.evaluate(() => {
        const blocker = document.createElement("div");
        blocker.setAttribute("role", "dialog");
        blocker.textContent = "Session notice";
        document.body.appendChild(blocker);
      });
    }
    return result;
  };

  try {
    const result = await clickShare(page, operation);
    assert.equal(result.ok, false);
    assert.equal(result.clickAttempted, false);
    assert.equal(result.retryAllowed, true);
    assert.match(result.reason, /unexpected Instagram dialog/i);
  } finally {
    handlePrototype.scrollIntoViewIfNeeded = originalScroll;
    await sampleHandle.dispose();
  }
  assert.equal(await page.evaluate(() => window.instagramLateDialogClicks), 0);
});

test("Instagram rejects multiple active composers before Share", async (t) => {
  const browser = await chromium.launch({ headless: true });
  t.after(() => browser.close());
  const page = await browser.newPage();
  await page.setContent(`
    <script>window.instagramMultipleComposerClicks = 0;</script>
    <div role="dialog"><button onclick="window.instagramMultipleComposerClicks += 1">Share</button></div>
    <div role="dialog"><button onclick="window.instagramMultipleComposerClicks += 1">Share</button></div>
  `);

  await assert.rejects(
    createInstagramOperationBinding(page),
    /2 active create dialogs/
  );
  assert.equal(await page.evaluate(() => window.instagramMultipleComposerClicks), 0);
});

test("Instagram confirmation ignores fresh global text without operation identity", async (t) => {
  const browser = await chromium.launch({ headless: true });
  t.after(() => browser.close());
  const page = await browser.newPage();
  await page.setContent(`
    <div role="dialog" id="composer">
      <textarea aria-label="Caption"></textarea>
      <button>Share</button>
    </div>
    <div id="feedback"></div>
  `);
  const operation = await createInstagramOperationBinding(page);
  t.after(() => operation.surfaceHandle.dispose());
  operation.startedUrl = page.url();
  const baseline = await readInstagramConfirmationEvidence(page, operation);
  await page.locator("#feedback").evaluate((element) => {
    element.setAttribute("role", "alert");
    element.textContent = "Posted";
  });

  const result = await waitForPostConfirmation(page, operation, baseline, {
    maxPolls: 2,
    pollIntervalMs: 5,
  });
  assert.equal(result.ok, false);
  assert.equal(result.outcome, "uncertain");
  assert.equal(result.retryAllowed, false);
});

test("Instagram confirmation accepts fresh evidence inside the bound composer", async (t) => {
  const browser = await chromium.launch({ headless: true });
  t.after(() => browser.close());
  const page = await browser.newPage();
  await page.setContent(`
    <div role="dialog" id="composer">
      <textarea aria-label="Caption"></textarea>
      <button>Share</button>
      <div id="status"></div>
    </div>
  `);
  const operation = await createInstagramOperationBinding(page);
  t.after(() => operation.surfaceHandle.dispose());
  operation.startedUrl = page.url();
  const baseline = await readInstagramConfirmationEvidence(page, operation);
  await page.locator("#status").evaluate((element) => {
    element.textContent = "Your post was shared";
  });

  const result = await waitForPostConfirmation(page, operation, baseline, {
    maxPolls: 2,
    pollIntervalMs: 5,
  });
  assert.equal(result.ok, true);
  assert.equal(result.outcome, "success");
  assert.equal(result.evidence.evidenceType, "bound-composer");
});

test("Instagram failure result preserves post-click uncertainty", () => {
  const error = new Error("confirmation timed out");
  error.outcome = "uncertain";
  error.retryAllowed = false;
  error.clickAttempted = true;
  error.reason = "publication may have succeeded";
  const result = buildInstagramUploadFailureResult(error, "safe-local-path.png");

  assert.equal(result.ok, false);
  assert.equal(result.outcome, "uncertain");
  assert.equal(result.retryAllowed, false);
  assert.equal(result.clickAttempted, true);
  assert.equal(result.reason, "publication may have succeeded");
});

test("Instagram unclassified post-click exception becomes sanitized uncertainty", () => {
  const error = new Error("secret-token=instagram-sensitive-value");
  const result = buildInstagramUploadFailureResult(error, "safe-local-path.png", {
    actionAttempted: true,
  });

  assert.equal(result.ok, false);
  assert.equal(result.outcome, "uncertain");
  assert.equal(result.retryAllowed, false);
  assert.equal(result.clickAttempted, true);
  assert.match(result.reason, /publication may have succeeded/i);
  assert.doesNotMatch(result.reason, /instagram-sensitive-value/);
  assert.doesNotMatch(result.error, /instagram-sensitive-value/);
});
