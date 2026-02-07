(function () {
  const state = {
    SEARCH_IFRAME: null,
    YOUTUBE_PLAYER: null,
    MOUSE_OVER_FRAME: null,
    IFRAME_ID: "YTSEARCH_IFRAME",
    SEARCH_BOX_VISIBILITY: false,
    YOUTUBE_RIGHT_CONTROLS: null,
    YOUTUBE_PLAYER_SEARCH_BUTTON: null,
  };

  const helpers = {
    onUrlChange(callback) {
      let href = "";
      const check = () => {
        if (href !== window.location.href) {
          href = window.location.href;
          callback(href);
        }
      };
      // YouTube uses History API for SPA navigation
      window.addEventListener("yt-navigate-finish", check);
      window.addEventListener("popstate", check);
      // Fallback poll for edge cases
      return setInterval(check, 500);
    },
    isVideoURL(url) {
      return url.indexOf(`https://${window.location.host}/watch`) === 0;
    },
    triggerEvent(el, type) {
      if ("createEvent" in document) {
        // modern browsers, IE9+
        var e = document.createEvent("HTMLEvents");
        e.initEvent(type, false, true);
        el.dispatchEvent(e);
      } else {
        // IE 8
        var e = document.createEventObject();
        e.eventType = type;
        el.fireEvent("on" + e.eventType, e);
      }
    },
    safePostMessage(target, message, origin) {
      try {
        target?.postMessage(message, origin);
      } catch (e) {
        // Ignore dead object errors (iframe navigated away)
      }
    },
  };

  const render = {
    iframe() {
      const iframe = document.createElement("iframe");
      iframe.setAttribute("id", state.IFRAME_ID);
      iframe.style =
        "margin-left:-150px;top:10%;left:50%;position:absolute;z-index:99999;overflow:hidden;display:none;";
      iframe.addEventListener("mouseenter", () => {
        state.MOUSE_OVER_FRAME = true;
      });
      iframe.addEventListener("mouseout", () => {
        state.MOUSE_OVER_FRAME = false;
        render.byState();
      });
      return iframe;
    },
    searchButton() {
      // Idempotent: reuse if it exists
      const id = "subtitle-search-button";
      const existing = document.getElementById(id);
      if (existing) return existing;

      const btn = document.createElement("button");
      btn.type = "button";
      btn.classList.add("ytp-button");
      btn.id = id;
      btn.setAttribute("aria-label", "Subtitle search");

      const ns = "http://www.w3.org/2000/svg";
      const svg = document.createElementNS(ns, "svg");
      svg.setAttribute("viewBox", "0 0 1792 1792");
      svg.setAttribute("focusable", "false");
      svg.setAttribute("aria-hidden", "true");
      svg.classList.add("ytp-svg-fill");

      // Force consistent size + centering
      btn.style.position = "relative";
      svg.style.setProperty("width", "24px", "important");
      svg.style.setProperty("height", "24px", "important");
      svg.style.setProperty("display", "block", "important");
      svg.style.setProperty("position", "absolute", "important");
      svg.style.setProperty("top", "50%", "important");
      svg.style.setProperty("left", "50%", "important");
      svg.style.setProperty("transform", "translate(-50%, -50%)", "important");
      svg.style.setProperty("margin", "0", "important");

      const path = document.createElementNS(ns, "path");
      path.setAttribute("fill", "currentColor");
      path.setAttribute(
        "d",
        "M1216 832q0-185-131.5-316.5t-316.5-131.5-316.5 131.5-131.5 316.5 131.5 316.5 316.5 131.5 316.5-131.5 131.5-316.5zm512 832q0 52-38 90t-90 38q-54 0-90-38l-343-342q-179 124-399 124-143 0-273.5-55.5t-225-150-150-225-55.5-273.5 55.5-273.5 150-225 225-150 273.5-55.5 273.5 55.5 225 150 150 225 55.5 273.5q0 220-124 399l343 343q37 37 37 90z"
      );

      svg.appendChild(path);
      btn.appendChild(svg);

      btn.addEventListener("click", render.toggleSearchInputVisibility);

      return btn;
    },
    byState() {
      if (!state.SEARCH_IFRAME || !state.YOUTUBE_PLAYER) return;

      if (state.SEARCH_BOX_VISIBILITY) {
        state.SEARCH_IFRAME.style.display = "block";
      } else if (!state.MOUSE_OVER_FRAME) {
        // Only hide if mouse is not over frame (allow interaction to complete)
        state.SEARCH_IFRAME.style.display = "none";
      }
    },
    toggleSearchInputVisibility() {
      state.SEARCH_BOX_VISIBILITY = !state.SEARCH_BOX_VISIBILITY;
      if (state.SEARCH_BOX_VISIBILITY) {
        state.MOUSE_OVER_FRAME = false; // Reset to ensure it shows
      }
      render.byState();
      if (state.SEARCH_BOX_VISIBILITY) {
        setTimeout(() => {
          state.SEARCH_IFRAME.contentWindow.postMessage("FOCUS_INPUT", "*");
        }, 100);
      }
    },
  };

  const logic = {
    async handleMessage(event) {
      let extension_url = chrome.runtime.getURL("").slice(0, -1);
      if (event.origin !== extension_url) {
        return;
      }

      const data = event.data;
      switch (data.action) {
        case "SEARCH.READY":
          state.YOUTUBE_PLAYER_SEARCH_BUTTON.style.display = "inline";
          break;
        case "SEARCH.CLOSE":
          state.SEARCH_BOX_VISIBILITY = false;
          state.MOUSE_OVER_FRAME = false; // Reset so it actually hides
          render.byState();
          break;
        case "SKIP":
          document.querySelector("video").currentTime = data.payload;

          // show timeline of video
          let el = document.getElementById("movie_player");
          helpers.triggerEvent(el, "mousemove");
          break;
        case "SEARCH.UPDATE_HEIGHT":
          state.SEARCH_IFRAME.style.height = data.payload;
          break;
        case "YT.GET_CAPTION_TRACKS": {
          const requestId = data.requestId;
          try {
            const tracks = await getCaptionTracks(data.payload.url);
            helpers.safePostMessage(event.source,
              {
                action: "YT.GET_CAPTION_TRACKS.RESULT",
                requestId,
                ok: true,
                tracks,
              },
              extension_url,
            );
          } catch (e) {
            helpers.safePostMessage(event.source,
              {
                action: "YT.GET_CAPTION_TRACKS.RESULT",
                requestId,
                ok: false,
                error: e?.message || String(e),
              },
              extension_url,
            );
          }
          break;
        }

        case "YT.GET_PLAYER_CAPTIONS": {
          const requestId = data.requestId;
          try {
            const result = await getPlayerCaptions();
            helpers.safePostMessage(event.source, 
              {
                action: "YT.GET_PLAYER_CAPTIONS.RESULT",
                requestId,
                ok: true,
                captions: result.captions,
                transcriptCues: result.transcriptCues,
              },
              extension_url,
            );
          } catch (e) {
            helpers.safePostMessage(event.source, 
              {
                action: "YT.GET_PLAYER_CAPTIONS.RESULT",
                requestId,
                ok: false,
                error: e?.message || String(e),
              },
              extension_url,
            );
          }
          break;
        }

        default:
          console.log("UNSUPPORTED ACTION", data);
          break;
      }
    },
  };

  // Read ytInitialData via wrappedJSObject (Firefox) without inline script injection
  function getYtInitialDataDirect() {
    try {
      const raw = window.wrappedJSObject?.ytInitialData;
      if (raw) return JSON.parse(JSON.stringify(raw));
    } catch (e) {}
    return null;
  }

  // Parse transcript cues from ytInitialData
  function parseTranscriptFromYtInitialData(ytInitialData) {
    const transcriptCues = [];
    if (!ytInitialData) return transcriptCues;

    const findTranscript = (obj) => {
      if (!obj || typeof obj !== 'object') return;
      if (obj.transcriptSearchPanelRenderer) {
        const sr = obj.transcriptSearchPanelRenderer;
        if (sr.body && sr.body.transcriptSegmentListRenderer) {
          const segments = sr.body.transcriptSegmentListRenderer.initialSegments || [];
          for (const seg of segments) {
            if (seg.transcriptSegmentRenderer) {
              const r = seg.transcriptSegmentRenderer;
              const startMs = parseInt(r.startMs || '0');
              const text = r.snippet?.runs?.map(run => run.text).join('') || '';
              if (text) transcriptCues.push({ startMs, text });
            }
          }
        }
      }
      for (const k in obj) {
        if (typeof obj[k] === 'object') findTranscript(obj[k]);
      }
    };
    findTranscript(ytInitialData);

    // Deduplicate cues (ytInitialData sometimes contains the transcript twice)
    const seen = new Set();
    const dedupedCues = [];
    for (const cue of transcriptCues) {
      const key = `${cue.startMs}:${cue.text}`;
      if (!seen.has(key)) {
        seen.add(key);
        dedupedCues.push(cue);
      }
    }
    return dedupedCues;
  }

  // Extract JSON object that follows a token in a string
  function extractJsonAfter(haystack, token) {
    const i = haystack.indexOf(token);
    if (i === -1) return null;
    let start = haystack.indexOf("{", i);
    if (start === -1) return null;
    let depth = 0;
    let cur = start;
    while (cur < haystack.length) {
      const ch = haystack[cur];
      if (ch === "{") depth++;
      else if (ch === "}") depth--;
      cur++;
      if (depth === 0) break;
    }
    try {
      return JSON.parse(haystack.substring(start, cur));
    } catch (e) {
      return null;
    }
  }

  function extractJsonStringValue(haystack, token) {
    const i = haystack.indexOf(token);
    if (i === -1) return null;
    let cur = i + token.length;
    let out = "";
    while (cur < haystack.length) {
      const ch = haystack[cur++];
      if (ch === "\\") {
        out += ch;
        if (cur < haystack.length) out += haystack[cur++];
        continue;
      }
      if (ch === '"') break;
      out += ch;
    }
    try {
      return JSON.parse('"' + out.replace(/"/g, '\\"') + '"');
    } catch (e) {
      return null;
    }
  }

  function extractPlayerResponse(html) {
    const prObj = extractJsonAfter(html, "ytInitialPlayerResponse");
    if (prObj) return prObj;
    const jsonStr = extractJsonStringValue(html, '"PLAYER_RESPONSE":"');
    if (jsonStr) {
      try {
        return JSON.parse(jsonStr);
      } catch (e) {
        return null;
      }
    }
    return null;
  }

  // Fetch YouTube page HTML and extract caption tracks
  async function getCaptionTracks(url) {
    const res = await fetch(url, { credentials: "include" });
    const html = await res.text();

    const initialPR = extractPlayerResponse(html);
    if (initialPR) {
      const tracks =
        initialPR?.captions?.playerCaptionsTracklistRenderer?.captionTracks ||
        [];
      if (tracks.length > 0) return tracks;
    }

    // Legacy fallback: scrape captionTracks JSON from HTML
    if (html.indexOf("captionTracks") === -1) {
      return [];
    }

    try {
      let startIdx = html.indexOf("captionTracks");
      startIdx = html.indexOf("[", startIdx);
      let curIdx = startIdx + 1;
      let depth = 1;
      while (depth != 0) {
        let curChar = html[curIdx];
        if (curChar == "[") depth += 1;
        else if (curChar == "]") depth -= 1;
        curIdx += 1;
      }
      return JSON.parse(html.substring(startIdx, curIdx));
    } catch (e) {
      return [];
    }
  }

  // Helper to wait for selector with polling
  async function waitForSelector(parent, selector, maxWait = 8000) {
    const start = Date.now();
    while (Date.now() - start < maxWait) {
      const el = parent.querySelectorAll(selector);
      if (el.length > 0) return el;
      await new Promise(r => setTimeout(r, 300));
    }
    return parent.querySelectorAll(selector);
  }

  // Scrape transcript from DOM (content script can access DOM directly)
  async function scrapeTranscriptFromDOM() {
    const transcriptCues = [];
    let hiddenStyle = null;

    try {
      // Find transcript button (structural selector, language-agnostic)
      const transcriptBtn = document.querySelector('ytd-video-description-transcript-section-renderer button');
      if (!transcriptBtn) return transcriptCues;

      // Hide panel with opacity and position:fixed to avoid layout shift
      // (visibility:hidden prevents rendering, so we use opacity instead)
      hiddenStyle = document.createElement('style');
      hiddenStyle.textContent = 'ytd-engagement-panel-section-list-renderer[target-id="engagement-panel-searchable-transcript"] { opacity: 0 !important; pointer-events: none !important; position: fixed !important; top: 0 !important; left: 0 !important; }';
      document.head.appendChild(hiddenStyle);

      transcriptBtn.click();
      await new Promise(r => setTimeout(r, 500));

      // Find and scrape transcript panel
      const transcriptPanel = document.querySelector('ytd-transcript-renderer, ytd-engagement-panel-section-list-renderer[target-id="engagement-panel-searchable-transcript"]');

      if (transcriptPanel) {
        const segments = await waitForSelector(transcriptPanel, 'ytd-transcript-segment-renderer');

        // Wait for content to load - YouTube lazy loads transcript text
        const waitForContent = async (maxWait = 5000) => {
          const start = Date.now();
          while (Date.now() - start < maxWait) {
            if (segments.length > 0 && segments[0].innerText && segments[0].innerText.trim()) {
              return true;
            }
            await new Promise(r => setTimeout(r, 200));
          }
          return false;
        };

        const contentLoaded = await waitForContent();

        // Only scrape if content loaded
        if (contentLoaded) {
          for (const seg of segments) {
            // Try to find structured elements first
            const tsEl = seg.querySelector('.segment-timestamp, [class*="timestamp"]');
            const txtEl = seg.querySelector('.segment-text, [class*="text"], yt-formatted-string');

            let timeText = '';
            let text = '';

            if (tsEl && txtEl) {
              timeText = tsEl.innerText.trim();
              text = txtEl.innerText.trim();
            } else {
              // Fallback: parse innerText
              const fullText = seg.innerText.trim();
              const lines = fullText.split(/[\n\r]+/).filter(l => l.trim());

              if (lines.length >= 2) {
                timeText = lines[0].trim();
                text = lines.slice(1).join(' ').trim();
              } else if (lines.length === 1) {
                const match = lines[0].match(/^(\d+:\d+(?::\d+)?)\s*(.*)/);
                if (match) {
                  timeText = match[1];
                  text = match[2];
                } else {
                  text = lines[0];
                }
              }
            }

            // Parse timestamp
            let startMs = 0;
            if (timeText) {
              const parts = timeText.split(':').map(p => parseInt(p) || 0);
              if (parts.length === 2) startMs = (parts[0] * 60 + parts[1]) * 1000;
              else if (parts.length === 3) startMs = (parts[0] * 3600 + parts[1] * 60 + parts[2]) * 1000;
            }

            if (text) transcriptCues.push({ startMs, text });
          }
        }
      }

      // Close panel
      const engagementPanel = document.querySelector('ytd-engagement-panel-section-list-renderer[target-id="engagement-panel-searchable-transcript"]');
      if (engagementPanel) {
        const closeBtn = engagementPanel.querySelector('#visibility-button button');
        if (closeBtn) {
          closeBtn.click();
          await new Promise(r => setTimeout(r, 300));
        }
      }
    } finally {
      // Always clean up hidden style
      if (hiddenStyle) hiddenStyle.remove();
    }

    return transcriptCues;
  }

  // Main function to get player captions
  async function getPlayerCaptions() {
    // Method 1: Try ytInitialData directly (Firefox wrappedJSObject, no CSP issues)
    try {
      const ytInitialData = getYtInitialDataDirect();
      const transcriptCues = parseTranscriptFromYtInitialData(ytInitialData);
      if (transcriptCues.length > 0) {
        return { captions: [], transcriptCues };
      }
    } catch (e) {
      console.warn('[YT-Search] wrappedJSObject error:', e.message);
    }

    // Method 2: Scrape from transcript panel DOM (content script can do this directly)
    const transcriptCues = await scrapeTranscriptFromDOM();

    if (transcriptCues.length === 0) {
      console.warn('[YT-Search] No transcript found. The video may not have captions.');
    }

    return { captions: [], transcriptCues };
  }

  function setup(url) {
    state.SEARCH_BOX_VISIBILITY = false;
    state.MOUSE_OVER_FRAME = false;

    if (!helpers.isVideoURL(url)) {
      return;
    }

    state.YOUTUBE_PLAYER = document.querySelector(
      "#container .html5-video-player",
    );
    if (state.YOUTUBE_PLAYER) {
      addOrUpdateSearchButton();
      addOrUpdateSearchInput(url);
    } else {
      setTimeout(() => setup(window.location.href), 2000);
    }
  }

  function addOrUpdateSearchInput(url) {
    state.SEARCH_IFRAME = render.iframe();
    state.SEARCH_IFRAME.src =
      chrome.runtime.getURL("src/app/index.html") +
      "?url=" +
      encodeURIComponent(url);

    if (!document.getElementById(state.IFRAME_ID)) {
      state.YOUTUBE_PLAYER.appendChild(state.SEARCH_IFRAME);
    } else {
      document.getElementById(state.IFRAME_ID).replaceWith(state.SEARCH_IFRAME);
    }
  }

  function addOrUpdateSearchButton() {
    state.YOUTUBE_PLAYER_SEARCH_BUTTON = render.searchButton();
    if (!document.getElementById("subtitle-search-button")) {
      state.YOUTUBE_RIGHT_CONTROLS = state.YOUTUBE_PLAYER.querySelector(
        ".ytp-right-controls",
      );
      state.YOUTUBE_RIGHT_CONTROLS.insertBefore(
        state.YOUTUBE_PLAYER_SEARCH_BUTTON,
        state.YOUTUBE_RIGHT_CONTROLS.firstChild,
      );
    } else {
      document
        .getElementById("subtitle-search-button")
        .replaceWith(state.YOUTUBE_PLAYER_SEARCH_BUTTON);
    }
  }

  helpers.onUrlChange(setup);
  window.addEventListener("message", logic.handleMessage);

  chrome.runtime.onMessage.addListener((data) => {
    if (data == "toggle-search-input") {
      render.toggleSearchInputVisibility();
    }
  });
})();
