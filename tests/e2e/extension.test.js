const { describe, it, before, after } = require("node:test");
const assert = require("node:assert");
const { By } = require("selenium-webdriver");
const {
  TEST_VIDEOS,
  buildExtension,
  launchFirefoxWithExtension,
  openYouTubeVideo,
  waitForElement,
  waitForVisible,
  switchToExtensionIframe,
  switchToMainPage,
  saveDiagnostics,
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
      // Switch into the extension iframe
      await switchToExtensionIframe(driver);

      // Find the search input
      const input = await waitForElement(
        driver,
        'input[placeholder="Search in video..."]',
        10000
      );
      assert.ok(input, "Search input should exist inside the iframe");

      // Type the search term
      await input.clear();
      await input.sendKeys(TEST_VIDEO.searchTerm);

      // Wait for dropdown results to appear
      // The dropdown container is .autocomplate (intentional spelling from source)
      await driver.sleep(1000); // Allow time for search to process

      const results = await driver.wait(async () => {
        const items = await driver.findElements(By.css(".autocomplate li"));
        return items.length > 0 ? items : null;
      }, 10000, `No search results found for "${TEST_VIDEO.searchTerm}"`);

      assert.ok(results.length > 0, "Should have at least one search result");

      // Verify first result has non-empty text (not just rendered but empty)
      const firstResultText = await results[0].getText();
      assert.ok(
        firstResultText.trim().length > 0,
        `First search result should have non-empty text, got: "${firstResultText}"`
      );

      // Switch back to main page for subsequent tests
      await switchToMainPage(driver);
    } catch (e) {
      // Make sure we're back on main page for diagnostics screenshot
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

      // Switch into iframe and click a result
      await switchToExtensionIframe(driver);

      // Re-enter search term if needed (previous test may have cleared state)
      const input = await waitForElement(
        driver,
        'input[placeholder="Search in video..."]',
        5000
      );
      await input.clear();
      await input.sendKeys(TEST_VIDEO.searchTerm);

      // Wait for results
      await driver.wait(async () => {
        const items = await driver.findElements(By.css(".autocomplate li"));
        return items.length > 0;
      }, 10000, "No search results appeared for seek test");

      const firstResult = await driver.findElement(By.css(".autocomplate li"));
      await firstResult.click();

      // Switch back to main page to check video time
      await switchToMainPage(driver);

      // Wait for currentTime to change (the click sends a SKIP message to seek)
      const seeked = await driver.wait(async () => {
        const timeAfter = await driver.executeScript(
          "return document.querySelector('video')?.currentTime || 0"
        );
        return Math.abs(timeAfter - timeBefore) > 1;
      }, 10000, "Video currentTime did not change after clicking search result");

      assert.ok(seeked, "Video should have seeked to a different timestamp");

      const timeAfter = await driver.executeScript(
        "return document.querySelector('video')?.currentTime || 0"
      );
      assert.ok(
        Math.abs(timeAfter - timeBefore) > 1,
        `Video time should have changed by > 1s. Before: ${timeBefore}, After: ${timeAfter}`
      );
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

      // Close the search iframe first (if open) by clicking the search button again
      try {
        const searchBtn = await driver.findElement(By.css("#subtitle-search-button"));
        await searchBtn.click();
        await driver.sleep(500);
      } catch {
        // Ignore — may already be closed
      }

      // Find and click the three-dot (more actions) menu button below the video
      const menuBtn = await waitForElement(
        driver,
        "#actions ytd-menu-renderer > yt-button-shape#button-shape button",
        10000
      );
      // Scroll into view and click
      await driver.executeScript("arguments[0].scrollIntoView({block:'center'})", menuBtn);
      await driver.sleep(500);
      await menuBtn.click();

      // Wait for the copy transcript menu item to appear
      const copyItem = await waitForElement(
        driver,
        "#yt-copy-transcript-item",
        10000
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

  it("should inject search button on fallback video", async (t) => {
    skipIfBotBlocked(t);
    try {
      const searchBtn = await waitForElement(driver, "#subtitle-search-button", 20000);
      assert.ok(searchBtn, "Search button should exist on fallback video");
    } catch (e) {
      await saveDiagnostics(driver, "06-fallback-search-button");
      throw e;
    }
  });

  it("should find search results on fallback video", async (t) => {
    skipIfBotBlocked(t);
    try {
      // Click search button to open iframe
      const searchBtn = await waitForElement(driver, "#subtitle-search-button", 10000);
      await searchBtn.click();
      await waitForVisible(driver, "#YTSEARCH_IFRAME", 15000);

      // Switch to iframe and search
      await switchToExtensionIframe(driver);
      const input = await waitForElement(
        driver,
        'input[placeholder="Search in video..."]',
        10000
      );
      await input.sendKeys(FALLBACK_VIDEO.searchTerm);

      await driver.sleep(1000);

      const results = await driver.wait(async () => {
        const items = await driver.findElements(By.css(".autocomplate li"));
        return items.length > 0 ? items : null;
      }, 10000, `No search results found for "${FALLBACK_VIDEO.searchTerm}" on fallback video`);

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
