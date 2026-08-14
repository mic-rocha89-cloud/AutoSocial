#!/usr/bin/env node
const path = require("node:path");
const yargs = require("yargs/yargs");
const { hideBin } = require("yargs/helpers");

const {
  AUTHORIZATION_VALUE,
  EXPECTED_ACCOUNT_ID,
  EXPECTED_BRANCH,
  runTikTokNoPublishDiagnostic,
} = require("../src/tiktok-no-publish-diagnostic");

function buildParser(argv) {
  return yargs(argv)
    .scriptName("diagnose-tiktok-no-publish")
    .usage("$0 --source <path> --expected-sha256 <digest> --expected-size <bytes> --expected-head <sha> --output-dir <path> --account-id qa-tiktok --authorization <value>")
    .option("source", {
      type: "string",
      demandOption: true,
      describe: "Approved original video outside the managed queue tree",
    })
    .option("expected-sha256", {
      type: "string",
      demandOption: true,
      describe: "Approved lowercase SHA-256 digest",
    })
    .option("expected-size", {
      type: "number",
      demandOption: true,
      describe: "Approved source size in bytes",
    })
    .option("expected-head", {
      type: "string",
      demandOption: true,
      describe: "Full reviewed Git HEAD",
    })
    .option("expected-branch", {
      type: "string",
      default: EXPECTED_BRANCH,
      describe: "Reviewed Git branch",
    })
    .option("output-dir", {
      type: "string",
      demandOption: true,
      describe: "New qa-tiktok-no-publish-* directory directly under .local",
    })
    .option("account-id", {
      type: "string",
      demandOption: true,
      describe: `Must be exactly ${EXPECTED_ACCOUNT_ID}`,
    })
    .option("authorization", {
      type: "string",
      demandOption: true,
      describe: `Must be exactly ${AUTHORIZATION_VALUE}`,
    })
    .strict()
    .help();
}

async function main(argv = hideBin(process.argv)) {
  const parsed = await buildParser(argv).parse();
  const result = await runTikTokNoPublishDiagnostic({
    accountId: parsed.accountId,
    authorization: parsed.authorization,
    expectedBranch: parsed.expectedBranch,
    expectedHead: parsed.expectedHead,
    expectedSha256: parsed.expectedSha256,
    expectedSize: parsed.expectedSize,
    outputDir: path.resolve(parsed.outputDir),
    sourcePath: path.resolve(parsed.source),
  });

  if (result.ok) {
    console.log(`No-publish diagnostic completed: ${result.reportPath}`);
    return 0;
  }
  console.error(`No-publish diagnostic failed closed: ${result.error}`);
  console.error(`Diagnostic report: ${result.reportPath}`);
  return 1;
}

if (require.main === module) {
  main()
    .then((exitCode) => {
      process.exitCode = exitCode;
    })
    .catch((error) => {
      console.error(`No-publish diagnostic preflight failed: ${error.message}`);
      process.exitCode = 1;
    });
}

module.exports = {
  buildParser,
  main,
};
