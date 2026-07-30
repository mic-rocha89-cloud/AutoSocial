const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const { chromium } = require("playwright");

const uiLabels = require("../src/platform-ui-labels");
const { _private } = require("../src/youtube-uploader");

const {
  classifyYouTubePublishStatusChanges,
  classifyYouTubePublishText,
  clickNext,
  getActiveUploadSurface,
  markNotMadeForKids,
  openUploadDialog,
  parseYouTubeVideoReference,
  sanitizeDiagnosticUrl,
  setNotAgeRestricted,
  setTitleAndDescription,
  setVideoFile,
  setVisibilityAndPublish,
  waitForPublishConfirmation,
} = _private;

test("YouTube UI labels recognize the observed PT-BR controls", () => {
  assert.equal(uiLabels.pattern("youtubeCreate").test("Criar"), true);
  assert.equal(
    uiLabels.pattern("youtubeUploadVideo").test("Enviar v\u00eddeos"),
    true
  );
  assert.equal(
    uiLabels.pattern("youtubeSelectFiles").test("Selecionar arquivos"),
    true
  );
  assert.equal(uiLabels.pattern("youtubeNext").test("Pr\u00f3ximo"), true);
  assert.equal(uiLabels.pattern("youtubeNext").test("Avancar"), true);
  assert.equal(uiLabels.pattern("youtubeNext").test("Avan\u00e7ar"), true);
  assert.equal(
    uiLabels
      .pattern("youtubeNotMadeForKids")
      .test("N\u00e3o, n\u00e3o \u00e9 conte\u00fado para crian\u00e7as"),
    true
  );
  assert.equal(uiLabels.pattern("youtubePublic").test("P\u00fablico"), true);
  assert.equal(uiLabels.pattern("youtubePublish").test("Publicar"), true);
  assert.equal(uiLabels.pattern("youtubeSave").test("Salvar"), true);
  assert.equal(
    uiLabels.pattern("youtubePublished").test("V\u00eddeo publicado"),
    true
  );
});

test("YouTube hydration diagnostics redact URL query and fragment", () => {
  assert.equal(
    sanitizeDiagnosticUrl(
      "https://accounts.google.com/o/oauth2/auth?state=secret#session"
    ),
    "https://accounts.google.com/o/oauth2/auth"
  );
  assert.equal(sanitizeDiagnosticUrl("about:blank"), "about:blank");
});

test("YouTube Create and Upload videos expose an empty file input in PT-BR", async (t) => {
  const browser = await chromium.launch({ headless: true });
  t.after(() => browser.close());
  const page = await browser.newPage();

  await page.setContent(`
    <script>
      window.youtubeUploadClicks = { create: 0, upload: 0 };
    </script>
    <input
      type="file"
      accept="video/mp4"
      data-testid="background-file-input"
    />
    <ytcp-button class="ytcpAppHeaderCreateIcon">
      <button
        aria-label="Criar"
        onclick="
          window.youtubeUploadClicks.create += 1;
          document.querySelector('#upload-menu').hidden = false;
        "
      >
        Criar
      </button>
    </ytcp-button>
    <div
      id="upload-menu"
      role="menuitem"
      hidden
      onclick="
        window.youtubeUploadClicks.upload += 1;
        const dialog = document.createElement('div');
        dialog.id = 'youtube-upload-dialog';
        dialog.setAttribute('role', 'dialog');
        const select = document.createElement('button');
        select.textContent = 'Selecionar arquivos';
        const input = document.createElement('input');
        input.type = 'file';
        input.accept = 'video/*';
        input.dataset.testid = 'youtube-file-input';
        dialog.appendChild(select);
        dialog.appendChild(input);
        document.body.appendChild(dialog);

        const otherDialog = document.createElement('div');
        otherDialog.id = 'unrelated-video-dialog';
        otherDialog.setAttribute('role', 'dialog');
        const otherInput = document.createElement('input');
        otherInput.type = 'file';
        otherInput.accept = 'video/*';
        otherInput.dataset.testid = 'unrelated-video-input';
        otherDialog.appendChild(otherInput);
        document.body.appendChild(otherDialog);
      "
    >
      Enviar v\u00eddeos
    </div>
  `);

  let fileChooserEvents = 0;
  page.on("filechooser", () => {
    fileChooserEvents += 1;
  });

  assert.equal(await openUploadDialog(page), true);
  const input = page.locator('input[data-testid="youtube-file-input"]');
  assert.equal(await input.count(), 1);
  assert.equal(
    await input.evaluate((element) => element.files.length),
    0
  );
  const backgroundInput = page.locator(
    'input[data-testid="background-file-input"]'
  );
  const unrelatedInput = page.locator(
    'input[data-testid="unrelated-video-input"]'
  );
  assert.equal(
    await backgroundInput.evaluate((element) => element.files.length),
    0
  );
  assert.equal(
    await unrelatedInput.evaluate((element) => element.files.length),
    0
  );
  assert.equal(
    await (await getActiveUploadSurface(page)).getAttribute("id"),
    "youtube-upload-dialog"
  );
  assert.equal(fileChooserEvents, 0);
  assert.deepEqual(
    await page.evaluate(() => window.youtubeUploadClicks),
    { create: 1, upload: 1 }
  );

  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "autosocial-youtube-"));
  const videoPath = path.join(tempDir, "qa-video.mp4");
  await fs.writeFile(videoPath, "local-test-video");
  t.after(() => fs.rm(tempDir, { recursive: true, force: true }));

  await setVideoFile(page, videoPath);
  assert.equal(
    await input.evaluate((element) => element.files[0].name),
    "qa-video.mp4"
  );
  assert.equal(
    await backgroundInput.evaluate((element) => element.files.length),
    0
  );
  assert.equal(
    await unrelatedInput.evaluate((element) => element.files.length),
    0
  );
  assert.deepEqual(
    await page.evaluate(() => window.youtubeUploadClicks),
    { create: 1, upload: 1 }
  );
});

test("YouTube waits for a delayed PT-BR Create button", async (t) => {
  const browser = await chromium.launch({ headless: true });
  t.after(() => browser.close());
  const page = await browser.newPage();

  await page.setContent(`
    <script>
      window.youtubeDelayedClicks = {
        decoy: 0,
        create: 0,
        upload: 0
      };
      window.setTimeout(() => {
        const host = document.createElement('ytcp-button');
        host.className = 'ytcpAppHeaderCreateIcon';
        const create = document.createElement('button');
        create.setAttribute('aria-label', 'Criar');
        create.textContent = 'Criar';
        create.onclick = () => {
          window.youtubeDelayedClicks.create += 1;
          document.querySelector('#delayed-upload-menu').hidden = false;
        };
        host.appendChild(create);
        document.body.appendChild(host);
      }, 150);
    </script>
    <button
      aria-label="Criar rascunho"
      onclick="window.youtubeDelayedClicks.decoy += 1"
    >
      Criar rascunho
    </button>
    <div
      id="delayed-upload-menu"
      role="menuitem"
      hidden
      onclick="
        window.youtubeDelayedClicks.upload += 1;
        const dialog = document.createElement('div');
        dialog.id = 'delayed-youtube-upload-dialog';
        dialog.setAttribute('role', 'dialog');
        const select = document.createElement('button');
        select.textContent = 'Selecionar arquivos';
        const input = document.createElement('input');
        input.type = 'file';
        input.accept = 'video/*';
        dialog.appendChild(select);
        dialog.appendChild(input);
        document.body.appendChild(dialog);
      "
    >
      Enviar v\u00eddeos
    </div>
  `);

  assert.equal(
    await openUploadDialog(page, {
      hydrationTimeoutMs: 2000,
      hydrationPollIntervalMs: 25,
    }),
    true
  );
  assert.equal(
    await (await getActiveUploadSurface(page)).getAttribute("id"),
    "delayed-youtube-upload-dialog"
  );
  assert.deepEqual(
    await page.evaluate(() => window.youtubeDelayedClicks),
    { decoy: 0, create: 1, upload: 1 }
  );
});

test("YouTube refuses a background-only file input", async (t) => {
  const browser = await chromium.launch({ headless: true });
  t.after(() => browser.close());
  const page = await browser.newPage();
  await page.setContent(`
    <script>
      window.youtubeBackgroundClicks = {
        createDecoy: 0,
        directUpload: 0
      };
    </script>
    <button
      aria-label="Criar rascunho"
      onclick="window.youtubeBackgroundClicks.createDecoy += 1"
    >
      Criar rascunho
    </button>
    <a
      href="/channel/test/videos/upload"
      onclick="
        event.preventDefault();
        window.youtubeBackgroundClicks.directUpload += 1;
      "
    >
      Envio direto
    </a>
    <input
      type="file"
      accept="video/mp4"
      data-testid="background-file-input"
    />
  `);

  const tempDir = await fs.mkdtemp(
    path.join(os.tmpdir(), "autosocial-youtube-background-")
  );
  const videoPath = path.join(tempDir, "must-not-attach.mp4");
  await fs.writeFile(videoPath, "local-test-video");
  t.after(() => fs.rm(tempDir, { recursive: true, force: true }));

  const hydrationOptions = {
    hydrationTimeoutMs: 100,
    hydrationPollIntervalMs: 20,
  };
  await assert.rejects(
    openUploadDialog(page, hydrationOptions),
    /YouTube Studio did not expose a ready upload entry within 100ms/
  );
  await assert.rejects(
    setVideoFile(page, videoPath, hydrationOptions),
    /YouTube Studio did not expose a ready upload entry within 100ms/
  );
  assert.equal(
    await page
      .locator('input[data-testid="background-file-input"]')
      .evaluate((element) => element.files.length),
    0
  );
  assert.deepEqual(
    await page.evaluate(() => window.youtubeBackgroundClicks),
    { createDecoy: 0, directUpload: 0 }
  );
});

test("YouTube prefers the upload dialog over nested upload progress", async (t) => {
  const browser = await chromium.launch({ headless: true });
  t.after(() => browser.close());
  const page = await browser.newPage();

  await page.setContent(`
    <ytcp-uploads-dialog id="youtube-upload-wizard">
      <div id="title-textarea">
        <div id="textbox" role="textbox" contenteditable="true">
          autosocial qa youtube 20260726 retry1
        </div>
      </div>
      <div id="description-textarea">
        <div id="textbox" role="textbox" contenteditable="true"></div>
      </div>
      <ytcp-video-upload-progress id="nested-upload-progress">
        O processamento come\u00e7ar\u00e1 em breve
      </ytcp-video-upload-progress>
    </ytcp-uploads-dialog>
  `);

  const uploadDialog = page.locator("#youtube-upload-wizard");
  const uploadProgress = page.locator("#nested-upload-progress");
  assert.equal(await uploadDialog.isVisible(), true);
  assert.equal(await uploadProgress.isVisible(), true);

  const surface = await getActiveUploadSurface(page);
  assert.equal(await surface.getAttribute("id"), "youtube-upload-wizard");
  assert.equal(await surface.evaluate((element) => element.tagName), "YTCP-UPLOADS-DIALOG");

  const caption = "Metadados controlados no modal externo";
  await setTitleAndDescription(page, caption, "fallback-title");
  assert.equal(
    await page
      .locator('#title-textarea #textbox[contenteditable="true"]')
      .textContent(),
    caption
  );
  assert.equal(
    await page
      .locator('#description-textarea #textbox[contenteditable="true"]')
      .textContent(),
    caption
  );
  assert.equal(
    (await uploadProgress.textContent()).trim(),
    "O processamento come\u00e7ar\u00e1 em breve"
  );
});

test("YouTube recognizes the uploads host through its visible paper dialog child", async (t) => {
  const browser = await chromium.launch({ headless: true });
  t.after(() => browser.close());
  const page = await browser.newPage();

  await page.setContent(`
    <style>
      #child-visible-upload-host {
        visibility: hidden;
      }
      #child-visible-upload-host > tp-yt-paper-dialog#dialog {
        visibility: visible;
        display: block;
        width: 640px;
        height: 360px;
      }
      #child-visible-upload-host ytcp-video-upload-progress {
        visibility: visible;
        display: block;
      }
    </style>
    <ytcp-uploads-dialog id="child-visible-upload-host">
      <tp-yt-paper-dialog id="dialog" role="dialog">
        <div id="title-textarea">
          <div id="textbox" role="textbox" contenteditable="true">
            T\u00edtulo controlado
          </div>
        </div>
        <div id="description-textarea">
          <div id="textbox" role="textbox" contenteditable="true"></div>
        </div>
        <ytcp-video-upload-progress id="child-visible-progress">
          Envio conclu\u00eddo
        </ytcp-video-upload-progress>
      </tp-yt-paper-dialog>
    </ytcp-uploads-dialog>
  `);

  const host = page.locator("#child-visible-upload-host");
  const paperDialog = host.locator("tp-yt-paper-dialog#dialog");
  assert.equal(await host.isVisible(), false);
  assert.equal(await paperDialog.isVisible(), true);

  const surface = await getActiveUploadSurface(page);
  assert.equal(await surface.getAttribute("id"), "child-visible-upload-host");
  assert.equal(
    await surface.evaluate((element) => element.tagName),
    "YTCP-UPLOADS-DIALOG"
  );
});

test("YouTube PT-BR wizard completes metadata and localized controls", async (t) => {
  const browser = await chromium.launch({ headless: true });
  t.after(() => browser.close());
  const page = await browser.newPage();

  await page.setContent(`
    <script>
      window.youtubeWizardClicks = {
        kids: 0,
        next: 0,
        public: 0,
        publish: 0
      };
      window.advanceYoutubeWizard = (button) => {
        window.youtubeWizardClicks.next += 1;
        button.disabled = true;
        if (window.youtubeWizardClicks.next === 2) {
          const doneHost = document.createElement('ytcp-button');
          doneHost.id = 'done-button';
          const done = document.createElement('button');
          done.textContent = 'Conclu\u00eddo';
          doneHost.appendChild(done);
          document.querySelector('#upload-wizard').appendChild(doneHost);
        } else {
          setTimeout(() => {
            button.disabled = false;
          }, 250);
        }
      };
    </script>

    <main>
      <button
        aria-label="Avan\u00e7ar"
        onclick="window.youtubeWizardClicks.backgroundNext = true"
      >
        Avan\u00e7ar
      </button>
    </main>

    <div id="upload-wizard" role="dialog">
      <textarea aria-label="T\u00edtulo"></textarea>
      <textarea aria-label="Descri\u00e7\u00e3o"></textarea>

      <tp-yt-paper-radio-button
        name="VIDEO_MADE_FOR_KIDS_NOT_MFK"
        role="radio"
        aria-checked="false"
        onclick="
          window.youtubeWizardClicks.kids += 1;
          this.setAttribute('aria-checked', 'true');
        "
      >
        N\u00e3o, n\u00e3o \u00e9 conte\u00fado para crian\u00e7as
      </tp-yt-paper-radio-button>

      <tp-yt-paper-radio-button
        name="VIDEO_AGE_RESTRICTION_NONE"
        role="radio"
        aria-checked="true"
      >
        N\u00e3o restringir para maiores de 18 anos
      </tp-yt-paper-radio-button>

      <button aria-label="Avan\u00e7ar" onclick="window.advanceYoutubeWizard(this)">
        Avan\u00e7ar
      </button>
    </div>
  `);

  const caption = "T\u00edtulo controlado para regress\u00e3o";
  await setTitleAndDescription(page, caption, "fallback-title");
  assert.equal(
    await page.locator('textarea[aria-label="T\u00edtulo"]').inputValue(),
    caption
  );
  assert.equal(
    await page.locator('textarea[aria-label="Descri\u00e7\u00e3o"]').inputValue(),
    caption
  );

  await markNotMadeForKids(page);
  await setNotAgeRestricted(page);
  await clickNext(page);
  assert.equal(
    await page.evaluate(() => window.youtubeWizardClicks.kids),
    1
  );
  assert.equal(
    await page.evaluate(() => window.youtubeWizardClicks.next),
    2
  );
  assert.notEqual(
    await page.evaluate(() => window.youtubeWizardClicks.backgroundNext),
    true
  );

  await page
    .locator("ytcp-button#done-button")
    .evaluateAll((elements) => elements.forEach((element) => element.remove()));
  await page
    .locator('#upload-wizard button[aria-label="Avan\u00e7ar"]')
    .evaluateAll((elements) => elements.forEach((element) => element.remove()));
  await page.setContent(`
    <script>
      window.youtubePublishClicks = {
        public: 0,
        publish: 0,
        save: 0,
        compoundPublish: 0,
        backgroundPublish: 0,
        unrelatedPublic: 0,
        unrelatedPublish: 0
      };
    </script>
    <div role="alert">V\u00eddeo publicado</div>
    <main>
      <button onclick="window.youtubePublishClicks.backgroundPublish += 1">
        Publicar
      </button>
    </main>
    <div role="dialog" id="publish-dialog">
      <button
        name="PUBLIC"
        role="radio"
        aria-label="P\u00fablico"
        aria-checked="false"
        onclick="
          window.youtubePublishClicks.public += 1;
          this.setAttribute('aria-checked', 'true');
        "
      >
        P\u00fablico
      </button>
      <button onclick="window.youtubePublishClicks.save += 1">Salvar</button>
      <button onclick="window.youtubePublishClicks.compoundPublish += 1">
        Publicar depois
      </button>
      <button
        onclick="
          window.youtubePublishClicks.publish += 1;
          const result = document.createElement('div');
          result.textContent = 'V\u00eddeo publicado';
          document.querySelector('#publish-dialog').appendChild(result);
        "
      >
        Publicar
      </button>
    </div>
    <div role="dialog" id="unrelated-dialog">
      <button
        role="radio"
        aria-label="P\u00fablico"
        aria-checked="false"
        onclick="window.youtubePublishClicks.unrelatedPublic += 1"
      >
        P\u00fablico
      </button>
      <button onclick="window.youtubePublishClicks.unrelatedPublish += 1">
        Publicar
      </button>
    </div>
  `);

  const activeSurface = await getActiveUploadSurface(page);
  assert.equal(await activeSurface.getAttribute("id"), "publish-dialog");
  const publishAttempt = await setVisibilityAndPublish(page);
  assert.equal(publishAttempt.ok, true);
  assert.deepEqual(
    await page.evaluate(() => window.youtubePublishClicks),
    {
      public: 1,
      publish: 1,
      save: 0,
      compoundPublish: 0,
      backgroundPublish: 0,
      unrelatedPublic: 0,
      unrelatedPublish: 0,
    }
  );
  const confirmation = await waitForPublishConfirmation(
    page,
    publishAttempt.baselineTexts
  );
  assert.equal(confirmation.ok, true);
  assert.equal(confirmation.confirmed, true);
  assert.equal(confirmation.evidenceType, "upload-surface");
  assert.equal(confirmation.matchedText, "V\u00eddeo publicado");
  assert.equal(confirmation.videoUrl, null);
  assert.equal(confirmation.videoId, null);
});

test("YouTube confirms an immediate visible post-publish dialog", async (t) => {
  const browser = await chromium.launch({ headless: true });
  t.after(() => browser.close());
  const page = await browser.newPage();

  await page.setContent(`
    <div role="dialog">
      <h2>V\u00eddeo publicado</h2>
      <button>Fechar</button>
    </div>
  `);

  const result = await waitForPublishConfirmation(page, [], {
    maxPolls: 2,
    pollIntervalMs: 10,
  });
  assert.equal(result.ok, true);
  assert.equal(result.confirmed, true);
  assert.equal(result.evidenceType, "post-publish-dialog");
  assert.equal(result.matchedText, "V\u00eddeo publicado");
});

test("YouTube confirms a post-publish dialog after delayed hydration", async (t) => {
  const browser = await chromium.launch({ headless: true });
  t.after(() => browser.close());
  const page = await browser.newPage();

  await page.setContent(`
    <main id="app"></main>
    <script>
      setTimeout(() => {
        const dialog = document.createElement("div");
        dialog.setAttribute("role", "dialog");
        dialog.textContent = "V\u00eddeo publicado";
        document.querySelector("#app").appendChild(dialog);
      }, 60);
    </script>
  `);

  const result = await waitForPublishConfirmation(page, [], {
    maxPolls: 10,
    pollIntervalMs: 20,
  });
  assert.equal(result.ok, true);
  assert.equal(result.evidenceType, "post-publish-dialog");
});

test("YouTube reads a visible dialog child inside an invisible custom host", async (t) => {
  const browser = await chromium.launch({ headless: true });
  t.after(() => browser.close());
  const page = await browser.newPage();

  await page.setContent(`
    <youtube-publish-confirmation
      id="invisible-host"
      style="display:block;width:0;height:0;overflow:visible"
    >
      <tp-yt-paper-dialog
        id="visible-child"
        role="dialog"
        style="position:fixed;left:20px;top:20px;width:320px;height:120px"
      >
        V\u00eddeo publicado
      </tp-yt-paper-dialog>
    </youtube-publish-confirmation>
  `);

  assert.equal(
    await page.locator("#invisible-host").isVisible().catch(() => false),
    false
  );
  assert.equal(await page.locator("#visible-child").isVisible(), true);
  const result = await waitForPublishConfirmation(page, [], {
    maxPolls: 2,
    pollIntervalMs: 10,
  });
  assert.equal(result.ok, true);
  assert.equal(result.evidenceType, "post-publish-dialog");
});

test("YouTube extracts a safe Shorts URL and video ID from confirmation", async (t) => {
  const browser = await chromium.launch({ headless: true });
  t.after(() => browser.close());
  const page = await browser.newPage();

  await page.setContent(`
    <div role="dialog">
      <h2>V\u00eddeo publicado</h2>
      <a href="https://youtube.com/shorts/AbCdEfGhI12?feature=share">
        Link do v\u00eddeo
      </a>
    </div>
  `);

  const result = await waitForPublishConfirmation(page, [], {
    maxPolls: 2,
    pollIntervalMs: 10,
  });
  assert.equal(result.ok, true);
  assert.equal(result.videoId, "AbCdEfGhI12");
  assert.equal(
    result.videoUrl,
    "https://youtube.com/shorts/AbCdEfGhI12?feature=share"
  );
});

test("YouTube preserves explicit toast and alert confirmation", async (t) => {
  const browser = await chromium.launch({ headless: true });
  t.after(() => browser.close());
  const page = await browser.newPage();

  await page.setContent('<div role="alert">V\u00eddeo publicado</div>');
  const result = await waitForPublishConfirmation(page, [], {
    maxPolls: 2,
    pollIntervalMs: 10,
  });
  assert.equal(result.ok, true);
  assert.equal(result.evidenceType, "alert");
});

test("YouTube keeps no-evidence confirmation fail-safe without retry", async (t) => {
  const browser = await chromium.launch({ headless: true });
  t.after(() => browser.close());
  const page = await browser.newPage();

  await page.setContent(`
    <script>window.youtubeNoEvidenceClicks = 0;</script>
    <button onclick="window.youtubeNoEvidenceClicks += 1">Publicar</button>
  `);
  const result = await waitForPublishConfirmation(page, [], {
    maxPolls: 2,
    pollIntervalMs: 5,
  });
  assert.equal(result.ok, false);
  assert.equal(result.confirmed, false);
  assert.equal(result.outcome, "uncertain");
  assert.equal(result.retryAllowed, false);
  assert.match(result.reason, /publication may have succeeded/i);
  assert.equal(await page.evaluate(() => window.youtubeNoEvidenceClicks), 0);
});

test("YouTube timeout after the final click never clicks Publish again", async (t) => {
  const browser = await chromium.launch({ headless: true });
  t.after(() => browser.close());
  const page = await browser.newPage();

  await page.setContent(`
    <script>window.youtubeTimeoutPublishClicks = 0;</script>
    <button
      id="publish"
      onclick="window.youtubeTimeoutPublishClicks += 1"
    >
      Publicar
    </button>
  `);
  await page.locator("#publish").click();
  const result = await waitForPublishConfirmation(page, [], {
    maxPolls: 3,
    pollIntervalMs: 5,
  });
  assert.equal(result.ok, false);
  assert.equal(result.retryAllowed, false);
  assert.equal(await page.evaluate(() => window.youtubeTimeoutPublishClicks), 1);
});

test("YouTube ignores a similar dialog without strong publish evidence", async (t) => {
  const browser = await chromium.launch({ headless: true });
  t.after(() => browser.close());
  const page = await browser.newPage();

  await page.setContent(`
    <div role="dialog">
      <h2>Compartilhar um link</h2>
      <p>Seu v\u00eddeo est\u00e1 sendo processado.</p>
    </div>
  `);
  const result = await waitForPublishConfirmation(page, [], {
    maxPolls: 2,
    pollIntervalMs: 5,
  });
  assert.equal(result.ok, false);
  assert.equal(result.outcome, "uncertain");
});

test("YouTube ignores help text that only mentions a published video", async (t) => {
  const browser = await chromium.launch({ headless: true });
  t.after(() => browser.close());
  const page = await browser.newPage();

  await page.setContent(`
    <div role="dialog">
      <h2>Ajuda do YouTube Studio</h2>
      <p>
        Depois que o texto V\u00eddeo publicado aparecer, voc\u00ea poder\u00e1
        fechar esta janela.
      </p>
    </div>
  `);
  const result = await waitForPublishConfirmation(page, [], {
    maxPolls: 2,
    pollIntervalMs: 5,
  });
  assert.equal(result.ok, false);
  assert.equal(result.outcome, "uncertain");
});

test("YouTube ignores hidden publish-confirmation text and templates", async (t) => {
  const browser = await chromium.launch({ headless: true });
  t.after(() => browser.close());
  const page = await browser.newPage();

  await page.setContent(`
    <template>
      <div role="dialog">V\u00eddeo publicado</div>
    </template>
    <div role="dialog" style="display:none">V\u00eddeo publicado</div>
  `);
  const result = await waitForPublishConfirmation(page, [], {
    maxPolls: 2,
    pollIntervalMs: 5,
  });
  assert.equal(result.ok, false);
  assert.equal(result.outcome, "uncertain");
});

test("YouTube rejects external URLs as publish evidence and video IDs", async (t) => {
  const browser = await chromium.launch({ headless: true });
  t.after(() => browser.close());
  const page = await browser.newPage();

  assert.equal(
    parseYouTubeVideoReference(
      "https://example.com/shorts/AbCdEfGhI12?feature=share"
    ),
    null
  );
  await page.setContent(`
    <div role="dialog">
      <h2>Envio conclu\u00eddo</h2>
      <a href="https://example.com/shorts/AbCdEfGhI12">Abrir</a>
    </div>
  `);
  const result = await waitForPublishConfirmation(page, [], {
    maxPolls: 2,
    pollIntervalMs: 5,
  });
  assert.equal(result.ok, false);
  assert.equal(result.videoId, undefined);
});

test("YouTube recognizes the external post-publish dialog regression fixture", async (t) => {
  const browser = await chromium.launch({ headless: true });
  t.after(() => browser.close());
  const page = await browser.newPage();

  await page.setContent(`
    <main id="channel-dashboard">
      <h1>Painel do canal</h1>
    </main>
    <youtube-video-share-dialog>
      <tp-yt-paper-dialog role="dialog">
        <h2>V\u00eddeo publicado</h2>
        <p>
          Teste sint\u00e9tico de publica\u00e7\u00e3o \u2014 fixture de confirma\u00e7\u00e3o
        </p>
        <p>Publicado em 15 de jan. de 2025</p>
        <h3>Compartilhar um link</h3>
        <a href="https://youtube.com/shorts/AbCdEfGhI12?feature=share">
          https://youtube.com/shorts/AbCdEfGhI12?feature=share
        </a>
        <button>Fechar</button>
      </tp-yt-paper-dialog>
    </youtube-video-share-dialog>
  `);

  assert.equal(await getActiveUploadSurface(page), null);
  const result = await waitForPublishConfirmation(page, [], {
    maxPolls: 2,
    pollIntervalMs: 10,
  });
  assert.equal(result.ok, true);
  assert.equal(result.confirmed, true);
  assert.equal(result.evidenceType, "post-publish-dialog");
  assert.equal(result.matchedText, "V\u00eddeo publicado");
  assert.equal(result.videoId, "AbCdEfGhI12");
  assert.equal(
    result.videoUrl,
    "https://youtube.com/shorts/AbCdEfGhI12?feature=share"
  );
});

test("YouTube never clicks Save or background Publish without verified Public", async (t) => {
  const browser = await chromium.launch({ headless: true });
  t.after(() => browser.close());
  const page = await browser.newPage();

  await page.setContent(`
    <script>
      window.youtubeUnsafeClicks = {
        public: 0,
        save: 0,
        insidePublish: 0,
        backgroundPublish: 0
      };
    </script>
    <button onclick="window.youtubeUnsafeClicks.backgroundPublish += 1">
      Publicar
    </button>
    <div role="dialog">
      <button
        name="PUBLIC"
        role="radio"
        aria-label="P\u00fablico"
        aria-checked="false"
        onclick="window.youtubeUnsafeClicks.public += 1"
      >
        P\u00fablico
      </button>
      <button onclick="window.youtubeUnsafeClicks.save += 1">Salvar</button>
      <button onclick="window.youtubeUnsafeClicks.insidePublish += 1">
        Publicar
      </button>
    </div>
  `);

  assert.equal((await setVisibilityAndPublish(page)).ok, false);
  assert.deepEqual(
    await page.evaluate(() => window.youtubeUnsafeClicks),
    { public: 1, save: 0, insidePublish: 0, backgroundPublish: 0 }
  );
});

test("YouTube Publish aborts after one ambiguous click attempt", async (t) => {
  const browser = await chromium.launch({ headless: true });
  t.after(() => browser.close());
  const page = await browser.newPage();
  await page.setContent(`
    <script>
      window.youtubeAmbiguousPublishClicks = {
        public: 0,
        publish: 0
      };
    </script>
    <div role="dialog">
      <button
        name="PUBLIC"
        role="radio"
        aria-label="P\u00fablico"
        aria-checked="false"
        onclick="
          window.youtubeAmbiguousPublishClicks.public += 1;
          this.setAttribute('aria-checked', 'true');
        "
      >
        P\u00fablico
      </button>
      <button
        id="ambiguous-publish"
        onclick="window.youtubeAmbiguousPublishClicks.publish += 1"
      >
        Publicar
      </button>
    </div>
  `);

  const sampleHandle = await page
    .locator("#ambiguous-publish")
    .elementHandle();
  const handlePrototype = Object.getPrototypeOf(sampleHandle);
  const originalClick = handlePrototype.click;
  let clickAttempts = 0;
  handlePrototype.click = async () => {
    clickAttempts += 1;
    throw new Error("synthetic ambiguous publish click");
  };

  try {
    await assert.rejects(
      setVisibilityAndPublish(page),
      /Publish click had an ambiguous outcome; no retry was attempted/
    );
  } finally {
    handlePrototype.click = originalClick;
    await sampleHandle.dispose();
  }

  assert.equal(clickAttempts, 1);
  assert.deepEqual(
    await page.evaluate(() => window.youtubeAmbiguousPublishClicks),
    { public: 1, publish: 0 }
  );
});

test("YouTube Publish rejects multiple active final buttons", async (t) => {
  const browser = await chromium.launch({ headless: true });
  t.after(() => browser.close());
  const page = await browser.newPage();
  await page.setContent(`
    <script>
      window.youtubeMultiplePublishClicks = {
        public: 0,
        publish: [0, 0]
      };
    </script>
    <div role="dialog">
      <button
        name="PUBLIC"
        role="radio"
        aria-label="P\u00fablico"
        aria-checked="false"
        onclick="
          window.youtubeMultiplePublishClicks.public += 1;
          this.setAttribute('aria-checked', 'true');
        "
      >
        P\u00fablico
      </button>
      <button onclick="window.youtubeMultiplePublishClicks.publish[0] += 1">
        Publicar
      </button>
      <button onclick="window.youtubeMultiplePublishClicks.publish[1] += 1">
        Publicar
      </button>
    </div>
  `);

  await assert.rejects(
    setVisibilityAndPublish(page),
    /multiple active Publish buttons/
  );
  assert.deepEqual(
    await page.evaluate(() => window.youtubeMultiplePublishClicks),
    { public: 1, publish: [0, 0] }
  );
});

test("YouTube Next removes the exact Google Survey overlay before advancing", async (t) => {
  const browser = await chromium.launch({ headless: true });
  t.after(() => browser.close());
  const page = await browser.newPage();

  await page.setContent(`
    <script>
      window.youtubeSurveyClicks = {
        next: 0,
        background: 0
      };
      window.showVisibilityStep = () => {
        const publicOption = document.createElement(
          'tp-yt-paper-radio-button'
        );
        publicOption.setAttribute('name', 'PUBLIC');
        publicOption.textContent = 'P\u00fablico';
        publicOption.style.display = 'block';
        publicOption.style.width = '120px';
        publicOption.style.height = '32px';
        document.querySelector('#survey-upload-wizard').append(publicOption);
      };
    </script>

    <button
      aria-label="Avan\u00e7ar"
      onclick="window.youtubeSurveyClicks.background += 1"
    >
      Avan\u00e7ar
    </button>

    <div id="survey-upload-wizard" role="dialog">
      <textarea aria-label="T\u00edtulo"></textarea>
      <textarea aria-label="Descri\u00e7\u00e3o"></textarea>
      <button
        id="survey-next"
        aria-label="Avan\u00e7ar"
        style="position: fixed; right: 20px; bottom: 20px"
        onclick="
          window.youtubeSurveyClicks.next += 1;
          this.remove();
          window.showVisibilityStep();
        "
      >
        Avan\u00e7ar
      </button>
    </div>

    <iframe
      id="google-hats-survey"
      title="Google Survey"
      src="about:blank"
      style="
        position: fixed;
        right: 0;
        bottom: 0;
        width: 360px;
        height: 260px;
        z-index: 1000;
      "
    ></iframe>
  `);

  await clickNext(page, {
    maxAdvanceClicks: 4,
    transitionTimeoutMs: 4000,
    pollIntervalMs: 20,
  });

  assert.equal(
    await page.locator(
      'iframe#google-hats-survey[title="Google Survey"]'
    ).count(),
    0
  );
  assert.deepEqual(
    await page.evaluate(() => window.youtubeSurveyClicks),
    { next: 1, background: 0 }
  );
});

test("YouTube Next waits for a delayed PT-BR control between wizard steps", async (t) => {
  const browser = await chromium.launch({ headless: true });
  t.after(() => browser.close());
  const page = await browser.newPage();

  await page.setContent(`
    <script>
      window.youtubeDelayedNextClicks = {
        first: 0,
        second: 0,
        background: 0,
        disabled: 0
      };
      window.youtubeDelayedNextTiming = {
        firstClickedAt: 0,
        secondMountedAt: 0,
        secondClickedAt: 0
      };
      window.showDelayedSecondNext = () => {
        document.querySelector('#first-next').remove();
        setTimeout(() => {
          window.youtubeDelayedNextTiming.secondMountedAt = performance.now();
          const second = document.createElement('button');
          second.id = 'second-next';
          second.setAttribute('aria-label', 'Avan\u00e7ar');
          second.textContent = 'Avan\u00e7ar';
          second.onclick = () => {
            window.youtubeDelayedNextClicks.second += 1;
            window.youtubeDelayedNextTiming.secondClickedAt = performance.now();
            second.remove();
            const doneHost = document.createElement('ytcp-button');
            doneHost.id = 'done-button';
            const done = document.createElement('button');
            done.textContent = 'Conclu\u00eddo';
            doneHost.appendChild(done);
            document.querySelector('#delayed-upload-wizard').appendChild(doneHost);
          };
          document.querySelector('#delayed-upload-wizard').appendChild(second);
        }, 1500);
      };
    </script>

    <button
      aria-label="Avan\u00e7ar"
      onclick="window.youtubeDelayedNextClicks.background += 1"
    >
      Avan\u00e7ar
    </button>

    <div id="delayed-upload-wizard" role="dialog">
      <textarea aria-label="T\u00edtulo"></textarea>
      <textarea aria-label="Descri\u00e7\u00e3o"></textarea>
      <button
        aria-label="Avan\u00e7ar"
        disabled
        onclick="window.youtubeDelayedNextClicks.disabled += 1"
      >
        Avan\u00e7ar
      </button>
      <button
        id="first-next"
        aria-label="Avan\u00e7ar"
        onclick="
          window.youtubeDelayedNextClicks.first += 1;
          window.youtubeDelayedNextTiming.firstClickedAt = performance.now();
          window.showDelayedSecondNext();
        "
      >
        Avan\u00e7ar
      </button>
    </div>
  `);

  await clickNext(page, {
    maxAdvanceClicks: 4,
    transitionTimeoutMs: 4000,
    pollIntervalMs: 50,
  });

  assert.deepEqual(
    await page.evaluate(() => window.youtubeDelayedNextClicks),
    { first: 1, second: 1, background: 0, disabled: 0 }
  );
  const timing = await page.evaluate(() => window.youtubeDelayedNextTiming);
  assert.ok(timing.secondMountedAt - timing.firstClickedAt >= 1400);
  assert.ok(timing.secondClickedAt >= timing.secondMountedAt);
  assert.equal(
    await page
      .locator("#delayed-upload-wizard ytcp-button#done-button button")
      .isVisible(),
    true
  );
});

test("YouTube Next prioritizes the active stepper while the same control hydrates", async (t) => {
  const browser = await chromium.launch({ headless: true });
  t.after(() => browser.close());
  const page = await browser.newPage();

  await page.setContent(`
    <script>
      window.youtubeReusedNextClicks = 0;
      window.youtubeReusedNextTimings = [];
      window.setReusedYoutubeStage = (stepIndex) => {
        const stages = [
          ['DETAILS', 'Detalhes'],
          ['VIDEO_ELEMENTS', 'Elementos do v\u00eddeo'],
          ['CHECKS', 'Verifica\u00e7\u00f5es'],
          ['VISIBILITY', 'Visibilidade']
        ];
        document
          .querySelectorAll(
            '#ytcp-uploads-dialog-stepper button[role="tab"][step-index]'
          )
          .forEach((tab) => {
            const active = Number(tab.getAttribute('step-index')) === stepIndex;
            tab.toggleAttribute('active', active);
            tab.setAttribute('aria-selected', active ? 'true' : 'false');
          });
        document.querySelector('#reused-stage-heading').textContent =
          stages[stepIndex][1];
      };
      window.setReusedNextEnabled = (enabled) => {
        const button = document.querySelector('#reused-next');
        button.disabled = !enabled;
        button.setAttribute('aria-disabled', enabled ? 'false' : 'true');
      };
      window.advanceReusedYoutubeWizard = () => {
        window.youtubeReusedNextClicks += 1;
        window.youtubeReusedNextTimings.push(performance.now());
        const clickNumber = window.youtubeReusedNextClicks;
        window.setReusedNextEnabled(false);

        if (window.youtubeReusedNextClicks === 1) {
          setTimeout(() => window.setReusedYoutubeStage(1), 100);
          setTimeout(() => window.setReusedNextEnabled(true), 650);
          return;
        }
        if (window.youtubeReusedNextClicks === 2) {
          setTimeout(() => window.setReusedYoutubeStage(2), 100);
          setTimeout(() => window.setReusedNextEnabled(true), 650);
          return;
        }
        if (window.youtubeReusedNextClicks === 3) {
          setTimeout(() => window.setReusedYoutubeStage(3), 100);
          setTimeout(() => {
            const publicOption = document.createElement(
              'tp-yt-paper-radio-button'
            );
            publicOption.setAttribute('name', 'PUBLIC');
            publicOption.textContent = 'P\u00fablico';
            publicOption.style.display = 'block';
            publicOption.style.width = '120px';
            publicOption.style.height = '32px';
            document
              .querySelector('#reused-control-upload-wizard')
              .appendChild(publicOption);
          }, 150);
        }
      };
    </script>

    <div id="reused-control-upload-wizard" role="dialog">
      <textarea aria-label="T\u00edtulo"></textarea>
      <textarea aria-label="Descri\u00e7\u00e3o"></textarea>
      <div id="ytcp-uploads-dialog-stepper">
        <button
          role="tab"
          test-id="DETAILS"
          step-index="0"
          active
          aria-selected="true"
        >
          Detalhes
        </button>
        <button
          role="tab"
          test-id="VIDEO_ELEMENTS"
          step-index="1"
          aria-selected="false"
        >
          Elementos do v\u00eddeo
        </button>
        <button
          role="tab"
          test-id="CHECKS"
          step-index="2"
          aria-selected="false"
        >
          Verifica\u00e7\u00f5es
        </button>
        <button
          role="tab"
          test-id="VISIBILITY"
          step-index="3"
          aria-selected="false"
        >
          Visibilidade
        </button>
      </div>
      <h1 id="stale-details-heading">Detalhes</h1>
      <h1 id="reused-stage-heading">Detalhes</h1>
      <ytcp-button id="next-button">
        <button
          id="reused-next"
          aria-label="Avan\u00e7ar"
          aria-disabled="false"
          onclick="window.advanceReusedYoutubeWizard()"
        >
          Avan\u00e7ar
        </button>
      </ytcp-button>
    </div>
  `);

  const originalButton = await page.locator("#reused-next").elementHandle();
  await clickNext(page, {
    maxAdvanceClicks: 4,
    transitionTimeoutMs: 3000,
    pollIntervalMs: 20,
  });
  const finalButton = await page.locator("#reused-next").elementHandle();

  assert.equal(
    await originalButton.evaluate(
      (element, finalElement) => element === finalElement,
      finalButton
    ),
    true
  );
  assert.equal(
    await page.evaluate(() => window.youtubeReusedNextClicks),
    3
  );
  const timings = await page.evaluate(() => window.youtubeReusedNextTimings);
  assert.equal(timings.length, 3);
  assert.ok(timings[1] - timings[0] >= 500);
  assert.ok(timings[2] - timings[1] >= 500);
  assert.equal(
    await page.locator("#stale-details-heading").innerText(),
    "Detalhes"
  );
  assert.equal(
    await page.locator("#reused-stage-heading").innerText(),
    "Visibilidade"
  );
  const activeStage = page.locator(
    '#ytcp-uploads-dialog-stepper button[role="tab"][active][aria-selected="true"]'
  );
  assert.equal(await activeStage.count(), 1);
  assert.equal(await activeStage.getAttribute("test-id"), "VISIBILITY");
  assert.equal(await activeStage.getAttribute("step-index"), "3");
  assert.equal(
    await page
      .locator(
        '#reused-control-upload-wizard tp-yt-paper-radio-button[name="PUBLIC"]'
      )
      .isVisible(),
    true
  );

  await originalButton.dispose();
  await finalButton.dispose();
});

test("YouTube Next fails closed when active stepper markers are ambiguous", async (t) => {
  const browser = await chromium.launch({ headless: true });
  t.after(() => browser.close());
  const page = await browser.newPage();
  await page.setContent(`
    <script>
      window.youtubeAmbiguousStepperClicks = 0;
    </script>
    <div role="dialog">
      <textarea aria-label="T\u00edtulo"></textarea>
      <textarea aria-label="Descri\u00e7\u00e3o"></textarea>
      <div id="ytcp-uploads-dialog-stepper">
        <button
          role="tab"
          test-id="DETAILS"
          step-index="0"
          active
          aria-selected="true"
        >
          Detalhes
        </button>
        <button
          role="tab"
          test-id="VIDEO_ELEMENTS"
          step-index="1"
          active
          aria-selected="true"
        >
          Elementos do v\u00eddeo
        </button>
      </div>
      <ytcp-button id="next-button">
        <button
          aria-label="Avan\u00e7ar"
          onclick="window.youtubeAmbiguousStepperClicks += 1"
        >
          Avan\u00e7ar
        </button>
      </ytcp-button>
    </div>
  `);

  await assert.rejects(
    clickNext(page, {
      maxAdvanceClicks: 4,
      transitionTimeoutMs: 150,
      pollIntervalMs: 20,
    }),
    /Could not reach the YouTube visibility step: no active Next button/
  );
  assert.equal(
    await page.evaluate(() => window.youtubeAmbiguousStepperClicks),
    0
  );
});

test("YouTube Next does not re-click an unchanged active control", async (t) => {
  const browser = await chromium.launch({ headless: true });
  t.after(() => browser.close());
  const page = await browser.newPage();
  await page.setContent(`
    <script>
      window.youtubeUnchangedNextClicks = 0;
    </script>
    <div role="dialog">
      <textarea aria-label="T\u00edtulo"></textarea>
      <textarea aria-label="Descri\u00e7\u00e3o"></textarea>
      <h2>Detalhes</h2>
      <button
        aria-label="Avan\u00e7ar"
        onclick="window.youtubeUnchangedNextClicks += 1"
      >
        Avan\u00e7ar
      </button>
    </div>
  `);

  await assert.rejects(
    clickNext(page, {
      maxAdvanceClicks: 4,
      transitionTimeoutMs: 1500,
      pollIntervalMs: 20,
    }),
    /no new active Next button or visibility step/
  );
  assert.equal(
    await page.evaluate(() => window.youtubeUnchangedNextClicks),
    1
  );
});

test("YouTube Next rejects multiple active controls inside the wizard", async (t) => {
  const browser = await chromium.launch({ headless: true });
  t.after(() => browser.close());
  const page = await browser.newPage();
  await page.setContent(`
    <script>
      window.youtubeAmbiguousNextClicks = [0, 0];
    </script>
    <div role="dialog">
      <textarea aria-label="T\u00edtulo"></textarea>
      <textarea aria-label="Descri\u00e7\u00e3o"></textarea>
      <button
        aria-label="Avan\u00e7ar"
        onclick="window.youtubeAmbiguousNextClicks[0] += 1"
      >
        Avan\u00e7ar
      </button>
      <button
        aria-label="Avan\u00e7ar"
        onclick="window.youtubeAmbiguousNextClicks[1] += 1"
      >
        Avan\u00e7ar
      </button>
    </div>
  `);

  await assert.rejects(
    clickNext(page, {
      maxAdvanceClicks: 4,
      transitionTimeoutMs: 150,
      pollIntervalMs: 20,
    }),
    /multiple active Next buttons/
  );
  assert.deepEqual(
    await page.evaluate(() => window.youtubeAmbiguousNextClicks),
    [0, 0]
  );
});

test("YouTube Next aborts after one ambiguous click attempt", async (t) => {
  const browser = await chromium.launch({ headless: true });
  t.after(() => browser.close());
  const page = await browser.newPage();
  await page.setContent(`
    <script>
      window.youtubeAmbiguousDispatches = 0;
    </script>
    <div role="dialog">
      <textarea aria-label="T\u00edtulo"></textarea>
      <textarea aria-label="Descri\u00e7\u00e3o"></textarea>
      <button
        id="ambiguous-next"
        aria-label="Avan\u00e7ar"
        onclick="window.youtubeAmbiguousDispatches += 1"
      >
        Avan\u00e7ar
      </button>
    </div>
  `);

  const sampleHandle = await page
    .locator("#ambiguous-next")
    .elementHandle();
  const handlePrototype = Object.getPrototypeOf(sampleHandle);
  const originalClick = handlePrototype.click;
  let clickAttempts = 0;
  handlePrototype.click = async () => {
    clickAttempts += 1;
    throw new Error("synthetic ambiguous click");
  };

  try {
    await assert.rejects(
      clickNext(page, {
        maxAdvanceClicks: 4,
        transitionTimeoutMs: 1500,
        pollIntervalMs: 20,
      }),
      /ambiguous outcome; no retry was attempted/
    );
  } finally {
    handlePrototype.click = originalClick;
    await sampleHandle.dispose();
  }

  assert.equal(clickAttempts, 1);
  assert.equal(
    await page.evaluate(() => window.youtubeAmbiguousDispatches),
    0
  );
});

test("YouTube Next rejects non-finite or zero transition timeouts", async (t) => {
  const browser = await chromium.launch({ headless: true });
  t.after(() => browser.close());
  const page = await browser.newPage();
  await page.setContent(`
    <script>
      window.youtubeInvalidTimeoutClicks = 0;
    </script>
    <div role="dialog">
      <textarea aria-label="T\u00edtulo"></textarea>
      <textarea aria-label="Descri\u00e7\u00e3o"></textarea>
      <button
        aria-label="Avan\u00e7ar"
        onclick="window.youtubeInvalidTimeoutClicks += 1"
      >
        Avan\u00e7ar
      </button>
    </div>
  `);

  await assert.rejects(
    clickNext(page, { transitionTimeoutMs: 0 }),
    /transitionTimeoutMs must be a finite positive number/
  );
  await assert.rejects(
    clickNext(page, { transitionTimeoutMs: Number.POSITIVE_INFINITY }),
    /transitionTimeoutMs must be a finite positive number/
  );
  assert.equal(
    await page.evaluate(() => window.youtubeInvalidTimeoutClicks),
    0
  );
});

test("YouTube Next fails closed before the visibility step", async (t) => {
  const browser = await chromium.launch({ headless: true });
  t.after(() => browser.close());
  const page = await browser.newPage();
  await page.setContent(`
    <div role="dialog">
      <textarea aria-label="T\u00edtulo"></textarea>
      <textarea aria-label="Descri\u00e7\u00e3o"></textarea>
      <div name="VIDEO_MADE_FOR_KIDS_NOT_MFK">
        N\u00e3o \u00e9 conte\u00fado para crian\u00e7as
      </div>
    </div>
  `);

  await assert.rejects(
    clickNext(page, {
      maxAdvanceClicks: 4,
      transitionTimeoutMs: 120,
      pollIntervalMs: 20,
    }),
    /Could not reach the YouTube visibility step: no active Next button/
  );
});

test("YouTube publish classifier keeps processing pending", () => {
  assert.deepEqual(classifyYouTubePublishText("Processando"), {
    state: "pending",
  });
  assert.deepEqual(classifyYouTubePublishText("Processing"), {
    state: "pending",
  });
  assert.deepEqual(classifyYouTubePublishText("V\u00eddeo publicado"), {
    state: "success",
  });
  assert.deepEqual(
    classifyYouTubePublishText("V\u00eddeo publicado anteriormente"),
    { state: "pending" }
  );
  assert.deepEqual(
    classifyYouTubePublishText("N\u00e3o foi poss\u00edvel publicar"),
    {
      state: "error",
      reason: "YouTube reported an error while publishing.",
    }
  );
  assert.deepEqual(classifyYouTubePublishText("\u004e\u0069\u0063\u0068\u0074\u0020\u0076\u0065\u0072\u00f6\u0066\u0066\u0065\u006e\u0074\u006c\u0069\u0063\u0068\u0074"), {
    state: "error",
    reason: "YouTube reported an error while publishing.",
  });
  assert.deepEqual(
    classifyYouTubePublishText("V\u00eddeo n\u00e3o publicado"),
    {
      state: "error",
      reason: "YouTube reported an error while publishing.",
    }
  );
  assert.deepEqual(
    classifyYouTubePublishStatusChanges(
      ["V\u00eddeo publicado"],
      ["V\u00eddeo publicado"]
    ),
    { state: "pending" }
  );
  assert.deepEqual(
    classifyYouTubePublishStatusChanges(
      ["V\u00eddeo publicado Progresso 20%"],
      ["V\u00eddeo publicado Progresso 10%"]
    ),
    { state: "pending" }
  );
  assert.deepEqual(
    classifyYouTubePublishStatusChanges(
      ["V\u00eddeo publicado", "V\u00eddeo publicado"],
      ["V\u00eddeo publicado"]
    ),
    { state: "success" }
  );
});
