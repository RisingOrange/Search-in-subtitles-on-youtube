window.Utilities = {
  _reqId: 0,
  _pending: {},
  getYouTubeURL() {
    try {
      var url = decodeURIComponent(window.location.href.split("url=")[1]);
      if (url.indexOf("https://www.youtube.com/watch") !== 0) {
        return null;
      }
      return url;
    } catch (error) {
      return null;
    }
  },
  searchSubtitles(value, timedTextList) {
    var results = [];
    var words = value
      .toLowerCase()
      .replace(/[^\p{Letter}0-9\s]/gimu, "")
      .trim()
      .split(" ")
      .filter((word) => word);

    if (words.length === 0) {
      return [];
    }

    for (
      let firstWordIdx = 0;
      firstWordIdx < timedTextList.length;
      firstWordIdx++
    ) {
      if (Utilities._isMatch(timedTextList, firstWordIdx, words)) {
        results.push({
          time: timedTextList[firstWordIdx].time,
          word: timedTextList[firstWordIdx].word,
          right: timedTextList
            .slice(firstWordIdx + 1, firstWordIdx + 4)
            .map((_) => _.word),
        });
      }
    }

    return results;
  },
  _isMatch(timedTextList, firstWordIdx, words) {
    return Array.from(
      timedTextList.slice(firstWordIdx, firstWordIdx + words.length).entries(),
    )
      .map(([idx, timedText]) => timedText.word.indexOf(words[idx]) === 0)
      .every(Boolean);
  },
  fancyTimeFormat(time) {
    let hrs = ~~(time / 3600);
    let mins = ~~((time % 3600) / 60);
    let secs = ~~time % 60;
    let ret = "";
    if (hrs > 0) {
      ret += "" + hrs + ":" + (mins < 10 ? "0" : "");
    }
    ret += "" + mins + ":" + (secs < 10 ? "0" : "");
    ret += "" + secs;
    return ret;
  },
  postMessage(message) {
    window.parent.postMessage(message, "https://www.youtube.com");
  },
  _ensureBridge() {
    if (Utilities._bridgeReady) return;
    Utilities._bridgeReady = true;
    window.addEventListener("message", (event) => {
      // Expect responses from YouTube page origin
      if (!/^https:\/\/.+youtube\.com$/.test(event.origin)) return;
      const data = event.data || {};
      const { action, requestId } = data;
      if (!action || !requestId) return;
      const key = `${action}:${requestId}`;
      const resolver = Utilities._pending[key];
      if (!resolver) return;
      delete Utilities._pending[key];
      resolver(data);
    });
  },
  async _csPostJsonInject(url, body, headers) {
    Utilities._ensureBridge();
    const requestId = `${Date.now()}_${++Utilities._reqId}`;
    const action = "YT.POST_JSON_INJECT";
    const resultAction = "YT.POST_JSON_INJECT.RESULT";
    const msg = { action, payload: { url, body, headers }, requestId };
    const p = new Promise((resolve, reject) => {
      const key = `${resultAction}:${requestId}`;
      Utilities._pending[key] = (data) => {
        if (data.ok) resolve(data.result && data.result.json);
        else reject(new Error(data.error || `Request failed: ${data.status}`));
      };
      setTimeout(() => {
        if (Utilities._pending[key]) {
          delete Utilities._pending[key];
          reject(new Error("Request timeout"));
        }
      }, 10000);
    });
    Utilities.postMessage(msg);
    return p;
  },
  async _csGetText(url) {
    Utilities._ensureBridge();
    const requestId = `${Date.now()}_${++Utilities._reqId}`;
    const action = "HTTP.GET_TEXT";
    const resultAction = "HTTP.GET_TEXT.RESULT";
    const msg = { action, payload: { url }, requestId };
    const p = new Promise((resolve, reject) => {
      const key = `${resultAction}:${requestId}`;
      Utilities._pending[key] = (data) => {
        if (data.ok) resolve(data.text || "");
        else reject(new Error(data.error || "Request failed"));
      };
      // Optional timeout
      setTimeout(() => {
        if (Utilities._pending[key]) {
          delete Utilities._pending[key];
          reject(new Error("Request timeout"));
        }
      }, 10000);
    });
    Utilities.postMessage(msg);
    return p;
  },
  async _getPlayerCaptions() {
    // Try to get captions from transcript panel or player
    Utilities._ensureBridge();
    const requestId = `${Date.now()}_${++Utilities._reqId}`;
    const action = "YT.GET_PLAYER_CAPTIONS";
    const resultAction = "YT.GET_PLAYER_CAPTIONS.RESULT";
    const msg = { action, payload: {}, requestId };
    const p = new Promise((resolve, reject) => {
      const key = `${resultAction}:${requestId}`;
      Utilities._pending[key] = (data) => {
        if (data.ok) resolve({ captions: data.captions || [], transcriptCues: data.transcriptCues || [] });
        else reject(new Error(data.error || "Request failed"));
      };
      setTimeout(() => {
        if (Utilities._pending[key]) {
          delete Utilities._pending[key];
          reject(new Error("Request timeout"));
        }
      }, 15000); // Longer timeout to allow panel to load
    });
    Utilities.postMessage(msg);
    return p;
  },
  async getSubtitles(caption_track) {
    if (!caption_track) {
      return [];
    }

    // Get captions from ytInitialData or transcript panel DOM
    try {
      const result = await Utilities._getPlayerCaptions();

      if (result?.transcriptCues && result.transcriptCues.length > 0) {
        const words = [];
        for (const cue of result.transcriptCues) {
          const cleanText = (cue.text || "")
            .toLowerCase()
            .replace(/\n/gi, " ")
            .replace(/\[.*\]/gim, "")
            .replace(/\(.*\)/gim, "")
            .replace(/[^\p{Letter}0-9\s]/gimu, "")
            .trim();
          if (!cleanText) continue;
          for (const word of cleanText.split(" ")) {
            if (!word) continue;
            words.push({ word, time: cue.startMs });
          }
        }
        return words;
      }
    } catch (e) {}

    return [];
  },
  async getCaptionTracks(url) {
    // Fetch the watch HTML to extract INNERTUBE config for the player API
    // Use content script to fetch HTML in first-party context
    let html = "";
    try {
      html = await Utilities._csGetText(url);
    } catch (e) {
      // fallback to direct fetch
      const res = await fetch(url, { credentials: "include" });
      html = await res.text();
    }

    const videoId = (() => {
      try {
        return new URL(url).searchParams.get("v");
      } catch (e) {
        return null;
      }
    })();

    let initialTracks = null;
    const initialPR = Utilities._extractPlayerResponse(html);
    if (initialPR) {
      const tracks =
        initialPR?.captions?.playerCaptionsTracklistRenderer?.captionTracks ||
        [];
      initialTracks = tracks;
      const prPoToken =
        initialPR?.playabilityStatus?.serviceIntegrityDimensions?.poToken ||
        null;
      const hasPotInUrls = (tracks || []).some(
        (t) => t?.baseUrl && t.baseUrl.includes("pot="),
      );
      if ((tracks || []).length > 0) {
        if (prPoToken) {
          return Utilities._appendPoTokenToTracks(tracks, prPoToken);
        }
        if (hasPotInUrls) {
          return tracks;
        }
        // else: try to fetch poToken via injected player fetch, then append
        try {
          const apiKeyTmp = Utilities._extractBetween(
            html,
            '"INNERTUBE_API_KEY":"',
            '"',
          );
          const ctxTmp = Utilities._extractJsonAfter(
            html,
            '"INNERTUBE_CONTEXT":',
          );
          const visitorTmp = Utilities._extractBetween(
            html,
            '"VISITOR_DATA":"',
            '"',
          );
          const clientNameTmp = Utilities._extractDigitsAfter(
            html,
            '"INNERTUBE_CONTEXT_CLIENT_NAME":',
          );
          const clientVersionTmp = Utilities._extractBetween(
            html,
            '"INNERTUBE_CONTEXT_CLIENT_VERSION":"',
            '"',
          );
          if (videoId && apiKeyTmp && ctxTmp) {
            const playerUrlTmp = `https://www.youtube.com/youtubei/v1/player?key=${apiKeyTmp}&prettyPrint=false`;
            const playerBodyTmp = {
              videoId,
              context: ctxTmp,
              contentCheckOk: true,
              racyCheckOk: true,
            };
            const headersTmp = {};
            if (visitorTmp) headersTmp["x-goog-visitor-id"] = visitorTmp;
            if (clientNameTmp)
              headersTmp["x-youtube-client-name"] = String(clientNameTmp);
            if (clientVersionTmp)
              headersTmp["x-youtube-client-version"] = clientVersionTmp;
            const playerJsonTmp = await Utilities._csPostJsonInject(
              playerUrlTmp,
              playerBodyTmp,
              headersTmp,
            );
            const poTokenTmp =
              playerJsonTmp?.playabilityStatus?.serviceIntegrityDimensions
                ?.poToken || null;
            if (poTokenTmp) {
              return Utilities._appendPoTokenToTracks(tracks, poTokenTmp);
            }
          }
        } catch (e) {}
        // else: try player POST below to get poToken, then append to initialTracks
      }
    }

    const apiKey = Utilities._extractBetween(
      html,
      '"INNERTUBE_API_KEY":"',
      '"',
    );
    const innerTubeContext = Utilities._extractJsonAfter(
      html,
      '"INNERTUBE_CONTEXT":',
    );
    const visitorData = Utilities._extractBetween(
      html,
      '"VISITOR_DATA":"',
      '"',
    );
    const clientName = Utilities._extractDigitsAfter(
      html,
      '"INNERTUBE_CONTEXT_CLIENT_NAME":',
    );
    const clientVersion = Utilities._extractBetween(
      html,
      '"INNERTUBE_CONTEXT_CLIENT_VERSION":"',
      '"',
    );

    if (videoId && apiKey && innerTubeContext) {
      try {
        const playerUrl = `https://www.youtube.com/youtubei/v1/player?key=${apiKey}&prettyPrint=false`;
        const playerBody = {
          videoId,
          context: innerTubeContext,
          contentCheckOk: true,
          racyCheckOk: true,
        };
        // Do the POST via page-context bridge so cookies/origin align
        const headers = {};
        if (visitorData) headers["x-goog-visitor-id"] = visitorData;
        if (clientName) headers["x-youtube-client-name"] = String(clientName);
        if (clientVersion) headers["x-youtube-client-version"] = clientVersion;
        const playerJson = await Utilities._csPostJsonInject(
          playerUrl,
          playerBody,
          headers,
        );
        const tracks =
          playerJson?.captions?.playerCaptionsTracklistRenderer
            ?.captionTracks || [];
        const poToken =
          playerJson?.playabilityStatus?.serviceIntegrityDimensions?.poToken ||
          null;
        // Prefer to append token to initialTracks if we had them
        if (poToken && initialTracks && initialTracks.length > 0) {
          return Utilities._appendPoTokenToTracks(initialTracks, poToken);
        }
        const withPot = Utilities._appendPoTokenToTracks(tracks, poToken);
        return withPot;
      } catch (e) {
        // fall through to legacy HTML scrape on failure
      }
    }

    // Legacy fallback: scrape captionTracks from HTML and append poToken if present in HTML
    if (html.indexOf("captionTracks") === -1) {
      return [];
    }

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
    let caption_tracks_json = html.substring(startIdx, curIdx);
    let result = JSON.parse(caption_tracks_json);

    // Try to extract poToken from HTML without player API
    const htmlPoToken = Utilities._extractBetween(html, '"poToken":"', '"');
    if (htmlPoToken) {
      try {
        result = Utilities._appendPoTokenToTracks(result, htmlPoToken);
      } catch (_) {}
    }

    return result;
  },

  _appendPoTokenToTracks(tracks, poToken) {
    return (tracks || []).map((t) => {
      try {
        const hasPot = t.baseUrl && t.baseUrl.includes("pot=");
        if (!poToken || hasPot) return t;
        const sep = t.baseUrl.includes("?") ? "&" : "?";
        return {
          ...t,
          baseUrl: `${t.baseUrl}${sep}pot=${encodeURIComponent(poToken)}&potc=1`,
        };
      } catch (_) {
        return t;
      }
    });
  },

  _extractBetween(haystack, left, right) {
    const i = haystack.indexOf(left);
    if (i === -1) return null;
    const start = i + left.length;
    const j = haystack.indexOf(right, start);
    if (j === -1) return null;
    return haystack.substring(start, j);
  },

  _extractJsonAfter(haystack, token) {
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
  },

  _extractDigitsAfter(haystack, token) {
    const i = haystack.indexOf(token);
    if (i === -1) return null;
    let cur = i + token.length;
    // skip whitespace and quotes if any
    while (
      cur < haystack.length &&
      (haystack[cur] === " " || haystack[cur] === '"')
    )
      cur++;
    let out = "";
    while (cur < haystack.length) {
      const ch = haystack[cur++];
      if (ch >= "0" && ch <= "9") out += ch;
      else break;
    }
    return out ? parseInt(out, 10) : null;
  },

  _extractPlayerResponse(html) {
    // Try direct ytInitialPlayerResponse assignment
    const prObj = Utilities._extractJsonAfter(html, "ytInitialPlayerResponse");
    if (prObj) return prObj;

    // Try ytcfg PLAYER_RESPONSE embedded as JSON string
    const jsonStr = Utilities._extractJsonStringValue(
      html,
      '"PLAYER_RESPONSE":"',
    );
    if (jsonStr) {
      try {
        return JSON.parse(jsonStr);
      } catch (e) {
        return null;
      }
    }
    return null;
  },

  _extractJsonStringValue(haystack, token) {
    const i = haystack.indexOf(token);
    if (i === -1) return null;
    let cur = i + token.length;
    let out = "";
    while (cur < haystack.length) {
      const ch = haystack[cur++];
      if (ch === "\\") {
        // include escape and next char; JSON.parse will handle it
        out += ch;
        if (cur < haystack.length) out += haystack[cur++];
        continue;
      }
      if (ch === '"') break;
      out += ch;
    }
    try {
      // It's a JSON string literal content; wrap with quotes to decode escapes
      return JSON.parse('"' + out.replace(/"/g, '\\"') + '"');
    } catch (e) {
      return null;
    }
  },
};
