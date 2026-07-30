const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");
const vm = require("vm");

const appSource = fs.readFileSync(
  path.resolve(__dirname, "..", "web", "app.js"),
  "utf8"
);

function loadDashboardUi() {
  let activeSchedulerText = "";
  const elements = {
    activeAccountsCount: {
      get textContent() {
        return activeSchedulerText;
      },
      set textContent(value) {
        activeSchedulerText = String(value);
      },
    },
    overviewProfilesContainer: { innerHTML: "" },
  };
  const document = {
    activeElement: null,
    addEventListener() {},
    getElementById(id) {
      return elements[id] || null;
    },
    querySelectorAll() {
      return [];
    },
  };
  const context = vm.createContext({
    console,
    document,
    fetch: async () => {
      throw new Error("Unexpected network request");
    },
    setInterval() {
      throw new Error("Unexpected polling start");
    },
  });

  vm.runInContext(appSource, context, { filename: "web/app.js" });
  const UI = vm.runInContext("UI", context);
  const API = vm.runInContext("API", context);
  return { UI, API, elements };
}

function createDeferred() {
  let resolve;
  const promise = new Promise((resolvePromise) => {
    resolve = resolvePromise;
  });
  return { promise, resolve };
}

test("saved sessions do not overwrite the active scheduler count", () => {
  const { UI, elements } = loadDashboardUi();
  UI.accountState = {
    tiktok: { loginOpen: false, sessionSaved: true, schedulerRunning: false },
    instagram: { loginOpen: false, sessionSaved: true, schedulerRunning: false },
    youtube: { loginOpen: false, sessionSaved: true, schedulerRunning: false },
    brands: [{ id: "default", name: "Default" }],
    activeBrandId: "default",
    activeBrandName: "Default",
  };
  const stoppedStatus = {
    running: false,
    queue: { counts: { pending: 0, posted: 0, failed: 0 } },
    logs: [],
  };

  UI.renderOverview({
    default: {
      tiktok: stoppedStatus,
      instagram: stoppedStatus,
      youtube: stoppedStatus,
    },
  });
  UI.renderAccounts();

  assert.equal(elements.activeAccountsCount.textContent, "0");
});

test("late polling responses do not overwrite newer dashboard state", async () => {
  const { UI, API } = loadDashboardUi();
  const mainEndpoints = [
    "/api/status",
    "/api/instagram/status",
    "/api/youtube/status",
    "/api/uniquifier/status",
    "/api/accounts",
    "/api/tiktok/login/status",
    "/api/instagram/login/status",
    "/api/youtube/login/status",
  ];
  const firstResponses = new Map(
    mainEndpoints.map((endpoint) => [endpoint, createDeferred()])
  );
  const callCounts = new Map();
  const renderedStatuses = [];

  const responseFor = (endpoint, marker) => {
    if (endpoint === "/api/accounts") {
      return {
        accounts: [{ id: marker, name: marker }],
        activeAccountId: marker,
        activeAccount: { id: marker, name: marker },
      };
    }
    if (endpoint.endsWith("/login/status")) {
      return { open: false, saved: true };
    }
    return {
      marker,
      running: false,
      queue: { counts: { pending: 0, posted: 0, failed: 0 } },
      logs: [],
    };
  };

  API.get = (endpoint) => {
    if (!firstResponses.has(endpoint)) {
      return Promise.resolve({});
    }
    const callCount = (callCounts.get(endpoint) || 0) + 1;
    callCounts.set(endpoint, callCount);
    if (callCount === 1) {
      return firstResponses.get(endpoint).promise;
    }
    return Promise.resolve(responseFor(endpoint, "new"));
  };
  UI.renderStatus = (status) => renderedStatuses.push(status.marker);
  UI.renderInstagramStatus = () => {};
  UI.renderYouTubeStatus = () => {};
  UI.renderUniquifierStatus = () => {};
  UI.renderBrandSelector = () => {};
  UI.renderAccounts = () => {};
  UI.renderAutoDownloadStatus = () => {};
  UI.renderProfileDownloadStatus = () => {};
  UI.renderOverview = () => {};

  const firstRefresh = UI.refresh();
  const secondRefresh = UI.refresh();
  await secondRefresh;

  for (const endpoint of mainEndpoints) {
    firstResponses.get(endpoint).resolve(responseFor(endpoint, "old"));
  }
  await firstRefresh;

  assert.deepEqual(renderedStatuses, ["new"]);
  assert.equal(UI.accountState.activeBrandId, "new");
});
