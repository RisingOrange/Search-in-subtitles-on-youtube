const { execSync } = require("child_process");
const { Builder, By, until } = require("selenium-webdriver");
const firefox = require("selenium-webdriver/firefox");
const geckodriver = require("geckodriver");
const fs = require("fs");
const path = require("path");

const PROJECT_ROOT = path.resolve(__dirname, "..", "..");
const ARTIFACTS_DIR = path.join(PROJECT_ROOT, "dist", "web-ext-artifacts");
const SCREENSHOTS_DIR = path.join(__dirname, "screenshots");

// Two test videos for redundancy — if one gets removed/restricted, the other still works.
// Both have creator-provided English captions.
const TEST_VIDEOS = [
  {
    // TED-Ed: "The benefits of a good night's sleep"
    url: "https://www.youtube.com/watch?v=gedoSfZvBgE&hl=en&gl=US",
    searchTerm: "memory",
  },
  {
    // TED-Ed: "How does the stock market work?"
    url: "https://www.youtube.com/watch?v=p7HKvqRI_Bo&hl=en&gl=US",
    searchTerm: "stock",
  },
];

/**
 * Build the extension zip using web-ext.
 * Returns the absolute path to the built .zip file.
 */
function buildExtension() {
  // Clean previous builds
  if (fs.existsSync(ARTIFACTS_DIR)) {
    fs.rmSync(ARTIFACTS_DIR, { recursive: true });
  }

  execSync(
    `npx web-ext build --source-dir="${PROJECT_ROOT}" --overwrite-dest --artifacts-dir="${ARTIFACTS_DIR}"`,
    { cwd: PROJECT_ROOT, stdio: "pipe" }
  );

  const files = fs.readdirSync(ARTIFACTS_DIR).filter((f) => f.endsWith(".zip"));

  if (files.length === 0) {
    throw new Error(
      `buildExtension: No .zip files found in ${ARTIFACTS_DIR}. web-ext build may have failed.`
    );
  }
  if (files.length > 1) {
    throw new Error(
      `buildExtension: Expected exactly 1 .zip file in ${ARTIFACTS_DIR}, found ${files.length}: ${files.join(", ")}`
    );
  }

  return path.join(ARTIFACTS_DIR, files[0]);
}

/**
 * Launch Firefox with the extension installed.
 * Returns { driver, extensionId }.
 */
async function launchFirefoxWithExtension(extensionPath) {
  const options = new firefox.Options();
  const service = new firefox.ServiceBuilder(geckodriver.path);
  options.addArguments("-headless");
  // Wider viewport so YouTube renders full player controls
  options.addArguments("-width=1280");
  options.addArguments("-height=900");

  // Allow overriding Firefox binary path via env var (useful for local dev)
  if (process.env.FIREFOX_BIN) {
    options.setBinary(process.env.FIREFOX_BIN);
  }

  const driver = await new Builder()
    .forBrowser("firefox")
    .setFirefoxService(service)
    .setFirefoxOptions(options)
    .build();

  // Install extension as temporary addon (works without signing)
  await driver.installAddon(extensionPath, true);

  return driver;
}

/**
 * Navigate to a YouTube video and handle interstitials.
 */
async function openYouTubeVideo(driver, url) {
  // Set consent cookie before navigating to suppress GDPR dialogs
  await driver.get("https://www.youtube.com");
  await driver.manage().addCookie({
    name: "CONSENT",
    value: "YES+cb.20210328-17-p0.en+FX+684",
    domain: ".youtube.com",
    path: "/",
  });
  // Also set SOCS cookie used by newer consent flow
  await driver.manage().addCookie({
    name: "SOCS",
    value: "CAISEwgDEgk2ODE4NTcyNjQaAmVuIAEaBgiA_LyaBg",
    domain: ".youtube.com",
    path: "/",
  });

  await driver.get(url);

  // Handle consent redirects (consent.youtube.com)
  await handleConsentInterstitial(driver);

  // Wait for the video player to be present
  await waitForElement(driver, "#movie_player", 20000);

  // Handle ads
  const videoReady = await ensureNoAdPlaying(driver);
  if (!videoReady) {
    console.warn("openYouTubeVideo: proceeding even though video readiness was not confirmed");
  }
}

/**
 * Detect and dismiss consent interstitials.
 */
async function handleConsentInterstitial(driver) {
  const currentUrl = await driver.getCurrentUrl();

  // If redirected to consent domain, find and click accept
  if (currentUrl.includes("consent.youtube.com") || currentUrl.includes("consent.google.com")) {
    try {
    
      // Try various accept button selectors
      const acceptSelectors = [
        'button[aria-label*="Accept"]',
        'button[aria-label*="accept"]',
        'input[type="submit"][value*="Accept"]',
        'button[jsname="b3VHJd"]',
        "form button",
      ];
      for (const selector of acceptSelectors) {
        try {
          const btn = await driver.findElement(By.css(selector));
          if (await btn.isDisplayed()) {
            await btn.click();
            // Wait for navigation back to youtube.com
            await driver.wait(async () => {
              const url = await driver.getCurrentUrl();
              return url.includes("youtube.com/watch");
            }, 10000);
            return;
          }
        } catch {
          // Try next selector
        }
      }
    } catch {
      // Continue — cookie may have prevented the dialog
    }
  }

  // Check for in-page consent dialog
  try {
  
    const dialog = await driver.findElement(By.css("tp-yt-paper-dialog.ytd-consent-bump-v2-lightbox"));
    if (await dialog.isDisplayed()) {
      const acceptBtn = await dialog.findElement(
        By.css('button[aria-label*="Accept"], ytd-button-renderer:last-child button')
      );
      await acceptBtn.click();
      await driver.sleep(2000);
    }
  } catch {
    // No in-page consent dialog — continue
  }
}

/**
 * Wait for ads to finish, skip if possible.
 * Ensures a playable non-ad video is available before returning.
 */
async function ensureNoAdPlaying(driver) {
  const maxWait = 90000; // 90s max for long prerolls/non-skippable ads
  const start = Date.now();

  while (Date.now() - start < maxWait) {
    const state = await driver.executeScript(`
      const player = document.querySelector('#movie_player');
      const video = document.querySelector('video');
      return {
        adShowing: !!(player && player.classList.contains('ad-showing')),
        hasVideo: !!video,
        readyState: video ? video.readyState : 0,
        duration: video ? video.duration : NaN,
      };
    `);

    if (!state.adShowing) {
      // Some CI runs stay paused in headless mode unless playback is nudged.
      await driver.executeScript(`
        const video = document.querySelector('video');
        if (!video) return;
        video.muted = true;
        video.play().catch(() => {});
      `);

      // Metadata/data is enough for subtitle search; full playback can start later.
      const isUsable =
        state.hasVideo && state.readyState >= 1 && !isNaN(state.duration) && state.duration > 0;
      if (isUsable) {
        return true;
      }
    }

    // Try to click skip button if ads are showing
    const skipSelectors = [
      ".ytp-skip-ad-button",
      ".ytp-ad-skip-button",
      ".ytp-ad-skip-button-modern",
      "button.ytp-ad-skip-button-modern",
      ".ytp-ad-skip-button-slot button",
    ];

    for (const selector of skipSelectors) {
      try {
        const skipBtn = await driver.findElement(By.css(selector));
        if (await skipBtn.isDisplayed()) {
          await skipBtn.click();
          break;
        }
      } catch {
        // Skip button not found/visible — ad may not be skippable yet
      }
    }

    await driver.sleep(1000);
  }

  // Best effort only: don't fail suite setup if ads or metadata are still loading.
  console.warn("ensureNoAdPlaying: continuing without confirmed playable video state");
  return false;
}


/**
 * Wait for an element to appear in the DOM.
 * Returns the element.
 */
async function waitForElement(driver, cssSelector, timeoutMs = 10000) {

  return driver.wait(
    until.elementLocated(By.css(cssSelector)),
    timeoutMs,
    `Timed out waiting for element: ${cssSelector}`
  );
}

/**
 * Wait for an element to be visible (displayed).
 * Returns the element.
 */
async function waitForVisible(driver, cssSelector, timeoutMs = 10000) {

  const el = await waitForElement(driver, cssSelector, timeoutMs);
  await driver.wait(
    until.elementIsVisible(el),
    timeoutMs,
    `Element found but not visible: ${cssSelector}`
  );
  return el;
}

/**
 * Switch into the extension's search iframe.
 */
async function switchToExtensionIframe(driver) {

  const iframe = await waitForElement(driver, "#YTSEARCH_IFRAME", 15000);
  await driver.switchTo().frame(iframe);
}

/**
 * Switch back to the main YouTube page from any iframe.
 */
async function switchToMainPage(driver) {
  await driver.switchTo().defaultContent();
}

/**
 * Save a screenshot and diagnostic info for debugging failures.
 * Returns the screenshot file path.
 */
async function saveDiagnostics(driver, testName) {
  if (!fs.existsSync(SCREENSHOTS_DIR)) {
    fs.mkdirSync(SCREENSHOTS_DIR, { recursive: true });
  }

  const safeName = testName.replace(/[^a-z0-9_-]/gi, "_");

  try {
    // Screenshot
    const screenshotData = await driver.takeScreenshot();
    const screenshotPath = path.join(SCREENSHOTS_DIR, `${safeName}.png`);
    fs.writeFileSync(screenshotPath, screenshotData, "base64");

    // Diagnostics text
    const currentUrl = await driver.getCurrentUrl();
    const readyState = await driver.executeScript("return document.readyState");
    const pageTitle = await driver.getTitle();
    const diagnostics = `URL: ${currentUrl}\nreadyState: ${readyState}\nTitle: ${pageTitle}\nTimestamp: ${new Date().toISOString()}`;
    const diagPath = path.join(SCREENSHOTS_DIR, `${safeName}.txt`);
    fs.writeFileSync(diagPath, diagnostics);

    return screenshotPath;
  } catch (e) {
    console.error(`Failed to save diagnostics for "${testName}":`, e.message);
    return null;
  }
}

module.exports = {
  TEST_VIDEOS,
  SCREENSHOTS_DIR,
  buildExtension,
  launchFirefoxWithExtension,
  openYouTubeVideo,
  ensureNoAdPlaying,
  waitForElement,
  waitForVisible,
  switchToExtensionIframe,
  switchToMainPage,
  saveDiagnostics,
};
