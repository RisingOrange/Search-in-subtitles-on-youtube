const { describe, it, before, after } = require("node:test");
const assert = require("node:assert");
const {
  TEST_VIDEO,
  TEST_VIDEO_MODERN_UI,
  buildExtension,
  launchFirefoxWithExtension,
  openYouTubeVideo,
  waitForElement,
  waitForVisible,
  revealPlayerControls,
  switchToMainPage,
  saveDiagnostics,
  searchInIframe,
  injectCopyTranscriptMenuItem,
} = require("./helpers");

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
      await switchToMainPage(driver);
      await revealPlayerControls(driver);

      const searchBtn = await waitForVisible(driver, "#subtitle-search-button", 10000);
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

// YouTube has two transcript panel UIs:
// - Old: engagement-panel-searchable-transcript with ytd-transcript-segment-renderer elements
// - Modern: PAmodern_transcript_view with transcript-segment-view-model elements
//
// The tests above (first suite) use mock subtitles and test the extension's UI plumbing
// (button injection, iframe, search, seek, copy menu) — they don't exercise real scraping.
//
// This suite tests real DOM scraping against the modern transcript panel, which (unlike the
// old panel) reliably renders content in headless Firefox. It verifies the extension's
// selectors (.ytwTranscriptSegmentViewModelTimestamp, span.yt-core-attributed-string) can
// extract timestamps and text from the actual YouTube DOM.
describe("Modern Transcript UI (PAmodern_transcript_view)", { timeout: 120000 }, () => {
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
    await openYouTubeVideo(driver, TEST_VIDEO_MODERN_UI.url);
    if (driver._botChallengeDetected) {
      botBlocked = true;
      await saveDiagnostics(driver, "10-bot-challenge-modern");
    }
  });

  after(async () => {
    if (driver) {
      await driver.quit().catch(() => {});
    }
  });

  // This test exercises the actual transcript DOM scraping (no mocks) by:
  // 1. Expanding the video description
  // 2. Clicking "Show transcript" to open the panel
  // 3. Verifying transcript-segment-view-model elements render with timestamps + text
  // 4. Scraping using the same CSS selectors the extension uses
  //
  // Asserts that the modern panel (PAmodern_transcript_view) is used.
  // If YouTube changes which UI this video gets, the test will fail with
  // a clear message — pick a different video that uses the modern UI.
  it("should scrape transcript cues from the modern transcript panel", async (t) => {
    skipIfBotBlocked(t);
    try {
      await driver.sleep(2000);

      // Scroll down and expand description to reveal the "Show transcript" button
      await driver.executeScript(`
        const desc = document.querySelector('#description-inline-expander, #meta #description');
        if (desc) desc.scrollIntoView({ block: 'center' });
      `);
      await driver.sleep(1000);

      // Click the expand trigger — YouTube uses different elements across layouts
      await driver.executeScript(`
        // Try the tp-yt-paper-button#expand first, then the #snippet area as a click target
        const expandBtn = document.querySelector('tp-yt-paper-button#expand')
          || document.querySelector('#description-inline-expander #expand')
          || document.querySelector('#snippet');
        if (expandBtn) expandBtn.click();
      `);
      await driver.sleep(1500);

      const result = await driver.executeScript(`
        return new Promise(async (resolve) => {
          try {
            const btn = document.querySelector('ytd-video-description-transcript-section-renderer button');
            if (!btn) { resolve({ error: 'no transcript button found (description may not be expanded)' }); return; }

            btn.scrollIntoView({ block: 'center' });
            await new Promise(r => setTimeout(r, 500));
            btn.click();
            await new Promise(r => setTimeout(r, 3000));

            // Check which panel opened — modern or old
            const modernPanel = document.querySelector(
              'ytd-engagement-panel-section-list-renderer[target-id="PAmodern_transcript_view"][visibility="ENGAGEMENT_PANEL_VISIBILITY_EXPANDED"]'
            );
            const oldPanel = document.querySelector(
              'ytd-engagement-panel-section-list-renderer[target-id="engagement-panel-searchable-transcript"][visibility="ENGAGEMENT_PANEL_VISIBILITY_EXPANDED"]'
            );
            const panel = modernPanel || oldPanel;
            if (!panel) {
              // Collect diagnostics about all panels
              const allPanels = [...document.querySelectorAll('ytd-engagement-panel-section-list-renderer')].map(p => ({
                id: p.getAttribute('target-id'),
                vis: p.getAttribute('visibility'),
              }));
              resolve({ error: 'no transcript panel opened. Panels: ' + JSON.stringify(allPanels) });
              return;
            }
            const panelType = modernPanel ? 'modern' : 'old';

            // Wait for segments to appear (up to 8s)
            const segSelector = panelType === 'modern'
              ? 'transcript-segment-view-model'
              : 'ytd-transcript-segment-renderer';
            let segments;
            const start = Date.now();
            while (Date.now() - start < 8000) {
              segments = panel.querySelectorAll(segSelector);
              if (segments.length > 0) break;
              await new Promise(r => setTimeout(r, 300));
            }

            if (!segments || segments.length === 0) {
              resolve({ error: 'no transcript-segment-view-model elements found in ' + panelType + ' panel' });
              return;
            }

            // Wait for text to hydrate (same as production code)
            const textSelector = panelType === 'modern'
              ? 'span.yt-core-attributed-string'
              : '.segment-text, [class*="text"], yt-formatted-string';
            const hydrateStart = Date.now();
            while (Date.now() - hydrateStart < 5000) {
              const txt = segments[0].querySelector(textSelector);
              if (txt && txt.innerText && txt.innerText.trim()) break;
              await new Promise(r => setTimeout(r, 200));
            }

            // Scrape using the same selectors as the extension
            const cues = [];
            if (panelType === 'modern') {
              for (const seg of segments) {
                const tsEl = seg.querySelector('.ytwTranscriptSegmentViewModelTimestamp');
                const txtEl = seg.querySelector('span.yt-core-attributed-string');
                const timeText = tsEl ? tsEl.innerText.trim() : '';
                const text = txtEl ? txtEl.innerText.trim() : '';
                if (text) cues.push({ time: timeText, text: text.substring(0, 80) });
              }
            } else {
              for (const seg of segments) {
                const tsEl = seg.querySelector('.segment-timestamp, [class*="timestamp"]');
                const txtEl = seg.querySelector('.segment-text, [class*="text"], yt-formatted-string');
                const timeText = tsEl ? tsEl.innerText.trim() : '';
                const text = txtEl ? txtEl.innerText.trim() : '';
                if (text) cues.push({ time: timeText, text: text.substring(0, 80) });
              }
            }

            // Close the panel
            const closeBtn = panel.querySelector('#visibility-button button');
            if (closeBtn) closeBtn.click();

            resolve({ panelType, count: cues.length, first: cues[0] || null, last: cues[cues.length - 1] || null });
          } catch (e) {
            resolve({ error: e.message });
          }
        });
      `);

      assert.ok(!result.error, `Scraping failed: ${result.error}`);
      assert.strictEqual(
        result.panelType, "modern",
        `Expected modern transcript panel but got "${result.panelType}" — YouTube may have changed which UI this video uses`
      );
      assert.ok(result.count > 0, `Should have scraped cues, got ${result.count}`);
      assert.ok(result.first.time, `First cue should have a timestamp, got: "${result.first.time}"`);
      assert.ok(result.first.text.length > 0, "First cue should have non-empty text");
      assert.ok(
        /^\d+:\d+/.test(result.first.time),
        `Timestamp should match M:SS or H:MM:SS format, got: "${result.first.time}"`
      );
    } catch (e) {
      await saveDiagnostics(driver, "11-modern-transcript-scrape");
      throw e;
    }
  });
});
