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

function createOneShotActionGuard(actionName) {
  let consumed = false;
  return {
    consume() {
      if (consumed) {
        throw new Error(`${actionName} action budget was already consumed.`);
      }
      consumed = true;
    },
    get consumed() {
      return consumed;
    },
  };
}

function applyUploadOutcome(error, result) {
  error.outcome = result.outcome;
  error.retryAllowed = result.retryAllowed;
  error.clickAttempted = result.clickAttempted;
  error.reason = result.reason;
  error.evidence = result.evidence;
  return error;
}

function buildInstagramUploadFailureResult(
  error,
  screenshotPath,
  { actionAttempted = false } = {}
) {
  const hasBoundPostClickOutcome =
    ["failure", "uncertain"].includes(error?.outcome) &&
    error?.retryAllowed === false &&
    error?.clickAttempted === true;
  if (actionAttempted && !hasBoundPostClickOutcome) {
    const reason =
      "Instagram post confirmation failed after Share was dispatched; " +
      "publication may have succeeded and no retry was attempted.";
    return {
      ok: false,
      outcome: "uncertain",
      retryAllowed: false,
      clickAttempted: true,
      reason,
      evidence: error?.evidence,
      error: reason,
      screenshotPath,
    };
  }

  return {
    ok: false,
    outcome: error.outcome || "failure",
    retryAllowed:
      typeof error.retryAllowed === "boolean" ? error.retryAllowed : true,
    clickAttempted:
      typeof error.clickAttempted === "boolean" ? error.clickAttempted : false,
    reason: error.reason || error.message,
    evidence: error.evidence,
    error: error.message,
    screenshotPath,
  };
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
    const structurallyOwned = await input
      .first()
      .evaluate((element) => {
        const owner = element.closest('[role="dialog"], [aria-modal="true"]');
        return Boolean(
          owner &&
            owner.isConnected &&
            owner.getClientRects().length &&
            getComputedStyle(owner).visibility !== "hidden"
        );
      })
      .catch(() => false);
    if (structurallyOwned) return true;
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
  const matches = [];

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
      matches.push(dialog);
    }
  }

  if (matches.length > 1) {
    throw new Error(
      `Could not safely bind the Instagram create operation: ` +
        `${matches.length} active create dialogs were recognized.`
    );
  }
  return matches[0] || null;
}

async function createInstagramOperationBinding(page) {
  const surface = await getActiveCreateSurface(page);
  if (!surface) {
    throw new Error("Could not bind the active Instagram create dialog.");
  }
  const surfaceHandle = await surface.elementHandle().catch(() => null);
  if (!surfaceHandle) {
    throw new Error("Could not retain the active Instagram create dialog identity.");
  }
  return {
    surfaceHandle,
    actionGuard: createOneShotActionGuard("Instagram Share"),
  };
}

async function requireBoundInstagramSurface(page, operation) {
  const surface = await getActiveCreateSurface(page);
  if (!surface) {
    throw new Error("Could not find the active Instagram create dialog.");
  }
  if (!operation?.surfaceHandle) return surface;

  const currentHandle = await surface.elementHandle().catch(() => null);
  if (!currentHandle) {
    throw new Error("Could not inspect the active Instagram create dialog identity.");
  }
  try {
    const sameOwner = await currentHandle
      .evaluate((element, expected) => element === expected, operation.surfaceHandle)
      .catch(() => false);
    const ownerReady = await operation.surfaceHandle
      .evaluate(
        (element) =>
          element.isConnected &&
          Boolean(element.getClientRects().length) &&
          getComputedStyle(element).visibility !== "hidden"
      )
      .catch(() => false);
    if (!sameOwner || !ownerReady) {
      throw new Error(
        "Instagram create dialog identity changed during the upload operation."
      );
    }
    return surface;
  } finally {
    await currentHandle.dispose().catch(() => {});
  }
}

async function ensureCreateFlowInput(page) {
  const inputs = page.locator('input[type="file"]');
  const inputCount = await inputs.count();
  if (inputCount > 1) {
    throw new Error(
      `Could not safely select the Instagram file input: observed ${inputCount}.`
    );
  }
  const input = inputs.first();
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
  const inputsAfterTrigger = page.locator('input[type="file"]');
  const inputCountAfterTrigger = await inputsAfterTrigger.count();
  if (inputCountAfterTrigger !== 1) {
    throw new Error(
      "Could not uniquely bind the Instagram file input after the upload trigger."
    );
  }
  input = inputsAfterTrigger.first();
  await input.waitFor({ state: "attached", timeout: 120000 });
  await input.setInputFiles(videoPath);
}

async function clickNextButtons(page, operation) {
  const exactNextPattern = exactUiTextPattern("next");
  let clickCount = 0;

  for (let pass = 0; pass < 3; pass += 1) {
    await dismissVideoPostsAreReelsDialog(page);
    const surface = await requireBoundInstagramSurface(page, operation);
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

  const surface = await requireBoundInstagramSurface(page, operation);
  if (surface && (await findVisibleCaptionTarget(surface))) {
    return clickCount;
  }
  throw new Error("Instagram composer did not reach the caption step.");
}

async function setCaption(page, caption, operation) {
  if (!caption) return;

  const surface = await requireBoundInstagramSurface(page, operation);

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

async function getUniqueActiveInstagramShareTarget(surface) {
  const sharePattern = exactUiTextPattern("share");
  const shareLocators = [
    surface.getByRole("button", { name: sharePattern }),
    surface.locator("button").filter({ hasText: sharePattern }),
    surface.locator('[role="button"]').filter({ hasText: sharePattern }),
  ];
  const activeTargets = [];

  try {
    for (const locator of shareLocators) {
      const total = await locator.count();
      for (let index = 0; index < total; index += 1) {
        const candidate = locator.nth(index);
        const visible = await candidate.isVisible().catch(() => false);
        const disabled = await candidate.isDisabled().catch(() => true);
        if (!visible || disabled) continue;

        const handle = await candidate.elementHandle().catch(() => null);
        if (!handle) continue;
        const identity = await handle
          .evaluate((element) => ({
            visibleText: String(element.innerText || "")
              .replace(/\s+/g, " ")
              .trim(),
            ariaLabel: String(element.getAttribute("aria-label") || "")
              .replace(/\s+/g, " ")
              .trim(),
          }))
          .catch(() => null);
        if (
          !identity ||
          !sharePattern.test(identity.visibleText) ||
          (identity.ariaLabel && !sharePattern.test(identity.ariaLabel))
        ) {
          await handle.dispose().catch(() => {});
          continue;
        }
        let duplicate = false;
        for (const existing of activeTargets) {
          duplicate = await handle
            .evaluate((element, other) => element === other, existing.handle)
            .catch(() => false);
          if (duplicate) break;
        }
        if (duplicate) {
          await handle.dispose().catch(() => {});
        } else {
          activeTargets.push({ handle });
        }
      }
    }

    if (activeTargets.length > 1) {
      throw new Error(
        "Could not safely publish the Instagram post: multiple active Share buttons."
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

async function inspectFinalInstagramShareBoundary(
  page,
  expectedSurfaceHandle,
  expectedTargetHandle
) {
  if (!expectedSurfaceHandle || !expectedTargetHandle) {
    return { ok: false, reason: "missing-boundary-identity" };
  }
  const shareLabels = uiLabels.terms("share");
  return page
    .evaluate(
      ({ expectedSurface, expectedTarget, allowedLabels }) => {
        const normalize = (value) =>
          String(value || "").replace(/\s+/g, " ").trim().toLowerCase();
        const allowed = new Set(allowedLabels.map(normalize));
        const isVisible = (element) => {
          if (!element?.isConnected || !element.getClientRects().length) {
            return false;
          }
          const style = getComputedStyle(element);
          return style.display !== "none" && style.visibility !== "hidden";
        };
        const hasExactShareIdentity = (element) => {
          if (!isVisible(element)) return false;
          if (
            element.disabled === true ||
            normalize(element.getAttribute("aria-disabled")) === "true"
          ) {
            return false;
          }
          const visibleText = normalize(element.innerText);
          const ariaLabel = normalize(element.getAttribute("aria-label"));
          return (
            Boolean(visibleText) &&
            allowed.has(visibleText) &&
            (!ariaLabel || allowed.has(ariaLabel))
          );
        };

        if (!isVisible(expectedSurface)) {
          return { ok: false, reason: "owner-changed" };
        }
        if (!expectedSurface.contains(expectedTarget)) {
          return { ok: false, reason: "target-identity-changed" };
        }
        const visibleDialogs = Array.from(
          new Set(
            document.querySelectorAll('[role="dialog"], [aria-modal="true"]')
          )
        ).filter(isVisible);
        if (
          visibleDialogs.length !== 1 ||
          visibleDialogs[0] !== expectedSurface
        ) {
          return { ok: false, reason: "unexpected-dialog" };
        }
        const candidates = Array.from(
          expectedSurface.querySelectorAll('button, [role="button"]')
        ).filter(hasExactShareIdentity);
        if (candidates.length !== 1) {
          return { ok: false, reason: "target-count-changed" };
        }
        if (candidates[0] !== expectedTarget) {
          return { ok: false, reason: "target-identity-changed" };
        }
        return { ok: true };
      },
      {
        expectedSurface: expectedSurfaceHandle,
        expectedTarget: expectedTargetHandle,
        allowedLabels: shareLabels,
      }
    )
    .catch(() => ({ ok: false, reason: "boundary-inspection-failed" }));
}

async function clickShare(page, operation) {
  const surface = await requireBoundInstagramSurface(page, operation);
  const target = await getUniqueActiveInstagramShareTarget(surface);
  if (!target) {
    return {
      ok: false,
      outcome: "failure",
      retryAllowed: true,
      clickAttempted: false,
      reason: "Could not find the unique active Instagram Share button.",
    };
  }

  const actionGuard =
    operation?.actionGuard || createOneShotActionGuard("Instagram Share");
  const temporarySurfaceHandle = operation?.surfaceHandle
    ? null
    : await surface.elementHandle().catch(() => null);
  try {
    await target.handle.scrollIntoViewIfNeeded({ timeout: 3000 });
    const finalBoundary = await inspectFinalInstagramShareBoundary(
      page,
      operation?.surfaceHandle || temporarySurfaceHandle,
      target.handle
    );
    if (!finalBoundary.ok) {
      const reasonByCode = {
        "unexpected-dialog":
          "An unexpected Instagram dialog appeared before the final Share action.",
        "target-identity-changed":
          "Instagram Share target identity changed before the final action.",
      };
      return {
        ok: false,
        outcome: "failure",
        retryAllowed: true,
        clickAttempted: false,
        reason:
          reasonByCode[finalBoundary.reason] ||
          "Instagram Share boundary changed before the final action.",
      };
    }
    try {
      actionGuard.consume();
      await target.handle.click({ timeout: 5000 });
    } catch (error) {
      return {
        ok: false,
        outcome: "uncertain",
        retryAllowed: false,
        clickAttempted: true,
        reason:
          "Instagram Share click had an ambiguous outcome; " +
          "publication may have succeeded and no retry was attempted.",
      };
    }
    return {
      ok: true,
      outcome: "clicked",
      retryAllowed: false,
      clickAttempted: true,
      reason: "Instagram Share click was dispatched once.",
    };
  } finally {
    if (temporarySurfaceHandle) {
      await temporarySurfaceHandle.dispose().catch(() => {});
    }
    await target.handle.dispose().catch(() => {});
  }
}

function parseInstagramPostReference(rawUrl) {
  try {
    const parsed = new URL(rawUrl, "https://www.instagram.com");
    if (!["instagram.com", "www.instagram.com"].includes(parsed.hostname.toLowerCase())) {
      return null;
    }
    const match = /^\/(?:p|reel|reels)\/([^/?#]+)/i.exec(parsed.pathname);
    if (!match || !/^[a-zA-Z0-9_-]{5,128}$/.test(match[1])) return null;
    return {
      postId: match[1],
      postUrl: `${parsed.origin}${parsed.pathname}`,
    };
  } catch {
    return null;
  }
}

async function readInstagramConfirmationEvidence(page, operation) {
  const entries = [];
  const addEntry = async (candidate, evidenceType, operationBound) => {
    if (!(await candidate.isVisible().catch(() => false))) return;
    const text = String(await candidate.innerText().catch(() => ""))
      .replace(/\s+/g, " ")
      .trim();
    if (!text) return;
    const hasSuccess = uiLabels.pattern("posted").test(text);
    const hasError = uiLabels.pattern("error").test(text);
    if (!hasSuccess && !hasError) return;
    let reference = null;
    const links = candidate.locator("a[href]");
    const total = await links.count();
    for (let index = 0; index < total && !reference; index += 1) {
      reference = parseInstagramPostReference(
        await links.nth(index).getAttribute("href").catch(() => "")
      );
    }
    entries.push({
      key: `${evidenceType}:${text}`,
      evidenceType,
      operationBound,
      hasSuccess,
      hasError,
      matchedText: hasSuccess ? text.match(uiLabels.pattern("posted"))?.[0] || null : null,
      postId: reference?.postId || null,
      postUrl: reference?.postUrl || null,
    });
  };

  if (operation?.surfaceHandle) {
    const boundVisible = await operation.surfaceHandle
      .evaluate(
        (element) =>
          element.isConnected &&
          Boolean(element.getClientRects().length) &&
          getComputedStyle(element).visibility !== "hidden"
      )
      .catch(() => false);
    if (boundVisible) {
      const surface = await getActiveCreateSurface(page).catch(() => null);
      if (surface) {
        const currentHandle = await surface.elementHandle().catch(() => null);
        const sameOwner = currentHandle
          ? await currentHandle
              .evaluate((element, expected) => element === expected, operation.surfaceHandle)
              .catch(() => false)
          : false;
        if (currentHandle) await currentHandle.dispose().catch(() => {});
        if (sameOwner) await addEntry(surface, "bound-composer", true);
      }
    }
  }

  const feedback = page.locator(
    '[role="alert"], [role="status"], [aria-live="assertive"], [aria-live="polite"]'
  );
  const feedbackTotal = await feedback.count();
  for (let index = 0; index < feedbackTotal; index += 1) {
    await addEntry(feedback.nth(index), "feedback", false);
  }

  const dialogs = page.locator('[role="dialog"], [aria-modal="true"]');
  const dialogTotal = await dialogs.count();
  for (let index = 0; index < dialogTotal; index += 1) {
    const dialog = dialogs.nth(index);
    let sameOwner = false;
    if (operation?.surfaceHandle) {
      const handle = await dialog.elementHandle().catch(() => null);
      if (handle) {
        sameOwner = await handle
          .evaluate((element, expected) => element === expected, operation.surfaceHandle)
          .catch(() => false);
        await handle.dispose().catch(() => {});
      }
    }
    if (!sameOwner) await addEntry(dialog, "post-share-dialog", false);
  }
  return entries;
}

async function waitForPostConfirmation(
  page,
  operation,
  baselineEntries = [],
  { maxPolls = 60, pollIntervalMs = 1500 } = {}
) {
  const baseline = new Map();
  for (const entry of baselineEntries) {
    baseline.set(entry.key, (baseline.get(entry.key) || 0) + 1);
  }
  const startedUrl = operation?.startedUrl || page.url();
  const safeMaxPolls = Math.max(1, Number(maxPolls) || 1);
  const safePollIntervalMs = Math.max(0, Number(pollIntervalMs) || 0);

  for (let poll = 0; poll < safeMaxPolls; poll += 1) {
    const current = await readInstagramConfirmationEvidence(page, operation);
    const remaining = new Map(baseline);
    const fresh = current.filter((entry) => {
      const count = remaining.get(entry.key) || 0;
      if (count > 0) {
        remaining.set(entry.key, count - 1);
        return false;
      }
      return true;
    });

    for (const entry of fresh) {
      if (entry.hasSuccess && entry.hasError) {
        return {
          ok: false,
          outcome: "uncertain",
          retryAllowed: false,
          clickAttempted: true,
          reason: "Instagram displayed conflicting post confirmation evidence.",
        };
      }
      if (entry.hasError && (entry.operationBound || entry.postId)) {
        return {
          ok: false,
          outcome: "failure",
          retryAllowed: false,
          clickAttempted: true,
          reason: "Instagram reported an operation-bound error while posting.",
        };
      }
      if (entry.hasSuccess && (entry.operationBound || entry.postId)) {
        return {
          ok: true,
          outcome: "success",
          retryAllowed: false,
          clickAttempted: true,
          reason: "Instagram publication was confirmed by operation-bound evidence.",
          evidence: {
            evidenceType: entry.evidenceType,
            matchedText: entry.matchedText,
            postId: entry.postId,
            postUrl: entry.postUrl,
          },
        };
      }
    }

    const navigationReference = parseInstagramPostReference(page.url());
    if (page.url() !== startedUrl && navigationReference) {
      return {
        ok: true,
        outcome: "success",
        retryAllowed: false,
        clickAttempted: true,
        reason: "Instagram navigated to a canonical post reference after Share.",
        evidence: { evidenceType: "post-navigation", ...navigationReference },
      };
    }
    if (poll + 1 < safeMaxPolls) {
      await page.waitForTimeout(safePollIntervalMs);
    }
  }
  return {
    ok: false,
    outcome: "uncertain",
    retryAllowed: false,
    clickAttempted: true,
    reason:
      "No operation-bound Instagram post confirmation was observed within timeout. " +
      "Publication may have succeeded; no retry was attempted.",
  };
}

async function uploadVideo({ videoPath, caption, accountId }) {
  const absoluteVideoPath = path.resolve(videoPath);
  const context = await openPersistentContext(accountId);
  let page = null;
  let closeHoldMs = 0;
  let operation = null;

  try {
    page = context.pages()[0] || (await context.newPage());
    await gotoUploadPage(page);
    await setVideoFile(page, absoluteVideoPath);
    await page.waitForTimeout(Math.max(config.postDelayMs, 5000));
    operation = await createInstagramOperationBinding(page);
    await clickNextButtons(page, operation);
    await setCaption(page, caption || config.defaultCaption, operation);

    operation.startedUrl = page.url();
    const baselineEntries = await readInstagramConfirmationEvidence(page, operation);
    const shareResult = await clickShare(page, operation);
    if (!shareResult.ok) {
      throw applyUploadOutcome(new Error(shareResult.reason), shareResult);
    }

    const confirmation = await waitForPostConfirmation(
      page,
      operation,
      baselineEntries
    );
    if (!confirmation.ok) {
      throw applyUploadOutcome(new Error(confirmation.reason), confirmation);
    }

    const successScreenshotPath = path.resolve(
      config.projectRoot,
      "last-instagram-upload-success.png"
    );
    await page.screenshot({ path: successScreenshotPath, fullPage: true }).catch(() => { });

    // Hold the browser open so background processing finishes
    closeHoldMs = Math.max(config.postPublishHoldMs || 15000, 15000);
    return {
      ok: true,
      outcome: "success",
      retryAllowed: false,
      clickAttempted: true,
      reason: confirmation.reason,
      evidence: confirmation.evidence,
      postUrl: confirmation.evidence?.postUrl || null,
      postId: confirmation.evidence?.postId || null,
    };
  } catch (error) {
    const screenshotPath = path.resolve(
      config.projectRoot,
      "last-instagram-upload-error.png"
    );
    if (page) {
      await page
        .screenshot({ path: screenshotPath, fullPage: true })
        .catch(() => {});
    }

    closeHoldMs = Math.max(config.failureHoldMs, 0);
    return buildInstagramUploadFailureResult(error, screenshotPath, {
      actionAttempted: operation?.actionGuard?.consumed === true,
    });
  } finally {
    if (operation?.surfaceHandle) {
      await operation.surfaceHandle.dispose().catch(() => {});
    }
    if (page && closeHoldMs > 0) {
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
    createInstagramOperationBinding,
    dismissVideoPostsAreReelsDialog,
    exactUiTextPattern,
    getActiveCreateSurface,
    isCreateUploadReady,
    parseInstagramPostReference,
    readInstagramConfirmationEvidence,
    requireBoundInstagramSurface,
    inspectFinalInstagramShareBoundary,
    setCaption,
    setVideoFile,
    waitForPostConfirmation,
    buildInstagramUploadFailureResult,
  },
};

