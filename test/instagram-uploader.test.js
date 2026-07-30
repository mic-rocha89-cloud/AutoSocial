const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const { chromium } = require("playwright");

const { _private } = require("../src/instagram-uploader");

const {
  clickNextButtons,
  clickShare,
  dismissVideoPostsAreReelsDialog,
  ensureCreateFlowInput,
  exactUiTextPattern,
  isCreateUploadReady,
  setCaption,
  setVideoFile,
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

  assert.equal(await clickShare(page), false);
  assert.equal(
    await page.evaluate(() => window.instagramComposerClicks.backgroundShare),
    0
  );

  assert.equal(await dismissVideoPostsAreReelsDialog(page), true);
  assert.equal(await page.locator("#reels-notice").count(), 0);

  assert.equal(await clickNextButtons(page), 2);
  await setCaption(page, "Controlled Instagram regression caption");
  assert.equal(
    await page.locator("#composer-caption").inputValue(),
    "Controlled Instagram regression caption"
  );

  assert.equal(await clickShare(page), true);
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
