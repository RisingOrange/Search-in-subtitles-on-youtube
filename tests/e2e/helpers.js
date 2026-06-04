const { execSync } = require("child_process");
const { Builder, By, until } = require("selenium-webdriver");
const firefox = require("selenium-webdriver/firefox");
const { download: downloadGeckodriver } = require("geckodriver");
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

// Pinned geckodriver version. geckodriver 0.37.0 (2026-06-03) has a regression
// where installAddon() reports success but content scripts of the installed
// add-on never run, so every injection-dependent test fails. The previous code
// passed `geckodriver.path` (undefined in geckodriver@4.x) to ServiceBuilder,
// which made Selenium Manager silently download and use the latest geckodriver.
//
// Revisit this pin when geckodriver releases a version > 0.37.0 (no upstream
// bug report existed as of 2026-06-04) — eventually a newer Firefox will
// require a newer driver and this pin will become the breakage.
const GECKODRIVER_VERSION = "0.36.0";

let geckodriverPathPromise = null;
function ensureGeckodriver() {
  if (!geckodriverPathPromise) {
    geckodriverPathPromise = downloadAndVerifyGeckodriver().catch((e) => {
      // Don't cache the failure — let the next launch attempt a fresh download.
      geckodriverPathPromise = null;
      throw e;
    });
  }
  return geckodriverPathPromise;
}

async function downloadAndVerifyGeckodriver() {
  // download() returns any binary already present in cacheDir without
  // checking its version, so scope the cache dir by version to make the
  // pin effective.
  const cacheDir = path.join(
    PROJECT_ROOT,
    "dist",
    "geckodriver",
    GECKODRIVER_VERSION
  );
  for (let attempt = 0; attempt < 2; attempt++) {
    const binaryPath = await downloadGeckodriver(GECKODRIVER_VERSION, cacheDir);
    try {
      // A failed/partial earlier download leaves a corrupt binary that
      // download() would happily keep returning — verify before using it.
      execSync(`"${binaryPath}" --version`, { stdio: "pipe" });
      return binaryPath;
    } catch {
      fs.rmSync(cacheDir, { recursive: true, force: true });
    }
  }
  throw new Error(
    `geckodriver ${GECKODRIVER_VERSION} binary failed verification after re-download`
  );
}

// TED-Ed: "The benefits of a good night's sleep" — has creator-provided English captions.
// Uses old transcript UI (engagement-panel-searchable-transcript with ytd-transcript-segment-renderer).
const TEST_VIDEO = {
  url: "https://www.youtube.com/watch?v=gedoSfZvBgE&hl=en&gl=US",
  searchTerm: "memory",
};

// Video with modern transcript UI (PAmodern_transcript_view with transcript-segment-view-model).
const TEST_VIDEO_MODERN_UI = {
  url: "https://www.youtube.com/watch?v=nve6PtFJeo4&hl=en&gl=US",
  searchTerm: "claude",
};

// The three-dot ("More actions") button below the video.
const VIDEO_MENU_BUTTON_SELECTOR =
  "#actions ytd-menu-renderer > yt-button-shape#button-shape button";

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
  const service = new firefox.ServiceBuilder(await ensureGeckodriver());
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

  // Mute all audio output at the browser level
  options.setPreference("media.volume_scale", "0.0");

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

function isNavigationTimeout(err) {
  return err && (err.name === "TimeoutError" || err.name === "ScriptTimeoutError");
}

async function navigateWithRetry(driver, url) {
  try {
    await driver.get(url);
    return true;
  } catch (err) {
    if (!isNavigationTimeout(err)) throw err;
    console.warn(`navigateWithRetry: navigation to ${url} timed out, retrying once`);
    try {
      await driver.get(url);
      return true;
    } catch (err2) {
      if (!isNavigationTimeout(err2)) throw err2;
      console.warn(`navigateWithRetry: retry to ${url} also timed out — tests will be skipped`);
      driver._navigationTimedOut = true;
      return false;
    }
  }
}

/**
 * Navigate to a YouTube video and handle interstitials.
 * Sets driver._botChallengeDetected = true if YouTube shows a bot gate.
 * Sets driver._navigationTimedOut = true if YouTube fails to load after a retry.
 */
async function openYouTubeVideo(driver, url) {
  // Set consent cookie before navigating to suppress GDPR dialogs
  if (!(await navigateWithRetry(driver, "https://www.youtube.com"))) return;
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

  if (!(await navigateWithRetry(driver, url))) return;

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
 * Return true when the search iframe exists and is visibly rendered.
 */
async function isSearchIframeVisible(driver) {
  return driver.executeScript(`
    const iframe = document.getElementById('YTSEARCH_IFRAME');
    return !!(
      iframe &&
      iframe.offsetWidth > 0 &&
      iframe.offsetHeight > 0 &&
      getComputedStyle(iframe).display !== 'none' &&
      getComputedStyle(iframe).visibility !== 'hidden'
    );
  `);
}

/**
 * Nudge the YouTube player so its controls are visible and clickable.
 */
async function revealPlayerControls(driver) {
  await driver.executeScript(`
    const player = document.querySelector('#movie_player');
    if (!player) return false;

    const rect = player.getBoundingClientRect();
    const x = rect.left + rect.width / 2;
    const y = rect.top + rect.height - 30;
    for (const type of ['mouseenter', 'mousemove', 'mouseover']) {
      player.dispatchEvent(new MouseEvent(type, {
        bubbles: true,
        clientX: x,
        clientY: y,
      }));
    }
    return true;
  `);
  await driver.wait(async () => {
    return driver.executeScript(`
      const btn = document.querySelector('#subtitle-search-button');
      if (!btn) return false;
      const style = getComputedStyle(btn);
      return btn.offsetWidth > 0 &&
        btn.offsetHeight > 0 &&
        style.display !== 'none' &&
        style.visibility !== 'hidden';
    `);
  }, 3000, "Search button did not become visible after revealing player controls");
}

/**
 * Ensure the search iframe is open and visible.
 * Returns the iframe element in the main page context.
 */
async function ensureSearchIframeOpen(driver) {
  await switchToMainPage(driver);

  if (await isSearchIframeVisible(driver)) {
    return waitForVisible(driver, "#YTSEARCH_IFRAME", 1000);
  }

  for (let attempt = 0; attempt < 2; attempt++) {
    await revealPlayerControls(driver);
    const searchBtn = await waitForVisible(driver, "#subtitle-search-button", 10000);

    try {
      await searchBtn.click();
    } catch {
      await driver.executeScript("arguments[0].click()", searchBtn);
    }

    try {
      return await waitForVisible(driver, "#YTSEARCH_IFRAME", 5000);
    } catch {
      // Retry once after re-revealing player controls in case YouTube hid them mid-click.
    }
  }

  return waitForVisible(driver, "#YTSEARCH_IFRAME", 15000);
}

/**
 * Switch into the extension's search iframe.
 */
async function switchToExtensionIframe(driver) {
  const iframe = await ensureSearchIframeOpen(driver);
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
    ];
    Utilities.getSubtitles = async function() {
      return mockWords;
    };
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
 *
 * Retries once when the iframe's browsing context gets discarded mid-search —
 * YouTube occasionally re-renders the player subtree (e.g. ad transitions),
 * which destroys and re-creates the extension iframe.
 */
async function searchInIframe(driver, searchTerm, { retries = 1 } = {}) {
  try {
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
  } catch (e) {
    const contextDiscarded =
      e.name === "NoSuchWindowError" ||
      /browsing context has been discarded/i.test(e.message || "");
    if (contextDiscarded && retries > 0) {
      return searchInIframe(driver, searchTerm, { retries: retries - 1 });
    }
    throw e;
  }
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

/**
 * Wait for the watch page below the player to hydrate (title + actions row).
 * Headless sessions show skeleton/shimmer placeholders until hydration
 * completes. Returns true when hydrated, false otherwise — callers should
 * fail their test on false: with the generous wait below, a miss is a real
 * anomaly (or a YouTube markup change), not environment noise.
 *
 * Timings are empirical (8-trial pure-wait experiment, 2026-06-04):
 * hydration is bimodal — ~1s or ~18-22s — and all sessions hydrated within
 * 23s without any reload. An earlier 15s wait + reload-retry approach only
 * appeared to work because each reload re-raced the same too-short window;
 * reloads restart hydration rather than rescue it, so we just wait longer.
 */
async function ensureWatchPageHydrated(driver) {
  // Deliberately checks broad hydration markers (title + any action button)
  // rather than the specific menu-button selector the extension uses — if
  // YouTube changes that markup on an otherwise hydrated page, the dependent
  // tests should fail (exposing the regression), not skip.
  // Transient executeScript failures (e.g. the page is mid-navigation) must
  // not reject the wait — driver.wait() propagates condition rejections
  // immediately, which would silently burn the whole 60s budget.
  const isHydrated = () =>
    driver
      .executeScript(`
        const title = document.querySelector('ytd-watch-metadata #title h1 yt-formatted-string');
        const actionButton = document.querySelector('ytd-watch-metadata #actions button');
        return !!(title && title.innerText.trim() && actionButton);
      `)
      .catch(() => false);

  // One long wait (~3x the slow mode), plus a single reload as a last
  // resort for the rare genuinely-stuck session.
  for (let attempt = 0; attempt < 2; attempt++) {
    if (attempt > 0) {
      await driver.navigate().refresh();
    }
    try {
      await driver.wait(isHydrated, 60000);
      return true;
    } catch {
      // Timed out — fall through to reload and retry.
    }
  }
  return false;
}

/**
 * Open the three-dot ("More actions") menu below the video and wait for its
 * popup to populate. YouTube re-renders the button and can swallow clicks,
 * so re-query and retry a few times. Returns true when the popup is open
 * with menu items.
 */
async function openVideoMenu(driver) {
  // Strict popup check: any dropdown counts only when it is actually
  // rendered (not display:none, not aria-hidden, non-zero size) AND contains
  // menu items — a stale or unrelated dropdown must not count as open.
  const isPopupOpen = () =>
    driver.executeScript(`
      return [...document.querySelectorAll('ytd-popup-container tp-yt-iron-dropdown')].some((dropdown) => {
        if (dropdown.style.display === 'none') return false;
        if (dropdown.getAttribute('aria-hidden') === 'true') return false;
        const rect = dropdown.getBoundingClientRect();
        if (rect.width === 0 || rect.height === 0) return false;
        const items = dropdown.querySelectorAll('ytd-menu-service-item-renderer, ytd-menu-navigation-item-renderer');
        return items.length > 0;
      });
    `);

  for (let attempt = 0; attempt < 6; attempt++) {
    // Don't click when the popup is already open — the button toggles, so a
    // blind re-click after a slow populate would close it again.
    if (await isPopupOpen()) return true;
    const menuBtn = await waitForElement(driver, VIDEO_MENU_BUTTON_SELECTOR, 10000);
    await driver.executeScript("arguments[0].scrollIntoView({block:'center'})", menuBtn);
    await driver.sleep(500);
    // YouTube swallows native (trusted) clicks on this button in some
    // sessions, so rotate click strategies: Selenium click, JS click, and a
    // synthetic pointer-event sequence (Polymer buttons may listen on
    // pointerdown, which a bare JS click() does not emit).
    if (attempt % 3 === 0) {
      await menuBtn.click().catch(() => {});
    } else if (attempt % 3 === 1) {
      await driver.executeScript("arguments[0].click()", menuBtn);
    } else {
      await driver.executeScript(`
        const btn = arguments[0];
        const rect = btn.getBoundingClientRect();
        const opts = {
          bubbles: true, cancelable: true, composed: true,
          clientX: rect.x + rect.width / 2, clientY: rect.y + rect.height / 2,
        };
        btn.dispatchEvent(new PointerEvent('pointerdown', opts));
        btn.dispatchEvent(new MouseEvent('mousedown', opts));
        btn.dispatchEvent(new PointerEvent('pointerup', opts));
        btn.dispatchEvent(new MouseEvent('mouseup', opts));
        btn.dispatchEvent(new MouseEvent('click', opts));
      `, menuBtn);
    }
    const popupOpen = await driver.wait(isPopupOpen, 5000).catch(() => false);
    if (popupOpen) return true;
  }
  return false;
}

module.exports = {
  TEST_VIDEO,
  TEST_VIDEO_MODERN_UI,
  SCREENSHOTS_DIR,
  buildExtension,
  launchFirefoxWithExtension,
  openYouTubeVideo,
  waitForElement,
  waitForVisible,
  revealPlayerControls,
  ensureSearchIframeOpen,
  switchToExtensionIframe,
  switchToMainPage,
  saveDiagnostics,
  injectMockSubtitles,
  searchInIframe,
  injectCopyTranscriptMenuItem,
  ensureWatchPageHydrated,
  openVideoMenu,
};
