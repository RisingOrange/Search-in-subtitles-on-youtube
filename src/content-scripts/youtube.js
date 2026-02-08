(function () {
  const state = {
    SEARCH_IFRAME: null,
    YOUTUBE_PLAYER: null,
    MOUSE_OVER_FRAME: null,
    IFRAME_ID: "YTSEARCH_IFRAME",
    SEARCH_BOX_VISIBILITY: false,
    YOUTUBE_RIGHT_CONTROLS: null,
    YOUTUBE_PLAYER_SEARCH_BUTTON: null,
    TRANSCRIPT_STATE: "idle", // idle | loading | ready | error
    TRANSCRIPT_CACHE: null,   // { videoId: string, cues: array }
    CURRENT_VIDEO_ID: null,
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
    getVideoId() {
      const params = new URLSearchParams(window.location.search);
      return params.get("v") || null;
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

  const copyTranscript = {
    _popupObserver: null,
    _retryTimeout: null,
    _menuRetryTimeout: null,
    _isVideoMenuClick: false,
    _menuButtonListeners: new WeakSet(),

    cleanup() {
      if (this._popupObserver) {
        this._popupObserver.disconnect();
        this._popupObserver = null;
      }
      if (this._retryTimeout) {
        clearTimeout(this._retryTimeout);
        this._retryTimeout = null;
      }
      if (this._menuRetryTimeout) {
        clearTimeout(this._menuRetryTimeout);
        this._menuRetryTimeout = null;
      }
      this._isVideoMenuClick = false;
      const toast = document.getElementById("yt-copy-transcript-toast");
      if (toast) toast.remove();
    },

    formatCues(cues) {
      return cues.map(cue => {
        const totalSec = Math.floor(cue.startMs / 1000);
        const h = Math.floor(totalSec / 3600);
        const m = Math.floor((totalSec % 3600) / 60);
        const s = totalSec % 60;
        const ts = h > 0
          ? `${h}:${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}`
          : `${m}:${String(s).padStart(2, "0")}`;
        return `${ts} ${cue.text}`;
      }).join("\n");
    },

    async writeToClipboard(text) {
      // Try navigator.clipboard first
      if (navigator.clipboard && navigator.clipboard.writeText) {
        try {
          await navigator.clipboard.writeText(text);
          return true;
        } catch (e) {
          // Fall through to execCommand
        }
      }
      // Fallback: execCommand
      try {
        const ta = document.createElement("textarea");
        ta.value = text;
        ta.style.cssText = "position:fixed;left:-9999px;top:-9999px;opacity:0;";
        document.body.appendChild(ta);
        ta.select();
        const ok = document.execCommand("copy");
        ta.remove();
        if (ok) return true;
      } catch (e) {}
      return false;
    },

    showToast(message, type) {
      const existing = document.getElementById("yt-copy-transcript-toast");
      if (existing) existing.remove();

      const player = document.querySelector("#container .html5-video-player");
      if (!player) return;

      const toast = document.createElement("div");
      toast.id = "yt-copy-transcript-toast";
      const backgrounds = { success: "rgba(30,130,76,0.92)", error: "rgba(192,57,43,0.92)" };
      const bg = backgrounds[type] || "rgba(50,50,50,0.92)";
      toast.style.cssText = `position:absolute;bottom:80px;left:50%;transform:translateX(-50%);
        background:${bg};color:#fff;padding:10px 20px;border-radius:8px;font-size:14px;
        font-family:Roboto,Arial,sans-serif;z-index:100000;pointer-events:none;
        opacity:0;transition:opacity 0.3s ease;white-space:nowrap;`;
      toast.textContent = message;
      player.appendChild(toast);

      // Fade in
      requestAnimationFrame(() => { toast.style.opacity = "1"; });
      // Auto-dismiss
      setTimeout(() => {
        toast.style.opacity = "0";
        setTimeout(() => toast.remove(), 300);
      }, 2000);
    },

    createMenuItem() {
      const item = document.createElement("tp-yt-paper-item");
      item.id = "yt-copy-transcript-item";
      item.setAttribute("role", "menuitem");
      item.setAttribute("tabindex", "-1");
      item.style.cssText = "display:flex;align-items:center;padding:0 16px;min-height:36px;cursor:pointer;font-family:Roboto,Arial,sans-serif;font-size:14px;";

      // Icon
      const iconWrap = document.createElement("div");
      iconWrap.style.cssText = "width:24px;height:24px;min-width:24px;margin-right:16px;display:flex;align-items:center;justify-content:center;";
      const ns = "http://www.w3.org/2000/svg";
      const svg = document.createElementNS(ns, "svg");
      svg.setAttribute("viewBox", "0 0 24 24");
      svg.setAttribute("width", "24");
      svg.setAttribute("height", "24");
      svg.setAttribute("fill", "currentColor");
      const path = document.createElementNS(ns, "path");
      path.setAttribute("d", "M16 1H4c-1.1 0-2 .9-2 2v14h2V3h12V1zm3 4H8c-1.1 0-2 .9-2 2v14c0 1.1.9 2 2 2h11c1.1 0 2-.9 2-2V7c0-1.1-.9-2-2-2zm0 16H8V7h11v14z");
      svg.appendChild(path);
      iconWrap.appendChild(svg);
      item.appendChild(iconWrap);

      // Label
      const label = document.createElement("span");
      label.style.cssText = "white-space:normal;word-wrap:break-word;";
      label.textContent = "Copy transcript";
      item.appendChild(label);

      item.addEventListener("click", (e) => {
        e.stopPropagation();
        // Close the menu by simulating Escape — keeps YouTube's internal state in sync
        document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", code: "Escape", bubbles: true }));
        this.handleCopyClick(label);
      });

      return item;
    },

    setLabelTemporarily(labelEl, text, resetDelay = 2000) {
      labelEl.textContent = text;
      setTimeout(() => { labelEl.textContent = "Copy transcript"; }, resetDelay);
    },

    async copyAndShowFeedback(cues, labelEl) {
      const text = this.formatCues(cues);
      const ok = await this.writeToClipboard(text);
      if (ok) {
        this.setLabelTemporarily(labelEl, "Copied!");
        this.showToast("Transcript copied!", "success");
      } else {
        this.setLabelTemporarily(labelEl, "Click again to copy", 5000);
      }
    },

    hasCachedTranscript(videoId) {
      return state.TRANSCRIPT_STATE === "ready"
        && state.TRANSCRIPT_CACHE
        && state.TRANSCRIPT_CACHE.videoId === videoId
        && state.TRANSCRIPT_CACHE.cues.length > 0;
    },

    async handleCopyClick(labelEl) {
      const videoId = helpers.getVideoId();
      if (!videoId) return;

      if (this.hasCachedTranscript(videoId)) {
        await this.copyAndShowFeedback(state.TRANSCRIPT_CACHE.cues, labelEl);
        return;
      }

      if (state.TRANSCRIPT_STATE === "loading") return;

      labelEl.textContent = "Loading...";
      state.TRANSCRIPT_STATE = "loading";

      try {
        const result = await getPlayerCaptions();
        const cues = result.transcriptCues || [];

        if (helpers.getVideoId() !== videoId) {
          state.TRANSCRIPT_STATE = "idle";
          return;
        }

        if (cues.length === 0) {
          state.TRANSCRIPT_STATE = "error";
          this.setLabelTemporarily(labelEl, "No transcript", 3000);
          this.showToast("No transcript available", "error");
          return;
        }

        state.TRANSCRIPT_CACHE = { videoId, cues };
        state.TRANSCRIPT_STATE = "ready";
        await this.copyAndShowFeedback(cues, labelEl);
      } catch (e) {
        if (helpers.getVideoId() !== videoId) {
          state.TRANSCRIPT_STATE = "idle";
          return;
        }
        state.TRANSCRIPT_STATE = "error";
        this.setLabelTemporarily(labelEl, "Error", 3000);
        this.showToast("Failed to load transcript", "error");
      }
    },

    tryInjectIntoVisiblePopup() {
      const popupContainer = document.querySelector("ytd-popup-container");
      if (!popupContainer) return;

      const dropdown = popupContainer.querySelector("tp-yt-iron-dropdown");
      if (!dropdown) return;

      // Check if dropdown is actually visible
      if (dropdown.style.display === "none") return;
      if (dropdown.getAttribute("aria-hidden") === "true") return;

      // Only inject if the video's three-dot button was what opened this popup
      if (!this._isVideoMenuClick) return;

      // Already injected?
      if (dropdown.querySelector("#yt-copy-transcript-item")) return;

      // Find menu items to confirm this is a menu popup (not some other dropdown)
      const menuItems = dropdown.querySelectorAll("ytd-menu-service-item-renderer, ytd-menu-navigation-item-renderer");

      if (menuItems.length === 0) return;

      // Find the list container
      const listbox = dropdown.querySelector("tp-yt-paper-listbox, #items");

      if (!listbox) return;

      listbox.appendChild(this.createMenuItem());
      // YTD-MENU-POPUP-RENDERER has a tight max-height that causes scrollbars
      const popupRenderer = dropdown.querySelector("ytd-menu-popup-renderer");
      if (popupRenderer) {
        popupRenderer.style.maxHeight = "none";
        popupRenderer.style.overflowX = "hidden";
      }
      if (typeof dropdown.refit === "function") dropdown.refit();
    },

    setupMenuClickFlag(retries = 0) {
      const menuBtn = document.querySelector(
        "#actions ytd-menu-renderer > yt-button-shape#button-shape button"
      );
      if (!menuBtn) {
        if (retries < 5) {
          this._menuRetryTimeout = setTimeout(() => this.setupMenuClickFlag(retries + 1), 1000);
        }
        return;
      }
      if (this._menuButtonListeners.has(menuBtn)) return;
      this._menuButtonListeners.add(menuBtn);
      menuBtn.addEventListener("click", () => {
        this._isVideoMenuClick = true;
      });
    },

    setupPopupObserver(retries = 0) {
      if (this._popupObserver) return;

      const popupContainer = document.querySelector("ytd-popup-container");

      if (!popupContainer) {
        if (retries < 5) {
          this._retryTimeout = setTimeout(() => this.setupPopupObserver(retries + 1), 1000);
        }
        return;
      }

      this._popupObserver = new MutationObserver(() => {
        // Reset flag when dropdown closes
        const dropdown = popupContainer.querySelector("tp-yt-iron-dropdown");
        if (dropdown && (dropdown.style.display === "none" || dropdown.getAttribute("aria-hidden") === "true")) {
          this._isVideoMenuClick = false;
        }
        this.tryInjectIntoVisiblePopup();
      });
      // Watch for attribute changes (style, aria-hidden) on the dropdown and subtree changes
      this._popupObserver.observe(popupContainer, {
        childList: true,
        subtree: true,
        attributes: true,
        attributeFilter: ["style", "aria-hidden"],
      });
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

  function cacheTranscript(videoId, cues) {
    if (videoId && helpers.getVideoId() === videoId) {
      state.TRANSCRIPT_CACHE = { videoId, cues };
      state.TRANSCRIPT_STATE = "ready";
    }
  }

  // Main function to get player captions
  async function getPlayerCaptions() {
    const videoId = helpers.getVideoId();

    // Return cached result if available
    if (copyTranscript.hasCachedTranscript(videoId)) {
      return { captions: [], transcriptCues: state.TRANSCRIPT_CACHE.cues };
    }

    // Scrape from transcript panel DOM (content script can do this directly)
    const transcriptCues = await scrapeTranscriptFromDOM();

    if (transcriptCues.length === 0) {
      console.warn('[YT-Search] No transcript found. The video may not have captions.');
    } else {
      cacheTranscript(videoId, transcriptCues);
    }

    return { captions: [], transcriptCues };
  }

  function setup(url) {
    state.SEARCH_BOX_VISIBILITY = false;
    state.MOUSE_OVER_FRAME = false;

    // Reset transcript state when video changes
    const newVideoId = helpers.getVideoId();
    if (newVideoId !== state.CURRENT_VIDEO_ID) {
      state.CURRENT_VIDEO_ID = newVideoId;
      state.TRANSCRIPT_STATE = "idle";
      state.TRANSCRIPT_CACHE = null;
    }
    copyTranscript.cleanup();

    if (!helpers.isVideoURL(url)) {
      return;
    }

    state.YOUTUBE_PLAYER = document.querySelector(
      "#container .html5-video-player",
    );
    if (state.YOUTUBE_PLAYER) {
      addOrUpdateSearchButton();
      addOrUpdateSearchInput(url);
      copyTranscript.setupPopupObserver();
      copyTranscript.setupMenuClickFlag();
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
