const path = require("path");
const fs = require("fs/promises");
const { chromium } = require("playwright");
const { config } = require("./config");
const uiLabels = require("./platform-ui-labels");
const {
  getActiveAccount,
  getPlatformProfileDir,
  hasSavedPlatformSession,
} = require("./account-manager");

let loginSessionContext = null;
let loginSessionAccountId = null;

async function openPersistentContext(accountId) {
  const profileDir = await getPlatformProfileDir("youtube", accountId);
  await fs.mkdir(profileDir, { recursive: true });
  return chromium.launchPersistentContext(profileDir, {
    headless: config.headless,
    viewport: { width: 1400, height: 1000 },
    locale: config.browserLocale,
    timezoneId: config.timezone,
    args: ["--disable-blink-features=AutomationControlled"],
  });
}

async function gotoUploadPage(page) {
  await page.goto(config.youtubeUploadPageUrl, { waitUntil: "domcontentloaded" });
}

async function clickFirstVisibleEnabledLocator(
  page,
  locator,
  { allowForceFallback = true } = {}
) {
  const total = await locator.count();
  for (let i = 0; i < total; i += 1) {
    const candidate = locator.nth(i);
    const visible = await candidate.isVisible().catch(() => false);
    if (!visible) continue;
    const disabled = await candidate.isDisabled().catch(() => false);
    if (disabled) continue;
    try {
      await candidate.scrollIntoViewIfNeeded({ timeout: 3000 });
      await candidate.click({ timeout: 5000 });
      return true;
    } catch {
      if (!allowForceFallback) continue;
      try {
        await candidate.click({ timeout: 5000, force: true });
        return true;
      } catch {
        // continue
      }
    }
  }
  return false;
}

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function exactUiTextPattern(...keys) {
  const labels = uiLabels.terms(...keys);
  return new RegExp(`^\\s*(?:${labels.map(escapeRegExp).join("|")})\\s*$`, "i");
}

function exactAttributeSelector(selector, attribute, ...keys) {
  return uiLabels
    .terms(...keys)
    .map(
      (value) =>
        `${selector}[${attribute}="${value.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}" i]`
    )
    .join(", ");
}

function getCreateButtonLocators(page) {
  return [
    page.locator(
      exactAttributeSelector(
        "ytcp-button.ytcpAppHeaderCreateIcon button",
        "aria-label",
        "youtubeCreate"
      )
    ),
  ];
}

async function hasVisibleEnabledLocator(locator) {
  const total = await locator.count();
  for (let index = 0; index < total; index += 1) {
    const candidate = locator.nth(index);
    const visible = await candidate.isVisible().catch(() => false);
    const disabled = await candidate.isDisabled().catch(() => false);
    if (visible && !disabled) {
      return true;
    }
  }
  return false;
}

function sanitizeDiagnosticUrl(rawUrl) {
  try {
    const parsed = new URL(rawUrl);
    if (parsed.protocol === "http:" || parsed.protocol === "https:") {
      return `${parsed.origin}${parsed.pathname}`;
    }
    if (parsed.protocol === "about:") {
      return `about:${parsed.pathname}`;
    }
    return `${parsed.protocol}[redacted]`;
  } catch {
    return "[unavailable]";
  }
}

async function getHydrationDiagnostics(page) {
  const url = sanitizeDiagnosticUrl(page.url());
  const dom = await page
    .evaluate(() => ({
      readyState: document.readyState,
      bodyTextLength: document.body?.innerText?.length || 0,
      bodyChildCount: document.body?.children?.length || 0,
      elementCount: document.querySelectorAll("*").length,
    }))
    .catch(() => ({
      readyState: "unavailable",
      bodyTextLength: 0,
      bodyChildCount: 0,
      elementCount: 0,
    }));
  return { url, ...dom };
}

async function waitForStudioHydration(
  page,
  { timeoutMs = 15000, pollIntervalMs = 200 } = {}
) {
  const safeTimeoutMs = Math.max(0, Number(timeoutMs) || 0);
  const safePollIntervalMs = Math.max(10, Number(pollIntervalMs) || 0);
  const startedAt = Date.now();
  const createButtons = getCreateButtonLocators(page);

  while (true) {
    if (await getActiveUploadSurface(page)) {
      return { kind: "upload-surface", elapsedMs: Date.now() - startedAt };
    }

    for (const locator of createButtons) {
      if (await hasVisibleEnabledLocator(locator)) {
        return { kind: "create-button", elapsedMs: Date.now() - startedAt };
      }
    }

    const elapsedMs = Date.now() - startedAt;
    if (elapsedMs >= safeTimeoutMs) {
      const diagnostics = await getHydrationDiagnostics(page);
      throw new Error(
        `YouTube Studio did not expose a ready upload entry within ${safeTimeoutMs}ms ` +
          `(url: ${diagnostics.url}, readyState: ${diagnostics.readyState}, ` +
          `bodyTextLength: ${diagnostics.bodyTextLength}, ` +
          `bodyChildCount: ${diagnostics.bodyChildCount}, ` +
          `elementCount: ${diagnostics.elementCount}).`
      );
    }

    await page.waitForTimeout(
      Math.min(safePollIntervalMs, safeTimeoutMs - elapsedMs)
    );
  }
}

async function isRecognizedFallbackUploadSurface(surface) {
  const hasTitle =
    (await surface
      .locator(
        `#title-textarea, ${uiLabels.attrSelector(
          "textarea",
          "aria-label",
          "youtubeTitleAttribute"
        )}`
      )
      .count()) > 0;
  const hasDescription =
    (await surface
      .locator(
        `#description-textarea, ${uiLabels.attrSelector(
          "textarea",
          "aria-label",
          "youtubeDescriptionAttribute"
        )}`
      )
      .count()) > 0;
  if (hasTitle && hasDescription) return true;

  const hasAudienceOption =
    (await surface
      .locator('[name="VIDEO_MADE_FOR_KIDS_NOT_MFK"]')
      .count()) > 0;
  const hasNextButton =
    (await surface
      .getByRole("button", { name: exactUiTextPattern("youtubeNext") })
      .count()) > 0;
  if (hasAudienceOption && hasNextButton) return true;

  const hasPublicOption =
    (await surface.locator('[name="PUBLIC"]').count()) > 0;
  const hasPublishButton =
    (await surface
      .getByRole("button", {
        name: exactUiTextPattern("youtubePublish"),
      })
      .count()) > 0;
  if (hasPublicOption && hasPublishButton) return true;

  const hasUploadInput = Boolean(await getUploadFileInput(surface));
  const hasUploadTrigger =
    (await surface
      .getByRole("button", {
        name: exactUiTextPattern("youtubeUploadVideo", "youtubeSelectFiles"),
      })
      .count()) > 0;
  return hasUploadInput && hasUploadTrigger;
}

async function hasVisibleUploadsDialogChild(surface) {
  const dialogs = surface.locator("tp-yt-paper-dialog#dialog");
  const total = await dialogs.count();
  for (let index = 0; index < total; index += 1) {
    if (await dialogs.nth(index).isVisible().catch(() => false)) {
      return true;
    }
  }
  return false;
}

async function getActiveUploadSurface(page) {
  const uploadDialogs = page.locator("ytcp-uploads-dialog");
  const uploadDialogTotal = await uploadDialogs.count();
  for (let index = uploadDialogTotal - 1; index >= 0; index -= 1) {
    const surface = uploadDialogs.nth(index);
    const hostVisible = await surface.isVisible().catch(() => false);
    if (hostVisible || (await hasVisibleUploadsDialogChild(surface))) {
      return surface;
    }
  }

  const surfaces = page.locator('ytcp-dialog, [role="dialog"]');
  const total = await surfaces.count();
  for (let index = total - 1; index >= 0; index -= 1) {
    const surface = surfaces.nth(index);
    if (!(await surface.isVisible().catch(() => false))) continue;
    if (await isRecognizedFallbackUploadSurface(surface)) {
      return surface;
    }
  }

  const uploadProgress = page.locator("ytcp-video-upload-progress");
  const uploadProgressTotal = await uploadProgress.count();
  for (let index = uploadProgressTotal - 1; index >= 0; index -= 1) {
    const surface = uploadProgress.nth(index);
    if (await surface.isVisible().catch(() => false)) {
      return surface;
    }
  }

  return null;
}

async function requireActiveUploadSurface(page) {
  const surface = await getActiveUploadSurface(page);
  if (!surface) {
    throw new Error("Could not find the active YouTube upload dialog.");
  }
  return surface;
}

async function getUploadFileInput(surface) {
  const inputs = surface.locator('input[type="file"]');
  const total = await inputs.count();
  let fallback = null;

  for (let index = 0; index < total; index += 1) {
    const candidate = inputs.nth(index);
    const accept = (
      (await candidate.getAttribute("accept").catch(() => "")) || ""
    ).toLowerCase();
    if (accept.includes("image") && !accept.includes("video")) continue;
    if (
      accept.includes("video") ||
      /\.(?:mp4|mov|mkv|webm|avi|mpeg|mpg)\b/i.test(accept)
    ) {
      return candidate;
    }
    fallback ||= candidate;
  }

  return fallback;
}

async function openUploadDialog(
  page,
  { hydrationTimeoutMs = 15000, hydrationPollIntervalMs = 200 } = {}
) {
  async function recoverFromInvalidUploadPage() {
    const bodyText = (await page.locator("body").innerText().catch(() => "")) || "";
    const onBrokenUploadPage =
      /studio\.youtube\.com\/videos\/upload/.test(page.url()) &&
      uiLabels.pattern("error", "youtubeError").test(bodyText);
    if (!onBrokenUploadPage) return;

    await page.goto("https://studio.youtube.com", { waitUntil: "domcontentloaded" });
    await page.waitForTimeout(1200);
  }

  await recoverFromInvalidUploadPage();

  const hasUploadSurface = async () => Boolean(await getActiveUploadSurface(page));
  const hydration = await waitForStudioHydration(page, {
    timeoutMs: hydrationTimeoutMs,
    pollIntervalMs: hydrationPollIntervalMs,
  });
  if (hydration.kind === "upload-surface") return true;

  const createButtons = getCreateButtonLocators(page);

  const uploadTargets = [
    page.locator('a[href*="/channel/"][href*="/videos/upload"]'),
    page.getByRole("menuitem", { name: uiLabels.pattern("youtubeUploadVideo") }),
    page.getByRole("button", { name: uiLabels.pattern("youtubeUploadVideo") }),
    page.locator(uiLabels.attrSelector("ytcp-icon-button", "aria-label", "youtubeUploadVideo")),
    page.locator(uiLabels.attrSelector("ytcp-button button", "aria-label", "youtubeUploadVideo")),
    page.locator('a[href*="/videos/upload"]'),
    page.locator('[role="menuitem"], a, button').filter({
      hasText: uiLabels.pattern("youtubeUploadVideo"),
    }),
  ];

  for (const btn of createButtons) {
    const clicked = await clickFirstVisibleEnabledLocator(page, btn, {
      allowForceFallback: false,
    });
    if (!clicked) continue;
    await page.waitForTimeout(700);
    for (const target of uploadTargets) {
      const picked = await clickFirstVisibleEnabledLocator(page, target, {
        allowForceFallback: false,
      });
      if (!picked) continue;
      await page.waitForTimeout(1200);
      if (await hasUploadSurface()) {
        return true;
      }
    }
  }

  // Fallback: use explicit channel upload link if available.
  const directUploadLink = page.locator('a[href*="/channel/"][href*="/videos/upload"]').first();
  if ((await directUploadLink.count()) > 0) {
    await clickFirstVisibleEnabledLocator(page, directUploadLink, {
      allowForceFallback: false,
    });
    await page.waitForTimeout(1200);
    if (await hasUploadSurface()) {
      return true;
    }
  }

  return await hasUploadSurface();
}

async function setVideoFile(page, videoPath, options = {}) {
  const opened = await openUploadDialog(page, options);
  if (!opened) {
    throw new Error("Could not open the active YouTube upload dialog.");
  }

  let surface = await requireActiveUploadSurface(page);
  let fileInput = await getUploadFileInput(surface);
  if (fileInput) {
    await fileInput.setInputFiles(videoPath);
    return;
  }

  const tryViaFileChooser = async () => {
    const activeSurface = await requireActiveUploadSurface(page);
    const exactUploadPattern = exactUiTextPattern(
      "youtubeUploadVideo",
      "youtubeSelectFiles"
    );
    const triggers = [
      activeSurface.getByRole("button", {
        name: exactUploadPattern,
      }),
      activeSurface.locator(
        uiLabels.attrSelector("button", "aria-label", "youtubeUploadVideo")
      ),
      activeSurface.locator(
        uiLabels.attrSelector("button", "aria-label", "youtubeSelectFiles")
      ),
      activeSurface.locator(
        "ytcp-upload-video-button button, ytcp-button#upload-button button"
      ),
      activeSurface.locator(
        uiLabels.attrSelector(
          "ytcp-icon-button",
          "aria-label",
          "youtubeUploadVideo"
        )
      ),
      activeSurface.locator(
        'a[test-id="upload-icon-url"], a[href*="/videos/upload"]'
      ),
      activeSurface.locator("button, [role='button']").filter({
        hasText: exactUploadPattern,
      }),
    ];

    for (const trigger of triggers) {
      const chooserPromise = page
        .waitForEvent("filechooser", { timeout: 2500 })
        .catch(() => null);
      const clicked = await clickFirstVisibleEnabledLocator(page, trigger, {
        allowForceFallback: false,
      });
      if (!clicked) continue;
      const chooser = await chooserPromise;
      if (chooser) {
        await chooser.setFiles(videoPath);
        return true;
      }
    }
    return false;
  };

  if (await tryViaFileChooser()) {
    return;
  }

  await page.waitForTimeout(1200);
  if (await tryViaFileChooser()) {
    return;
  }

  surface = await requireActiveUploadSurface(page);
  fileInput = await getUploadFileInput(surface);
  if (fileInput) {
    await fileInput.setInputFiles(videoPath);
    return;
  }

  const uploadUrl = page.url();
  throw new Error(
    `Could not find a video file input inside the active YouTube upload dialog. Current URL: ${uploadUrl}`
  );
}

async function setTitleAndDescription(page, caption, fileNameStem) {
  const surface = await requireActiveUploadSurface(page);
  const effectiveCaption = caption && caption.trim() ? caption.trim() : "";
  const baseTitle = effectiveCaption || fileNameStem;
  const shortTitle = baseTitle.slice(0, 95);
  const descriptionText = effectiveCaption || config.defaultCaption || "";

  async function fillContentEditable(locator, value) {
    if ((await locator.count()) === 0) return false;
    try {
      await locator.first().click({ timeout: 5000 });
      await page.keyboard.press("Control+A");
      await page.keyboard.press("Delete");
      if (value) {
        await page.keyboard.type(value, { delay: 8 });
      }

      // Force model sync in Polymer inputs.
      await locator.first().evaluate((el, nextValue) => {
        const node = el;
        node.textContent = nextValue;
        node.dispatchEvent(new InputEvent("input", { bubbles: true, composed: true }));
        node.dispatchEvent(new Event("change", { bubbles: true, composed: true }));
      }, value);
      return true;
    } catch {
      return false;
    }
  }

  const titleCandidates = [
    surface.locator('#title-textarea #textbox[contenteditable="true"]').first(),
    surface.locator('#title-textarea [role="textbox"][contenteditable="true"]').first(),
    surface.locator(uiLabels.attrSelector("textarea", "aria-label", "youtubeTitleAttribute")).first(),
    surface.locator('#title-textarea textarea').first(),
  ];

  let titleSet = false;
  for (const titleInput of titleCandidates) {
    titleSet = await fillContentEditable(titleInput, shortTitle);
    if (titleSet) break;
  }

  const descCandidates = [
    surface.locator('#description-textarea #textbox[contenteditable="true"]').first(),
    surface.locator('#description-textarea [role="textbox"][contenteditable="true"]').first(),
    surface.locator(uiLabels.attrSelector("textarea", "aria-label", "youtubeDescriptionAttribute")).first(),
    surface.locator('#description-textarea textarea').first(),
  ];
  let descSet = false;
  for (const descInput of descCandidates) {
    descSet = await fillContentEditable(descInput, descriptionText);
    if (descSet) break;
  }

  if (!titleSet) {
    throw new Error("Could not set YouTube title field in upload wizard.");
  }
  if (!descSet) {
    throw new Error("Could not set YouTube description field in upload wizard.");
  }
}

async function markNotMadeForKids(page) {
  const surface = await requireActiveUploadSurface(page);
  const selectors = [
    surface.locator('tp-yt-paper-radio-button[name="VIDEO_MADE_FOR_KIDS_NOT_MFK"]'),
    surface.locator('[name="VIDEO_MADE_FOR_KIDS_NOT_MFK"]'),
    surface.getByRole("radio", { name: uiLabels.pattern("youtubeNotMadeForKids") }),
    surface.locator('[name="VIDEO_MADE_FOR_KIDS_NOT_MFK"], tp-yt-paper-radio-button').filter({
      hasText: uiLabels.pattern("youtubeNotMadeForKids"),
    }),
  ];
  for (const selector of selectors) {
    const clicked = await clickFirstVisibleEnabledLocator(page, selector, {
      allowForceFallback: false,
    });
    if (!clicked) continue;
    const chosen = surface.locator(
      'tp-yt-paper-radio-button[name="VIDEO_MADE_FOR_KIDS_NOT_MFK"], [name="VIDEO_MADE_FOR_KIDS_NOT_MFK"]'
    );
    const checked = await chosen
      .first()
      .getAttribute("aria-checked")
      .catch(() => null);
    if (checked === "true") {
      return;
    }
  }

  throw new Error('Could not select "not made for kids" option.');
}

async function setNotAgeRestricted(page) {
  const surface = await requireActiveUploadSurface(page);
  const desired = surface.locator(
    'tp-yt-paper-radio-button[name="VIDEO_AGE_RESTRICTION_NONE"]'
  );
  const isSelected = async () =>
    (await desired.first().getAttribute("aria-checked").catch(() => null)) === "true";

  if (await isSelected()) {
    return;
  }

  const expandButton = surface
    .locator('button[aria-controls="age-restriction"]')
    .first();
  if ((await desired.count()) === 0 || !(await desired.first().isVisible().catch(() => false))) {
    const canExpand = (await expandButton.count()) > 0;
    if (canExpand) {
      await clickFirstVisibleEnabledLocator(page, expandButton, {
        allowForceFallback: false,
      });
      await page.waitForTimeout(500);
    }
  }

  const clicked = await clickFirstVisibleEnabledLocator(
    page,
    surface.locator(
      'tp-yt-paper-radio-button[name="VIDEO_AGE_RESTRICTION_NONE"], [name="VIDEO_AGE_RESTRICTION_NONE"]'
    ),
    { allowForceFallback: false }
  );
  if (!clicked || !(await isSelected())) {
    throw new Error('Could not select "not age restricted" option.');
  }
}

async function hasVisibleLocator(locator) {
  const total = await locator.count();
  for (let index = 0; index < total; index += 1) {
    if (await locator.nth(index).isVisible().catch(() => false)) {
      return true;
    }
  }
  return false;
}

async function isVisibilityStepReady(surface) {
  return (
    (await hasVisibleLocator(
      surface.locator("ytcp-button#done-button button")
    )) ||
    (await hasVisibleLocator(
      surface.locator(
        'tp-yt-paper-radio-button[name="PUBLIC"], [name="PUBLIC"]'
      )
    ))
  );
}

const YOUTUBE_WIZARD_STAGE_ORDER = new Map([
  ["details", 0],
  ["elements", 1],
  ["checks", 2],
  ["visibility", 3],
]);
const YOUTUBE_WIZARD_STAGE_BY_TEST_ID = new Map([
  ["DETAILS", "details"],
  ["VIDEO_ELEMENTS", "elements"],
  ["CHECKS", "checks"],
  ["VISIBILITY", "visibility"],
]);
const YOUTUBE_WIZARD_STAGE_BY_INDEX = new Map([
  ["0", "details"],
  ["1", "elements"],
  ["2", "checks"],
  ["3", "visibility"],
]);

function classifyYouTubeWizardStageText(rawText) {
  const text = String(rawText || "")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase();

  if (text === "details" || text === "detalhes") {
    return "details";
  }
  if (
    text === "video elements" ||
    text === "videoelemente" ||
    text === "elementos do video"
  ) {
    return "elements";
  }
  if (
    text === "checks" ||
    text === "prufungen" ||
    text === "uberprufungen" ||
    text === "verificacoes"
  ) {
    return "checks";
  }
  if (
    text === "visibility" ||
    text === "sichtbarkeit" ||
    text === "visibilidade"
  ) {
    return "visibility";
  }
  return null;
}

async function readYouTubeWizardStageState(surface) {
  const stepper = surface.locator("#ytcp-uploads-dialog-stepper");
  if ((await stepper.count()) > 0) {
    const activeTabs = stepper.locator(
      'button[role="tab"][active][aria-selected="true"][test-id][step-index]'
    );
    const visibleTabs = [];
    const total = await activeTabs.count();
    for (let index = 0; index < total; index += 1) {
      const candidate = activeTabs.nth(index);
      if (await candidate.isVisible().catch(() => false)) {
        visibleTabs.push(candidate);
      }
    }

    if (visibleTabs.length !== 1) {
      return { stage: null, ready: false, source: "stepper" };
    }

    const activeTab = visibleTabs[0];
    const testId = String(
      (await activeTab.getAttribute("test-id").catch(() => "")) || ""
    )
      .trim()
      .toUpperCase();
    const stepIndex = String(
      (await activeTab.getAttribute("step-index").catch(() => "")) || ""
    ).trim();
    const stageFromTestId =
      YOUTUBE_WIZARD_STAGE_BY_TEST_ID.get(testId) || null;
    const stageFromIndex =
      YOUTUBE_WIZARD_STAGE_BY_INDEX.get(stepIndex) || null;
    const stageFromText = classifyYouTubeWizardStageText(
      await activeTab.innerText().catch(() => "")
    );
    const attributesAgree =
      stageFromTestId &&
      stageFromIndex &&
      stageFromTestId === stageFromIndex;
    const textAgrees =
      !stageFromText || stageFromText === stageFromTestId;

    if (!attributesAgree || !textAgrees) {
      return { stage: null, ready: false, source: "stepper" };
    }
    return {
      stage: stageFromTestId,
      ready: true,
      source: "stepper",
    };
  }

  const candidates = surface.locator(
    [
      '[aria-current="step"]',
      '[aria-current="true"]',
      '[aria-selected="true"]',
      "h1",
      "h2",
      "h3",
      '[role="heading"]',
    ].join(", ")
  );
  const stages = new Set();
  const total = await candidates.count();

  for (let index = 0; index < total; index += 1) {
    const candidate = candidates.nth(index);
    if (!(await candidate.isVisible().catch(() => false))) continue;

    const stage = classifyYouTubeWizardStageText(
      await candidate.innerText().catch(() => "")
    );
    if (stage) {
      stages.add(stage);
    }
  }

  return {
    stage: stages.size === 1 ? [...stages][0] : null,
    ready: true,
    source: "fallback",
  };
}

function didYouTubeWizardStageAdvance(previousStage, currentStage) {
  const previousOrder = YOUTUBE_WIZARD_STAGE_ORDER.get(previousStage);
  const currentOrder = YOUTUBE_WIZARD_STAGE_ORDER.get(currentStage);
  return (
    Number.isInteger(previousOrder) &&
    Number.isInteger(currentOrder) &&
    currentOrder > previousOrder
  );
}

async function removeExactGoogleSurveyOverlay(page) {
  const selector = 'iframe#google-hats-survey[title="Google Survey"]';
  const candidates = page.locator(selector);
  const visibleHandles = [];
  const total = await candidates.count();

  try {
    for (let index = 0; index < total; index += 1) {
      const candidate = candidates.nth(index);
      if (!(await candidate.isVisible().catch(() => false))) continue;

      const handle = await candidate.elementHandle().catch(() => null);
      if (handle) {
        visibleHandles.push(handle);
      }
    }

    if (visibleHandles.length > 1) {
      throw new Error(
        "Could not safely dismiss the YouTube Google Survey: multiple visible survey iframes."
      );
    }
    if (visibleHandles.length === 0) {
      return false;
    }

    const removed = await visibleHandles[0]
      .evaluate((element) => {
        if (
          element.id !== "google-hats-survey" ||
          element.getAttribute("title") !== "Google Survey"
        ) {
          return false;
        }
        element.remove();
        return !element.isConnected;
      })
      .catch(() => false);

    if (!removed) {
      throw new Error(
        "Could not safely dismiss the YouTube Google Survey before advancing."
      );
    }
    return true;
  } finally {
    await Promise.all(
      visibleHandles.map((handle) => handle.dispose().catch(() => {}))
    );
  }
}

async function getUniqueActiveNextTarget(surface, handleTimeoutMs) {
  const exactNextPattern = exactUiTextPattern("youtubeNext");
  const locators = [
    surface.getByRole("button", { name: exactNextPattern }),
    surface.locator("ytcp-button#next-button button"),
    surface.locator(
      uiLabels.attrSelector("button", "aria-label", "youtubeNext")
    ),
  ];
  const activeTargets = [];

  try {
    for (const locator of locators) {
      const total = await locator.count();
      for (let index = 0; index < total; index += 1) {
        const candidate = locator.nth(index);
        const visible = await candidate.isVisible().catch(() => false);
        const disabled = await candidate.isDisabled().catch(() => true);
        if (!visible || disabled) continue;

        const handle = await candidate
          .elementHandle({ timeout: handleTimeoutMs })
          .catch(() => null);
        if (!handle) continue;

        let addCandidate = true;
        for (
          let targetIndex = activeTargets.length - 1;
          targetIndex >= 0;
          targetIndex -= 1
        ) {
          const existing = activeTargets[targetIndex];
          const sameElement = await handle
            .evaluate((element, other) => element === other, existing.handle)
            .catch(() => false);
          if (sameElement) {
            addCandidate = false;
            break;
          }

          const currentContainsExisting = await handle
            .evaluate(
              (element, other) => element.contains(other),
              existing.handle
            )
            .catch(() => false);
          if (currentContainsExisting) {
            addCandidate = false;
            break;
          }

          const existingContainsCurrent = await existing.handle
            .evaluate((element, other) => element.contains(other), handle)
            .catch(() => false);
          if (existingContainsCurrent) {
            await existing.handle.dispose().catch(() => {});
            activeTargets.splice(targetIndex, 1);
          }
        }

        if (addCandidate) {
          activeTargets.push({ handle });
        } else {
          await handle.dispose().catch(() => {});
        }
      }
    }

    if (activeTargets.length > 1) {
      throw new Error(
        "Could not safely advance the YouTube wizard: multiple active Next buttons."
      );
    }

    return activeTargets[0] || null;
  } catch (error) {
    await Promise.all(
      activeTargets.map(({ handle }) => handle.dispose().catch(() => {}))
    );
    throw error;
  }
}

async function getUniqueActivePublishTarget(surface, handleTimeoutMs) {
  const exactPublishPattern = exactUiTextPattern("youtubePublish");
  const locators = [
    surface.getByRole("button", { name: exactPublishPattern }),
    surface
      .locator("ytcp-button#done-button button")
      .filter({ hasText: exactPublishPattern }),
    surface.locator("button").filter({ hasText: exactPublishPattern }),
  ];
  const activeTargets = [];

  try {
    for (const locator of locators) {
      const total = await locator.count();
      for (let index = 0; index < total; index += 1) {
        const candidate = locator.nth(index);
        const visible = await candidate.isVisible().catch(() => false);
        const disabled = await candidate.isDisabled().catch(() => true);
        if (!visible || disabled) continue;

        const handle = await candidate
          .elementHandle({ timeout: handleTimeoutMs })
          .catch(() => null);
        if (!handle) continue;

        let addCandidate = true;
        for (
          let targetIndex = activeTargets.length - 1;
          targetIndex >= 0;
          targetIndex -= 1
        ) {
          const existing = activeTargets[targetIndex];
          const sameElement = await handle
            .evaluate((element, other) => element === other, existing.handle)
            .catch(() => false);
          if (sameElement) {
            addCandidate = false;
            break;
          }

          const currentContainsExisting = await handle
            .evaluate(
              (element, other) => element.contains(other),
              existing.handle
            )
            .catch(() => false);
          if (currentContainsExisting) {
            addCandidate = false;
            break;
          }

          const existingContainsCurrent = await existing.handle
            .evaluate((element, other) => element.contains(other), handle)
            .catch(() => false);
          if (existingContainsCurrent) {
            await existing.handle.dispose().catch(() => {});
            activeTargets.splice(targetIndex, 1);
          }
        }

        if (addCandidate) {
          activeTargets.push({ handle });
        } else {
          await handle.dispose().catch(() => {});
        }
      }
    }

    if (activeTargets.length > 1) {
      throw new Error(
        "Could not safely publish the YouTube video: multiple active Publish buttons."
      );
    }

    return activeTargets[0] || null;
  } catch (error) {
    await Promise.all(
      activeTargets.map(({ handle }) => handle.dispose().catch(() => {}))
    );
    throw error;
  }
}

async function clickNext(
  page,
  {
    maxAdvanceClicks = 4,
    transitionTimeoutMs = 30000,
    pollIntervalMs = 100,
  } = {}
) {
  const parsedMaxAdvanceClicks = Number(maxAdvanceClicks);
  const parsedTransitionTimeoutMs = Number(transitionTimeoutMs);
  const parsedPollIntervalMs = Number(pollIntervalMs);
  if (
    !Number.isFinite(parsedMaxAdvanceClicks) ||
    parsedMaxAdvanceClicks < 1
  ) {
    throw new Error("YouTube Next maxAdvanceClicks must be a positive number.");
  }
  if (
    !Number.isFinite(parsedTransitionTimeoutMs) ||
    parsedTransitionTimeoutMs <= 0
  ) {
    throw new Error(
      "YouTube Next transitionTimeoutMs must be a finite positive number."
    );
  }
  if (!Number.isFinite(parsedPollIntervalMs) || parsedPollIntervalMs <= 0) {
    throw new Error(
      "YouTube Next pollIntervalMs must be a finite positive number."
    );
  }

  const safeMaxAdvanceClicks = Math.min(
    6,
    Math.floor(parsedMaxAdvanceClicks)
  );
  const safeTransitionTimeoutMs = Math.min(
    60000,
    Math.floor(parsedTransitionTimeoutMs)
  );
  const safePollIntervalMs = Math.min(
    1000,
    Math.max(10, Math.floor(parsedPollIntervalMs))
  );
  let previousHandle = null;
  let previousWizardStage = null;
  let advanceClicks = 0;

  try {
    while (true) {
      const startedAt = Date.now();
      let sawDisarmedTransition = previousHandle === null;
      const throwTransitionTimeout = () => {
        const reason =
          advanceClicks === 0
            ? "no active Next button"
            : "no new active Next button or visibility step";
        throw new Error(
          "Could not reach the YouTube visibility step: " +
            `${reason} within ${safeTransitionTimeoutMs}ms ` +
            `after ${advanceClicks} controlled click(s).`
        );
      };

      while (true) {
        if (Date.now() - startedAt >= safeTransitionTimeoutMs) {
          throwTransitionTimeout();
        }

        const surface = await getActiveUploadSurface(page).catch(() => null);
        const removedSurvey = surface
          ? await removeExactGoogleSurveyOverlay(page)
          : false;
        if (removedSurvey) {
          continue;
        }
        if (
          surface &&
          (await isVisibilityStepReady(surface).catch(() => false))
        ) {
          return true;
        }
        const wizardStageState = surface
          ? await readYouTubeWizardStageState(surface).catch(() => ({
              stage: null,
              ready: false,
              source: "error",
            }))
          : { stage: null, ready: false, source: "missing-surface" };
        const wizardStage = wizardStageState.stage;

        const remainingMs = Math.max(
          1,
          safeTransitionTimeoutMs - (Date.now() - startedAt)
        );
        const target =
          surface &&
          wizardStageState.ready &&
          wizardStage !== "visibility"
          ? await getUniqueActiveNextTarget(
              surface,
              Math.min(1000, remainingMs)
            )
          : null;
        if (!target) {
          if (previousHandle && wizardStage !== "visibility") {
            sawDisarmedTransition = true;
          }
        } else {
          const sameAsPrevious = previousHandle
            ? await target.handle
                .evaluate((element, previous) => element === previous, previousHandle)
                .catch(() => false)
            : false;
          const wizardStageAdvanced = didYouTubeWizardStageAdvance(
            previousWizardStage,
            wizardStage
          );
          const transitioned =
            previousHandle === null ||
            !sameAsPrevious ||
            sawDisarmedTransition ||
            wizardStageAdvanced;

          if (transitioned) {
            if (Date.now() - startedAt >= safeTransitionTimeoutMs) {
              await target.handle.dispose().catch(() => {});
              throwTransitionTimeout();
            }
            if (advanceClicks >= safeMaxAdvanceClicks) {
              await target.handle.dispose().catch(() => {});
              throw new Error(
                "Could not reach the YouTube visibility step within " +
                  `${safeMaxAdvanceClicks} controlled Next clicks.`
              );
            }

            if (previousHandle) {
              await previousHandle.dispose().catch(() => {});
            }
            previousHandle = target.handle;
            previousWizardStage = wizardStage;
            const clickNumber = advanceClicks + 1;
            const clickRemainingMs =
              safeTransitionTimeoutMs - (Date.now() - startedAt);
            if (clickRemainingMs <= 0) {
              throwTransitionTimeout();
            }
            try {
              await target.handle.click({
                timeout: Math.min(5000, clickRemainingMs),
              });
            } catch (error) {
              throw new Error(
                `YouTube Next click ${clickNumber} had an ambiguous outcome; ` +
                  `no retry was attempted. ${error.message}`
              );
            }
            advanceClicks = clickNumber;
            break;
          }

          await target.handle.dispose().catch(() => {});
        }

        const elapsedMs = Date.now() - startedAt;
        if (elapsedMs >= safeTransitionTimeoutMs) {
          throwTransitionTimeout();
        }

        await page.waitForTimeout(
          Math.min(
            safePollIntervalMs,
            safeTransitionTimeoutMs - elapsedMs
          )
        );
      }
    }
  } finally {
    if (previousHandle) {
      await previousHandle.dispose().catch(() => {});
    }
  }
}

async function setVisibilityAndPublish(page) {
  const surface = await requireActiveUploadSurface(page);
  const exactPublicPattern = exactUiTextPattern("youtubePublic");
  const visibilityOptions = [
    surface.locator('tp-yt-paper-radio-button[name="PUBLIC"], [name="PUBLIC"]'),
    surface.getByRole("radio", { name: exactPublicPattern }),
    surface
      .locator("tp-yt-paper-radio-button")
      .filter({ hasText: exactPublicPattern }),
  ];
  let publicSelected = false;
  for (const option of visibilityOptions) {
    const total = await option.count();
    for (let index = 0; index < total; index += 1) {
      const candidate = option.nth(index);
      const visible = await candidate.isVisible().catch(() => false);
      const disabled = await candidate.isDisabled().catch(() => false);
      if (!visible || disabled) continue;
      try {
        await candidate.scrollIntoViewIfNeeded({ timeout: 3000 });
        await candidate.click({ timeout: 5000 });
      } catch {
        continue;
      }
      await page.waitForTimeout(250);
      const ariaChecked = await candidate
        .getAttribute("aria-checked")
        .catch(() => null);
      const nativeChecked = await candidate.isChecked().catch(() => false);
      if (ariaChecked === "true" || nativeChecked) {
        publicSelected = true;
        break;
      }
      return { ok: false, baselineTexts: [] };
    }
    if (publicSelected) break;
  }
  if (!publicSelected) {
    return { ok: false, baselineTexts: [] };
  }

  const baselineTexts = await readYouTubePublishStatusTexts(page);
  const publishTarget = await getUniqueActivePublishTarget(surface, 1000);
  if (!publishTarget) {
    return { ok: false, baselineTexts };
  }

  try {
    await publishTarget.handle.scrollIntoViewIfNeeded({ timeout: 3000 });
    try {
      await publishTarget.handle.click({ timeout: 5000 });
    } catch (error) {
      throw new Error(
        "YouTube Publish click had an ambiguous outcome; " +
          `no retry was attempted. ${error.message}`
      );
    }
    return { ok: true, baselineTexts };
  } finally {
    await publishTarget.handle.dispose().catch(() => {});
  }
}

function classifyYouTubePublishText(text) {
  if (uiLabels.pattern("error", "youtubeError").test(text)) {
    return {
      state: "error",
      reason: "YouTube reported an error while publishing.",
    };
  }
  if (uiLabels.pattern("youtubeHistoricalPublish").test(text)) {
    return { state: "pending" };
  }
  if (uiLabels.pattern("youtubePublished").test(text)) {
    return { state: "success" };
  }
  return { state: "pending" };
}

function normalizePublishStatusText(text) {
  return String(text || "").replace(/\s+/g, " ").trim();
}

function getMatchedYouTubePublishedText(text) {
  if (classifyYouTubePublishText(text).state !== "success") {
    return null;
  }

  const normalizedText = normalizePublishStatusText(text);
  const terms = uiLabels
    .terms("youtubePublished")
    .map((term) => normalizePublishStatusText(term))
    .filter(Boolean)
    .sort((left, right) => right.length - left.length);
  for (const term of terms) {
    const match = normalizedText.match(new RegExp(escapeRegExp(term), "i"));
    if (match) {
      return match[0];
    }
  }
  return null;
}

function parseYouTubeVideoReference(rawValue) {
  const value = String(rawValue || "").trim();
  if (!value) return null;

  const candidates = [];
  if (/^\/(?:shorts\/|watch(?:\?|$))/i.test(value)) {
    candidates.push(value);
  }
  for (const match of value.matchAll(/https?:\/\/[^\s<>"']+/gi)) {
    candidates.push(match[0].replace(/[),.;]+$/, ""));
  }
  if (/^https?:\/\//i.test(value)) {
    candidates.unshift(value);
  }

  for (const candidate of [...new Set(candidates)]) {
    let parsed;
    try {
      parsed = new URL(candidate, "https://www.youtube.com");
    } catch {
      continue;
    }

    const hostname = parsed.hostname.toLowerCase();
    const isYouTubeHost = [
      "youtube.com",
      "www.youtube.com",
      "m.youtube.com",
    ].includes(hostname);
    const isShortHost = hostname === "youtu.be";
    if (!isYouTubeHost && !isShortHost) continue;

    let videoId = null;
    if (isShortHost) {
      videoId = parsed.pathname.split("/").filter(Boolean)[0] || null;
    } else {
      const shortsMatch = /^\/shorts\/([^/?#]+)/i.exec(parsed.pathname);
      if (shortsMatch) {
        videoId = shortsMatch[1];
      } else if (parsed.pathname === "/watch") {
        videoId = parsed.searchParams.get("v");
      }
    }

    if (!videoId || !/^[a-zA-Z0-9_-]{6,64}$/.test(videoId)) {
      continue;
    }
    return {
      videoUrl: parsed.toString(),
      videoId,
    };
  }

  return null;
}

async function getYouTubeVideoReferenceFromContext(context) {
  const links = context.locator("a[href]");
  const total = await links.count();
  for (let index = 0; index < total; index += 1) {
    const link = links.nth(index);
    const values = [
      await link.getAttribute("href").catch(() => ""),
      await link.innerText().catch(() => ""),
    ];
    for (const value of values) {
      const reference = parseYouTubeVideoReference(value);
      if (reference) return reference;
    }
  }

  return parseYouTubeVideoReference(
    await context.innerText().catch(() => "")
  );
}

async function getExplicitDialogPublishMatch(context, text, reference) {
  if (exactUiTextPattern("youtubePublished").test(text)) {
    return getMatchedYouTubePublishedText(text);
  }

  const headings = context.locator('h1, h2, h3, [role="heading"]');
  const total = await headings.count();
  for (let index = 0; index < total; index += 1) {
    const heading = headings.nth(index);
    if (!(await heading.isVisible().catch(() => false))) continue;
    const matchedText = getMatchedYouTubePublishedText(
      await heading.innerText().catch(() => "")
    );
    if (matchedText) return matchedText;
  }

  return reference ? getMatchedYouTubePublishedText(text) : null;
}

async function readPublishEvidenceEntry(candidate, evidenceType) {
  if (!(await candidate.isVisible().catch(() => false))) {
    return null;
  }

  const text = normalizePublishStatusText(
    await candidate.innerText().catch(() => "")
  );
  if (!text) return null;

  const detectedPublishText = getMatchedYouTubePublishedText(text);
  const reference = detectedPublishText
    ? await getYouTubeVideoReferenceFromContext(candidate)
    : null;
  let matchedText = detectedPublishText;
  if (evidenceType === "post-publish-dialog" && detectedPublishText) {
    matchedText = await getExplicitDialogPublishMatch(
      candidate,
      text,
      reference
    );
    if (!matchedText) return null;
  }
  return {
    text,
    evidenceType,
    matchedText,
    videoUrl: reference?.videoUrl || null,
    videoId: reference?.videoId || null,
  };
}

function extractYouTubePublishSignals(text) {
  let workingText = normalizePublishStatusText(text).toLowerCase();
  if (!workingText) return [];

  const maskTerms = (keys) => {
    const terms = uiLabels
      .terms(...keys)
      .map((term) => normalizePublishStatusText(term).toLowerCase())
      .filter(Boolean)
      .sort((left, right) => right.length - left.length);
    for (const term of terms) {
      workingText = workingText.replace(
        new RegExp(escapeRegExp(term), "gi"),
        (match) => " ".repeat(match.length)
      );
    }
  };

  maskTerms(["youtubeHistoricalPublish"]);

  const signals = [];
  const collectSignals = (state, keys) => {
    const terms = uiLabels
      .terms(...keys)
      .map((term) => normalizePublishStatusText(term).toLowerCase())
      .filter(Boolean)
      .sort((left, right) => right.length - left.length);
    for (const term of terms) {
      workingText = workingText.replace(
        new RegExp(escapeRegExp(term), "gi"),
        (match) => {
          signals.push(`${state}:${term}`);
          return " ".repeat(match.length);
        }
      );
    }
  };

  collectSignals("error", ["error", "youtubeError"]);
  collectSignals("success", ["youtubePublished"]);
  return signals;
}

function classifyYouTubePublishStatusChanges(currentTexts, baselineTexts = []) {
  const remainingBaseline = new Map();
  for (const text of baselineTexts) {
    for (const signal of extractYouTubePublishSignals(text)) {
      remainingBaseline.set(
        signal,
        (remainingBaseline.get(signal) || 0) + 1
      );
    }
  }

  let sawSuccess = false;
  for (const text of currentTexts) {
    for (const signal of extractYouTubePublishSignals(text)) {
      const remaining = remainingBaseline.get(signal) || 0;
      if (remaining > 0) {
        remainingBaseline.set(signal, remaining - 1);
        continue;
      }
      if (signal.startsWith("error:")) {
        return {
          state: "error",
          reason: "YouTube reported an error while publishing.",
        };
      }
      if (signal.startsWith("success:")) {
        sawSuccess = true;
      }
    }
  }

  return sawSuccess ? { state: "success" } : { state: "pending" };
}

function selectNewYouTubePublishEvidence(entries, baselineTexts = []) {
  const remainingBaselineTexts = new Map();
  for (const text of baselineTexts) {
    const normalized = normalizePublishStatusText(text);
    remainingBaselineTexts.set(
      normalized,
      (remainingBaselineTexts.get(normalized) || 0) + 1
    );
  }

  const newEntries = [];
  for (const entry of entries) {
    const normalized = normalizePublishStatusText(entry.text);
    const exactRemaining = remainingBaselineTexts.get(normalized) || 0;
    if (exactRemaining > 0) {
      remainingBaselineTexts.set(normalized, exactRemaining - 1);
      continue;
    }
    newEntries.push(entry);
  }

  const remainingBaseline = new Map();
  for (const [text, count] of remainingBaselineTexts) {
    if (count <= 0) continue;
    for (const signal of extractYouTubePublishSignals(text)) {
      remainingBaseline.set(
        signal,
        (remainingBaseline.get(signal) || 0) + count
      );
    }
  }

  for (const entry of newEntries) {
    for (const signal of extractYouTubePublishSignals(entry.text)) {
      const remaining = remainingBaseline.get(signal) || 0;
      if (remaining > 0) {
        remainingBaseline.set(signal, remaining - 1);
        continue;
      }
      if (signal.startsWith("success:")) {
        return entry;
      }
    }
  }
  return null;
}

async function readYouTubePublishEvidence(page) {
  const entries = [];
  const surface = await getActiveUploadSurface(page);
  if (surface && (await surface.isVisible().catch(() => false))) {
    const entry = await readPublishEvidenceEntry(surface, "upload-surface");
    if (entry) entries.push(entry);
  }

  const feedback = page.locator('tp-yt-paper-toast, [role="alert"]');
  const total = await feedback.count();
  for (let index = 0; index < total; index += 1) {
    const candidate = feedback.nth(index);
    const role = await candidate.getAttribute("role").catch(() => null);
    const evidenceType = role === "alert" ? "alert" : "toast";
    const entry = await readPublishEvidenceEntry(candidate, evidenceType);
    if (entry) entries.push(entry);
  }

  const dialogs = page.locator('tp-yt-paper-dialog, [role="dialog"]');
  const dialogTotal = await dialogs.count();
  for (let index = 0; index < dialogTotal; index += 1) {
    const entry = await readPublishEvidenceEntry(
      dialogs.nth(index),
      "post-publish-dialog"
    );
    if (entry) entries.push(entry);
  }

  return entries;
}

async function readYouTubePublishStatusTexts(page) {
  const entries = await readYouTubePublishEvidence(page);
  return entries.map((entry) => entry.text);
}

async function waitForPublishConfirmation(
  page,
  baselineTexts = [],
  { maxPolls = 40, pollIntervalMs = 1500 } = {}
) {
  const safeMaxPolls = Math.max(1, Number(maxPolls) || 1);
  const safePollIntervalMs = Math.max(0, Number(pollIntervalMs) || 0);
  for (let i = 0; i < safeMaxPolls; i += 1) {
    const entries = await readYouTubePublishEvidence(page);
    const currentTexts = entries.map((entry) => entry.text);
    const classification = classifyYouTubePublishStatusChanges(
      currentTexts,
      baselineTexts
    );
    if (classification.state === "success") {
      const evidence = selectNewYouTubePublishEvidence(
        entries,
        baselineTexts
      );
      return {
        ok: true,
        confirmed: true,
        evidenceType: evidence?.evidenceType || "status-text",
        matchedText: evidence?.matchedText || null,
        videoUrl: evidence?.videoUrl || null,
        videoId: evidence?.videoId || null,
      };
    }
    if (classification.state === "error") {
      return { ok: false, reason: classification.reason };
    }
    if (i + 1 < safeMaxPolls) {
      await page.waitForTimeout(safePollIntervalMs);
    }
  }
  return {
    ok: false,
    confirmed: false,
    outcome: "uncertain",
    retryAllowed: false,
    reason:
      "No reliable YouTube publish confirmation within timeout. " +
      "Publish confirmation was not observed; publication may have succeeded; " +
      "no retry was attempted.",
  };
}

async function startLoginSession() {
  const activeAccount = await getActiveAccount();
  if (loginSessionContext && loginSessionAccountId !== activeAccount.id) {
    const previous = loginSessionContext;
    loginSessionContext = null;
    loginSessionAccountId = null;
    await previous.close().catch(() => { });
  }

  if (loginSessionContext) {
    return { ok: true, alreadyOpen: true };
  }
  const context = await openPersistentContext(activeAccount.id);
  const page = context.pages()[0] || (await context.newPage());
  loginSessionContext = context;
  loginSessionAccountId = activeAccount.id;
  context.on("close", () => {
    if (loginSessionContext === context) {
      loginSessionContext = null;
      loginSessionAccountId = null;
    }
  });
  await gotoUploadPage(page);
  return { ok: true, alreadyOpen: false, url: page.url() };
}

async function getLoginSessionStatus() {
  const activeAccount = await getActiveAccount();
  const saved = await hasSavedPlatformSession("youtube", activeAccount.id);
  return {
    open: Boolean(loginSessionContext) && loginSessionAccountId === activeAccount.id,
    saved,
  };
}

async function closeLoginSession() {
  if (!loginSessionContext) {
    return { ok: true, alreadyClosed: true };
  }
  const context = loginSessionContext;
  loginSessionContext = null;
  loginSessionAccountId = null;
  await context.close().catch(() => { });
  return { ok: true, alreadyClosed: false };
}

async function uploadVideo({ videoPath, caption, accountId }) {
  const absoluteVideoPath = path.resolve(videoPath);
  const context = await openPersistentContext(accountId);
  const page = context.pages()[0] || (await context.newPage());
  let closeHoldMs = 0;
  try {
    await gotoUploadPage(page);
    await setVideoFile(page, absoluteVideoPath);
    await page.waitForTimeout(Math.max(config.postDelayMs, 5000));
    await setTitleAndDescription(
      page,
      caption,
      path.parse(absoluteVideoPath).name
    );
    await markNotMadeForKids(page);
    await setNotAgeRestricted(page);
    await clickNext(page);
    const publishAttempt = await setVisibilityAndPublish(page);
    if (!publishAttempt.ok) {
      throw new Error("Could not find/click YouTube publish button.");
    }

    const confirmation = await waitForPublishConfirmation(
      page,
      publishAttempt.baselineTexts
    );
    if (!confirmation.ok) {
      throw new Error(confirmation.reason);
    }

    const successScreenshotPath = path.resolve(
      config.projectRoot,
      "last-youtube-upload-success.png"
    );
    await page.screenshot({ path: successScreenshotPath, fullPage: true }).catch(() => { });
    closeHoldMs = Math.max(config.postPublishHoldMs, 0);
    return {
      ok: true,
      confirmation: {
        confirmed: confirmation.confirmed,
        evidenceType: confirmation.evidenceType,
        matchedText: confirmation.matchedText,
        videoUrl: confirmation.videoUrl,
        videoId: confirmation.videoId,
      },
      videoUrl: confirmation.videoUrl,
      videoId: confirmation.videoId,
    };
  } catch (error) {
    const screenshotPath = path.resolve(
      config.projectRoot,
      "last-youtube-upload-error.png"
    );
    await page.screenshot({ path: screenshotPath, fullPage: true }).catch(() => { });
    closeHoldMs = Math.max(config.failureHoldMs, 0);
    return {
      ok: false,
      error: error.message,
      screenshotPath,
    };
  } finally {
    await page.waitForTimeout(closeHoldMs).catch(() => { });
    await context.close();
  }
}

module.exports = {
  uploadVideo,
  startLoginSession,
  getLoginSessionStatus,
  closeLoginSession,
  _private: {
    classifyYouTubePublishText,
    classifyYouTubePublishStatusChanges,
    clickNext,
    exactUiTextPattern,
    getCreateButtonLocators,
    getActiveUploadSurface,
    getUploadFileInput,
    markNotMadeForKids,
    openUploadDialog,
    parseYouTubeVideoReference,
    readYouTubePublishEvidence,
    readYouTubePublishStatusTexts,
    sanitizeDiagnosticUrl,
    setNotAgeRestricted,
    setTitleAndDescription,
    setVideoFile,
    setVisibilityAndPublish,
    waitForStudioHydration,
    waitForPublishConfirmation,
  },
};

