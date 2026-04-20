const {
  TEST_VIDEO,
  buildExtension,
  launchFirefoxWithExtension,
  openYouTubeVideo,
} = require("./helpers");

async function main() {
  const url = process.env.DEV_BROWSER_URL || TEST_VIDEO.url;

  console.log("Building extension...");
  const extensionPath = buildExtension();

  console.log("Launching Firefox...");
  const driver = await launchFirefoxWithExtension(extensionPath);

  console.log(`Opening ${url}`);
  await openYouTubeVideo(driver, url);

  if (driver._botChallengeDetected) {
    console.warn("YouTube bot challenge detected — page may not work properly");
  }
  if (driver._navigationTimedOut) {
    console.warn("YouTube navigation timed out — page may not work properly");
  }

  console.log("Browser ready. Press Ctrl+C to close.");

  // Keep process alive until interrupted
  await new Promise((resolve) => {
    const keepAlive = setInterval(() => {}, 1000);
    process.on("SIGINT", resolve);
    process.on("SIGTERM", resolve);
    process.on("SIGINT", () => clearInterval(keepAlive));
    process.on("SIGTERM", () => clearInterval(keepAlive));
  });

  await driver.quit().catch(() => {});
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
