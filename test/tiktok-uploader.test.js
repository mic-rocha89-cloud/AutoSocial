const test = require("node:test");
const assert = require("node:assert/strict");
const { chromium } = require("playwright");

const { _private } = require("../src/tiktok-uploader");

const {
  getPublishCandidateScore,
  isLikelyPublishCandidateInfo,
  setCaption,
} = _private;

test("TikTok publish candidate rejects the Studio sidebar Posts item", () => {
  const candidate = {
    disabled: false,
    inNavigation: true,
    rect: { left: 48, top: 300, width: 120, height: 36 },
    role: "button",
    tagName: "button",
    text: "Posts",
    viewportWidth: 1200,
  };

  assert.equal(isLikelyPublishCandidateInfo(candidate), false);
});

test("TikTok publish candidate accepts the main upload Post button", () => {
  const candidate = {
    disabled: false,
    inNavigation: false,
    rect: { left: 900, right: 1060, top: 780, width: 160, height: 44 },
    role: "",
    tagName: "button",
    text: "Post",
    viewportHeight: 900,
    viewportWidth: 1200,
  };

  assert.equal(isLikelyPublishCandidateInfo(candidate), true);
});

test("TikTok publish candidate rejects ambiguous left-side Post controls", () => {
  const candidate = {
    disabled: false,
    inNavigation: false,
    rect: { left: 80, right: 200, top: 320, width: 120, height: 36 },
    role: "",
    tagName: "button",
    text: "Post",
    viewportHeight: 900,
    viewportWidth: 1200,
  };

  assert.equal(isLikelyPublishCandidateInfo(candidate), false);
});

test("TikTok publish candidate allows Post controls in the main content area", () => {
  const candidate = {
    disabled: false,
    inNavigation: false,
    rect: { left: 300, right: 460, top: 760, width: 160, height: 44 },
    role: "",
    tagName: "button",
    text: "Post",
    viewportHeight: 900,
    viewportWidth: 1200,
  };

  assert.equal(isLikelyPublishCandidateInfo(candidate), true);
});

test("TikTok publish candidate scores bottom Post button above sidebar Posts", () => {
  const sidebar = {
    disabled: false,
    inNavigation: false,
    rect: { left: 80, right: 190, top: 248, width: 110, height: 36 },
    role: "button",
    tagName: "button",
    text: "Posts",
    viewportHeight: 940,
    viewportWidth: 1154,
  };
  const bottomButton = {
    className: "TUXButton TUXButton--primary",
    disabled: false,
    inNavigation: false,
    rect: { left: 340, right: 540, top: 884, width: 200, height: 38 },
    role: "",
    tagName: "button",
    text: "Post",
    viewportHeight: 940,
    viewportWidth: 1154,
  };

  assert.equal(getPublishCandidateScore(sidebar), -1);
  assert.ok(getPublishCandidateScore(bottomButton) > 0);
});

test("TikTok secondary confirm terms reject plain Post and sidebar Posts", () => {
  const sidebar = {
    disabled: false,
    inNavigation: false,
    rect: { left: 80, right: 190, top: 248, width: 110, height: 36 },
    role: "button",
    tagName: "button",
    text: "Posts",
    viewportHeight: 940,
    viewportWidth: 1154,
  };
  const bottomButton = {
    className: "TUXButton TUXButton--primary",
    disabled: false,
    inNavigation: false,
    rect: { left: 340, right: 540, top: 884, width: 200, height: 38 },
    role: "",
    tagName: "button",
    text: "Post",
    viewportHeight: 940,
    viewportWidth: 1154,
  };
  const secondaryTerms = ["publish", "confirm", "continue"];

  assert.equal(getPublishCandidateScore(sidebar, secondaryTerms), -1);
  assert.equal(getPublishCandidateScore(bottomButton, secondaryTerms), -1);
});

test("TikTok caption flow dismisses blocking dialogs before filling description", async (t) => {
  const browser = await chromium.launch({ headless: true });
  t.after(() => browser.close());
  const page = await browser.newPage();

  await page.setContent(`
    <style>
      .overlay {
        align-items: center;
        background: rgba(0, 0, 0, 0.6);
        display: flex;
        inset: 0;
        justify-content: center;
        position: fixed;
        z-index: 10;
      }
      #editing-tip { z-index: 11; }
    </style>
    <div>
      <label for="description">Description</label>
      <div id="description" role="textbox" contenteditable="true">generated filename</div>
    </div>
    <div id="content-checks" class="overlay" role="dialog">
      <button onclick="document.querySelector('#content-checks').remove()">Cancel</button>
      <button>Turn on</button>
    </div>
    <div id="editing-tip" class="overlay" role="dialog">
      <button onclick="document.querySelector('#editing-tip').remove()">Got it</button>
    </div>
  `);

  const caption = "Controlled AutoSocial QA caption.";
  await setCaption(page, caption);

  assert.equal(await page.locator('[role="dialog"]').count(), 0);
  assert.equal(await page.locator("#description").textContent(), caption);
});
