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
  async getSubtitles(caption_track) {
    const text = await Utilities._downloadTimedText(caption_track);
    if (text && text.length > 0) {
      return Utilities._parseTimedText(text);
    }
    // Fallback: use youtubei get_transcript API when timedtext returns empty
    try {
      const transcriptWords = await Utilities._fetchTranscriptFallback();
      return transcriptWords;
    } catch (_) {
      return [];
    }
  },
  async _downloadTimedText(caption_track) {
    let timedtextURL = await Utilities._getTimedTextUrl(caption_track);

    if (!timedtextURL) {
      return "";
    }

    // Fetch via content script (first-party context) to preserve cookies/origin
    let text = "";
    try {
      text = await Utilities._csGetText(timedtextURL);
    } catch (e) {
      // As a final fallback, try direct fetch (may be blocked or cookie-less)
      try {
        const res = await fetch(timedtextURL, { credentials: "include" });
        text = await res.text();
      } catch (_) {
        text = "";
      }
    }
    // Some responses return 200 with empty body if token missing or stale
    if (text.length === 0) {
      return "";
    }
    return text;
  },
  async _fetchTranscriptFallback() {
    const url = Utilities.getYouTubeURL();
    if (!url) return [];
    // Fetch watch HTML to get API key, context and transcript params
    let html = "";
    try {
      html = await Utilities._csGetText(url);
    } catch (e) {
      const res = await fetch(url, { credentials: "include" });
      html = await res.text();
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
    const params = Utilities._extractTranscriptParams(html);
    if (!apiKey || !innerTubeContext || !params) return [];
    const endpoint = `https://www.youtube.com/youtubei/v1/get_transcript?key=${apiKey}&prettyPrint=false`;
    const body = { context: innerTubeContext, params };
    const headers = {};
    if (visitorData) headers["x-goog-visitor-id"] = visitorData;
    if (clientName) headers["x-youtube-client-name"] = String(clientName);
    if (clientVersion) headers["x-youtube-client-version"] = clientVersion;
    // Inject into page to ensure visibility and first-party behavior
    const json = await Utilities._csPostJsonInject(endpoint, body, headers);
    return Utilities._parseTranscriptJson(json);
  },
  _extractTranscriptParams(html) {
    // Try common patterns found in ytInitialData for transcript panel
    // Pattern 1: "getTranscriptEndpoint":{"params":"..."}
    let m = html.match(
      /\"getTranscriptEndpoint\"\s*:\s*\{[^}]*\"params\"\s*:\s*\"([^\"]+)\"/,
    );
    if (m && m[1]) return m[1];
    // Pattern 2: apiUrl:"/youtubei/v1/get_transcript" ... "params":"..."
    m = html.match(
      /apiUrl\":\"\\\/youtubei\\\/v1\\\/get_transcript\"[\s\S]{0,400}?\"params\"\s*:\s*\"([^\"]+)\"/,
    );
    if (m && m[1]) return m[1];
    // Pattern 3: generic "get_transcript" nearby params
    m = html.match(/get_transcript[\s\S]{0,200}?\"params\"\s*:\s*\"([^\"]+)\"/);
    if (m && m[1]) return m[1];
    return null;
  },
  _parseTranscriptJson(j) {
    // Traverse known shapes to collect cues with start times and text
    const words = [];
    if (!j) return words;
    // Helper to normalize a cue renderer into words
    const pushCue = (cr) => {
      if (!cr) return;
      const startMs =
        cr.startOffsetMs || (cr.cue && cr.cue.startOffsetMs) || cr.startMs;
      const start = parseInt(startMs || "0");
      let text = "";
      const cue = cr.cue || cr || {};
      if (cue.simpleText) text = cue.simpleText;
      else if (cue.runs) text = (cue.runs || []).map((r) => r.text).join("");
      text = (text || "")
        .toLowerCase()
        .replace(/\n/gi, " ")
        .replace(/\[.*\]/gim, "")
        .replace(/\(.*\)/gim, "")
        .replace(/[^\p{Letter}0-9\s]/gimu, "")
        .trim();
      if (!text) return;
      for (const w of text.split(" ")) {
        if (!w) continue;
        words.push({ word: w, time: start });
      }
    };

    const actions = j.actions || [];
    // Path 1: transcriptRenderer
    for (const a of actions) {
      const content = a?.updateEngagementPanelAction?.content;
      const tr = content?.transcriptRenderer;
      const body = tr?.body?.transcriptBodyRenderer;
      const cueGroups = body?.cueGroups || [];
      for (const g of cueGroups) {
        const group = g.transcriptCueGroupRenderer || {};
        const cues = group.cues || [];
        for (const c of cues) pushCue(c.transcriptCueRenderer || c);
      }
    }
    if (words.length > 0) return words;

    // Path 2: searchable transcript panel variant (transcriptSegmentListRenderer.initialSegments)
    for (const a of actions) {
      const content = a?.updateEngagementPanelAction?.content;
      const tr = content?.transcriptRenderer;
      const sr = tr?.content?.transcriptSearchPanelRenderer;
      const list = sr?.body?.transcriptSegmentListRenderer;
      const items = list?.initialSegments || list?.contents || [];
      for (const it of items) {
        if (it.transcriptSegmentRenderer) {
          const seg = it.transcriptSegmentRenderer;
          const startMs =
            seg.startMs ||
            (seg.startTimeText && seg.startTimeText.simpleText) ||
            0;
          const runs = (seg.snippet && seg.snippet.runs) || [];
          const text = runs.map((r) => r.text).join("");
          pushCue({ startOffsetMs: startMs, cue: { simpleText: text } });
        } else if (it.transcriptSectionHeaderRenderer) {
          // ignore section headers
        }
      }
    }
    if (words.length > 0) return words;

    // Path 3: deep walk for any transcriptCueRenderer occurrences
    const walk = (obj) => {
      if (!obj || typeof obj !== "object") return;
      if (obj.transcriptCueRenderer) pushCue(obj.transcriptCueRenderer);
      for (const k in obj) {
        if (!Object.prototype.hasOwnProperty.call(obj, k)) continue;
        const v = obj[k];
        if (Array.isArray(v)) v.forEach(walk);
        else if (v && typeof v === "object") walk(v);
      }
    };
    walk(j);
    return words;
  },
  async _getTimedTextUrl(caption_track) {
    // to get one word per line
    return caption_track.baseUrl + "&fmt=srv3&xorb=2&xobt=3&xovt=3";
  },
  _parseTimedText(xml) {
    let doc = null;
    try {
      doc = new DOMParser().parseFromString(xml, "application/xml");
    } catch (_) {}
    try {
      if (!doc || doc.getElementsByTagName("parsererror").length) {
        doc = new DOMParser().parseFromString(xml, "text/html");
      }
    } catch (_) {}

    const jsonTimedText = [];
    const paragraphs = doc
      ? (doc.querySelectorAll ? Array.from(doc.querySelectorAll("p")) : Array.from(doc.getElementsByTagName("p")))
      : [];

    paragraphs.forEach((p) => {
      const time = parseInt(p.getAttribute("t"));
      let text = (p.textContent || "")
        .toLowerCase()
        .replace(/\n/gi, " ")
        .replace(/\[.*\]/gim, "")
        .replace(/\(.*\)/gim, "")
        .replace(/[^\p{Letter}0-9\s]/gimu, "")
        .trim();
      if (!text) return;
      text.split(" ").forEach((word) => {
        if (!word) return;
        jsonTimedText.push({ word, time });
      });
    });
    return jsonTimedText;
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
        } catch (_) {}
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
