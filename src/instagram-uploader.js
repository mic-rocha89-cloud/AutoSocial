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

const REALISTIC_USER_AGENT =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36";

let loginSessionContext = null;
let loginSessionAccountId = null;

async function openPersistentContext(accountId) {
  const profileDir = await getPlatformProfileDir("instagram", accountId);
  await fs.mkdir(profileDir, { recursive: true });
  return chromium.launchPersistentContext(profileDir, {
    headless: config.headless,
    viewport: { width: 1400, height: 1000 },
    userAgent: REALISTIC_USER_AGENT,
    locale: config.browserLocale,
    timezoneId: config.timezone,
    args: [
      "--disable-blink-features=AutomationControlled",
      "--disable-infobars",
      "--no-first-run",
      "--no-default-browser-check",
      "--disable-extensions",
    ],
  });
}

/**
 * Navigate with retry logic and exponential backoff.
 * On 429 / network errors, waits and retries up to `maxRetries` times.
 */
async function navigateWithRetry(page, url, { maxRetries = 3, waitUntil = "domcontentloaded" } = {}) {
  const backoffMs = [5000, 15000, 30000];
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      const response = await page.goto(url, { waitUntil, timeout: 60000 });
      if (response && response.status() === 429) {
        throw new Error("HTTP 429 - Instagram rate limit");
      }
      // Random human-like pause after navigation (1.5-3.5 s)
      await page.waitForTimeout(1500 + Math.random() * 2000);
      return response;
    } catch (error) {
      if (attempt >= maxRetries) {
        throw error;
      }
      const delay = backoffMs[attempt] || 30000;
      console.log(
        `Instagram navigation failed (attempt ${attempt + 1}/${maxRetries + 1}): ${error.message}. ` +
        `Retrying in ${delay / 1000}s...`
      );
      await page.waitForTimeout(delay);
    }
  }
}

async function gotoUploadPage(page) {
  await navigateWithRetry(page, config.instagramUploadPageUrl);
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

  // Navigate to the homepage first; less suspicious than going straight to /create/.
  await navigateWithRetry(page, "https://www.instagram.com/");
  return { ok: true, alreadyOpen: false, url: page.url() };
}

async function getLoginSessionStatus() {
  const activeAccount = await getActiveAccount();
  const saved = await hasSavedPlatformSession("instagram", activeAccount.id);
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

const VIDEO_POSTS_ARE_REELS_PATTERN = /video posts are now reels/i;
const DISMISS_INFORMATION_PATTERN =
  /^\s*(?:ok|okay|got it)\s*$/i;

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function exactUiTextPattern(...keys) {
  const labels = uiLabels.terms(...keys);
  return new RegExp(`^\\s*(?:${labels.map(escapeRegExp).join("|")})\\s*$`, "i");
}

function getUploadTriggerLocators(page) {
  const uploadTriggerPattern = uiLabels.pattern("instagramUploadTrigger");
  return [
    page.getByRole("button", { name: uploadTriggerPattern }),
    page.locator('button, [role="button"]').filter({
      hasText: uploadTriggerPattern,
    }),
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

async function isCreateUploadReady(page, input) {
  if ((await input.count()) > 0) {
    return true;
  }

  for (const trigger of getUploadTriggerLocators(page)) {
    if (await hasVisibleEnabledLocator(trigger)) {
      return true;
    }
  }

  return false;
}

async function dismissVideoPostsAreReelsDialog(page) {
  const dialogs = page.locator('[role="dialog"], [aria-modal="true"]');
  const total = await dialogs.count();

  for (let index = total - 1; index >= 0; index -= 1) {
    const dialog = dialogs.nth(index);
    if (!(await dialog.isVisible().catch(() => false))) continue;
    const text = await dialog.innerText().catch(() => "");
    if (!VIDEO_POSTS_ARE_REELS_PATTERN.test(text)) continue;

    const dismissButtons = [
      dialog.getByRole("button", { name: DISMISS_INFORMATION_PATTERN }),
      dialog.locator("button").filter({ hasText: DISMISS_INFORMATION_PATTERN }),
      dialog.locator('[role="button"]').filter({
        hasText: DISMISS_INFORMATION_PATTERN,
      }),
    ];

    for (const button of dismissButtons) {
      const clicked = await clickFirstVisibleEnabledLocator(page, button, {
        allowForceFallback: false,
      });
      if (!clicked) continue;
      await dialog.waitFor({ state: "hidden", timeout: 10000 }).catch(() => {});
      console.log('Instagram "video posts are now reels" notice dismissed.');
      return true;
    }

    throw new Error(
      'Instagram "video posts are now reels" notice is blocking the composer.'
    );
  }

  return false;
}

function getCaptionLocators(root) {
  return [
    root.locator(uiLabels.attrSelector("textarea", "aria-label", "captionAttribute")),
    root.locator(uiLabels.attrSelector("textarea", "placeholder", "captionAttribute")),
    root.locator("textarea"),
    root.locator('div[contenteditable="true"]'),
  ];
}

async function findVisibleCaptionTarget(root) {
  for (const locator of getCaptionLocators(root)) {
    const total = await locator.count();
    for (let index = 0; index < total; index += 1) {
      const candidate = locator.nth(index);
      if (await candidate.isVisible().catch(() => false)) {
        return candidate;
      }
    }
  }
  return null;
}

async function getActiveCreateSurface(page) {
  const dialogs = page.locator('[role="dialog"], [aria-modal="true"]');
  const total = await dialogs.count();
  const exactNextPattern = exactUiTextPattern("next");
  const exactSharePattern = exactUiTextPattern("share");

  for (let index = total - 1; index >= 0; index -= 1) {
    const dialog = dialogs.nth(index);
    if (!(await dialog.isVisible().catch(() => false))) continue;
    const text = await dialog.innerText().catch(() => "");
    if (VIDEO_POSTS_ARE_REELS_PATTERN.test(text)) continue;

    const hasNext =
      (await dialog.getByRole("button", { name: exactNextPattern }).count()) > 0;
    const hasShare =
      (await dialog.getByRole("button", { name: exactSharePattern }).count()) > 0;
    const hasCaption = Boolean(await findVisibleCaptionTarget(dialog));
    if (hasNext || hasShare || hasCaption) {
      return dialog;
    }
  }

  return null;
}

async function ensureCreateFlowInput(page) {
  const input = page.locator('input[type="file"]').first();
  if (await isCreateUploadReady(page, input)) return input;

  const createPattern = uiLabels.pattern("create");
  const postFormatPattern = uiLabels.pattern("instagramPostFormat");
  const exactPostFormatPattern = exactUiTextPattern("instagramPostFormat");
  const createEntryPoints = [
    page.locator('a:has(svg[aria-label="New post" i])'),
    page.getByRole("link", { name: createPattern }),
    page.getByRole("button", { name: createPattern }),
    page.locator('a[href*="/create"]').filter({ hasText: createPattern }),
    page.locator('nav a, nav [role="link"], nav button, nav [role="button"]').filter({
      hasText: createPattern,
    }),
  ];

  for (const entry of createEntryPoints) {
    const clicked = await clickFirstVisibleEnabledLocator(page, entry);
    if (!clicked) continue;
    console.log("Instagram create entry clicked.");
    await page.waitForTimeout(1200);
    if (await isCreateUploadReady(page, input)) return input;
    // One successful click opens the format menu. Trying equivalent Create
    // locators again can toggle that menu closed.
    break;
  }

  // The desktop flow opens a Post/Reels menu. Select Post specifically:
  // "Reels" also exists in the main navigation and is not the upload format.
  const formatPickers = [
    page.getByText(exactPostFormatPattern),
    page.locator('a[role="link"][href="#"]').filter({
      hasText: exactPostFormatPattern,
    }),
    page.getByRole("button", { name: exactPostFormatPattern }),
    page.getByRole("menuitem", { name: exactPostFormatPattern }),
    page.getByRole("option", { name: exactPostFormatPattern }),
    page.getByRole("link", { name: exactPostFormatPattern }),
    page
      .locator(
        [
          '[role="button"]',
          '[role="menuitem"]',
          '[role="option"]',
          '[role="link"]',
          '[tabindex="0"]',
          "button",
          "a",
          "div",
          "span",
        ].join(", ")
      )
      .filter({
        hasText: exactPostFormatPattern,
      }),
    page.locator('[role="menuitem"], [role="option"], button, a').filter({
      hasText: postFormatPattern,
    }),
  ];
  let formatSelected = false;
  for (const picker of formatPickers) {
    const clicked = await clickFirstVisibleEnabledLocator(page, picker);
    if (!clicked) continue;
    formatSelected = true;
    console.log("Instagram post format selected (Post).");
    await page.waitForTimeout(1200);
    if (await isCreateUploadReady(page, input)) return input;
    // Do not click the same Post item again through an equivalent locator.
    break;
  }
  if (formatSelected) return input;

  const createButtons = [
    page.getByRole("button", { name: uiLabels.pattern("create", "instagramPostFormat") }),
    page.locator('[role="button"]').filter({ hasText: uiLabels.pattern("create", "instagramPostFormat") }),
    page.locator("a, [role='link']").filter({ hasText: uiLabels.pattern("create", "instagramPostFormat") }),
  ];

  for (const button of createButtons) {
    const clicked = await clickFirstVisibleEnabledLocator(page, button);
    if (clicked) {
      await page.waitForTimeout(1200);
      if (await isCreateUploadReady(page, input)) return input;
    }
  }

  return input;
}

async function setVideoFile(page, videoPath) {
  let input = await ensureCreateFlowInput(page);
  if ((await input.count()) > 0) {
    await input.waitFor({ state: "attached", timeout: 120000 });
    await input.setInputFiles(videoPath);
    return;
  }

  // Fallback: use file chooser event if no file input is exposed yet.
  const chooserPromise = page.waitForEvent("filechooser", { timeout: 10000 }).catch(() => null);
  const uploadTriggers = getUploadTriggerLocators(page);

  for (const trigger of uploadTriggers) {
    const clicked = await clickFirstVisibleEnabledLocator(page, trigger);
    if (clicked) {
      console.log("Instagram upload trigger clicked.");
      break;
    }
  }

  const chooser = await chooserPromise;
  if (chooser) {
    await chooser.setFiles(videoPath);
    return;
  }

  // Some Instagram variants add the input only after the upload trigger click.
  input = page.locator('input[type="file"]').first();
  await input.waitFor({ state: "attached", timeout: 120000 });
  await input.setInputFiles(videoPath);
}

async function clickNextButtons(page) {
  const exactNextPattern = exactUiTextPattern("next");
  let clickCount = 0;

  for (let pass = 0; pass < 3; pass += 1) {
    await dismissVideoPostsAreReelsDialog(page);
    const surface = await getActiveCreateSurface(page);
    if (!surface) {
      throw new Error("Could not find the active Instagram create dialog.");
    }
    if (await findVisibleCaptionTarget(surface)) {
      return clickCount;
    }

    const nextSelectors = [
      surface.getByRole("button", { name: exactNextPattern }),
      surface.locator("button").filter({ hasText: exactNextPattern }),
      surface.locator('[role="button"]').filter({ hasText: exactNextPattern }),
    ];
    let clicked = false;
    for (const selector of nextSelectors) {
      const didClick = await clickFirstVisibleEnabledLocator(page, selector, {
        allowForceFallback: false,
      });
      if (didClick) {
        clicked = true;
        clickCount += 1;
        await page.waitForTimeout(1200);
        break;
      }
    }
    if (!clicked) {
      throw new Error(
        `Could not find/click Instagram Next button in create step ${pass + 1}.`
      );
    }
  }

  const surface = await getActiveCreateSurface(page);
  if (surface && (await findVisibleCaptionTarget(surface))) {
    return clickCount;
  }
  throw new Error("Instagram composer did not reach the caption step.");
}

async function setCaption(page, caption) {
  if (!caption) return;

  const surface = await getActiveCreateSurface(page);
  if (!surface) {
    throw new Error("Could not find the active Instagram create dialog.");
  }

  for (const locator of getCaptionLocators(surface)) {
    const total = await locator.count();
    for (let index = 0; index < total; index += 1) {
      const candidate = locator.nth(index);
      if (!(await candidate.isVisible().catch(() => false))) continue;
      try {
        await candidate.click({ timeout: 8000 });
        await page.keyboard.press("Control+A");
        await page.keyboard.press("Delete");
        await candidate.type(caption, { delay: 10 });
        return;
      } catch {
        // next
      }
    }
  }

  throw new Error("Could not fill the Instagram caption inside the create dialog.");
}

async function clickShare(page) {
  const surface = await getActiveCreateSurface(page);
  if (!surface) return false;

  const sharePattern = exactUiTextPattern("share");
  const shareLocators = [
    surface.getByRole("button", { name: sharePattern }),
    surface.locator("button").filter({ hasText: sharePattern }),
    surface.locator('[role="button"]').filter({ hasText: sharePattern }),
  ];

  for (const locator of shareLocators) {
    const clicked = await clickFirstVisibleEnabledLocator(page, locator, {
      allowForceFallback: false,
    });
    if (clicked) return true;
  }
  return false;
}

async function waitForPostConfirmation(page, startedUrl) {
  // Wait up to 60 * 1500ms = 90 seconds for upload processing
  for (let i = 0; i < 60; i += 1) {
    const text = await page.locator("body").innerText().catch(() => "");
    if (uiLabels.pattern("posted").test(text)) {
      return { ok: true };
    }
    if (uiLabels.pattern("error").test(text)) {
      return { ok: false, reason: "Instagram reported an error while posting." };
    }

    const currentUrl = page.url();
    if (currentUrl !== startedUrl && !/\/create\//i.test(currentUrl)) {
      return { ok: true };
    }
    await page.waitForTimeout(1500);
  }
  return { ok: false, reason: "No reliable Instagram post confirmation within timeout." };
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
    await clickNextButtons(page);
    await setCaption(page, caption || config.defaultCaption);

    const startedUrl = page.url();
    const shared = await clickShare(page);
    if (!shared) {
      throw new Error("Could not find/click Instagram Share button.");
    }

    const confirmation = await waitForPostConfirmation(page, startedUrl);
    if (!confirmation.ok) {
      throw new Error(confirmation.reason);
    }

    const successScreenshotPath = path.resolve(
      config.projectRoot,
      "last-instagram-upload-success.png"
    );
    await page.screenshot({ path: successScreenshotPath, fullPage: true }).catch(() => { });

    // Hold the browser open so background processing finishes
    closeHoldMs = Math.max(config.postPublishHoldMs || 15000, 15000);
    return { ok: true };
  } catch (error) {
    const screenshotPath = path.resolve(
      config.projectRoot,
      "last-instagram-upload-error.png"
    );
    await page.screenshot({ path: screenshotPath, fullPage: true }).catch(() => { });

    closeHoldMs = Math.max(config.failureHoldMs, 0);
    return {
      ok: false,
      error: error.message,
      screenshotPath,
    };
  } finally {
    if (closeHoldMs > 0) {
      console.log(`Holding browser for ${closeHoldMs / 1000}s before closing...`);
      await page.waitForTimeout(closeHoldMs).catch(() => { });
    }
    await context.close();
  }
}

module.exports = {
  uploadVideo,
  startLoginSession,
  getLoginSessionStatus,
  closeLoginSession,
  _private: {
    ensureCreateFlowInput,
    clickNextButtons,
    clickShare,
    dismissVideoPostsAreReelsDialog,
    exactUiTextPattern,
    getActiveCreateSurface,
    isCreateUploadReady,
    setCaption,
    setVideoFile,
  },
};

