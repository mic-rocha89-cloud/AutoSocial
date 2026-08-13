const path = require("path");
const fs = require("fs/promises");
const crypto = require("crypto");
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
  const profileDir = await getPlatformProfileDir("tiktok", accountId);
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
  await page.goto(config.uploadPageUrl, { waitUntil: "domcontentloaded" });
}

async function setVideoFile(page, videoPath) {
  const fileInput = page.locator('input[type="file"]').first();
  await fileInput.waitFor({ state: "attached", timeout: 120000 });
  await fileInput.setInputFiles(videoPath);
}

async function setCaption(page, caption) {
  const onboardingState = await dismissKnownTikTokPrePublishOnboarding(page, {
    phase: "pre-caption",
  });
  if (onboardingState.blocked) {
    throw new Error(
      "TikTok caption editing is blocked by a visible dialog; " +
        "automatic dialog interaction is disabled."
    );
  }

  if (!caption) {
    return;
  }

  const candidates = [
    '[contenteditable="true"][aria-label*="description" i]',
    '[contenteditable="true"][aria-label*="caption" i]',
    '[contenteditable="true"][data-e2e*="caption" i]',
    '[contenteditable="true"][role="textbox"]',
    'div[contenteditable="true"]',
    'textarea[placeholder*="description" i]',
    'textarea[placeholder*="caption" i]',
    'textarea',
  ];

  for (const selector of candidates) {
    const matches = page.locator(selector);
    const count = await matches.count();

    for (let index = 0; index < count; index += 1) {
      const target = matches.nth(index);
      const visible = await target.isVisible().catch(() => false);
      if (!visible) {
        continue;
      }

      try {
        await target.scrollIntoViewIfNeeded({ timeout: 3000 });
        await target.fill(caption, { timeout: 8000 });
        return;
      } catch {
        // Try the next visible caption candidate.
      }
    }
  }

  throw new Error("Could not fill a visible caption or description field.");
}

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

async function clickFirstVisibleEnabledLocator(page, locator) {
  const total = await locator.count();
  if (total === 0) {
    return false;
  }

  for (let i = 0; i < total; i += 1) {
    const candidate = locator.nth(i);
    const visible = await candidate.isVisible().catch(() => false);
    if (!visible) {
      continue;
    }

    const disabled = await candidate.isDisabled().catch(() => false);
    if (disabled) {
      continue;
    }

    try {
      await candidate.scrollIntoViewIfNeeded({ timeout: 3000 });
      await page.waitForTimeout(250);
      await candidate.click({ timeout: 5000 });
      return true;
    } catch {
      try {
        await candidate.click({ timeout: 5000, force: true });
        return true;
      } catch {
        // Continue to next candidate.
      }
    }
  }

  return false;
}

function normalizeUiText(value) {
  return String(value || "").trim().replace(/\s+/g, " ").toLowerCase();
}

function getPublishClickAttempted(error) {
  return typeof error?.clickAttempted === "boolean"
    ? error.clickAttempted
    : false;
}

const KNOWN_TIKTOK_EDITOR_ONBOARDING = Object.freeze({
  id: "editor-features",
  title: "New editing features added",
  body:
    "Now it's easier than ever before to create professional and engaging videos.",
  button: "Got it",
  allowedPhases: Object.freeze(["pre-caption"]),
  detectedLog: "Known TikTok onboarding dialog detected.",
  dismissedLog: "Known TikTok onboarding dialog dismissed safely.",
});

const KNOWN_TIKTOK_PHONE_PREVIEW_ONBOARDING = Object.freeze({
  id: "phone-preview",
  title: "Preview your video on your phone",
  body: "Now you can view your video as it will appear on TikTok.",
  button: "Got it",
  allowedPhases: Object.freeze(["pre-caption"]),
  detectedLog:
    "Known TikTok phone-preview onboarding dialog detected.",
  dismissedLog:
    "Known TikTok phone-preview onboarding dialog dismissed safely.",
  reappearedLog:
    "Known TikTok phone-preview onboarding dialog reappeared after allowed dismiss; failing closed.",
  structure: Object.freeze({
    containerTag: "DIV",
    containerRole: "alertdialog",
    containerAriaModal: "true",
    containerClassToken: "react-joyride__tooltip",
    exactContainerAriaLabel: true,
    titleClassToken: "tutorial-tooltip__title",
    bodyClassToken: "tutorial-tooltip__desc",
    actionFooterClassToken: "tutorial-tooltip__footer",
    buttonTag: "BUTTON",
    buttonRole: "button",
    buttonType: "button",
    buttonAriaDisabled: "false",
  }),
});

const KNOWN_TIKTOK_PRE_PUBLISH_ONBOARDINGS = Object.freeze([
  KNOWN_TIKTOK_EDITOR_ONBOARDING,
  KNOWN_TIKTOK_PHONE_PREVIEW_ONBOARDING,
]);

const TIKTOK_PUBLISH_READINESS = Object.freeze({
  origin: "https://www.tiktok.com",
  path: "/tiktokstudio/upload",
  uploadPendingText: "Checks can only start after the file is uploaded.",
  music: Object.freeze({
    title: "Music copyright check",
    selector: '[data-e2e="copyright_container"]',
    pending: Object.freeze([
      "We'll check if your video has any unauthorized music that may cause it to be muted.",
      "Checking in progress. This will take about 30 seconds.",
    ]),
    safe: Object.freeze(["No issues found."]),
  }),
  content: Object.freeze({
    title: "Content check lite",
    selector: ".headline-wrapper",
    pending: Object.freeze([
      "We'll check your content for For You Feed eligibility.",
      "Checking in progress. This will take about 10 minutes. Longer videos may take more time.",
    ]),
    safe: Object.freeze([
      "No issues found. However, your video could still be removed later if it violates our Community Guidelines.",
    ]),
  }),
});

function classifyTikTokCheckState(statusText, fingerprint) {
  const status = normalizeUiText(statusText);
  const pending = new Set(fingerprint.pending.map(normalizeUiText));
  const safe = new Set(fingerprint.safe.map(normalizeUiText));

  if (safe.has(status)) return "safe";
  if (pending.has(status)) return "pending";
  if (/\b(?:failed|unable|could not|couldn't)\b/.test(status)) return "failed";
  if (
    /\b(?:warning|issues? found|copyright detected|not eligible|restricted|blocked|muted)\b/.test(
      status
    )
  ) {
    return "warning";
  }
  return "unknown";
}

function classifyTikTokPublishReadinessInfo(info) {
  if (!info) {
    return {
      status: "unknown",
      reason: "TikTok publish readiness information is unavailable.",
    };
  }
  if (
    info.pageOrigin !== TIKTOK_PUBLISH_READINESS.origin ||
    normalizeUiText(info.pagePath) !== TIKTOK_PUBLISH_READINESS.path
  ) {
    return {
      status: "unknown",
      reason: "TikTok publish readiness was observed outside the exact Studio upload page.",
      evidence: info,
    };
  }
  if (info.visibleDialogCount > 0) {
    return {
      status: "blocked",
      reason: "TikTok publish readiness is blocked by a visible dialog.",
      evidence: info,
    };
  }
  if (
    info.musicAnchorCount !== 1 ||
    info.contentAnchorCount !== 1 ||
    info.sameCheckRegion !== true
  ) {
    return {
      status: "unknown",
      reason: "TikTok publish check structure is missing or ambiguous.",
      evidence: info,
    };
  }

  const musicState = classifyTikTokCheckState(
    info.musicStatusText,
    TIKTOK_PUBLISH_READINESS.music
  );
  const contentState = classifyTikTokCheckState(
    info.contentStatusText,
    TIKTOK_PUBLISH_READINESS.content
  );
  const evidence = {
    ...info,
    musicState,
    contentState,
  };

  if (musicState === "failed" || contentState === "failed") {
    return {
      status: "failed",
      reason: "TikTok reported a failed publish check.",
      evidence,
    };
  }
  if (musicState === "warning" || contentState === "warning") {
    return {
      status: "warning",
      reason: "TikTok reported a publish check warning.",
      evidence,
    };
  }
  if (musicState === "unknown" || contentState === "unknown") {
    return {
      status: "unknown",
      reason: "TikTok publish check state is unknown.",
      evidence,
    };
  }

  const uploadState = info.uploadPendingVisible
    ? "pending"
    : musicState === "safe" || musicState === "pending"
      ? "complete"
      : "unknown";
  evidence.uploadState = uploadState;

  if (
    uploadState === "pending" ||
    musicState === "pending" ||
    contentState === "pending"
  ) {
    return {
      status: "pending",
      reason: "TikTok upload or publish checks are still pending.",
      evidence,
    };
  }
  if (
    uploadState === "complete" &&
    musicState === "safe" &&
    contentState === "safe"
  ) {
    return {
      status: "ready",
      reason: "TikTok upload and publish checks reached exact safe states.",
      evidence,
    };
  }

  return {
    status: "unknown",
    reason: "TikTok publish readiness could not be proven.",
    evidence,
  };
}

async function collectTikTokPublishReadinessInfo(page) {
  return page.evaluate((fingerprint) => {
    const normalize = (value) =>
      String(value || "").trim().replace(/\s+/g, " ");
    const isVisible = (element) => {
      if (!element?.isConnected) return false;
      const style = window.getComputedStyle(element);
      const rect = element.getBoundingClientRect();
      return (
        style.display !== "none" &&
        style.visibility !== "hidden" &&
        rect.width > 0 &&
        rect.height > 0
      );
    };
    const exactVisibleAnchors = (selector, title) =>
      Array.from(document.querySelectorAll(selector)).filter(
        (element) => isVisible(element) && normalize(element.innerText) === title
      );
    const getStatusText = (section, title) => {
      const text = normalize(section?.innerText);
      const prefix = `${title} `;
      return text.startsWith(prefix) ? text.slice(prefix.length) : "";
    };

    const musicAnchors = exactVisibleAnchors(
      fingerprint.music.selector,
      fingerprint.music.title
    );
    const contentAnchors = exactVisibleAnchors(
      fingerprint.content.selector,
      fingerprint.content.title
    );
    const musicSection =
      musicAnchors.length === 1 ? musicAnchors[0].parentElement : null;
    const contentSection =
      contentAnchors.length === 1 ? contentAnchors[0].parentElement : null;
    const visibleDialogs = Array.from(
      document.querySelectorAll(
        '[role="dialog"], [role="alertdialog"], [aria-modal="true"]'
      )
    ).filter(isVisible);
    const uploadPendingVisible = Array.from(
      document.querySelectorAll("body *")
    ).some(
      (element) =>
        isVisible(element) &&
        normalize(element.innerText) === fingerprint.uploadPendingText
    );

    return {
      contentAnchorCount: contentAnchors.length,
      contentStatusText: getStatusText(
        contentSection,
        fingerprint.content.title
      ),
      musicAnchorCount: musicAnchors.length,
      musicStatusText: getStatusText(musicSection, fingerprint.music.title),
      pageOrigin: window.location.origin,
      pagePath: window.location.pathname,
      sameCheckRegion: Boolean(
        musicSection &&
          contentSection &&
          musicSection.parentElement === contentSection.parentElement
      ),
      uploadPendingVisible,
      visibleDialogCount: visibleDialogs.length,
    };
  }, TIKTOK_PUBLISH_READINESS);
}

async function waitForTikTokPublishReadiness(
  page,
  {
    maxWaitMs = 12 * 60 * 1000,
    pollIntervalMs = 5000,
    requiredStablePolls = 2,
  } = {}
) {
  const safeMaxWaitMs = Math.max(0, Number(maxWaitMs) || 0);
  const safePollIntervalMs = Math.max(0, Number(pollIntervalMs) || 0);
  const safeRequiredStablePolls = Math.max(
    1,
    Number(requiredStablePolls) || 1
  );
  const deadline = Date.now() + safeMaxWaitMs;
  let lastLoggedState = "";
  let stableSignature = "";
  let stablePolls = 0;

  while (true) {
    const info = await collectTikTokPublishReadinessInfo(page).catch(() => null);
    const readiness = classifyTikTokPublishReadinessInfo(info);
    const logState = JSON.stringify({
      content: readiness.evidence?.contentState || "unknown",
      music: readiness.evidence?.musicState || "unknown",
      status: readiness.status,
      upload: readiness.evidence?.uploadState || "unknown",
    });
    if (logState !== lastLoggedState) {
      console.log(`TikTok publish readiness: ${logState}`);
      lastLoggedState = logState;
    }

    if (readiness.status === "ready") {
      const diagnostics = await collectPublishCandidateDiagnostics(page).catch(
        () => null
      );
      if (!diagnostics) {
        return {
          ok: false,
          outcome: "failure",
          retryAllowed: true,
          clickAttempted: false,
          reason: "TikTok publish target readiness could not be inspected.",
          evidence: readiness.evidence,
        };
      }
      if (diagnostics.qualifiedTargetCount > 1) {
        return {
          ok: false,
          outcome: "failure",
          retryAllowed: true,
          clickAttempted: false,
          reason:
            "TikTok publish readiness found multiple physical publish targets.",
          evidence: { readiness: readiness.evidence, diagnostics },
        };
      }
      if (diagnostics.qualifiedTargetCount === 1) {
        const target = diagnostics.candidates.find(
          ({ status }) => status === "ACCEPTED"
        );
        const signature = JSON.stringify({
          contentStatusText: readiness.evidence.contentStatusText,
          dataE2e: target?.dataE2e || "",
          label: normalizeUiText(target?.text || target?.ariaLabel),
          musicStatusText: readiness.evidence.musicStatusText,
          pageOrigin: target?.pageOrigin || "",
          pagePath: target?.pagePath || "",
          structuralBinding: target?.structuralBinding || "",
        });
        stablePolls = signature === stableSignature ? stablePolls + 1 : 1;
        stableSignature = signature;
        if (stablePolls >= safeRequiredStablePolls) {
          return {
            ok: true,
            outcome: "ready",
            retryAllowed: true,
            clickAttempted: false,
            reason: readiness.reason,
            evidence: {
              ...readiness.evidence,
              qualifiedTargetCount: diagnostics.qualifiedTargetCount,
              stablePolls,
            },
          };
        }
      } else {
        stablePolls = 0;
        stableSignature = "";
      }
    } else if (readiness.status !== "pending") {
      return {
        ok: false,
        outcome: "failure",
        retryAllowed: true,
        clickAttempted: false,
        reason: readiness.reason,
        evidence: readiness.evidence,
      };
    } else {
      stablePolls = 0;
      stableSignature = "";
    }

    if (Date.now() >= deadline) {
      return {
        ok: false,
        outcome: "failure",
        retryAllowed: true,
        clickAttempted: false,
        reason:
          "TikTok upload or publish checks remained pending until the bounded readiness timeout.",
        evidence: readiness.evidence,
      };
    }
    await page.waitForTimeout(safePollIntervalMs);
  }
}

function createKnownOnboardingDismissGuard() {
  let dismissAttempts = 0;
  const maxDismissAttempts = 1;

  return {
    consume() {
      if (dismissAttempts >= maxDismissAttempts) {
        throw new Error(
          "TikTok known onboarding dismiss budget is already exhausted."
        );
      }
      dismissAttempts += 1;
    },
  };
}

async function inspectKnownTikTokOnboarding(
  dialog,
  fingerprint,
  { expectedButton = null, requireOnlyVisibleDialog = false } = {}
) {
  return dialog.evaluate(
    (container, inspection) => {
      const normalize = (value) =>
        String(value || "").trim().replace(/\s+/g, " ").toLowerCase();
      const isVisible = (element) => {
        if (!element?.isConnected) return false;
        const style = window.getComputedStyle(element);
        const rect = element.getBoundingClientRect();
        return (
          style.display !== "none" &&
          style.visibility !== "hidden" &&
          rect.width > 0 &&
          rect.height > 0
        );
      };
      const expected = inspection.fingerprint;
      const structure = expected.structure || {};
      const expectedDialogText = normalize(
        `${expected.title} ${expected.body} ${expected.button}`
      );
      const expectedAriaLabel = normalize(
        `${expected.title}${expected.body}${expected.button}`
      );
      const descendants = Array.from(container.querySelectorAll("*"));
      const exactVisibleTextNodes = (text) =>
        descendants.filter(
          (element) =>
            isVisible(element) && normalize(element.innerText) === normalize(text)
        );
      const titleNodes = exactVisibleTextNodes(expected.title);
      const bodyNodes = exactVisibleTextNodes(expected.body);
      const titleNode = titleNodes.length === 1 ? titleNodes[0] : null;
      const bodyNode = bodyNodes.length === 1 ? bodyNodes[0] : null;
      const controls = Array.from(
        container.querySelectorAll("button, [role='button']")
      );
      const visibleControls = controls.filter(isVisible);
      const button = visibleControls.length === 1 ? visibleControls[0] : null;
      const buttonText = normalize(button?.innerText || button?.textContent);
      const buttonAriaLabel = normalize(button?.getAttribute("aria-label"));
      const exactButtonIdentity =
        buttonText === normalize(expected.button) &&
        (!buttonAriaLabel || buttonAriaLabel === normalize(expected.button)) &&
        !button?.disabled &&
        normalize(button?.getAttribute("aria-disabled")) !== "true";
      const hasClassToken = (element, token) =>
        !token || Boolean(element?.classList?.contains(token));
      const containerStructureMatches =
        (!structure.containerTag || container.tagName === structure.containerTag) &&
        (!structure.containerRole ||
          container.getAttribute("role") === structure.containerRole) &&
        (!structure.containerAriaModal ||
          container.getAttribute("aria-modal") === structure.containerAriaModal) &&
        hasClassToken(container, structure.containerClassToken) &&
        (!structure.exactContainerAriaLabel ||
          normalize(container.getAttribute("aria-label")) === expectedAriaLabel);
      const textStructureMatches =
        titleNodes.length === 1 &&
        bodyNodes.length === 1 &&
        hasClassToken(titleNode, structure.titleClassToken) &&
        hasClassToken(bodyNode, structure.bodyClassToken);
      const actionFooter = structure.actionFooterClassToken
        ? button?.closest(`.${structure.actionFooterClassToken}`)
        : null;
      const buttonStructureMatches =
        (!structure.buttonTag || button?.tagName === structure.buttonTag) &&
        (!structure.buttonRole ||
          button?.getAttribute("role") === structure.buttonRole) &&
        (!structure.buttonType ||
          button?.getAttribute("type") === structure.buttonType) &&
        (!structure.buttonAriaDisabled ||
          button?.getAttribute("aria-disabled") ===
            structure.buttonAriaDisabled) &&
        (!structure.actionFooterClassToken ||
          (actionFooter && container.contains(actionFooter)));
      const visibleDialogs = inspection.requireOnlyVisibleDialog
        ? Array.from(
            document.querySelectorAll(
              '[role="dialog"], [role="alertdialog"], [aria-modal="true"]'
            )
          ).filter(isVisible)
        : [];
      const onlyVisibleDialog =
        !inspection.requireOnlyVisibleDialog ||
        (visibleDialogs.length === 1 && visibleDialogs[0] === container);
      const sameButton = !inspection.expectedButton || button === inspection.expectedButton;
      const matches =
        isVisible(container) &&
        onlyVisibleDialog &&
        normalize(container.innerText) === expectedDialogText &&
        containerStructureMatches &&
        textStructureMatches &&
        exactButtonIdentity &&
        buttonStructureMatches &&
        sameButton;

      return {
        buttonIndex: button ? controls.indexOf(button) : -1,
        matches,
      };
    },
    {
      expectedButton,
      fingerprint,
      requireOnlyVisibleDialog,
    }
  );
}

async function recognizeKnownTikTokPrePublishOnboarding(
  dialog,
  { phase, expectedButton = null, requireOnlyVisibleDialog = false } = {}
) {
  const matches = [];

  for (const fingerprint of KNOWN_TIKTOK_PRE_PUBLISH_ONBOARDINGS) {
    if (!fingerprint.allowedPhases.includes(phase)) {
      continue;
    }
    const inspection = await inspectKnownTikTokOnboarding(dialog, fingerprint, {
      expectedButton,
      requireOnlyVisibleDialog,
    }).catch(() => null);
    if (inspection?.matches) {
      matches.push({ fingerprint, inspection });
    }
  }

  return matches.length === 1 ? matches[0] : null;
}

async function hasVisibleKnownTikTokOnboarding(page, fingerprint) {
  const dialogHandles = await page
    .locator('[role="dialog"], [role="alertdialog"], [aria-modal="true"]')
    .elementHandles();

  try {
    for (const dialog of dialogHandles) {
      if (!(await dialog.isVisible().catch(() => false))) {
        continue;
      }
      const inspection = await inspectKnownTikTokOnboarding(
        dialog,
        fingerprint
      ).catch(() => null);
      if (inspection?.matches) {
        return true;
      }
    }
    return false;
  } finally {
    await Promise.all(
      dialogHandles.map((dialog) => dialog.dispose().catch(() => {}))
    );
  }
}

async function dismissKnownTikTokPrePublishOnboarding(
  page,
  { phase = "pre-caption", beforeFinalValidation } = {}
) {
  const dialogHandles = await page
    .locator('[role="dialog"], [role="alertdialog"], [aria-modal="true"]')
    .elementHandles();
  const controlHandles = [];
  let dismissAttempted = false;

  try {
    const visibleDialogs = [];
    for (const dialog of dialogHandles) {
      if (await dialog.isVisible().catch(() => false)) {
        visibleDialogs.push(dialog);
      }
    }

    if (visibleDialogs.length === 0) {
      return {
        blocked: false,
        dismissed: false,
        dismissAttempted: false,
        visibleDialogCount: 0,
      };
    }

    if (visibleDialogs.length !== 1) {
      return {
        blocked: true,
        dismissed: false,
        dismissAttempted: false,
        visibleDialogCount: visibleDialogs.length,
      };
    }

    const dialog = visibleDialogs[0];
    const recognition = await recognizeKnownTikTokPrePublishOnboarding(dialog, {
      phase,
      requireOnlyVisibleDialog: true,
    }).catch(() => null);
    if (!recognition || recognition.inspection.buttonIndex < 0) {
      return {
        blocked: true,
        dismissed: false,
        dismissAttempted: false,
        visibleDialogCount: 1,
      };
    }

    const { fingerprint, inspection } = recognition;
    const controls = await dialog.$$("button, [role='button']");
    controlHandles.push(...controls);
    const button = controls[inspection.buttonIndex];
    if (!button) {
      return {
        blocked: true,
        dismissed: false,
        dismissAttempted: false,
        visibleDialogCount: 1,
      };
    }

    console.log(fingerprint.detectedLog);

    const actionable = await button
      .click({ timeout: 3000, trial: true })
      .then(() => true)
      .catch(() => false);
    if (!actionable) {
      return {
        blocked: true,
        dismissed: false,
        dismissAttempted: false,
        visibleDialogCount: 1,
      };
    }

    if (beforeFinalValidation) {
      try {
        await beforeFinalValidation();
      } catch {
        return {
          blocked: true,
          dismissed: false,
          dismissAttempted: false,
          visibleDialogCount: 1,
        };
      }
    }

    const finalValidation = await recognizeKnownTikTokPrePublishOnboarding(dialog, {
      phase,
      expectedButton: button,
      requireOnlyVisibleDialog: true,
    }).catch(() => null);
    if (!finalValidation || finalValidation.fingerprint.id !== fingerprint.id) {
      return {
        blocked: true,
        dismissed: false,
        dismissAttempted: false,
        visibleDialogCount: 1,
      };
    }

    const dismissGuard = createKnownOnboardingDismissGuard();
    try {
      dismissGuard.consume();
      dismissAttempted = true;
      await button.click({ timeout: 5000 });
    } catch {
      return {
        blocked: true,
        dismissed: false,
        dismissAttempted,
        visibleDialogCount: 1,
      };
    }

    const disappeared = await dialog
      .waitForElementState("hidden", { timeout: 5000 })
      .then(() => true)
      .catch(() => false);
    const remainingOverlayState = await detectInterferingOverlays(page);
    if (!disappeared || remainingOverlayState.blocked) {
      if (
        disappeared &&
        fingerprint.reappearedLog &&
        (await hasVisibleKnownTikTokOnboarding(page, fingerprint))
      ) {
        console.log(fingerprint.reappearedLog);
      }
      return {
        blocked: true,
        dismissed: false,
        dismissAttempted,
        visibleDialogCount: remainingOverlayState.visibleDialogCount,
      };
    }

    console.log(fingerprint.dismissedLog);
    return {
      blocked: false,
      dismissed: true,
      dismissAttempted,
      onboardingId: fingerprint.id,
      visibleDialogCount: 0,
    };
  } finally {
    await Promise.all(
      controlHandles.map((control) => control.dispose().catch(() => {}))
    );
    await Promise.all(
      dialogHandles.map((dialog) => dialog.dispose().catch(() => {}))
    );
  }
}

async function dismissKnownTikTokEditorOnboarding(page, options = {}) {
  return dismissKnownTikTokPrePublishOnboarding(page, options);
}

function classifyPublishCandidateInfo(
  info,
  publishTerms = uiLabels.terms("tiktokPublish")
) {
  const reject = (reason) => ({
    qualified: false,
    reasons: [reason],
    score: -1,
  });
  const visibleText = normalizeUiText(info?.text);
  const ariaLabel = normalizeUiText(info?.ariaLabel);
  const text = visibleText || ariaLabel;
  if (!info) return reject("candidate-info-unavailable");
  if (info.visible === false) return reject("invisible");
  if (!text) return reject("missing-label");
  if (info.disabled) return reject("disabled");
  if (info.inNavigation) return reject("inside-navigation");
  if (!info.structuralBinding) return reject("structural-binding-missing");

  const tagName = normalizeUiText(info?.tagName);
  const role = normalizeUiText(info?.role);
  if (!["button", "a"].includes(tagName) && role !== "button") {
    return reject("non-semantic-clickable");
  }

  const href = normalizeUiText(info?.href);
  if (href && /\/(post|posts|analytics|comment|home|inspiration|monetization|academy|sound|feedback)(\/|$|\?)/i.test(href)) {
    return reject("navigation-href");
  }

  if (text === "posts") {
    return reject("posts-label");
  }

  const labels = new Set(publishTerms.map(normalizeUiText).filter(Boolean));
  const identities = new Set([visibleText, ariaLabel].filter(Boolean));
  if (identities.size !== 1) return reject("text-aria-mismatch");
  if (!labels.has([...identities][0])) return reject("label-not-allowlisted");

  const rect = info?.rect || {};
  const viewportWidth = Number(info?.viewportWidth) || 0;
  const viewportHeight = Number(info?.viewportHeight) || 0;
  const left = Number(rect.left) || 0;
  const top = Number(rect.top) || 0;
  const width = Number(rect.width) || 0;
  const height = Number(rect.height) || 0;
  const right = Number(rect.right) || left + width;
  const mainContentBoundary = viewportWidth >= 900 ? Math.min(300, viewportWidth * 0.25) : 0;

  if (viewportWidth >= 900 && right <= mainContentBoundary) {
    return reject("left-of-main-content");
  }

  const isBottomAction = viewportHeight > 0 && top >= viewportHeight * 0.5;
  const isCtaSized = width >= 80 && height >= 28;
  const className = normalizeUiText(info?.className);
  const hasPublishCue = /\b(post|publish|submit)\b/.test(className);

  if (text === "post" && viewportHeight >= 600 && !isBottomAction && !hasPublishCue) {
    return reject("post-outside-bottom-action-without-class-cue");
  }

  let score = 0;
  score += 30;
  if (tagName === "button") score += 20;
  if (normalizeUiText(info?.type) === "submit") score += 20;
  if (hasPublishCue) score += 20;
  if (isCtaSized) score += 15;
  if (isBottomAction) score += 60;
  if (viewportWidth >= 900 && left >= mainContentBoundary) score += 20;
  score += Math.min(20, Math.max(0, top / 40));

  return {
    qualified: true,
    reasons: ["qualified"],
    score,
  };
}

function getPublishCandidateScore(info, publishTerms = uiLabels.terms("tiktokPublish")) {
  return classifyPublishCandidateInfo(info, publishTerms).score;
}

function isLikelyPublishCandidateInfo(info, publishTerms = uiLabels.terms("tiktokPublish")) {
  return getPublishCandidateScore(info, publishTerms) >= 0;
}

async function getPublishCandidateInfo(
  candidate,
  { inspectFinalBoundary = false, originallySelected = null } = {}
) {
  return candidate.evaluate((el, boundaryOptions) => {
    const clickable = el.closest("button, [role='button'], a") || el;
    const rect = clickable.getBoundingClientRect();
    const style = window.getComputedStyle(clickable);
    const className = (clickable.className || "").toString();
    const dataAttributes = Array.from(clickable.attributes || [])
      .filter((attr) => attr.name.startsWith("data-"))
      .map((attr) => `${attr.name}=${attr.value}`)
      .join(" ");
    const inNavigation = Boolean(
      clickable.closest(
        [
          "nav",
          "aside",
          "[role='navigation']",
          "[role='menu']",
          "[role='menubar']",
          "[class*='sidebar' i]",
          "[class*='side-bar' i]",
          "[class*='sidenav' i]",
          "[class*='side-nav' i]",
          "[class*='side_nav' i]",
          "[class*='menu' i]",
          "[class*='navigation' i]",
          "[class*='nav-item' i]",
          "[class*='nav_item' i]",
          "[data-e2e*='nav' i]",
          "[data-e2e*='side' i]",
          "[data-testid*='nav' i]",
          "[data-testid*='side' i]",
        ].join(", ")
      )
    );
    const anchor = clickable.closest("a");
    const nearestButtonOwner = el.closest("button, [role='button']");
    const sidebarAncestorSelector = [
      "[class*='sidebar' i]",
      "[class*='side-bar' i]",
      "[class*='sidenav' i]",
      "[class*='side-nav' i]",
      "[class*='side_nav' i]",
      "[data-e2e*='side' i]",
      "[data-testid*='side' i]",
    ].join(", ");
    const blockedStructuralAncestorSelector = [
      "nav",
      "aside",
      "[role='navigation']",
      "[role='dialog']",
      "[aria-modal='true']",
    ].join(", ");
    let structuralBinding = "";
    const structuralRoot = clickable.closest("form");

    if (structuralRoot) {
      const activeUploadInputs = Array.from(
        structuralRoot.querySelectorAll('input[type="file"]')
      ).filter(
        (input) =>
          input.isConnected &&
          !input.disabled &&
          input.files &&
          input.files.length > 0
      );
      if (
        activeUploadInputs.length === 1 &&
        !structuralRoot.closest(blockedStructuralAncestorSelector)
      ) {
        structuralBinding = "active-upload-form";
      }
    }

    const actionRegion = clickable.parentElement;
    const actionFooter = actionRegion?.parentElement || null;
    const actionRegionPosts = actionRegion
      ? Array.from(
          actionRegion.querySelectorAll('[data-e2e="post_video_button"]')
        )
      : [];
    const actionRegionDiscards = actionRegion
      ? Array.from(
          actionRegion.querySelectorAll('[data-e2e="discard_post_button"]')
        )
      : [];
    const discardOwner =
      actionRegionDiscards.length === 1 ? actionRegionDiscards[0] : null;
    const hasVerifiedUploadActionRegion =
      window.location.origin === "https://www.tiktok.com" &&
      /^\/tiktokstudio\/upload\/?$/i.test(window.location.pathname) &&
      clickable.tagName === "BUTTON" &&
      clickable.getAttribute("role") === "button" &&
      clickable.getAttribute("type") === "button" &&
      clickable.getAttribute("data-e2e") === "post_video_button" &&
      clickable.getAttribute("data-icon-only") === "false" &&
      clickable.getAttribute("data-size") === "large" &&
      clickable.getAttribute("data-disabled") === "false" &&
      actionRegion?.classList.contains("button-group") &&
      Boolean(
        actionFooter &&
          (actionFooter.tagName === "FOOTER" ||
            actionFooter.classList.contains("footer"))
      ) &&
      actionRegionPosts.length === 1 &&
      actionRegionPosts[0] === clickable &&
      discardOwner?.matches("button, [role='button']") &&
      !discardOwner.disabled &&
      discardOwner.getAttribute("aria-disabled") !== "true" &&
      !actionRegion.closest(blockedStructuralAncestorSelector);

    if (!structuralBinding && hasVerifiedUploadActionRegion) {
      structuralBinding = "verified-upload-action-region";
    }

    const describeAncestor = (element, depth) => ({
      className: (element.className || "").toString(),
      dataE2e: element.getAttribute("data-e2e") || "",
      dataTestId: element.getAttribute("data-testid") || "",
      depth,
      id: element.id || "",
      populatedFileInputCount: Array.from(
        element.querySelectorAll('input[type="file"]')
      ).filter(
        (input) =>
          input.isConnected &&
          !input.disabled &&
          input.files &&
          input.files.length > 0
      ).length,
      role: element.getAttribute("role") || "",
      tagName: element.tagName,
    });
    const ancestorChain = [];
    let currentAncestor = clickable.parentElement;
    for (
      let depth = 1;
      currentAncestor && depth <= 12;
      depth += 1, currentAncestor = currentAncestor.parentElement
    ) {
      ancestorChain.push(describeAncestor(currentAncestor, depth));
    }
    const documentPopulatedFileInputCount = Array.from(
      document.querySelectorAll('input[type="file"]')
    ).filter(
      (input) =>
        input.isConnected &&
        !input.disabled &&
        input.files &&
        input.files.length > 0
    ).length;

    const info = {
      ancestorChain,
      ariaLabel: clickable.getAttribute("aria-label") || "",
      ariaDisabled: clickable.getAttribute("aria-disabled") || "",
      ancestorAside: Boolean(clickable.closest("aside")),
      ancestorDialog: Boolean(
        clickable.closest('[role="dialog"], [aria-modal="true"]')
      ),
      ancestorForm: Boolean(structuralRoot),
      ancestorMain: Boolean(clickable.closest("main, [role='main']")),
      ancestorMenu: Boolean(
        clickable.closest("[role='menu'], [role='menubar']")
      ),
      ancestorNav: Boolean(clickable.closest("nav")),
      ancestorNavigation: Boolean(clickable.closest("[role='navigation']")),
      ancestorSection: Boolean(clickable.closest("section")),
      ancestorSidebar: Boolean(clickable.closest(sidebarAncestorSelector)),
      actionRegion: actionRegion
        ? {
            className: (actionRegion.className || "").toString(),
            discardCount: actionRegionDiscards.length,
            footerClassName: (actionFooter?.className || "").toString(),
            footerTagName: actionFooter?.tagName || "",
            postCount: actionRegionPosts.length,
          }
        : null,
      className,
      dataE2e: clickable.getAttribute("data-e2e") || "",
      dataAttributes,
      dataTestId: clickable.getAttribute("data-testid") || "",
      disabled: Boolean(clickable.disabled) || clickable.getAttribute("aria-disabled") === "true",
      documentPopulatedFileInputCount,
      formAction: structuralRoot?.getAttribute("action") || "",
      href: anchor ? anchor.getAttribute("href") || "" : "",
      id: clickable.id || "",
      inNavigation,
      nearestButtonOwner: nearestButtonOwner
        ? {
            ariaLabel: nearestButtonOwner.getAttribute("aria-label") || "",
            id: nearestButtonOwner.id || "",
            role: nearestButtonOwner.getAttribute("role") || "",
            tagName: nearestButtonOwner.tagName,
            text: nearestButtonOwner.textContent || "",
          }
        : null,
      pageOrigin: window.location.origin,
      pagePath: window.location.pathname,
      rect: {
        left: rect.left,
        right: rect.right,
        top: rect.top,
        bottom: rect.bottom,
        width: rect.width,
        height: rect.height,
      },
      role: clickable.getAttribute("role") || "",
      structuralBinding,
      tagName: clickable.tagName,
      type: clickable.getAttribute("type") || "",
      text: clickable.textContent || "",
      visible:
        clickable.isConnected &&
        style.display !== "none" &&
        style.visibility !== "hidden" &&
        rect.width > 0 &&
        rect.height > 0,
      viewportHeight: window.innerHeight,
      viewportWidth: window.innerWidth,
    };

    if (!boundaryOptions.inspectFinalBoundary) {
      return info;
    }

    const readinessFingerprint = boundaryOptions.readinessFingerprint;
    const normalizeReadinessText = (value) =>
      String(value || "").trim().replace(/\s+/g, " ");
    const isVisibleReadinessElement = (element) => {
      if (!element?.isConnected) return false;
      const elementStyle = window.getComputedStyle(element);
      const elementRect = element.getBoundingClientRect();
      return (
        elementStyle.display !== "none" &&
        elementStyle.visibility !== "hidden" &&
        elementRect.width > 0 &&
        elementRect.height > 0
      );
    };
    const exactVisibleReadinessAnchors = (selector, title) =>
      Array.from(document.querySelectorAll(selector)).filter(
        (element) =>
          isVisibleReadinessElement(element) &&
          normalizeReadinessText(element.innerText) === title
      );
    const getReadinessStatusText = (section, title) => {
      const text = normalizeReadinessText(section?.innerText);
      const prefix = `${title} `;
      return text.startsWith(prefix) ? text.slice(prefix.length) : "";
    };
    const musicAnchors = exactVisibleReadinessAnchors(
      readinessFingerprint.music.selector,
      readinessFingerprint.music.title
    );
    const contentAnchors = exactVisibleReadinessAnchors(
      readinessFingerprint.content.selector,
      readinessFingerprint.content.title
    );
    const musicSection =
      musicAnchors.length === 1 ? musicAnchors[0].parentElement : null;
    const contentSection =
      contentAnchors.length === 1 ? contentAnchors[0].parentElement : null;

    const visibleDialogCount = Array.from(
      document.querySelectorAll(
        '[role="dialog"], [role="alertdialog"], [aria-modal="true"]'
      )
    ).filter((dialog) => {
      const style = window.getComputedStyle(dialog);
      const rect = dialog.getBoundingClientRect();
      return (
        dialog.isConnected &&
        style.display !== "none" &&
        style.visibility !== "hidden" &&
        rect.width > 0 &&
        rect.height > 0
      );
    }).length;
    const uploadPendingVisible = Array.from(
      document.querySelectorAll("body *")
    ).some(
      (element) =>
        isVisibleReadinessElement(element) &&
        normalizeReadinessText(element.innerText) ===
          readinessFingerprint.uploadPendingText
    );
    const publishReadinessInfo = {
      contentAnchorCount: contentAnchors.length,
      contentStatusText: getReadinessStatusText(
        contentSection,
        readinessFingerprint.content.title
      ),
      musicAnchorCount: musicAnchors.length,
      musicStatusText: getReadinessStatusText(
        musicSection,
        readinessFingerprint.music.title
      ),
      pageOrigin: window.location.origin,
      pagePath: window.location.pathname,
      sameCheckRegion: Boolean(
        musicSection &&
          contentSection &&
          musicSection.parentElement === contentSection.parentElement
      ),
      uploadPendingVisible,
      visibleDialogCount,
    };

    return {
      ...info,
      finalBoundary: {
        publishReadinessInfo,
        sameOwner: clickable === boundaryOptions.originallySelected,
        visibleDialogCount,
      },
    };
  }, {
    inspectFinalBoundary,
    originallySelected,
    readinessFingerprint: TIKTOK_PUBLISH_READINESS,
  });
}

async function getCanonicalPublishOwner(candidate) {
  const ownerHandle = await candidate
    .evaluateHandle(
      (element) =>
        element.closest("button, [role='button'], a") || element
    )
    .catch(() => null);
  if (!ownerHandle) {
    return null;
  }

  const owner = ownerHandle.asElement();
  if (!owner) {
    await ownerHandle.dispose().catch(() => {});
    return null;
  }
  return owner;
}

function getPublishCandidateLocators(page) {
  const exactPublishName = new RegExp(
    `^(?:${uiLabels
      .terms("tiktokPublish")
      .map((label) => escapeRegExp(normalizeUiText(label)))
      .join("|")})$`,
    "i"
  );

  return [
    page.getByRole("button", { name: exactPublishName }),
    page.locator("button, [role='button'], a"),
  ];
}

function isPublishDiagnosticCandidateInfo(
  info,
  publishTerms = uiLabels.terms("tiktokPublish")
) {
  const labels = publishTerms.map(normalizeUiText).filter(Boolean);
  const evidence = normalizeUiText(
    [
      info?.text,
      info?.ariaLabel,
      info?.className,
      info?.dataAttributes,
      info?.dataE2e,
      info?.dataTestId,
    ].join(" ")
  );
  return (
    normalizeUiText(info?.type) === "submit" ||
    labels.some((label) => evidence.includes(label)) ||
    /\b(posts?|publish|submit)\b/.test(evidence)
  );
}

async function collectPublishCandidateDiagnostics(
  page,
  publishTerms = uiLabels.terms("tiktokPublish")
) {
  const owners = [];
  const locatorSources = ["exact-role", "semantic-clickable"];

  try {
    const locators = getPublishCandidateLocators(page);
    for (let locatorIndex = 0; locatorIndex < locators.length; locatorIndex += 1) {
      const locator = locators[locatorIndex];
      const total = await locator.count();
      for (let candidateIndex = 0; candidateIndex < total; candidateIndex += 1) {
        const handle = await getCanonicalPublishOwner(locator.nth(candidateIndex));
        if (!handle) continue;

        let duplicate = null;
        for (const owner of owners) {
          const sameOwner = await handle
            .evaluate((element, other) => element === other, owner.handle)
            .catch(() => false);
          if (sameOwner) {
            duplicate = owner;
            break;
          }
        }

        if (duplicate) {
          duplicate.locatorSources.add(locatorSources[locatorIndex]);
          await handle.dispose().catch(() => {});
          continue;
        }

        const info = await getPublishCandidateInfo(handle).catch(() => null);
        if (!isPublishDiagnosticCandidateInfo(info, publishTerms)) {
          await handle.dispose().catch(() => {});
          continue;
        }
        owners.push({
          handle,
          info,
          locatorSources: new Set([locatorSources[locatorIndex]]),
        });
      }
    }

    const classified = owners.map((owner) => ({
      ...owner,
      classification: classifyPublishCandidateInfo(owner.info, publishTerms),
    }));
    const qualifiedTargetCount = classified.filter(
      ({ classification }) => classification.qualified
    ).length;

    return {
      candidateCount: classified.length,
      qualifiedTargetCount,
      candidates: classified.map((entry, index) => {
        const ambiguous =
          entry.classification.qualified && qualifiedTargetCount !== 1;
        return {
          index,
          status:
            entry.classification.qualified && !ambiguous
              ? "ACCEPTED"
              : "REJECTED",
          reasons: ambiguous
            ? ["ambiguous-qualified-duplicate"]
            : entry.classification.reasons,
          score: entry.classification.score,
          locatorSources: [...entry.locatorSources],
          ...entry.info,
        };
      }),
    };
  } finally {
    await Promise.all(owners.map(({ handle }) => handle.dispose().catch(() => {})));
  }
}

async function disposePublishTargets(targets) {
  await Promise.all(
    targets.map(({ handle }) => handle.dispose().catch(() => {}))
  );
}

async function collectUniquePublishTargets(
  page,
  publishTerms = uiLabels.terms("tiktokPublish")
) {
  const targets = [];

  try {
    for (const locator of getPublishCandidateLocators(page)) {
      const total = await locator.count();
      for (let index = 0; index < total; index += 1) {
        const candidate = locator.nth(index);
        if (!(await candidate.isVisible().catch(() => false))) {
          continue;
        }

        const handle = await getCanonicalPublishOwner(candidate);
        if (!handle) {
          continue;
        }

        const info = await getPublishCandidateInfo(handle).catch(() => null);
        const score = getPublishCandidateScore(info, publishTerms);
        if (score < 0) {
          await handle.dispose().catch(() => {});
          continue;
        }

        let duplicateIndex = -1;
        for (let targetIndex = 0; targetIndex < targets.length; targetIndex += 1) {
          const existing = targets[targetIndex];
          const sameOwner = await handle
            .evaluate(
              (element, other) => element === other,
              existing.handle
            )
            .catch(() => false);
          if (sameOwner) {
            duplicateIndex = targetIndex;
            break;
          }
        }

        if (duplicateIndex < 0) {
          targets.push({ handle, info, score });
          continue;
        }

        const existing = targets[duplicateIndex];
        existing.info = score > existing.score ? info : existing.info;
        existing.score = Math.max(score, existing.score);
        await handle.dispose().catch(() => {});
      }
    }

    targets.sort((a, b) => {
      if (b.score !== a.score) {
        return b.score - a.score;
      }
      return (
        (Number(b.info?.rect?.top) || 0) -
        (Number(a.info?.rect?.top) || 0)
      );
    });
    return targets;
  } catch (error) {
    await disposePublishTargets(targets);
    throw error;
  }
}

async function addDefaultSound(page, source) {
  if (source === "instant-post") {
    console.log("Skipping auto-add sound: Post triggered via Instant Post (video already has sound).");
    return;
  }

  if (!config.autoAddSound) {
    console.log("Auto-add sound disabled by config.");
    return;
  }

  const query = (config.defaultSoundQuery || "").trim();
  if (!query) {
    console.log("Auto-add sound enabled, but DEFAULT_SOUND_QUERY is empty; skipping sound change.");
    return;
  }

  console.log(`Adding sound flow started${query ? `: ${query}` : ""}`);

  async function clickUploadEditorSoundsButton() {
    // Strict targeting for the editor action row under the preview.
    const rowPattern = uiLabels.pattern("tiktokEdit");
    const soundsPattern = uiLabels.pattern("tiktokSounds");
    const textPattern = uiLabels.pattern("tiktokText");

    const rowCandidates = page
      .locator("div, section")
      .filter({ hasText: rowPattern })
      .filter({ hasText: soundsPattern })
      .filter({ hasText: textPattern });

    const rowCount = await rowCandidates.count();
    for (let i = 0; i < rowCount; i += 1) {
      const row = rowCandidates.nth(i);
      const rowVisible = await row.isVisible().catch(() => false);
      if (!rowVisible) {
        continue;
      }

      const box = await row.boundingBox().catch(() => null);
      if (!box) {
        continue;
      }

      // Keep only right-side rows near the phone preview area.
      if (box.x < 520) {
        continue;
      }

      const exactSounds = row.locator(
        uiLabels.textSelector("button", "tiktokSounds") +
          ", " +
          uiLabels.textSelector('[role="button"]', "tiktokSounds")
      );
      const clickedExact = await clickFirstVisibleEnabledLocator(page, exactSounds);
      if (clickedExact) {
        console.log("Sound panel open strategy: strict editor row");
        return true;
      }

      const looseSounds = row.locator("button, [role='button'], div").filter({
        hasText: soundsPattern,
      });
      const clickedLoose = await clickFirstVisibleEnabledLocator(page, looseSounds);
      if (clickedLoose) {
        console.log("Sound panel open strategy: editor row fallback");
        return true;
      }
    }

    // Last resort: right-side clickable element named Sounds/Audio, never nav/aside.
    const soundLabels = uiLabels.terms("tiktokSounds").map((term) => term.toLowerCase());
    const clicked = await page.evaluate((labels) => {
      const isVisible = (el) => {
        const rect = el.getBoundingClientRect();
        return rect.width > 0 && rect.height > 0;
      };

      const nodes = Array.from(document.querySelectorAll("button, [role='button']"));
      for (const el of nodes) {
        const text = (el.textContent || "").trim().toLowerCase();
        if (!labels.includes(text)) {
          continue;
        }
        if (el.closest("nav, aside, [role='navigation']")) {
          continue;
        }
        if (!isVisible(el)) {
          continue;
        }

        const rect = el.getBoundingClientRect();
        // Stronger right-side lock so it cannot hit left menu.
        if (rect.left < window.innerWidth * 0.65) {
          continue;
        }

        el.scrollIntoView({ block: "center", inline: "center" });
        el.click();
        return true;
      }

      return false;
    }, soundLabels);

    if (clicked) {
      console.log("Sound panel open strategy: right-side hard fallback");
      return true;
    }

    return false;
  }

  const previousUrl = page.url();
  const opened = await clickUploadEditorSoundsButton();

  if (!opened) {
    console.log("Could not open sound panel; continuing without sound change.");
    return;
  }

  await page.waitForTimeout(700);
  // Guard: if wrong control caused navigation, jump back to upload page and skip sound.
  if (!page.url().includes("/upload")) {
    console.log(`Sounds click navigated away (${page.url()}); returning to upload page.`);
    await gotoUploadPage(page);
    await page.waitForTimeout(1000);
    return;
  }

  if (page.url() !== previousUrl) {
    console.log(`Upload page URL changed after sounds click: ${page.url()}`);
  }

  await page.waitForTimeout(1000);

  let added = false;

  // The "Use this sound" button in the sound panel is the ArrowLeftRight icon button.
  // The PlusBold icon button is typically disabled. We target both but prefer ArrowLeftRight.
  const useButtonSelector = [
    'button:has([data-testid="ArrowLeftRight"])',
    'button:has([data-icon="ArrowLeftRight"])',
  ].join(", ");

  // Step 1: try direct row match first (avoids flaky input focus/autocomplete issues).
  const queryPattern = new RegExp(escapeRegExp(query), "i");
  const directRow = page
    .locator('[role="listitem"], .MusicPanelMusicItem__wrap')
    .filter({ hasText: queryPattern });
  const directUse = directRow.locator(useButtonSelector);
  added = await clickFirstVisibleEnabledLocator(page, directUse);
  if (added) {
    console.log(`Sound used directly from visible "${query}" row (ArrowLeftRight).`);
    await page.waitForTimeout(1500);
  }

  // Step 2: fallback to search when direct row is unavailable.
  if (!added) {
    const soundSearchInput = page.getByPlaceholder(uiLabels.pattern("tiktokSearchSounds")).first();
    const inputVisible = await soundSearchInput.isVisible().catch(() => false);

    if (!inputVisible) {
      console.log("Sound search input not visible; skipping search.");
    } else {
      const queryPrefix = query.split(/\s+/).slice(0, 2).join(" ");
      const searchQueries = Array.from(new Set([query, queryPrefix].filter(Boolean)));

      for (const currentQuery of searchQueries) {
        await soundSearchInput.click({ timeout: 3000 });
        await page.waitForTimeout(300);

        await soundSearchInput.evaluate((el) => {
          el.focus();
          el.value = "";
          el.dispatchEvent(new Event("input", { bubbles: true }));
        });
        await page.waitForTimeout(200);

        await page.keyboard.type(currentQuery, { delay: 30 });
        await page.waitForTimeout(300);
        await page.keyboard.press("Enter");
        await page.waitForTimeout(2000);

        const typedValue = await soundSearchInput.inputValue().catch(() => "");
        console.log(`Sound search typed: "${typedValue}" (wanted: "${currentQuery}")`);

        const rows = page
          .locator('[role="listitem"], .MusicPanelMusicItem__wrap')
          .filter({ hasText: new RegExp(escapeRegExp(currentQuery), "i") });
        const rowCount = await rows.count();
        if (rowCount === 0) {
          console.log(`No rows found for "${currentQuery}".`);
          continue;
        }

        const maxRowsToTry = Math.min(rowCount, 5);
        for (let i = 0; i < maxRowsToTry; i += 1) {
          const row = rows.nth(i);
          const rowVisible = await row.isVisible().catch(() => false);
          if (!rowVisible) continue;

          const addStrategies = [
            row.locator(useButtonSelector),
            row.locator(".MusicPanelMusicItem__operation button").first(),
          ];

          for (const locator of addStrategies) {
            added = await clickFirstVisibleEnabledLocator(page, locator);
            if (added) {
              console.log(`Sound "${currentQuery}" applied via use-button.`);
              await page.waitForTimeout(1500);
              break;
            }
          }
          if (added) break;
        }
        if (added) break;
      }
    }
  }

  // Step 3: hard fallback - click first enabled use-button in the panel.
  if (!added) {
    const firstUse = page.locator(
      `.MusicPanelMusicItem__operation ${useButtonSelector}`
    );
    added = await clickFirstVisibleEnabledLocator(page, firstUse);
    if (added) {
      console.log("Sound applied via first visible ArrowLeftRight fallback.");
      await page.waitForTimeout(1500);
    }
  }

  if (!added) {
    throw new Error(`Could not click use-button for sound "${query}".`);
  }

  // Step 4: Click "Save" to confirm the sound selection.
  // The sound panel is an overlay; the Publish button may be visible behind it,
  // so we must NOT rely on publishVisible to decide if we are done.
  let saved = false;
  const saveLocator = page.locator("button.Button__root--type-primary, button").filter({
    hasText: uiLabels.pattern("tiktokSave"),
  });

  // Retry a few times with waits; the button may need a moment after the sound loads.
  for (let attempt = 0; attempt < 5; attempt++) {
    saved = await clickFirstVisibleEnabledLocator(page, saveLocator);
    if (saved) {
      console.log(`Sound saved via Save (attempt ${attempt + 1}).`);
      break;
    }
    console.log(`Save not ready yet, waiting... (attempt ${attempt + 1}/5)`);
    await page.waitForTimeout(1500);
  }

  if (!saved) {
    // Last resort: try clicking via page.evaluate to force-find and click the button.
    const saveTerms = uiLabels.terms("tiktokSave").map((term) => term.toLowerCase());
    saved = await page.evaluate((labels) => {
      const buttons = Array.from(document.querySelectorAll("button"));
      const saveBtn = buttons.find(
        (b) =>
          labels.includes((b.textContent || "").trim().toLowerCase())
      );
      if (saveBtn && !saveBtn.disabled) {
        saveBtn.scrollIntoView();
        saveBtn.click();
        return true;
      }
      return false;
    }, saveTerms);
    if (saved) {
      console.log("Sound saved via evaluate fallback.");
    }
  }

  if (!saved) {
    // Check if the panel actually closed on its own.
    const soundSearchStillVisible = await page
      .getByPlaceholder(uiLabels.pattern("tiktokSearchSounds"))
      .first()
      .isVisible()
      .catch(() => false);
    const cancelVisible = await page
      .locator("button")
      .filter({ hasText: uiLabels.pattern("tiktokCancel") })
      .first()
      .isVisible()
      .catch(() => false);

    if (!soundSearchStillVisible && !cancelVisible) {
      console.log("Sound panel closed on its own after applying sound.");
      await page.waitForTimeout(800);
      return;
    }

    console.log(
      "WARNING: Could not click Save. Trying Cancel to avoid stuck panel."
    );
    await clickFirstVisibleEnabledLocator(
      page,
      page.locator("button").filter({ hasText: uiLabels.pattern("tiktokCancel") })
    );
    throw new Error("Could not click Save in sound editor.");
  }

  await page.waitForTimeout(1500);
}

async function disableShortContentCheck(page) {
  const labelPattern =
    uiLabels.pattern("tiktokShortContentCheck");
  const section = page
    .locator("section, div, li, form")
    .filter({ hasText: labelPattern })
    .first();

  if ((await section.count()) === 0) {
    console.log("Short content check toggle not found; continuing.");
    return;
  }

  async function readSwitchState(candidate) {
    return candidate.evaluate((el) => {
      const ariaChecked = (el.getAttribute("aria-checked") || "").toLowerCase();
      if (ariaChecked === "true") {
        return true;
      }
      if (ariaChecked === "false") {
        return false;
      }

      if (el instanceof HTMLInputElement && el.type === "checkbox") {
        return el.checked;
      }

      const className = (el.className || "").toString().toLowerCase();
      if (
        className.includes("checked") ||
        className.includes("active") ||
        className.includes("enabled") ||
        className.includes("on")
      ) {
        return true;
      }
      if (
        className.includes("disabled") ||
        className.includes("inactive") ||
        className.includes("off")
      ) {
        return false;
      }

      return null;
    });
  }

  const switchCandidates = [
    section.locator('[role="switch"]'),
    section.locator('button[aria-checked], button[class*="switch" i], button[class*="toggle" i]'),
    section.locator('input[type="checkbox"]'),
  ];

  for (const pool of switchCandidates) {
    const count = await pool.count();
    for (let i = 0; i < count; i += 1) {
      const candidate = pool.nth(i);
      const visible = await candidate.isVisible().catch(() => false);
      if (!visible) {
        continue;
      }

      await candidate.scrollIntoViewIfNeeded({ timeout: 3000 }).catch(() => { });
      const before = await readSwitchState(candidate).catch(() => null);
      if (before === false) {
        console.log("Short content check already disabled.");
        return;
      }

      await candidate.click({ timeout: 3000, force: true }).catch(() => { });
      await page.waitForTimeout(800);
      const after = await readSwitchState(candidate).catch(() => null);

      if (after === false || (before === true && after !== true)) {
        console.log("Short content check disabled.");
        return;
      }
    }
  }

  console.log("Short content check toggle found but could not be switched off.");
}

async function detectInterferingOverlays(page) {
  const dialogs = page.locator(
    '[role="dialog"], [role="alertdialog"], [aria-modal="true"]'
  );
  const dialogCount = await dialogs.count();
  let visibleDialogCount = 0;

  for (let dialogIndex = 0; dialogIndex < dialogCount; dialogIndex += 1) {
    const dialog = dialogs.nth(dialogIndex);
    if (await dialog.isVisible().catch(() => false)) {
      visibleDialogCount += 1;
    }
  }

  return {
    blocked: visibleDialogCount > 0,
    visibleDialogCount,
  };
}

async function readBodyText(page) {
  return page
    .locator("body")
    .innerText()
    .then((value) => value || "")
    .catch(() => "");
}

async function findUniquePublishTarget(
  page,
  { maxPolls = 6, pollIntervalMs = 2000 } = {}
) {
  const safeMaxPolls = Math.max(1, Number(maxPolls) || 1);
  const safePollIntervalMs = Math.max(0, Number(pollIntervalMs) || 0);

  for (let poll = 0; poll < safeMaxPolls; poll += 1) {
    const targets = await collectUniquePublishTargets(page);
    if (targets.length > 1) {
      const count = targets.length;
      await disposePublishTargets(targets);
      return {
        status: "multiple",
        count,
        reason:
          "Could not safely publish on TikTok: multiple distinct active Publish/Post buttons.",
      };
    }
    if (targets.length === 1) {
      return { status: "unique", target: targets[0] };
    }
    if (poll + 1 < safeMaxPolls) {
      await page.waitForTimeout(safePollIntervalMs);
    }
  }

  return {
    status: "none",
    count: 0,
    reason:
      "Could not find exactly one enabled TikTok Publish/Post button before any click.",
  };
}

async function clickPublishOnce(
  page,
  {
    maxPolls = 6,
    pollIntervalMs = 2000,
    settleMs = 500,
    beforeFinalValidation,
    beforeClick,
    publishResponseTracker,
    operationId,
  } = {}
) {
  const overlayState = await detectInterferingOverlays(page);
  if (overlayState.blocked) {
    return {
      ok: false,
      outcome: "failure",
      retryAllowed: true,
      clickAttempted: false,
      reason:
        "TikTok Publish/Post is blocked by a visible dialog; " +
        "automatic dialog interaction is disabled.",
    };
  }
  await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight));
  await page.waitForTimeout(Math.max(0, Number(settleMs) || 0));

  const resolved = await findUniquePublishTarget(page, {
    maxPolls,
    pollIntervalMs,
  });
  if (resolved.status !== "unique") {
    return {
      ok: false,
      outcome: "failure",
      retryAllowed: true,
      clickAttempted: false,
      reason: resolved.reason,
    };
  }

  const selectedTarget = resolved.target;
  let finalTarget = null;
  const actionGuard = createPublishActionGuard();
  try {
    try {
      await selectedTarget.handle.scrollIntoViewIfNeeded({ timeout: 3000 });
    } catch (error) {
      return {
        ok: false,
        outcome: "failure",
        retryAllowed: true,
        clickAttempted: false,
        reason: `Could not prepare the TikTok Publish/Post button before click: ${error.message}`,
      };
    }

    if (beforeFinalValidation) {
      await beforeFinalValidation();
    }

    if (beforeClick) {
      await beforeClick();
    }

    if (
      publishResponseTracker &&
      typeof publishResponseTracker.beginClick === "function"
    ) {
      publishResponseTracker.beginClick(operationId);
    }

    const finalTargets = await collectUniquePublishTargets(page);
    if (finalTargets.length !== 1) {
      const count = finalTargets.length;
      await disposePublishTargets(finalTargets);
      return {
        ok: false,
        outcome: "failure",
        retryAllowed: true,
        clickAttempted: false,
        reason:
          "TikTok Publish/Post target changed immediately before click: " +
          `expected exactly one canonical owner, observed ${count}.`,
      };
    }

    finalTarget = finalTargets[0];
    const finalBoundaryInfo = await getPublishCandidateInfo(
      finalTarget.handle,
      {
        inspectFinalBoundary: true,
        originallySelected: selectedTarget.handle,
      }
    ).catch(() => null);
    if (!finalBoundaryInfo?.finalBoundary?.sameOwner) {
      return {
        ok: false,
        outcome: "failure",
        retryAllowed: true,
        clickAttempted: false,
        reason:
          "TikTok Publish/Post target identity changed immediately before click.",
      };
    }

    if (finalBoundaryInfo.finalBoundary.visibleDialogCount > 0) {
      return {
        ok: false,
        outcome: "failure",
        retryAllowed: true,
        clickAttempted: false,
        reason:
          "TikTok Publish/Post is blocked by a visible dialog; " +
          "automatic dialog interaction is disabled.",
      };
    }

    const finalReadiness = classifyTikTokPublishReadinessInfo(
      finalBoundaryInfo.finalBoundary.publishReadinessInfo
    );
    if (finalReadiness.status !== "ready") {
      return {
        ok: false,
        outcome: "failure",
        retryAllowed: true,
        clickAttempted: false,
        reason:
          "TikTok publish readiness changed immediately before click: " +
          finalReadiness.reason,
        evidence: finalReadiness.evidence,
      };
    }

    if (getPublishCandidateScore(finalBoundaryInfo) < 0) {
      return {
        ok: false,
        outcome: "failure",
        retryAllowed: true,
        clickAttempted: false,
        reason:
          "TikTok Publish/Post target qualification changed immediately before click.",
      };
    }

    try {
      actionGuard.consume();
      await finalTarget.handle.click({ timeout: 5000 });
    } catch (error) {
      return {
        ok: false,
        outcome: "uncertain",
        retryAllowed: false,
        clickAttempted: true,
        reason:
          "TikTok Publish/Post click had an ambiguous outcome; " +
          `no retry was attempted. ${error.message}`,
      };
    }

    const { info, score } = finalTarget;
    const rect = info?.rect || {};
    console.log(
      `Publish candidate clicked once: "${normalizeUiText(
        info?.text || info?.ariaLabel
      )}" score=${score.toFixed(1)} ` +
        `rect=${Math.round(Number(rect.left) || 0)},${Math.round(
          Number(rect.top) || 0
        )},${Math.round(Number(rect.width) || 0)}x${Math.round(
          Number(rect.height) || 0
        )}`
    );
    return {
      ok: true,
      outcome: "clicked",
      retryAllowed: false,
      clickAttempted: true,
    };
  } finally {
    await selectedTarget.handle.dispose().catch(() => {});
    if (finalTarget) {
      await finalTarget.handle.dispose().catch(() => {});
    }
  }
}

function createPublishActionGuard() {
  let actionAttempted = false;
  return {
    consume() {
      if (actionAttempted) {
        throw new Error("TikTok publish action budget is already exhausted.");
      }
      actionAttempted = true;
    },
    wasAttempted() {
      return actionAttempted;
    },
  };
}

function hasSuccessCueText(text) {
  const successPatterns = [
    uiLabels.pattern("tiktokPublished"),
  ];

  return successPatterns.some((pattern) => pattern.test(text));
}

function hasFailureCueText(text) {
  const failurePatterns = [
    uiLabels.pattern("tiktokFailed"),
  ];

  return failurePatterns.some((pattern) => pattern.test(text));
}

function getExpectedOrigin(value) {
  try {
    return new URL(value).origin;
  } catch {
    return null;
  }
}

function isLikelyPublishApiResponse(response, expectedOrigin) {
  const request = response.request();
  const method = request.method().toUpperCase();

  if (!["POST", "PUT", "PATCH"].includes(method)) {
    return false;
  }

  let parsedUrl;
  try {
    parsedUrl = new URL(response.url());
  } catch {
    return false;
  }
  const allowedOrigin = expectedOrigin || "https://www.tiktok.com";
  if (parsedUrl.origin !== allowedOrigin) {
    return false;
  }

  const pathname = parsedUrl.pathname.toLowerCase();
  const unequivocalEndpointPatterns = [
    /\/publish(?:\/|$)/,
    /\/post\/publish(?:\/|$)/,
    /\/web\/project\/post(?:\/|$)/,
    /\/aweme(?:\/[^/]+)*\/(?:create|commit|publish)(?:\/|$)/,
  ];
  if (unequivocalEndpointPatterns.some((pattern) => pattern.test(pathname))) {
    return true;
  }

  const contextualPostEndpoint =
    /\/(?:api\/)?(?:web\/)?post(?:\/|$)/.test(pathname);
  const postData =
    typeof request.postData === "function" ? request.postData() || "" : "";
  return (
    contextualPostEndpoint &&
    /\b(?:publish|privacy_level|video_id|project_id|caption)\b/i.test(postData)
  );
}

function createPublishResponseTracker(page) {
  let armed = false;
  let clickStarted = false;
  let operationId = null;
  let expectedOrigin = null;
  let publishApiSuccess = null;
  let publishApiFailure = null;
  let startedRequests = new WeakSet();

  const requestHandler = (request) => {
    if (!armed || !clickStarted) {
      return;
    }
    const candidate = {
      request: () => request,
      url: () => request.url(),
    };
    if (isLikelyPublishApiResponse(candidate, expectedOrigin)) {
      startedRequests.add(request);
    }
  };

  const responseHandler = (response) => {
    if (!armed || !clickStarted) {
      return;
    }
    const request = response.request();
    if (
      !startedRequests.has(request) ||
      !isLikelyPublishApiResponse(response, expectedOrigin)
    ) {
      return;
    }

    const status = response.status();
    const url = response.url();
    const method = response.request().method().toUpperCase();
    const evidence = {
      type: "http",
      method,
      status,
      url,
      operationId,
      expectedOriginMatched: true,
      requestStartedAfterClick: true,
      responseCompletedAfterClick: true,
      currentVideoMatched: false,
    };

    if (status >= 200 && status < 300) {
      publishApiSuccess = evidence;
      console.log(`Publish API success: ${method} ${status} ${url}`);
      return;
    }

    if (status >= 400) {
      publishApiFailure = {
        ...evidence,
        reason: `Publish API returned ${status}: ${method} ${url}`,
      };
      console.log(publishApiFailure.reason);
    }
  };

  page.on("request", requestHandler);
  page.on("response", responseHandler);

  return {
    arm() {
      expectedOrigin = getExpectedOrigin(page.url());
      publishApiSuccess = null;
      publishApiFailure = null;
      startedRequests = new WeakSet();
      clickStarted = false;
      operationId = null;
      armed = true;
    },
    beginClick(currentOperationId) {
      if (!armed) {
        return;
      }
      operationId = currentOperationId || null;
      clickStarted = true;
    },
    dispose() {
      page.off("request", requestHandler);
      page.off("response", responseHandler);
    },
    failure() {
      return publishApiFailure;
    },
    success() {
      return publishApiSuccess;
    },
  };
}

function isAuthoritativePublishEvidence(evidence) {
  return Boolean(
    evidence &&
      evidence.type === "http" &&
      evidence.expectedOriginMatched === true &&
      evidence.requestStartedAfterClick === true &&
      evidence.responseCompletedAfterClick === true &&
      evidence.currentVideoMatched === true &&
      typeof evidence.operationId === "string" &&
      evidence.operationId.length > 0 &&
      typeof evidence.postId === "string" &&
      evidence.postId.length > 0
  );
}

const PUBLISH_CONFIRMATION_SURFACE_SELECTOR = [
  "[role='alert']",
  "[role='status']",
  "[aria-live='assertive']",
  "[aria-live='polite']",
  "[data-e2e*='toast' i]",
  "[data-testid*='toast' i]",
  "[class*='toast' i]",
  "[class*='snackbar' i]",
  "[class*='notification' i]",
].join(", ");

async function captureVisiblePublishConfirmationSurfaces(page) {
  const surfaces = [];
  const locator = page.locator(PUBLISH_CONFIRMATION_SURFACE_SELECTOR);
  const count = await locator.count();

  try {
    for (let index = 0; index < count; index += 1) {
      const candidate = locator.nth(index);
      const visible = await candidate
        .evaluate((element) => {
          const style = window.getComputedStyle(element);
          const rect = element.getBoundingClientRect();
          return (
            style.display !== "none" &&
            style.visibility !== "hidden" &&
            style.visibility !== "collapse" &&
            Number(style.opacity || "1") > 0 &&
            rect.width > 0 &&
            rect.height > 0
          );
        })
        .catch(() => false);
      if (!visible) {
        continue;
      }

      const handle = await candidate.elementHandle().catch(() => null);
      if (!handle) {
        continue;
      }
      const text = await candidate.innerText().catch(() => "");
      surfaces.push({ handle, text: normalizeUiText(text) });
    }
    return surfaces;
  } catch (error) {
    await disposeConfirmationSurfaces(surfaces);
    throw error;
  }
}

async function disposeConfirmationSurfaces(surfaces) {
  await Promise.all(
    (surfaces || []).map(({ handle }) => handle.dispose().catch(() => {}))
  );
}

async function findNewVisibleScopedSuccess(page, baselineSurfaces) {
  const currentSurfaces =
    await captureVisiblePublishConfirmationSurfaces(page);
  try {
    for (const current of currentSurfaces) {
      if (!hasSuccessCueText(current.text)) {
        continue;
      }

      let existedBeforeClick = false;
      for (const baseline of baselineSurfaces || []) {
        const sameElement = await current.handle
          .evaluate((element, previous) => element === previous, baseline.handle)
          .catch(() => false);
        if (sameElement) {
          existedBeforeClick = true;
          break;
        }
      }

      if (!existedBeforeClick) {
        return {
          type: "dom",
          scope: "publish-confirmation-surface",
          text: current.text,
          visible: true,
          observedAfterClick: true,
        };
      }
    }
    return null;
  } finally {
    await disposeConfirmationSurfaces(currentSurfaces);
  }
}

function getAllowlistedPublishNavigation(startedUrl, currentUrl) {
  let started;
  let current;
  try {
    started = new URL(startedUrl);
    current = new URL(currentUrl);
  } catch {
    return null;
  }

  const startedWithoutHash = `${started.origin}${started.pathname}${started.search}`;
  const currentWithoutHash = `${current.origin}${current.pathname}${current.search}`;
  if (startedWithoutHash === currentWithoutHash) {
    return null;
  }
  if (started.origin !== current.origin) {
    return null;
  }

  const successPaths = [
    /^\/tiktokstudio\/(?:content|posts|manage)(?:\/|$)/i,
    /^\/creator-center\/(?:content|posts|manage)(?:\/|$)/i,
  ];
  if (!successPaths.some((pattern) => pattern.test(current.pathname))) {
    return null;
  }

  return {
    type: "navigation",
    from: startedWithoutHash,
    to: currentWithoutHash,
  };
}

async function waitForPublishConfirmation(
  page,
  responseTracker,
  {
    startedUrl = page.url(),
    baselineSurfaces = [],
    maxPolls = 30,
    pollIntervalMs = 2000,
  } = {}
) {
  const tracker = responseTracker || createPublishResponseTracker(page);
  const ownsTracker = !responseTracker;
  const safeMaxPolls = Math.max(1, Number(maxPolls) || 1);
  const safePollIntervalMs = Math.max(0, Number(pollIntervalMs) || 0);
  if (ownsTracker && typeof tracker.arm === "function") {
    tracker.arm();
  }
  let lastUnboundHint = null;

  try {
    for (let poll = 0; poll < safeMaxPolls; poll += 1) {
      const publishApiFailure = tracker.failure();
      if (publishApiFailure) {
        return {
          ok: false,
          outcome: "failure",
          retryAllowed: false,
          reason: publishApiFailure.reason || String(publishApiFailure),
          evidence: publishApiFailure,
        };
      }

      const publishApiSuccess = tracker.success();
      if (isAuthoritativePublishEvidence(publishApiSuccess)) {
        return {
          ok: true,
          outcome: "success",
          retryAllowed: false,
          reason: "Publish API call succeeded.",
          evidenceStrength: "strong",
          evidence: publishApiSuccess,
        };
      }
      if (publishApiSuccess) {
        lastUnboundHint = publishApiSuccess;
      }

      const bodyText = await readBodyText(page);
      if (hasFailureCueText(bodyText)) {
        return {
          ok: false,
          outcome: "failure",
          retryAllowed: false,
          reason: "TikTok displayed an explicit error after publish click.",
        };
      }

      const scopedSuccess = await findNewVisibleScopedSuccess(
        page,
        baselineSurfaces
      );
      if (scopedSuccess) {
        lastUnboundHint = scopedSuccess;
      }
      const navigationEvidence = getAllowlistedPublishNavigation(
        startedUrl,
        page.url()
      );
      if (navigationEvidence) {
        lastUnboundHint = navigationEvidence;
      }

      if (poll + 1 < safeMaxPolls) {
        await page.waitForTimeout(safePollIntervalMs);
      }
    }

    return {
      ok: false,
      outcome: "uncertain",
      retryAllowed: false,
      reason:
        "No operation-bound TikTok publish confirmation observed within timeout. " +
        "Publication may have succeeded; no retry was attempted.",
      evidence: lastUnboundHint || undefined,
    };
  } finally {
    if (ownsTracker) {
      tracker.dispose();
    }
  }
}

async function publishFailClosed(
  page,
  responseTracker,
  {
    findMaxPolls = 6,
    findPollIntervalMs = 2000,
    settleMs = 500,
    confirmationMaxPolls = 30,
    confirmationPollIntervalMs = 2000,
    readinessMaxWaitMs = 12 * 60 * 1000,
    readinessPollIntervalMs = 5000,
    readinessStablePolls = 2,
    beforeFinalValidation,
  } = {}
) {
  const overlayState = await detectInterferingOverlays(page);
  if (overlayState.blocked) {
    return {
      ok: false,
      outcome: "failure",
      retryAllowed: true,
      clickAttempted: false,
      reason:
        "TikTok Publish/Post is blocked by a visible dialog; " +
        "automatic dialog interaction is disabled.",
    };
  }
  const baselineBodyText = await readBodyText(page);
  if (hasFailureCueText(baselineBodyText)) {
    return {
      ok: false,
      outcome: "failure",
      retryAllowed: true,
      clickAttempted: false,
      reason:
        "TikTok displayed an explicit error before the Publish/Post action.",
    };
  }

  const readiness = await waitForTikTokPublishReadiness(page, {
    maxWaitMs: readinessMaxWaitMs,
    pollIntervalMs: readinessPollIntervalMs,
    requiredStablePolls: readinessStablePolls,
  });
  if (!readiness.ok) {
    return readiness;
  }

  const tracker = responseTracker || createPublishResponseTracker(page);
  const ownsTracker = !responseTracker;
  const operationId = crypto.randomUUID();
  let startedUrl = page.url();
  let baselineSurfaces = [];
  try {
    const clickResult = await clickPublishOnce(page, {
      maxPolls: findMaxPolls,
      pollIntervalMs: findPollIntervalMs,
      settleMs,
      beforeFinalValidation,
      beforeClick: async () => {
        baselineSurfaces =
          await captureVisiblePublishConfirmationSurfaces(page);
        startedUrl = page.url();
        if (typeof tracker.arm === "function") {
          tracker.arm();
        }
      },
      publishResponseTracker: tracker,
      operationId,
    });
    if (!clickResult.ok) {
      return clickResult;
    }

    try {
      const confirmation = await waitForPublishConfirmation(page, tracker, {
        startedUrl,
        baselineSurfaces,
        maxPolls: confirmationMaxPolls,
        pollIntervalMs: confirmationPollIntervalMs,
      });
      return {
        ...confirmation,
        clickAttempted: clickResult.clickAttempted,
      };
    } catch (error) {
      return {
        ok: false,
        outcome: "uncertain",
        retryAllowed: false,
        clickAttempted: clickResult.clickAttempted,
        reason:
          "TikTok publish confirmation could not be inspected after the click; " +
          `no retry was attempted. ${error.message}`,
      };
    }
  } finally {
    await disposeConfirmationSurfaces(baselineSurfaces);
    if (ownsTracker) {
      tracker.dispose();
    }
  }
}

async function waitForUploadReady(page) {
  await page.waitForTimeout(Math.max(config.postDelayMs, 5000));
}

async function holdBrowserBeforeClose(page, holdMs, reason) {
  if (!Number.isFinite(holdMs) || holdMs <= 0) {
    return;
  }

  console.log(`Holding browser for ${holdMs}ms (${reason}).`);
  await page.waitForTimeout(holdMs).catch(() => { });
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
  const saved = await hasSavedPlatformSession("tiktok", activeAccount.id);
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

async function startLoginSessionCli() {
  const result = await startLoginSession();

  console.log("");
  console.log("Log in to TikTok in the opened browser window.");
  console.log("After login is complete, press Ctrl+C in this terminal.");
  console.log("Your session will be reused for future automated posts.");
  console.log("");

  if (result.alreadyOpen) {
    return;
  }

  await new Promise(() => {
    // Keep process alive until manual interruption.
  });
}

async function uploadVideo({ videoPath, caption, source, accountId }) {
  const absoluteVideoPath = path.resolve(videoPath);
  const context = await openPersistentContext(accountId);
  const page = context.pages()[0] || (await context.newPage());
  let closeHoldMs = 0;
  let publishResponseTracker = null;

  try {
    if (config.autoAddSound) {
      throw new Error(
        "Automatic TikTok sound-panel interaction is disabled by the " +
          "fail-closed publishing policy."
      );
    }
    await gotoUploadPage(page);
    await setVideoFile(page, absoluteVideoPath);
    await waitForUploadReady(page);
    await setCaption(page, caption || config.defaultCaption);
    publishResponseTracker = createPublishResponseTracker(page);
    const confirmation = await publishFailClosed(
      page,
      publishResponseTracker
    );
    if (!confirmation.ok) {
      const error = new Error(
        `Publish verification failed: ${confirmation.reason}`
      );
      error.outcome = confirmation.outcome;
      error.retryAllowed = confirmation.retryAllowed;
      error.reason = confirmation.reason;
      error.evidence = confirmation.evidence;
      error.clickAttempted = confirmation.clickAttempted;
      throw error;
    }

    const successScreenshotPath = path.resolve(
      config.projectRoot,
      "last-upload-success.png"
    );
    await page
      .screenshot({ path: successScreenshotPath, fullPage: true })
      .catch(() => { });

    closeHoldMs = Math.max(config.postPublishHoldMs, 0);
    return {
      ok: true,
      outcome: "success",
      retryAllowed: false,
      reason: confirmation.reason,
      evidence: confirmation.evidence,
      clickAttempted: confirmation.clickAttempted,
    };
  } catch (error) {
    const screenshotPath = path.resolve(
      config.projectRoot,
      "last-upload-error.png"
    );
    await page.screenshot({ path: screenshotPath, fullPage: true }).catch(() => { });
    closeHoldMs = Math.max(config.failureHoldMs, 0);
    return {
      ok: false,
      outcome: error.outcome || "failure",
      retryAllowed:
        typeof error.retryAllowed === "boolean"
          ? error.retryAllowed
          : true,
      error: error.message,
      reason: error.reason || error.message,
      evidence: error.evidence,
      clickAttempted: getPublishClickAttempted(error),
      screenshotPath,
    };
  } finally {
    if (publishResponseTracker) {
      publishResponseTracker.dispose();
    }
    await holdBrowserBeforeClose(page, closeHoldMs, "post-finalization");
    await context.close();
  }
}

module.exports = {
  startLoginSession: startLoginSessionCli,
  startDashboardLoginSession: startLoginSession,
  getLoginSessionStatus,
  closeLoginSession,
  uploadVideo,
  _private: {
    classifyPublishCandidateInfo,
    classifyTikTokPublishReadinessInfo,
    clickPublishOnce,
    collectTikTokPublishReadinessInfo,
    collectUniquePublishTargets,
    collectPublishCandidateDiagnostics,
    createPublishActionGuard,
    createPublishResponseTracker,
    detectInterferingOverlays,
    dismissKnownTikTokEditorOnboarding,
    dismissKnownTikTokPrePublishOnboarding,
    findUniquePublishTarget,
    getPublishClickAttempted,
    getPublishCandidateScore,
    getAllowlistedPublishNavigation,
    isLikelyPublishApiResponse,
    isAuthoritativePublishEvidence,
    isLikelyPublishCandidateInfo,
    publishFailClosed,
    setCaption,
    waitForTikTokPublishReadiness,
    waitForPublishConfirmation,
  },
};
