# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

A Firefox/Chrome browser extension (Manifest V2) that lets users search YouTube video subtitles and jump to the matching timestamp, and copy full transcripts to clipboard. Available on [Firefox Addons](https://addons.mozilla.org/en-US/firefox/addon/search-in-subtitles-on-youtube/).

## Development Commands

```bash
# Build extension zip for distribution
web-ext build              # outputs to web-ext-artifacts/

# Run in Firefox with auto-reload for development
web-ext run

# After version changes, update manifest.json "version" field
```

No build step, bundler, or test framework — all source is plain JavaScript loaded via `<script>` tags.

## Architecture

### Two execution contexts communicate via `postMessage`:

1. **Content Script** (`src/content-scripts/youtube.js`) — injected into youtube.com pages. Manages the search iframe lifecycle, adds a search button to the YouTube player controls, injects a "Copy transcript" item into YouTube's three-dot menu, and handles all YouTube data access (fetching page HTML, parsing caption tracks, DOM scraping of the transcript panel). Handles `SKIP`, `SEARCH.CLOSE`, `SEARCH.READY`, `SEARCH.UPDATE_HEIGHT`, `YT.GET_CAPTION_TRACKS`, and `YT.GET_PLAYER_CAPTIONS` message actions.

2. **Extension Iframe** (`src/app/`) — the search UI loaded inside an iframe overlaying the YouTube player. Uses a custom minimal component library (`src/app/libraries/component.js`) that creates DOM elements via global functions (`div()`, `input()`, `ul()`, etc.) and a `$refs` system for element references. `src/app/libraries/utilities.js` contains subtitle searching, text cleaning, and a `_bridgeCall` helper for messaging the content script.

### Background Script

`src/background.js` — listens for the keyboard shortcut command (`Ctrl+Shift+F`) and forwards it to the active tab's content script.

### Subtitle Retrieval Flow

**Step 1 — Caption track discovery** (`getCaptionTracks` in youtube.js): Fetches YouTube page HTML and parses `ytInitialPlayerResponse` to find available subtitle languages/tracks. This is used by `app.js` to gate on captions existing before showing the search UI.

**Step 2 — Subtitle text retrieval** (`getPlayerCaptions` in youtube.js): Opens YouTube's transcript panel (hidden with `opacity: 0`), scrapes DOM segments, then closes the panel. YouTube doesn't render `innerText` for `visibility: hidden` elements, so `opacity: 0` is used instead. All DOM selectors are structural (component names, IDs) to be language-agnostic. There is no language picker — the default transcript language provided by YouTube is used.

### Copy Transcript Feature

The `copyTranscript` object in youtube.js injects a "Copy transcript" menu item into YouTube's three-dot ("More actions") menu below the video. Key patterns:

- **Menu injection**: A persistent `MutationObserver` on `ytd-popup-container` watches for `style`/`aria-hidden` attribute changes to detect when a dropdown becomes visible. A click listener on the video's three-dot button (`#actions ytd-menu-renderer > yt-button-shape#button-shape button`) sets a flag to scope injection to only that menu.
- **Dropdown sizing**: `ytd-menu-popup-renderer` has a tight `max-height` — set it to `"none"` and `overflowX` to `"hidden"` after injection, then call `dropdown.refit()`.
- **Closing the menu**: Dispatch `new KeyboardEvent("keydown", { key: "Escape" })` on `document`. Do not use `dropdown.close()` or `dropdown.style.display = "none"` — both break YouTube's internal toggle state.
- **Menu item styling**: Use `tp-yt-paper-item` element, `<span>` for labels (not `<yt-formatted-string>`), `white-space:normal` for text wrapping, `min-width:24px` on icon wrapper.
- **Transcript cache**: Cues are cached by video ID. Cache is invalidated on video ID change in `setup()`. The `getPlayerCaptions()` function populates the cache, shared by both the search iframe and the copy feature.
- **Clipboard fallback**: `navigator.clipboard.writeText()` → `document.execCommand('copy')` → "Click again to copy" (re-gesture).

### Options UI

`src/options-ui/` — allows Firefox users to customize the keyboard shortcut. Chrome users are directed to `chrome://extensions/shortcuts`.

## Key Conventions

- No framework or bundler — vanilla JS with script tag loading order defined in `src/app/index.html`
- Global functions (`div`, `input`, `span`, `ul`, etc.) and `$refs` are created by `component.js` and used throughout the app components
- `Utilities` is a global object on `window` containing all subtitle fetching, searching, and messaging logic
- Version is tracked only in `manifest.json`
