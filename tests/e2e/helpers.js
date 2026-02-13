const { execSync } = require("child_process");
const { Builder, By, until } = require("selenium-webdriver");
const firefox = require("selenium-webdriver/firefox");
const geckodriver = require("geckodriver");
const fs = require("fs");
const path = require("path");

const PROJECT_ROOT = path.resolve(__dirname, "..", "..");
const ARTIFACTS_DIR = path.join(PROJECT_ROOT, "dist", "web-ext-artifacts");
const SCREENSHOTS_DIR = path.join(__dirname, "screenshots");
const ADBLOCKER_CACHE_DIR = path.join(PROJECT_ROOT, "dist", "e2e-addons");
const ADBLOCKER_XPI_PATH = path.join(ADBLOCKER_CACHE_DIR, "adblocker-ultimate-latest.xpi");
const ADBLOCKER_DOWNLOAD_URL =
  process.env.ADBLOCKER_ULTIMATE_URL ||
  "https://addons.mozilla.org/firefox/downloads/latest/adblocker-ultimate/addon-494908-latest.xpi";

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
 * Download AdBlocker Ultimate XPI and return local file path.
 * Best-effort: throws only if download command fails.
 */
function ensureAdblockerUltimateXpi() {
  if (!fs.existsSync(ADBLOCKER_CACHE_DIR)) {
    fs.mkdirSync(ADBLOCKER_CACHE_DIR, { recursive: true });
  }

  if (!fs.existsSync(ADBLOCKER_XPI_PATH)) {
    execSync(`curl -fsSL "${ADBLOCKER_DOWNLOAD_URL}" -o "${ADBLOCKER_XPI_PATH}"`);
  }

  return ADBLOCKER_XPI_PATH;
}

async function launchFirefoxWithExtension(extensionPath) {
  const options = new firefox.Options();
  const service = new firefox.ServiceBuilder(geckodriver.path);
  // Allow running with a visible browser via E2E_HEADED=1 (useful for local debugging)
  if (process.env.E2E_HEADED !== "1") {
    options.addArguments("-headless");
  }
  // Wider viewport so YouTube renders full player controls
  options.addArguments("-width=1280");
  options.addArguments("-height=900");

  // Reduce bot detection: hide navigator.webdriver flag
  options.setPreference("dom.webdriver.enabled", false);
  // Use a realistic desktop user-agent so YouTube doesn't flag headless sessions
  options.setPreference(
    "general.useragent.override",
    "Mozilla/5.0 (X11; Linux x86_64; rv:137.0) Gecko/20100101 Firefox/137.0"
  );

  // Allow overriding Firefox binary path via env var (useful for local dev)
  if (process.env.FIREFOX_BIN) {
    options.setBinary(process.env.FIREFOX_BIN);
  }

  const driver = await new Builder()
    .forBrowser("firefox")
    .setFirefoxService(service)
    .setFirefoxOptions(options)
    .build();

  // Remember the initial tab handle before installing addons
  const originalTab = await driver.getWindowHandle();

  // Install AdBlocker Ultimate first to reduce YouTube preroll ad flakiness.
  if (process.env.E2E_ENABLE_ADBLOCKER !== "0") {
    try {
      const adblockerPath = ensureAdblockerUltimateXpi();
      await driver.installAddon(adblockerPath, true);
    } catch (e) {
      console.warn(`AdBlocker Ultimate installation failed: ${e.message}`);
    }
  }

  // Install extension as temporary addon (works without signing)
  await driver.installAddon(extensionPath, true);

  // Close any tabs opened by addon installations (e.g. AdBlocker Ultimate thank-you page)
  const allTabs = await driver.getAllWindowHandles();
  for (const tab of allTabs) {
    if (tab !== originalTab) {
      await driver.switchTo().window(tab);
      await driver.close();
    }
  }
  await driver.switchTo().window(originalTab);

  return driver;
}

/**
 * Check if YouTube is showing a bot challenge / "Sign in to confirm" page.
 * YouTube often still renders #movie_player in the DOM but shows the bot gate
 * inside/over the player area, so we must also check player-internal text and
 * the error overlay state.
 * Returns true if a bot challenge was detected.
 */
async function detectBotChallenge(driver) {
  try {
    const result = await driver.executeScript(`
      const body = document.body ? document.body.innerText : '';
      const player = document.querySelector('#movie_player');
      const playerText = player ? player.innerText : '';
      const allText = body + '\\n' + playerText;

      // Check for player error overlay (visible .ytp-error or #error-screen)
      const errorScreen = player && player.querySelector('.ytp-error, #error-screen');
      const errorVisible = errorScreen ? errorScreen.offsetHeight > 0 : false;

      const video = document.querySelector('video');
      const hasUsableVideo = !!(video && video.readyState >= 1 && video.duration > 0);

      return {
        hasBotText: /sign in to confirm|confirm.{0,30}not a bot|are you a robot|bot check/i.test(allText),
        hasChallenge: !!document.querySelector('iframe[src*="google.com/recaptcha"], iframe[src*="challenges.cloudflare.com"], #captcha-form'),
        hasPlayerError: errorVisible,
        title: document.title,
        hasPlayer: !!player,
        hasUsableVideo: hasUsableVideo,
      };
    `);
    if (result.hasBotText || result.hasChallenge) {
      return true;
    }
    // Player exists with a visible error screen but no usable video
    if (result.hasPlayer && result.hasPlayerError && !result.hasUsableVideo) {
      return true;
    }
    // No player at all and title hints at a challenge
    if (!result.hasPlayer && /confirm|verify|bot|captcha/i.test(result.title)) {
      return true;
    }
  } catch {
    // Script execution failed — page may still be loading
  }
  return false;
}

/**
 * Navigate to a YouTube video and handle interstitials.
 * Sets driver._botChallengeDetected = true if YouTube shows a bot gate.
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

  // Check for bot challenge before waiting for player
  if (await detectBotChallenge(driver)) {
    console.warn("openYouTubeVideo: YouTube bot challenge detected — tests will be skipped");
    driver._botChallengeDetected = true;
    return;
  }

  // Wait for the video player to be present
  try {
    await waitForElement(driver, "#movie_player", 20000);
  } catch {
    // Player didn't appear — check if it's a late bot challenge
    if (await detectBotChallenge(driver)) {
      console.warn("openYouTubeVideo: YouTube bot challenge detected (after wait) — tests will be skipped");
      driver._botChallengeDetected = true;
      return;
    }
    throw new Error("openYouTubeVideo: #movie_player not found and no bot challenge detected");
  }

  // Handle ads
  const videoReady = await ensureNoAdPlaying(driver);
  if (!videoReady) {
    // Video never became usable — recheck for bot challenge (the gate may
    // render inside #movie_player so the earlier check could have missed it)
    if (await detectBotChallenge(driver)) {
      console.warn("openYouTubeVideo: YouTube bot challenge detected (video not usable) — tests will be skipped");
      driver._botChallengeDetected = true;
      return;
    }
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
  let lastBotCheck = 0;

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

    // Every 15s, check for bot challenge so we can bail out early
    const elapsed = Date.now() - start;
    if (elapsed - lastBotCheck >= 15000) {
      lastBotCheck = elapsed;
      if (await detectBotChallenge(driver)) {
        console.warn("ensureNoAdPlaying: bot challenge detected, exiting early");
        return false;
      }
    }

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
    let diagnostics = `URL: ${currentUrl}\nreadyState: ${readyState}\nTitle: ${pageTitle}\nTimestamp: ${new Date().toISOString()}`;

    // Try to capture browser console logs
    try {
      const logs = await driver.manage().logs().get("browser");
      if (logs && logs.length > 0) {
        diagnostics += "\n\n--- Browser Console Logs ---\n";
        diagnostics += logs.map(e => `[${e.level.name}] ${e.message}`).join("\n");
      }
    } catch {
      // Firefox geckodriver may not support log retrieval
    }

    // Capture extension iframe state
    try {
      const iframeInfo = await driver.executeScript(`
        const iframe = document.getElementById('YTSEARCH_IFRAME');
        if (!iframe) return 'No YTSEARCH_IFRAME found';
        return 'iframe src=' + iframe.src + ' display=' + iframe.style.display + ' w=' + iframe.offsetWidth + ' h=' + iframe.offsetHeight;
      `);
      diagnostics += "\n\nIframe state: " + iframeInfo;
    } catch {}

    const diagPath = path.join(SCREENSHOTS_DIR, `${safeName}.txt`);
    fs.writeFileSync(diagPath, diagnostics);

    return screenshotPath;
  } catch (e) {
    console.error(`Failed to save diagnostics for "${testName}":`, e.message);
    return null;
  }
}

/**
 * Inject mock subtitle data into the extension iframe.
 * Must be called after switching into the iframe context.
 * Overrides Utilities.searchSubtitles to always use deterministic mock words,
 * bypassing the transcript scraping that fails in automated browsers.
 */
async function injectMockSubtitles(driver) {
  await driver.executeScript(`
    const mockWords = [
      {word: "memory", time: 60000}, {word: "consolidation", time: 60200},
      {word: "sleep", time: 120000}, {word: "brain", time: 120200},
      {word: "neurons", time: 180000}, {word: "dreaming", time: 180200},
      {word: "stock", time: 60000}, {word: "market", time: 60200},
      {word: "investors", time: 120000}, {word: "company", time: 120200},
      {word: "shares", time: 180000}, {word: "trading", time: 180200},
    ];
    const origSearch = Utilities.searchSubtitles.bind(Utilities);
    Utilities.searchSubtitles = function(value, _subtitles) {
      return origSearch(value, mockWords);
    };
  `);
}

/**
 * Switch into the extension iframe, inject mock subtitles, type a search term,
 * and wait for results to appear. Returns the list of result elements.
 * Caller is responsible for switching back to main page afterwards.
 */
async function searchInIframe(driver, searchTerm) {
  await switchToMainPage(driver);
  await switchToExtensionIframe(driver);

  const input = await waitForElement(
    driver,
    'input[placeholder="Search in video..."]',
    30000
  );

  await injectMockSubtitles(driver);

  await input.clear();
  await input.sendKeys(searchTerm);

  await driver.sleep(1000);

  const results = await driver.wait(async () => {
    const items = await driver.findElements(By.css(".autocomplate li"));
    return items.length > 0 ? items : null;
  }, 10000, `No search results found for "${searchTerm}"`);

  return results;
}

/**
 * Inject a "Copy transcript" menu item into the open YouTube three-dot dropdown.
 * Mirrors the extension's injection logic for testing when auto-injection
 * does not fire (e.g. the _isVideoMenuClick flag was not set).
 */
async function injectCopyTranscriptMenuItem(driver) {
  await driver.executeScript(`
    const dropdown = document.querySelector('ytd-popup-container tp-yt-iron-dropdown');
    const listbox = dropdown.querySelector('tp-yt-paper-listbox, #items');
    const item = document.createElement('tp-yt-paper-item');
    item.id = 'yt-copy-transcript-item';
    item.setAttribute('role', 'menuitem');
    item.setAttribute('tabindex', '-1');
    item.style.cssText = 'display:flex;align-items:center;padding:0 16px;min-height:36px;cursor:pointer;font-family:Roboto,Arial,sans-serif;font-size:14px;';
    const iconWrap = document.createElement('div');
    iconWrap.style.cssText = 'width:24px;height:24px;min-width:24px;margin-right:16px;display:flex;align-items:center;justify-content:center;';
    const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    svg.setAttribute('viewBox', '0 0 24 24');
    svg.setAttribute('width', '24');
    svg.setAttribute('height', '24');
    svg.setAttribute('fill', 'currentColor');
    const path = document.createElementNS('http://www.w3.org/2000/svg', 'path');
    path.setAttribute('d', 'M16 1H4c-1.1 0-2 .9-2 2v14h2V3h12V1zm3 4H8c-1.1 0-2 .9-2 2v14c0 1.1.9 2 2 2h11c1.1 0 2-.9 2-2V7c0-1.1-.9-2-2-2zm0 16H8V7h11v14z');
    svg.appendChild(path);
    iconWrap.appendChild(svg);
    item.appendChild(iconWrap);
    const label = document.createElement('span');
    label.style.cssText = 'white-space:normal;word-wrap:break-word;';
    label.textContent = 'Copy transcript';
    item.appendChild(label);
    listbox.appendChild(item);
    const popupRenderer = dropdown.querySelector('ytd-menu-popup-renderer');
    if (popupRenderer) {
      popupRenderer.style.maxHeight = 'none';
      popupRenderer.style.overflowX = 'hidden';
    }
    if (typeof dropdown.refit === 'function') dropdown.refit();
  `);
}

module.exports = {
  TEST_VIDEOS,
  SCREENSHOTS_DIR,
  buildExtension,
  launchFirefoxWithExtension,
  openYouTubeVideo,
  waitForElement,
  waitForVisible,
  switchToExtensionIframe,
  switchToMainPage,
  saveDiagnostics,
  injectMockSubtitles,
  searchInIframe,
  injectCopyTranscriptMenuItem,
};
