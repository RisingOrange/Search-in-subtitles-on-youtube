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
  async _bridgeCall(action, payload = {}, timeout = 10000) {
    Utilities._ensureBridge();
    const requestId = `${Date.now()}_${++Utilities._reqId}`;
    const resultAction = `${action}.RESULT`;
    const msg = { action, payload, requestId };
    return new Promise((resolve, reject) => {
      const key = `${resultAction}:${requestId}`;
      Utilities._pending[key] = (data) => {
        if (data.ok) resolve(data);
        else reject(new Error(data.error || "Request failed"));
      };
      setTimeout(() => {
        if (Utilities._pending[key]) {
          delete Utilities._pending[key];
          reject(new Error("Request timeout"));
        }
      }, timeout);
      Utilities.postMessage(msg);
    });
  },
  async getCaptionTracks(url) {
    try {
      const data = await Utilities._bridgeCall("YT.GET_CAPTION_TRACKS", { url });
      return data.tracks || [];
    } catch (e) {
      return [];
    }
  },
  async getSubtitles(caption_track) {
    if (!caption_track) {
      return [];
    }

    try {
      const data = await Utilities._bridgeCall("YT.GET_PLAYER_CAPTIONS", {}, 15000);
      const transcriptCues = data.transcriptCues || [];

      if (transcriptCues.length > 0) {
        const words = [];
        for (const cue of transcriptCues) {
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
    } catch (e) {
      // Failed to get captions, fall through to return empty
    }

    return [];
  },
};
