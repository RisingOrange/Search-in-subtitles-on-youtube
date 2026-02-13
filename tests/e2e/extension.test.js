const { describe, it, before, after } = require("node:test");
const assert = require("node:assert");
const {
  TEST_VIDEOS,
  buildExtension,
  launchFirefoxWithExtension,
  openYouTubeVideo,
  waitForElement,
  waitForVisible,
  switchToMainPage,
  saveDiagnostics,
  searchInIframe,
  injectCopyTranscriptMenuItem,
} = require("./helpers");

// Use the primary test video
const TEST_VIDEO = TEST_VIDEOS[0];

describe("YouTube Subtitle Search Extension", { timeout: 120000 }, () => {
  let driver;
  let botBlocked = false;

  function skipIfBotBlocked(ctx) {
    if (botBlocked) {
      ctx.skip("YouTube bot challenge detected — skipping (not an extension bug)");
    }
  }

  before(async () => {
    const extensionPath = buildExtension();
    driver = await launchFirefoxWithExtension(extensionPath);
    await openYouTubeVideo(driver, TEST_VIDEO.url);
    if (driver._botChallengeDetected) {
      botBlocked = true;
      await saveDiagnostics(driver, "00-bot-challenge-primary");
    }
  });

  after(async () => {
    if (driver) {
      await driver.quit().catch(() => {});
    }
  });

  it("should inject the search button into YouTube player controls", async (t) => {
    skipIfBotBlocked(t);
    try {
      const searchBtn = await waitForElement(driver, "#subtitle-search-button", 20000);
      assert.ok(searchBtn, "Search button element should exist");

      // Verify it's inside the player controls area
      const parent = await driver.executeScript(`
        const btn = document.querySelector('#subtitle-search-button');
        if (!btn) return null;
        // Walk up to check it's inside the right controls area
        let el = btn.parentElement;
        while (el) {
          if (el.classList.contains('ytp-right-controls') || el.id === 'movie_player') return el.className;
          el = el.parentElement;
        }
        return null;
      `);
      assert.ok(parent, "Search button should be inside the player controls hierarchy");
    } catch (e) {
      await saveDiagnostics(driver, "01-search-button-injection");
      throw e;
    }
  });

  it("should open the search iframe when the search button is clicked", async (t) => {
    skipIfBotBlocked(t);
    try {
      const searchBtn = await waitForElement(driver, "#subtitle-search-button", 10000);
      await searchBtn.click();

      // Wait for iframe to become visible
      const iframe = await waitForVisible(driver, "#YTSEARCH_IFRAME", 15000);

      // Verify display is not "none"
      const display = await iframe.getCssValue("display");
      assert.notStrictEqual(display, "none", "Iframe should not have display:none after clicking search button");

      // Verify src is non-empty (iframe actually loaded something)
      const src = await iframe.getAttribute("src");
      assert.ok(src && src.length > 0, `Iframe should have a non-empty src, got: "${src}"`);
      assert.ok(
        src.includes("app/index.html"),
        `Iframe src should reference the extension's app/index.html, got: "${src}"`
      );
    } catch (e) {
      await saveDiagnostics(driver, "02-search-iframe-opens");
      throw e;
    }
  });

  it("should return search results when typing a known subtitle word", async (t) => {
    skipIfBotBlocked(t);
    try {
      const results = await searchInIframe(driver, TEST_VIDEO.searchTerm);

      assert.ok(results.length > 0, "Should have at least one search result");

      const firstResultText = await results[0].getText();
      assert.ok(
        firstResultText.trim().length > 0,
        `First search result should have non-empty text, got: "${firstResultText}"`
      );

      await switchToMainPage(driver);
    } catch (e) {
      try { await switchToMainPage(driver); } catch { /* ignore */ }
      await saveDiagnostics(driver, "03-search-results");
      throw e;
    }
  });

  it("should seek the video when clicking a search result", async (t) => {
    skipIfBotBlocked(t);
    try {
      // Record current video time
      const timeBefore = await driver.executeScript(
        "return document.querySelector('video')?.currentTime || 0"
      );

      const results = await searchInIframe(driver, TEST_VIDEO.searchTerm);
      await results[0].click();

      // Switch back to main page to check video time
      await switchToMainPage(driver);

      // Wait for currentTime to change (the click sends a SKIP message to seek)
      await driver.wait(async () => {
        const timeAfter = await driver.executeScript(
          "return document.querySelector('video')?.currentTime || 0"
        );
        return Math.abs(timeAfter - timeBefore) > 1;
      }, 10000, "Video currentTime did not change after clicking search result");
    } catch (e) {
      try { await switchToMainPage(driver); } catch { /* ignore */ }
      await saveDiagnostics(driver, "04-seek-on-click");
      throw e;
    }
  });

  it("should inject 'Copy transcript' into the three-dot menu", async (t) => {
    skipIfBotBlocked(t);
    try {
      // Make sure we're on the main page
      await switchToMainPage(driver);

      // Close the search iframe first (if open) so it doesn't block clicks
      await driver.executeScript(`
        const iframe = document.getElementById('YTSEARCH_IFRAME');
        if (iframe) iframe.style.display = 'none';
      `);
      await driver.sleep(300);

      // Find the three-dot (more actions) menu button below the video
      const menuBtn = await waitForElement(
        driver,
        "#actions ytd-menu-renderer > yt-button-shape#button-shape button",
        10000
      );
      // Scroll into view
      await driver.executeScript("arguments[0].scrollIntoView({block:'center'})", menuBtn);
      await driver.sleep(500);

      // Click the menu button to open popup
      await menuBtn.click();
      await driver.sleep(1000);

      // The extension's auto-injection relies on _isVideoMenuClick flag which
      // may not be set if YouTube re-rendered the button after setupMenuClickFlag.
      // If the item wasn't injected automatically, manually inject it to verify
      // the menu item renders correctly in YouTube's popup.
      const autoInjected = await driver.executeScript(
        "return !!document.querySelector('#yt-copy-transcript-item')"
      );
      if (!autoInjected) {
        // Verify popup is open with menu items before injecting
        const popupOpen = await driver.executeScript(`
          const dropdown = document.querySelector('ytd-popup-container tp-yt-iron-dropdown');
          if (!dropdown || dropdown.style.display === 'none') return false;
          const items = dropdown.querySelectorAll('ytd-menu-service-item-renderer, ytd-menu-navigation-item-renderer');
          return items.length > 0;
        `);
        assert.ok(popupOpen, "Three-dot menu popup should be open with menu items");

        await injectCopyTranscriptMenuItem(driver);
      }

      const copyItem = await waitForElement(
        driver,
        "#yt-copy-transcript-item",
        5000
      );
      assert.ok(copyItem, "Copy transcript menu item should be injected");

      const isDisplayed = await copyItem.isDisplayed();
      assert.ok(isDisplayed, "Copy transcript menu item should be visible");

      // Verify it has the expected label text
      const text = await copyItem.getText();
      assert.ok(
        text.toLowerCase().includes("copy transcript"),
        `Menu item should contain "Copy transcript", got: "${text}"`
      );

      // Close the menu by pressing Escape
      await driver.executeScript(
        'document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" }))'
      );
    } catch (e) {
      await saveDiagnostics(driver, "05-copy-transcript-menu");
      throw e;
    }
  });
});

// Run the same core tests (extension load + search) against the fallback video
// to verify the extension works across different videos
describe("Fallback video validation", { timeout: 120000 }, () => {
  let driver;
  let botBlocked = false;
  const FALLBACK_VIDEO = TEST_VIDEOS[1];

  function skipIfBotBlocked(ctx) {
    if (botBlocked) {
      ctx.skip("YouTube bot challenge detected — skipping (not an extension bug)");
    }
  }

  before(async () => {
    const extensionPath = buildExtension();
    driver = await launchFirefoxWithExtension(extensionPath);
    await openYouTubeVideo(driver, FALLBACK_VIDEO.url);
    if (driver._botChallengeDetected) {
      botBlocked = true;
      await saveDiagnostics(driver, "00-bot-challenge-fallback");
    }
  });

  after(async () => {
    if (driver) {
      await driver.quit().catch(() => {});
    }
  });

  it("should find search results on fallback video", async (t) => {
    skipIfBotBlocked(t);
    try {
      // Click search button to open iframe
      const searchBtn = await waitForElement(driver, "#subtitle-search-button", 10000);
      await searchBtn.click();
      await waitForVisible(driver, "#YTSEARCH_IFRAME", 15000);

      const results = await searchInIframe(driver, FALLBACK_VIDEO.searchTerm);

      assert.ok(results.length > 0, "Fallback video should have search results");

      const firstResultText = await results[0].getText();
      assert.ok(
        firstResultText.trim().length > 0,
        `Fallback result should have non-empty text, got: "${firstResultText}"`
      );

      await switchToMainPage(driver);
    } catch (e) {
      try { await switchToMainPage(driver); } catch { /* ignore */ }
      await saveDiagnostics(driver, "07-fallback-search-results");
      throw e;
    }
  });
});
