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
      return setInterval(function () {
        if (href !== window.location.href) {
          href = window.location.href;
          callback(href);
        }
      }, 1);
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
  };

  const render = {
    iframe() {
      const iframe = document.createElement("iframe");
      iframe.setAttribute("id", state.IFRAME_ID);
      iframe.style =
        "margin-left:-150px;top:10%;left:50%;position:absolute;z-index:99999;overflow:hidden;display:none;";
      iframe.addEventListener(
        "mouseenter",
        () => (state.MOUSE_OVER_FRAME = true),
      );
      iframe.addEventListener(
        "mouseout",
        () => (state.MOUSE_OVER_FRAME = false),
      );
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
      if (!state.SEARCH_IFRAME) return;

      if (!state.SEARCH_BOX_VISIBILITY) {
        state.SEARCH_IFRAME.style.display = "none";
        return;
      }
      if (state.MOUSE_OVER_FRAME || !state.YOUTUBE_PLAYER) {
        return;
      }
      state.SEARCH_IFRAME.style.display = "block";
    },
    toggleSearchInputVisibility() {
      state.SEARCH_BOX_VISIBILITY = !state.SEARCH_BOX_VISIBILITY;
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
        case "HTTP.GET_TEXT": {
          try {
            const res = await fetch(data.payload.url, {
              credentials: "include",
            });
            const text = await res.text();
            event.source.postMessage(
              {
                action: "HTTP.GET_TEXT.RESULT",
                requestId: data.requestId,
                ok: true,
                status: res.status,
                text,
              },
              extension_url,
            );
          } catch (e) {
            event.source.postMessage(
              {
                action: "HTTP.GET_TEXT.RESULT",
                requestId: data.requestId,
                ok: false,
                error: e?.message || String(e),
              },
              extension_url,
            );
          }
          break;
        }

        case "YT.POST_JSON_INJECT": {
          const requestId = data.requestId;
          const { url, body, headers } = data.payload || {};
          try {
            const result = await injectAndPostJson(
              requestId,
              url,
              body,
              headers,
            );
            event.source.postMessage(
              {
                action: "YT.POST_JSON_INJECT.RESULT",
                requestId,
                ok: true,
                result,
              },
              extension_url,
            );
          } catch (e) {
            event.source.postMessage(
              {
                action: "YT.POST_JSON_INJECT.RESULT",
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

  // Listen for page-injected script responses
  function onPageMessage(event) {
    if (event.source !== window) return;
    const data = event.data || {};
    if (data.source !== "YT_INJECT" || data.type !== "YT.PAGE_DATA") return;
    const cb = pendingPageData[data.requestId];
    if (cb) {
      delete pendingPageData[data.requestId];
      cb(data);
    }
  }

  const pendingPageData = {};
  window.addEventListener("message", onPageMessage);

  function injectAndPostJson(requestId, url, body, headers) {
    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        delete pendingPageData[requestId];
        reject(new Error("Injected POST timeout"));
      }, 10000);

      pendingPageData[requestId] = (msg) => {
        clearTimeout(timeout);
        if (msg.error) reject(new Error(msg.error));
        else resolve({ json: msg.json || null, status: msg.status || 0 });
      };

      const script = document.createElement("script");
      script.textContent = `(() => {
        const reqId = '${requestId}';
        const u = ${JSON.stringify(url)};
        const b = ${JSON.stringify(body || {})};
        const h = ${JSON.stringify(headers || {})};
        const finalHeaders = Object.assign({ 'content-type': 'application/json' }, h || {});
        fetch(u, {
          method: 'POST',
          credentials: 'same-origin',
          headers: finalHeaders,
          body: typeof b === 'string' ? b : JSON.stringify(b)
        }).then(async (r) => {
          const status = r.status;
          let json = null;
          try { json = await r.json(); } catch (_) {}
          window.postMessage({ source: 'YT_INJECT', type: 'YT.PAGE_DATA', requestId: reqId, status, json }, '*');
        }).catch(e => {
          window.postMessage({ source: 'YT_INJECT', type: 'YT.PAGE_DATA', requestId: reqId, error: String(e) }, '*');
        });
      })();`;
      (document.head || document.documentElement).appendChild(script);
      script.remove();
    });
  }

  function setup(url) {
    state.SEARCH_BOX_VISIBILITY = false;

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
  setInterval(render.byState, 10);
  window.addEventListener("message", logic.handleMessage);

  chrome.runtime.onMessage.addListener((data, sender) => {
    if (data == "toggle-search-input") {
      render.toggleSearchInputVisibility();
    }
  });
})();
