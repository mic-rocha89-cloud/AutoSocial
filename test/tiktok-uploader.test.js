const test = require("node:test");
const assert = require("node:assert/strict");
const { chromium } = require("playwright");

const { uploadVideo, _private } = require("../src/tiktok-uploader");

const {
  classifyPublishCandidateInfo,
  clickPublishOnce,
  collectPublishCandidateDiagnostics,
  collectUniquePublishTargets,
  detectInterferingOverlays,
  dismissKnownTikTokEditorOnboarding,
  getPublishCandidateScore,
  isLikelyPublishApiResponse,
  isLikelyPublishCandidateInfo,
  publishFailClosed,
  setCaption,
} = _private;

test("TikTok publish candidate rejects the Studio sidebar Posts item", () => {
  const candidate = {
    disabled: false,
    inNavigation: true,
    rect: { left: 48, top: 300, width: 120, height: 36 },
    role: "button",
    structuralBinding: "active-upload-form",
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
    structuralBinding: "active-upload-form",
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
    structuralBinding: "active-upload-form",
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
    structuralBinding: "active-upload-form",
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
    structuralBinding: "active-upload-form",
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
    structuralBinding: "active-upload-form",
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

test("TikTok publish diagnostics explain candidates without clicking", async (t) => {
  const browser = await chromium.launch({ headless: true });
  t.after(() => browser.close());
  const page = await browser.newPage({ viewport: { width: 1200, height: 900 } });

  await page.setContent(`
    <style>
      #valid-publish { bottom: 20px; height: 44px; position: fixed; right: 20px; width: 160px; }
    </style>
    <nav id="studio-sidebar">
      <button id="sidebar-posts" onclick="window.publishDiagnosticClicks += 1">Posts</button>
      <button id="sidebar-post" onclick="window.publishDiagnosticClicks += 1">Post</button>
    </nav>
    <form id="upload-form" action="/tiktokstudio/upload">
      <input id="upload-input" type="file" accept="video/*">
      <button
        id="valid-publish"
        class="TUXButton publish-button"
        data-e2e="post_video_button"
        data-testid="publish-action"
        type="submit"
        onclick="event.preventDefault(); window.publishDiagnosticClicks += 1"
      ><span>Post</span></button>
    </form>
    <button id="disabled-post" disabled onclick="window.publishDiagnosticClicks += 1">Post</button>
    <button id="aria-disabled-post" aria-disabled="true" onclick="window.publishDiagnosticClicks += 1">Post</button>
    <button id="invisible-post" style="display:none" onclick="window.publishDiagnosticClicks += 1">Post</button>
    <script>window.publishDiagnosticClicks = 0;</script>
  `);
  await page.locator("#upload-input").setInputFiles({
    name: "fixture.mp4",
    mimeType: "video/mp4",
    buffer: Buffer.from("local fixture"),
  });

  const diagnostics = await collectPublishCandidateDiagnostics(page);
  const byId = new Map(diagnostics.candidates.map((candidate) => [candidate.id, candidate]));

  assert.equal(diagnostics.qualifiedTargetCount, 1);
  assert.equal(byId.get("valid-publish").status, "ACCEPTED");
  assert.deepEqual(byId.get("valid-publish").reasons, ["qualified"]);
  assert.deepEqual(byId.get("valid-publish").locatorSources.sort(), [
    "exact-role",
    "semantic-clickable",
  ]);
  assert.equal(byId.get("valid-publish").tagName, "BUTTON");
  assert.equal(byId.get("valid-publish").type, "submit");
  assert.equal(byId.get("valid-publish").structuralBinding, "active-upload-form");
  assert.equal(byId.get("valid-publish").nearestButtonOwner.tagName, "BUTTON");
  assert.equal(byId.get("valid-publish").documentPopulatedFileInputCount, 1);
  assert.equal(
    byId
      .get("valid-publish")
      .ancestorChain.find((ancestor) => ancestor.id === "upload-form")
      .populatedFileInputCount,
    1
  );
  assert.deepEqual(byId.get("sidebar-posts").reasons, ["inside-navigation"]);
  assert.deepEqual(byId.get("sidebar-post").reasons, ["inside-navigation"]);
  assert.deepEqual(byId.get("disabled-post").reasons, ["disabled"]);
  assert.deepEqual(byId.get("aria-disabled-post").reasons, ["disabled"]);
  assert.deepEqual(byId.get("invisible-post").reasons, ["invisible"]);
  assert.equal(await page.evaluate(() => window.publishDiagnosticClicks), 0);
  assert.doesNotMatch(
    collectPublishCandidateDiagnostics.toString(),
    /\.click\(|keyboard\.|mouse\./
  );
});

test("TikTok candidate classifier rejects conflicting visible and ARIA identities", () => {
  const classification = classifyPublishCandidateInfo({
    ariaLabel: "Delete",
    disabled: false,
    inNavigation: false,
    rect: { left: 900, right: 1060, top: 780, width: 160, height: 44 },
    role: "",
    structuralBinding: "active-upload-form",
    tagName: "button",
    text: "Post",
    visible: true,
    viewportHeight: 900,
    viewportWidth: 1200,
  });

  assert.equal(classification.qualified, false);
  assert.deepEqual(classification.reasons, ["text-aria-mismatch"]);
});

test("TikTok caption flow refuses a blocking dialog without clicking it", async (t) => {
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
      <button onclick="window.overlayClicks += 1; document.querySelector('#content-checks').remove()">Cancel</button>
      <button>Turn on</button>
    </div>
    <div id="editing-tip" class="overlay" role="dialog">
      <button onclick="window.overlayClicks += 1; document.querySelector('#editing-tip').remove()">Got it</button>
    </div>
    <script>window.overlayClicks = 0;</script>
  `);

  const caption = "Controlled AutoSocial QA caption.";
  await assert.rejects(
    setCaption(page, caption),
    /blocked by a visible dialog/i
  );

  assert.equal(await page.locator('[role="dialog"]').count(), 2);
  assert.equal(await page.evaluate(() => window.overlayClicks), 0);
  assert.equal(
    await page.locator("#description").textContent(),
    "generated filename"
  );
});

const KNOWN_EDITOR_ONBOARDING_TITLE = "New editing features added";
const KNOWN_EDITOR_ONBOARDING_BODY =
  "Now it's easier than ever before to create professional and engaging videos.";

function editorOnboardingMarkup({
  id = "editor-onboarding",
  title = KNOWN_EDITOR_ONBOARDING_TITLE,
  body = KNOWN_EDITOR_ONBOARDING_BODY,
  buttonLabel = "Got it",
  hidden = false,
  onClick =
    "window.onboardingClicks += 1; this.closest('[role=dialog]').remove()",
} = {}) {
  return `
    <div id="${id}" class="test-dialog" role="dialog"${
      hidden ? ' style="display: none"' : ""
    }>
      <h2>${title}</h2>
      <p>${body}</p>
      <button type="button" onclick="${onClick}">${buttonLabel}</button>
    </div>
  `;
}

async function createCaptionPage(browser, { content = "", decoy = false } = {}) {
  const page = await browser.newPage();
  await page.setContent(`
    <style>
      .test-dialog {
        background: white;
        height: 240px;
        left: 300px;
        position: fixed;
        top: 120px;
        width: 360px;
        z-index: 10;
      }
    </style>
    <div id="description" role="textbox" contenteditable="true">generated filename</div>
    ${
      decoy
        ? '<button id="external-decoy" onclick="window.decoyClicks += 1">Got it</button>'
        : ""
    }
    ${content}
    <script>
      window.decoyClicks = 0;
      window.onboardingClicks = 0;
      window.publishClickCount = 0;
      window.unknownDialogClicks = 0;
    </script>
  `);
  return page;
}

test("TikTok safely dismisses only the exact known editor onboarding", async (t) => {
  const browser = await chromium.launch({ headless: true });
  t.after(() => browser.close());
  const caption = "Controlled AutoSocial QA caption.";

  await t.test("exact single onboarding is dismissed once before caption editing", async () => {
    const page = await createCaptionPage(browser, {
      content: editorOnboardingMarkup(),
    });
    try {
      await setCaption(page, caption);
      assert.equal(await page.locator("#editor-onboarding").count(), 0);
      assert.equal(await page.evaluate(() => window.onboardingClicks), 1);
      assert.equal(await page.evaluate(() => window.publishClickCount), 0);
      assert.equal(await page.locator("#description").textContent(), caption);
    } finally {
      await page.close();
    }
  });

  for (const scenario of [
    {
      name: "changed title fails closed",
      content: editorOnboardingMarkup({
        title: "New publishing features added",
      }),
    },
    {
      name: "materially changed body fails closed",
      content: editorOnboardingMarkup({
        body: "Review the post and confirm that you accept the updated terms.",
      }),
    },
    {
      name: "changed button fails closed",
      content: editorOnboardingMarkup({ buttonLabel: "Continue" }),
    },
  ]) {
    await t.test(scenario.name, async () => {
      const page = await createCaptionPage(browser, { content: scenario.content });
      try {
        await assert.rejects(setCaption(page, caption), /blocked by a visible dialog/i);
        assert.equal(await page.evaluate(() => window.onboardingClicks), 0);
        assert.equal(
          await page.locator("#description").textContent(),
          "generated filename"
        );
      } finally {
        await page.close();
      }
    });
  }

  await t.test("external Got it decoy is never selected", async () => {
    const page = await createCaptionPage(browser, {
      content: editorOnboardingMarkup(),
      decoy: true,
    });
    try {
      await setCaption(page, caption);
      assert.equal(await page.evaluate(() => window.onboardingClicks), 1);
      assert.equal(await page.evaluate(() => window.decoyClicks), 0);
      assert.equal(await page.locator("#external-decoy").count(), 1);
    } finally {
      await page.close();
    }
  });

  await t.test("known onboarding plus another visible dialog fails closed", async () => {
    const page = await createCaptionPage(browser, {
      content:
        editorOnboardingMarkup() +
        '<div id="unknown-dialog" class="test-dialog" role="dialog"><button onclick="window.unknownDialogClicks += 1">Close</button></div>',
    });
    try {
      await assert.rejects(setCaption(page, caption), /blocked by a visible dialog/i);
      assert.equal(await page.evaluate(() => window.onboardingClicks), 0);
      assert.equal(await page.evaluate(() => window.unknownDialogClicks), 0);
    } finally {
      await page.close();
    }
  });

  await t.test("two identical onboarding candidates fail closed", async () => {
    const page = await createCaptionPage(browser, {
      content:
        editorOnboardingMarkup({ id: "editor-onboarding-one" }) +
        editorOnboardingMarkup({ id: "editor-onboarding-two" }),
    });
    try {
      await assert.rejects(setCaption(page, caption), /blocked by a visible dialog/i);
      assert.equal(await page.evaluate(() => window.onboardingClicks), 0);
    } finally {
      await page.close();
    }
  });

  await t.test("hidden onboarding remains untouched and is not an active blocker", async () => {
    const page = await createCaptionPage(browser, {
      content: editorOnboardingMarkup({ hidden: true }),
    });
    try {
      await setCaption(page, caption);
      assert.equal(await page.locator("#editor-onboarding").count(), 1);
      assert.equal(await page.evaluate(() => window.onboardingClicks), 0);
      assert.equal(await page.locator("#description").textContent(), caption);
    } finally {
      await page.close();
    }
  });

  await t.test("dialog disappearing before final validation receives no click", async () => {
    const page = await createCaptionPage(browser, {
      content: editorOnboardingMarkup(),
    });
    try {
      const result = await dismissKnownTikTokEditorOnboarding(page, {
        beforeFinalValidation: async () => {
          await page.locator("#editor-onboarding").evaluate((dialog) => dialog.remove());
        },
      });
      assert.equal(result.blocked, true);
      assert.equal(result.dismissAttempted, false);
      assert.equal(await page.evaluate(() => window.onboardingClicks), 0);
    } finally {
      await page.close();
    }
  });

  await t.test("button replacement before final validation receives no click", async () => {
    const page = await createCaptionPage(browser, {
      content: editorOnboardingMarkup(),
    });
    try {
      const result = await dismissKnownTikTokEditorOnboarding(page, {
        beforeFinalValidation: async () => {
          await page.locator("#editor-onboarding button").evaluate((button) => {
            const replacement = button.cloneNode(true);
            replacement.textContent = "Continue";
            button.replaceWith(replacement);
          });
        },
      });
      assert.equal(result.blocked, true);
      assert.equal(result.dismissAttempted, false);
      assert.equal(await page.evaluate(() => window.onboardingClicks), 0);
    } finally {
      await page.close();
    }
  });

  await t.test("reappearing onboarding consumes only one dismiss attempt", async () => {
    const page = await createCaptionPage(browser, {
      content: editorOnboardingMarkup({
        onClick:
          "window.onboardingClicks += 1; const dialog = this.closest('[role=dialog]'); const replacement = dialog.cloneNode(true); replacement.id = 'editor-onboarding-again'; dialog.replaceWith(replacement)",
      }),
    });
    try {
      await assert.rejects(setCaption(page, caption), /blocked by a visible dialog/i);
      assert.equal(await page.evaluate(() => window.onboardingClicks), 1);
      assert.equal(await page.locator("#editor-onboarding-again").count(), 1);
      assert.equal(
        await page.locator("#description").textContent(),
        "generated filename"
      );
    } finally {
      await page.close();
    }
  });

  await t.test("automatic content checks dialog remains untouched", async () => {
    const page = await createCaptionPage(browser, {
      content: `
        <div id="automatic-content-checks" class="test-dialog" role="dialog">
          <h2>Turn on automatic content checks?</h2>
          <p>Review content for possible issues before publishing.</p>
          <button onclick="window.unknownDialogClicks += 1">Cancel</button>
          <button onclick="window.unknownDialogClicks += 1">Turn on</button>
        </div>
      `,
    });
    try {
      await assert.rejects(setCaption(page, caption), /blocked by a visible dialog/i);
      assert.equal(await page.evaluate(() => window.unknownDialogClicks), 0);
      assert.equal(await page.locator("#automatic-content-checks").count(), 1);
    } finally {
      await page.close();
    }
  });
});

test("TikTok final publish boundary has no setup call after owner validation", () => {
  const source = clickPublishOnce.toString();
  const beginClickIndex = source.indexOf("publishResponseTracker.beginClick");
  const finalCollectionIndex = source.indexOf(
    "const finalTargets = await collectUniquePublishTargets"
  );
  const finalBoundaryIndex = source.indexOf(
    "const finalBoundaryInfo = await getPublishCandidateInfo"
  );
  const finalBoundaryEndIndex = source.indexOf(
    ").catch(() => null);",
    finalBoundaryIndex
  );
  const consumeIndex = source.indexOf("actionGuard.consume()");
  const clickIndex = source.indexOf("await finalTarget.handle.click");

  assert.ok(beginClickIndex >= 0);
  assert.ok(beginClickIndex < finalCollectionIndex);
  assert.ok(finalCollectionIndex < finalBoundaryIndex);
  assert.ok(finalBoundaryIndex < finalBoundaryEndIndex);
  assert.ok(finalBoundaryEndIndex < consumeIndex);
  assert.ok(consumeIndex < clickIndex);
  assert.doesNotMatch(
    source.slice(finalBoundaryEndIndex, consumeIndex),
    /\bawait\b|waitFor|scroll|locator\(|beginClick|beforeClick|beforeFinalValidation/
  );
  assert.match(
    source.slice(consumeIndex, clickIndex),
    /^actionGuard\.consume\(\);\s*$/
  );
});

test("TikTok publish path contains no automatic overlay interaction", () => {
  const detectorSource = detectInterferingOverlays.toString();
  const uploadSource = uploadVideo.toString();

  assert.doesNotMatch(detectorSource, /\.click\(|keyboard\.(?:press|type)/);
  assert.doesNotMatch(
    uploadSource,
    /addDefaultSound\(|disableShortContentCheck\(/
  );
});

function createResponseTracker({ success = false, failure = null } = {}) {
  let currentSuccess = success;
  let currentFailure = failure;
  let armed = false;

  return {
    arm() {
      armed = true;
      currentSuccess = false;
      currentFailure = null;
    },
    recordFailure(reason) {
      if (armed) {
        currentFailure = reason;
      }
    },
    recordSuccess(evidence = true) {
      if (armed) {
        currentSuccess = evidence;
      }
    },
    success: () => currentSuccess,
    failure: () => currentFailure,
    dispose() {},
  };
}

async function createPublishPage(browser, {
  bodyText = "",
  bindToComposer = true,
  buttonLabel = "Post",
  includeButton = true,
  secondButton = false,
  onClick = "window.publishClickCount += 1",
  statusAttributes = 'role="status"',
} = {}) {
  const page = await browser.newPage({
    viewport: { width: 1200, height: 900 },
  });
  const button = includeButton
    ? `<button type="button" id="publish" class="publish-button" onclick="${onClick}">${buttonLabel}</button>`
    : "";
  const duplicate = secondButton
    ? '<button type="button" id="publish-two" class="publish-button">Publish</button>'
    : "";
  const uploadForm = bindToComposer
    ? `<form id="upload-composer">
        <input id="upload-input" type="file" accept="video/*">
        ${button}
        ${duplicate}
      </form>`
    : `<form id="upload-composer">
        <input id="upload-input" type="file" accept="video/*">
      </form>
      <div id="unbound-actions">
        ${button}
        ${duplicate}
      </div>`;
  const document = `
    <style>
      body { min-height: 900px; }
      .publish-button {
        bottom: 20px;
        height: 44px;
        position: fixed;
        right: 20px;
        width: 160px;
      }
      #publish-two { right: 210px; }
    </style>
    <div id="status" ${statusAttributes}>${bodyText}</div>
    ${uploadForm}
    <script>window.publishClickCount = 0;</script>
  `;
  await page.route("https://www.tiktok.com/**", (route) =>
    route.fulfill({ contentType: "text/html", body: document })
  );
  await page.goto("https://www.tiktok.com/tiktokstudio/upload");
  await page.locator("#upload-input").setInputFiles({
    name: "fixture.mp4",
    mimeType: "video/mp4",
    buffer: Buffer.from("local fixture"),
  });
  return page;
}

async function createHydratedStudioPublishPage(browser, {
  includeDiscard = true,
  onClick = "window.publishClickCount += 1",
  pathName = "/tiktokstudio/upload",
} = {}) {
  const page = await browser.newPage({ viewport: { width: 1400, height: 1000 } });
  const document = `
    <style>
      body { min-height: 1600px; }
      .button-group { position: absolute; top: 1488px; left: 280px; }
      [data-e2e="post_video_button"] { height: 36px; width: 200px; }
    </style>
    <div id="studio-sidebar" data-tt="Sidebar_Sidebar_Clickable">
      <button type="button">Posts</button>
    </div>
    <div class="main-body">
      <div class="layout">
        <div class="footer">
          <div class="button-group">
            <button
              type="button"
              role="button"
              class="Button__root Button__root--size-large Button__root--type-primary"
              data-icon-only="false"
              data-size="large"
              data-disabled="false"
              data-e2e="post_video_button"
              onclick="${onClick}"
            ><span>Post</span></button>
            ${
              includeDiscard
                ? '<button type="button" role="button" data-e2e="discard_post_button">Discard</button>'
                : ""
            }
          </div>
        </div>
      </div>
    </div>
    <script>window.publishClickCount = 0;</script>
  `;
  await page.route("https://www.tiktok.com/**", (route) =>
    route.fulfill({ contentType: "text/html", body: document })
  );
  await page.goto(`https://www.tiktok.com${pathName}`);
  return page;
}

function fastPublishOptions(overrides = {}) {
  return {
    findMaxPolls: 1,
    findPollIntervalMs: 0,
    settleMs: 0,
    confirmationMaxPolls: 3,
    confirmationPollIntervalMs: 10,
    ...overrides,
  };
}

test("TikTok final publish rejects composite transactional actions", async (t) => {
  const browser = await chromium.launch({ headless: true });
  t.after(() => browser.close());
  const page = await createPublishPage(browser, {
    buttonLabel: "Publish and enroll in rewards",
  });
  try {
    const result = await clickPublishOnce(page, {
      maxPolls: 1,
      pollIntervalMs: 0,
      settleMs: 0,
    });

    assert.equal(result.clickAttempted, false);
    assert.equal(await page.evaluate(() => window.publishClickCount), 0);
  } finally {
    await page.close();
  }
});

test("TikTok qualifies the hydrated Studio publish action observed in real DOM", async (t) => {
  const browser = await chromium.launch({ headless: true });
  t.after(() => browser.close());
  const page = await createHydratedStudioPublishPage(browser);
  try {
    const diagnostics = await collectPublishCandidateDiagnostics(page);
    const postCandidate = diagnostics.candidates.find(
      ({ dataE2e }) => dataE2e === "post_video_button"
    );
    assert.equal(postCandidate.status, "ACCEPTED");
    assert.equal(postCandidate.structuralBinding, "verified-upload-action-region");
    assert.equal(diagnostics.qualifiedTargetCount, 1);

    const result = await clickPublishOnce(page, {
      maxPolls: 1,
      pollIntervalMs: 0,
      settleMs: 0,
    });
    assert.equal(result.outcome, "clicked");
    assert.equal(result.clickAttempted, true);
    assert.equal(await page.evaluate(() => window.publishClickCount), 1);
  } finally {
    await page.close();
  }
});

test("TikTok hydrated Studio binding fails closed when structural proof is incomplete", async (t) => {
  const browser = await chromium.launch({ headless: true });
  t.after(() => browser.close());
  const clickOptions = { maxPolls: 1, pollIntervalMs: 0, settleMs: 0 };

  for (const scenario of [
    {
      name: "paired Discard action is missing",
      options: { includeDiscard: false },
    },
    {
      name: "same action region is outside the Studio upload path",
      options: { pathName: "/tiktokstudio/content" },
    },
  ]) {
    await t.test(scenario.name, async () => {
      const page = await createHydratedStudioPublishPage(
        browser,
        scenario.options
      );
      try {
        const diagnostics = await collectPublishCandidateDiagnostics(page);
        const postCandidate = diagnostics.candidates.find(
          ({ dataE2e }) => dataE2e === "post_video_button"
        );
        assert.equal(postCandidate.status, "REJECTED");
        assert.deepEqual(postCandidate.reasons, ["structural-binding-missing"]);
        assert.equal(diagnostics.qualifiedTargetCount, 0);

        const result = await clickPublishOnce(page, clickOptions);
        assert.equal(result.outcome, "failure");
        assert.equal(result.clickAttempted, false);
        assert.equal(await page.evaluate(() => window.publishClickCount), 0);
      } finally {
        await page.close();
      }
    });
  }

  await t.test("two physical verified action regions remain ambiguous", async () => {
    const page = await createHydratedStudioPublishPage(browser);
    try {
      await page.evaluate(() => {
        const original = document.querySelector(".button-group");
        const duplicate = original.cloneNode(true);
        duplicate.id = "second-physical-action-group";
        duplicate.style.left = "520px";
        original.parentElement.appendChild(duplicate);
      });

      const diagnostics = await collectPublishCandidateDiagnostics(page);
      const verifiedPosts = diagnostics.candidates.filter(
        ({ dataE2e }) => dataE2e === "post_video_button"
      );
      assert.equal(verifiedPosts.length, 2);
      assert.equal(diagnostics.qualifiedTargetCount, 2);
      assert.ok(
        verifiedPosts.every(
          ({ status, reasons }) =>
            status === "REJECTED" &&
            reasons.length === 1 &&
            reasons[0] === "ambiguous-qualified-duplicate"
        )
      );

      const result = await clickPublishOnce(page, clickOptions);
      assert.equal(result.outcome, "failure");
      assert.equal(result.clickAttempted, false);
      assert.equal(await page.evaluate(() => window.publishClickCount), 0);
    } finally {
      await page.close();
    }
  });
});

test("TikTok publish target requires exact identity and active composer binding", async (t) => {
  const browser = await chromium.launch({ headless: true });
  t.after(() => browser.close());
  const clickOptions = {
    maxPolls: 1,
    pollIntervalMs: 0,
    settleMs: 0,
  };

  async function assertRejected(label, options = {}) {
    const page = await createPublishPage(browser, {
      buttonLabel: label,
      ...options,
    });
    try {
      const result = await clickPublishOnce(page, clickOptions);
      assert.equal(result.outcome, "failure", label);
      assert.equal(result.clickAttempted, false, label);
      assert.equal(
        await page.evaluate(() => window.publishClickCount),
        0,
        label
      );
    } finally {
      await page.close();
    }
  }

  await t.test("exact Publish inside the active upload form is eligible", async () => {
    const page = await createPublishPage(browser, { buttonLabel: "Publish" });
    try {
      const result = await clickPublishOnce(page, clickOptions);
      assert.equal(result.outcome, "clicked");
      assert.equal(result.clickAttempted, true);
      assert.equal(await page.evaluate(() => window.publishClickCount), 1);
    } finally {
      await page.close();
    }
  });

  await t.test("Publish and promote is rejected", () =>
    assertRejected("Publish and promote"));

  await t.test("prefix and suffix composites are rejected", async () => {
    for (const label of [
      "Publish & continue",
      "Publish now and schedule",
      "Post and continue",
      "Confirm Publish",
    ]) {
      await assertRejected(label);
    }
  });

  await t.test("exact Publish without an active composer binding is rejected", () =>
    assertRejected("Publish", { bindToComposer: false }));

  await t.test("a bound non-exact label is rejected", () =>
    assertRejected("Publish later"));

  await t.test("two exact bound controls are rejected", async () => {
    const page = await createPublishPage(browser, {
      buttonLabel: "Publish",
      secondButton: true,
    });
    try {
      const result = await clickPublishOnce(page, clickOptions);
      assert.equal(result.outcome, "failure");
      assert.equal(result.clickAttempted, false);
      assert.equal(await page.evaluate(() => window.publishClickCount), 0);
    } finally {
      await page.close();
    }
  });

  await t.test("exact officially supported aliases remain eligible", async () => {
    for (const label of [
      "Post",
      "Ver&#246;ffentlichen",
      Buffer.from(
        "7665726f656666656e746c696368656e",
        "hex"
      ).toString("utf8"),
      "Publicar",
      "Publier",
      "Pubblica",
    ]) {
      const page = await createPublishPage(browser, { buttonLabel: label });
      try {
        const result = await clickPublishOnce(page, clickOptions);
        assert.equal(result.outcome, "clicked", label);
        assert.equal(await page.evaluate(() => window.publishClickCount), 1, label);
      } finally {
        await page.close();
      }
    }
  });
});

test("TikTok final publish is fail-closed across confirmation paths", async (t) => {
  const browser = await chromium.launch({ headless: true });
  t.after(() => browser.close());

  await t.test("unbound DOM status remains uncertain after one click", async () => {
    const page = await createPublishPage(browser, {
      statusAttributes: "",
      onClick:
        "window.publishClickCount += 1; const success = document.createElement('div'); success.setAttribute('role', 'status'); success.textContent = 'Published'; document.body.appendChild(success);",
    });
    try {
      const result = await publishFailClosed(
        page,
        createResponseTracker(),
        fastPublishOptions()
      );
      assert.equal(result.outcome, "uncertain");
      assert.equal(result.retryAllowed, false);
      assert.equal(await page.evaluate(() => window.publishClickCount), 1);
    } finally {
      await page.close();
    }
  });

  await t.test("delayed unbound DOM status remains uncertain", async () => {
    const page = await createPublishPage(browser, {
      statusAttributes: "",
      onClick:
        "window.publishClickCount += 1; setTimeout(() => { const success = document.createElement('div'); success.setAttribute('role', 'status'); success.textContent = 'Published'; document.body.appendChild(success); }, 30);",
    });
    try {
      const result = await publishFailClosed(
        page,
        createResponseTracker(),
        fastPublishOptions({
          confirmationMaxPolls: 10,
          confirmationPollIntervalMs: 10,
        })
      );
      assert.equal(result.outcome, "uncertain");
      assert.equal(result.retryAllowed, false);
      assert.equal(await page.evaluate(() => window.publishClickCount), 1);
    } finally {
      await page.close();
    }
  });

  await t.test("timeout after click is uncertain and never retries", async () => {
    const page = await createPublishPage(browser);
    try {
      const result = await publishFailClosed(
        page,
        createResponseTracker(),
        fastPublishOptions({
          confirmationMaxPolls: 2,
          confirmationPollIntervalMs: 0,
        })
      );
      assert.equal(result.ok, false);
      assert.equal(result.outcome, "uncertain");
      assert.equal(result.retryAllowed, false);
      assert.equal(await page.evaluate(() => window.publishClickCount), 1);
    } finally {
      await page.close();
    }
  });

  await t.test("hash-only navigation does not confirm success", async () => {
    const page = await createPublishPage(browser, {
      onClick:
        "window.publishClickCount += 1; window.location.hash = 'published';",
    });
    try {
      const result = await publishFailClosed(
        page,
        createResponseTracker(),
        fastPublishOptions()
      );
      assert.equal(result.outcome, "uncertain");
      assert.equal(await page.evaluate(() => window.publishClickCount), 1);
    } finally {
      await page.close();
    }
  });

  await t.test("multiple locators for one logical button are deduplicated", async () => {
    const page = await createPublishPage(browser);
    try {
      const targets = await collectUniquePublishTargets(page);
      assert.equal(targets.length, 1);
      await Promise.all(
        targets.map(({ handle }) => handle.dispose().catch(() => {}))
      );

      const result = await publishFailClosed(
        page,
        createResponseTracker(),
        fastPublishOptions({
          confirmationMaxPolls: 1,
          confirmationPollIntervalMs: 0,
        })
      );
      assert.equal(result.outcome, "uncertain");
      assert.equal(await page.evaluate(() => window.publishClickCount), 1);
    } finally {
      await page.close();
    }
  });

  await t.test("initial visible dialog aborts publish without remote interaction", async () => {
    const page = await createPublishPage(browser, { buttonLabel: "Publish" });
    try {
      await page.evaluate(() => {
        const dialog = document.createElement("div");
        dialog.id = "initial-dialog";
        dialog.setAttribute("role", "dialog");
        dialog.innerHTML =
          '<button onclick="window.dialogClickCount += 1">Close</button>';
        document.body.appendChild(dialog);
        window.dialogClickCount = 0;
      });

      const result = await publishFailClosed(
        page,
        createResponseTracker(),
        fastPublishOptions()
      );

      assert.equal(result.outcome, "failure");
      assert.equal(result.retryAllowed, true);
      assert.equal(result.clickAttempted, false);
      assert.equal(await page.evaluate(() => window.publishClickCount), 0);
      assert.equal(await page.evaluate(() => window.dialogClickCount), 0);
      assert.equal(await page.locator("#initial-dialog").count(), 1);
    } finally {
      await page.close();
    }
  });

  await t.test("automatic content checks dialog blocks final publish without interaction", async () => {
    const page = await createPublishPage(browser, { buttonLabel: "Publish" });
    try {
      await page.evaluate(() => {
        const dialog = document.createElement("div");
        dialog.id = "automatic-content-checks";
        dialog.setAttribute("role", "dialog");
        dialog.style.cssText =
          "position:fixed;left:200px;top:100px;width:360px;height:240px";
        dialog.innerHTML =
          "<h2>Turn on automatic content checks?</h2>" +
          '<button onclick="window.contentCheckClicks += 1">Cancel</button>' +
          '<button onclick="window.contentCheckClicks += 1">Turn on</button>';
        document.body.appendChild(dialog);
        window.contentCheckClicks = 0;
      });

      const result = await publishFailClosed(
        page,
        createResponseTracker(),
        fastPublishOptions()
      );

      assert.equal(result.outcome, "failure");
      assert.equal(result.clickAttempted, false);
      assert.equal(await page.evaluate(() => window.publishClickCount), 0);
      assert.equal(await page.evaluate(() => window.contentCheckClicks), 0);
      assert.equal(await page.locator("#automatic-content-checks").count(), 1);
      assert.match(result.reason, /blocked by a visible dialog/i);
    } finally {
      await page.close();
    }
  });

  await t.test("late visible dialog aborts final publish with zero clicks", async () => {
    const page = await createPublishPage(browser, { buttonLabel: "Publish" });
    try {
      const result = await publishFailClosed(
        page,
        createResponseTracker(),
        fastPublishOptions({
          beforeFinalValidation: async () => {
            await page.evaluate(() => {
              const dialog = document.createElement("div");
              dialog.id = "late-dialog";
              dialog.setAttribute("role", "dialog");
              dialog.innerHTML =
                '<button id="late-dialog-control" ' +
                'onclick="window.dialogClickCount += 1; this.parentElement.remove()">' +
                "Continue</button>";
              document.body.appendChild(dialog);
              window.dialogClickCount = 0;
            });
          },
          confirmationMaxPolls: 1,
          confirmationPollIntervalMs: 0,
        })
      );

      assert.equal(result.ok, false);
      assert.equal(result.outcome, "failure");
      assert.equal(result.retryAllowed, true);
      assert.equal(result.clickAttempted, false);
      assert.equal(await page.evaluate(() => window.publishClickCount), 0);
      assert.equal(await page.evaluate(() => window.dialogClickCount), 0);
      assert.equal(await page.locator("#late-dialog").count(), 1);
      assert.match(result.reason, /blocked by a visible dialog/i);
    } finally {
      await page.close();
    }
  });

  await t.test("known onboarding appearing at final publish boundary is not dismissed", async () => {
    const page = await createPublishPage(browser, { buttonLabel: "Publish" });
    try {
      const result = await publishFailClosed(
        page,
        createResponseTracker(),
        fastPublishOptions({
          beforeFinalValidation: async () => {
            await page.evaluate(
              ({ title, body }) => {
                const dialog = document.createElement("div");
                dialog.id = "late-known-onboarding";
                dialog.setAttribute("role", "dialog");
                dialog.style.cssText =
                  "position:fixed;left:200px;top:100px;width:360px;height:240px";
                dialog.innerHTML =
                  `<h2>${title}</h2><p>${body}</p>` +
                  '<button onclick="window.knownOnboardingClicks += 1; this.parentElement.remove()">Got it</button>';
                document.body.appendChild(dialog);
                window.knownOnboardingClicks = 0;
              },
              {
                title: KNOWN_EDITOR_ONBOARDING_TITLE,
                body: KNOWN_EDITOR_ONBOARDING_BODY,
              }
            );
          },
          confirmationMaxPolls: 1,
          confirmationPollIntervalMs: 0,
        })
      );

      assert.equal(result.ok, false);
      assert.equal(result.outcome, "failure");
      assert.equal(result.clickAttempted, false);
      assert.equal(await page.evaluate(() => window.publishClickCount), 0);
      assert.equal(await page.evaluate(() => window.knownOnboardingClicks), 0);
      assert.equal(await page.locator("#late-known-onboarding").count(), 1);
      assert.match(result.reason, /blocked by a visible dialog/i);
    } finally {
      await page.close();
    }
  });

  await t.test("ambiguous click error does not try another locator", async () => {
    const page = await createPublishPage(browser);
    try {
      const result = await publishFailClosed(
        page,
        createResponseTracker(),
        fastPublishOptions({
          beforeFinalValidation: async () => {
            await page.evaluate(() => {
              const blocker = document.createElement("div");
              blocker.id = "late-blocker";
              blocker.style.cssText =
                "position:fixed;inset:0;z-index:9999;background:transparent";
              document.body.appendChild(blocker);
            });
          },
        })
      );
      assert.equal(result.ok, false);
      assert.equal(result.outcome, "uncertain");
      assert.equal(result.retryAllowed, false);
      assert.equal(result.clickAttempted, true);
      assert.equal(await page.evaluate(() => window.publishClickCount), 0);
      assert.match(result.reason, /no retry was attempted/i);
    } finally {
      await page.close();
    }
  });

  await t.test("confirmation inspection error after click is uncertain", async () => {
    const page = await createPublishPage(browser);
    try {
      const result = await publishFailClosed(
        page,
        {
          failure() {
            throw new Error("confirmation tracker unavailable");
          },
          success: () => false,
          dispose() {},
        },
        fastPublishOptions()
      );
      assert.equal(result.ok, false);
      assert.equal(result.outcome, "uncertain");
      assert.equal(result.retryAllowed, false);
      assert.equal(await page.evaluate(() => window.publishClickCount), 1);
      assert.match(result.reason, /no retry was attempted/i);
    } finally {
      await page.close();
    }
  });

  await t.test("missing button is a safe failure before any click", async () => {
    const page = await createPublishPage(browser, { includeButton: false });
    try {
      const result = await publishFailClosed(
        page,
        createResponseTracker(),
        fastPublishOptions()
      );
      assert.equal(result.ok, false);
      assert.equal(result.outcome, "failure");
      assert.equal(result.clickAttempted, false);
      assert.equal(result.retryAllowed, true);
      assert.equal(await page.evaluate(() => window.publishClickCount), 0);
    } finally {
      await page.close();
    }
  });

  await t.test("explicit pre-click error fails with zero clicks", async () => {
    const page = await createPublishPage(browser, {
      bodyText: "Error: publishing is unavailable.",
    });
    try {
      const result = await publishFailClosed(
        page,
        createResponseTracker(),
        fastPublishOptions()
      );
      assert.equal(result.outcome, "failure");
      assert.equal(result.clickAttempted, false);
      assert.equal(await page.evaluate(() => window.publishClickCount), 0);
    } finally {
      await page.close();
    }
  });

  await t.test("historical success-like text is not a new confirmation", async () => {
    const page = await createPublishPage(browser, {
      bodyText: "Previously posted videos",
    });
    try {
      const result = await publishFailClosed(
        page,
        createResponseTracker(),
        fastPublishOptions({
          confirmationMaxPolls: 1,
          confirmationPollIntervalMs: 0,
        })
      );
      assert.notEqual(result.outcome, "success");
      assert.equal(result.outcome, "uncertain");
      assert.equal(await page.evaluate(() => window.publishClickCount), 1);
    } finally {
      await page.close();
    }
  });

  await t.test("publish click count stays at or below one on every path", async () => {
    const cases = [
      {
        bodyText: "",
        includeButton: true,
        onClick:
          "window.publishClickCount += 1; document.querySelector('#status').textContent = 'Published';",
      },
      {
        bodyText: "",
        includeButton: true,
        onClick: "window.publishClickCount += 1",
      },
      {
        bodyText: "",
        includeButton: false,
      },
    ];

    for (const scenario of cases) {
      const page = await createPublishPage(browser, scenario);
      try {
        await publishFailClosed(
          page,
          createResponseTracker(),
          fastPublishOptions({
            confirmationMaxPolls: 1,
            confirmationPollIntervalMs: 0,
          })
        );
        assert.ok(
          (await page.evaluate(() => window.publishClickCount)) <= 1
        );
      } finally {
        await page.close();
      }
    }
  });

  await t.test("multiple distinct active publish buttons abort before click", async () => {
    const page = await createPublishPage(browser, { secondButton: true });
    try {
      const result = await publishFailClosed(
        page,
        createResponseTracker(),
        fastPublishOptions()
      );
      assert.equal(result.outcome, "failure");
      assert.equal(result.clickAttempted, false);
      assert.equal(await page.evaluate(() => window.publishClickCount), 0);
    } finally {
      await page.close();
    }
  });

  await t.test("visible dialogs are detected without clicking any remote control", async () => {
    const translatedContinue = Buffer.from(
      "666f727466616872656e",
      "hex"
    ).toString("utf8");
    for (const label of ["Continue", translatedContinue]) {
      const page = await browser.newPage();
      await page.setContent(`
        <div id="benign" role="dialog">
          <button onclick="document.querySelector('#benign').remove()">Cancel</button>
        </div>
        <button id="transactional" onclick="window.transactionalClicks += 1">${label}</button>
        <script>window.transactionalClicks = 0;</script>
      `);
      try {
        const overlayState = await detectInterferingOverlays(page);
        assert.equal(overlayState.blocked, true);
        assert.equal(overlayState.visibleDialogCount, 1);
        assert.equal(await page.locator("#benign").count(), 1);
        assert.equal(
          await page.evaluate(() => window.transactionalClicks),
          0,
          `${label} must remain outside generic cleanup`
        );
      } finally {
        await page.close();
      }
    }
  });

  await t.test("nested actionable owners remain distinct and abort with zero clicks", async () => {
    const page = await browser.newPage({
      viewport: { width: 1200, height: 900 },
    });
    await page.setContent(`
      <style>
        #outer {
          bottom: 20px;
          height: 80px;
          position: fixed;
          right: 20px;
          width: 240px;
        }
        #inner { height: 44px; width: 160px; }
      </style>
      <form id="nested-upload-composer">
        <input id="nested-upload-input" type="file" accept="video/*">
        <div
          id="outer"
          role="button"
          aria-label="Publish"
          class="publish-owner"
          onclick="window.outerClicks += 1"
        >
          <button
            type="button"
            id="inner"
            aria-label="Publish"
            class="publish-button"
            onclick="event.stopPropagation(); window.innerClicks += 1"
          ></button>
        </div>
      </form>
      <script>window.outerClicks = 0; window.innerClicks = 0;</script>
    `);
    await page.locator("#nested-upload-input").setInputFiles({
      name: "fixture.mp4",
      mimeType: "video/mp4",
      buffer: Buffer.from("local fixture"),
    });
    try {
      const targets = await collectUniquePublishTargets(page);
      assert.equal(
        targets.length,
        2,
        JSON.stringify(targets.map(({ info }) => info))
      );
      await Promise.all(
        targets.map(({ handle }) => handle.dispose().catch(() => {}))
      );

      const result = await publishFailClosed(
        page,
        createResponseTracker(),
        fastPublishOptions()
      );
      assert.equal(result.outcome, "failure");
      assert.equal(result.clickAttempted, false);
      assert.deepEqual(
        await page.evaluate(() => [window.outerClicks, window.innerClicks]),
        [0, 0]
      );
    } finally {
      await page.close();
    }
  });

  await t.test("a second owner appearing immediately before click aborts with zero clicks", async () => {
    const page = await createPublishPage(browser);
    try {
      const result = await publishFailClosed(
        page,
        createResponseTracker(),
        fastPublishOptions({
          beforeFinalValidation: async () => {
            await page.evaluate(() => {
              const second = document.createElement("button");
              second.id = "late-publish";
              second.className = "publish-button";
              second.textContent = "Publish";
              second.style.right = "210px";
              document.querySelector("#upload-composer").appendChild(second);
            });
          },
        })
      );
      assert.equal(result.outcome, "failure");
      assert.equal(result.clickAttempted, false);
      assert.equal(await page.evaluate(() => window.publishClickCount), 0);
    } finally {
      await page.close();
    }
  });

  await t.test("replacing the selected owner before click aborts with zero clicks", async () => {
    const page = await createPublishPage(browser);
    try {
      const result = await publishFailClosed(
        page,
        createResponseTracker(),
        fastPublishOptions({
          beforeFinalValidation: async () => {
            await page.evaluate(() => {
              const original = document.querySelector("#publish");
              const replacement = original.cloneNode(true);
              replacement.id = "replacement-publish";
              original.replaceWith(replacement);
            });
          },
        })
      );
      assert.equal(result.outcome, "failure");
      assert.equal(result.clickAttempted, false);
      assert.equal(await page.evaluate(() => window.publishClickCount), 0);
    } finally {
      await page.close();
    }
  });

  await t.test("an unrelated mutating HTTP response is not publish evidence", () => {
    const response = {
      url: () => "https://www.tiktok.com/creator/analytics",
      request: () => ({
        method: () => "POST",
        postData: () => JSON.stringify({ range: "28d" }),
      }),
    };
    assert.equal(isLikelyPublishApiResponse(response), false);
    assert.equal(
      isLikelyPublishApiResponse({
        url: () => "https://www.tiktok.com/api/post/publish",
        request: () => ({
          method: () => "POST",
          postData: () => JSON.stringify({ video_id: "current-video" }),
        }),
      }),
      true
    );
  });

  await t.test("HTTP evidence accumulated before the click is reset", async () => {
    const page = await createPublishPage(browser);
    try {
      const result = await publishFailClosed(
        page,
        createResponseTracker({ success: true }),
        fastPublishOptions({
          confirmationMaxPolls: 1,
          confirmationPollIntervalMs: 0,
        })
      );
      assert.equal(result.outcome, "uncertain");
      assert.equal(await page.evaluate(() => window.publishClickCount), 1);
    } finally {
      await page.close();
    }
  });

  await t.test("generic body text does not confirm success", async () => {
    const page = await createPublishPage(browser, {
      statusAttributes: "",
      onClick:
        "window.publishClickCount += 1; document.querySelector('#status').textContent = 'Success';",
    });
    try {
      const result = await publishFailClosed(
        page,
        createResponseTracker(),
        fastPublishOptions({
          confirmationMaxPolls: 1,
          confirmationPollIntervalMs: 0,
        })
      );
      assert.equal(result.outcome, "uncertain");
    } finally {
      await page.close();
    }
  });

  await t.test("generic scoped status text does not confirm success", async () => {
    const page = await createPublishPage(browser, {
      statusAttributes: "",
      onClick:
        "window.publishClickCount += 1; const status = document.createElement('div'); status.setAttribute('role', 'status'); status.textContent = 'Success'; document.body.appendChild(status);",
    });
    try {
      const result = await publishFailClosed(
        page,
        createResponseTracker(),
        fastPublishOptions({
          confirmationMaxPolls: 1,
          confirmationPollIntervalMs: 0,
        })
      );
      assert.equal(result.outcome, "uncertain");
    } finally {
      await page.close();
    }
  });

  await t.test("invisible scoped success text does not confirm success", async () => {
    const page = await createPublishPage(browser, {
      statusAttributes: "",
      onClick:
        "window.publishClickCount += 1; const success = document.createElement('div'); success.setAttribute('role', 'status'); success.style.opacity = '0'; success.textContent = 'Published'; document.body.appendChild(success);",
    });
    try {
      const result = await publishFailClosed(
        page,
        createResponseTracker(),
        fastPublishOptions({
          confirmationMaxPolls: 1,
          confirmationPollIntervalMs: 0,
        })
      );
      assert.equal(result.outcome, "uncertain");
    } finally {
      await page.close();
    }
  });

  await t.test("generic navigation away from upload does not confirm success", async () => {
    const page = await createPublishPage(browser, {
      onClick:
        "window.publishClickCount += 1; history.pushState({}, '', '/home');",
    });
    try {
      const result = await publishFailClosed(
        page,
        createResponseTracker(),
        fastPublishOptions({
          confirmationMaxPolls: 1,
          confirmationPollIntervalMs: 0,
        })
      );
      assert.equal(result.outcome, "uncertain");
    } finally {
      await page.close();
    }
  });
});
