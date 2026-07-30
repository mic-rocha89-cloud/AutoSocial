const test = require("node:test");
const assert = require("node:assert/strict");

const { _private } = require("../src/cli");

const { logResult } = _private;

test("CLI result logging returns success for completed and skipped posts", () => {
  const originalLog = console.log;
  console.log = () => {};

  try {
    assert.equal(logResult({ ok: true, movedVideo: "posted.mp4" }), 0);
    assert.equal(logResult({ ok: true, skipped: true, reason: "Queue is empty." }), 0);
  } finally {
    console.log = originalLog;
  }
});

test("CLI result logging returns failure for an unsuccessful post", () => {
  const originalError = console.error;
  console.error = () => {};

  try {
    assert.equal(logResult({ ok: false, error: "Upload failed." }), 1);
  } finally {
    console.error = originalError;
  }
});
