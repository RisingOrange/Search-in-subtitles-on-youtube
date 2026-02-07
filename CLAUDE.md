# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

A Firefox/Chrome browser extension (Manifest V2) that lets users search YouTube video subtitles and jump to the matching timestamp. Available on [Firefox Addons](https://addons.mozilla.org/en-US/firefox/addon/search-in-subtitles-on-youtube/).

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

1. **Content Script** (`src/content-scripts/youtube.js`) — injected into youtube.com pages. Manages the search iframe lifecycle, adds a search button to the YouTube player controls, and handles all YouTube data access (fetching page HTML, parsing caption tracks, reading `ytInitialData` via Firefox's `wrappedJSObject`, DOM scraping of the transcript panel). Handles `SKIP`, `SEARCH.CLOSE`, `SEARCH.READY`, `SEARCH.UPDATE_HEIGHT`, `YT.GET_CAPTION_TRACKS`, and `YT.GET_PLAYER_CAPTIONS` message actions.

2. **Extension Iframe** (`src/app/`) — the search UI loaded inside an iframe overlaying the YouTube player. Uses a custom minimal component library (`src/app/libraries/component.js`) that creates DOM elements via global functions (`div()`, `input()`, `ul()`, etc.) and a `$refs` system for element references. `src/app/libraries/utilities.js` contains subtitle searching, text cleaning, and a `_bridgeCall` helper for messaging the content script.

### Background Script

`src/background.js` — listens for the keyboard shortcut command (`Ctrl+Shift+F`) and forwards it to the active tab's content script.

### Subtitle Retrieval Flow

**Step 1 — Caption track discovery** (`getCaptionTracks` in youtube.js): Fetches YouTube page HTML and parses `ytInitialPlayerResponse` to find available subtitle languages/tracks.

**Step 2 — Subtitle text retrieval** (`getPlayerCaptions` in youtube.js): Two methods, tried in order:
1. **Primary**: Read `window.ytInitialData` via Firefox's `wrappedJSObject` API and extract transcript cues
2. **Fallback**: Open YouTube's transcript panel, scrape DOM segments, close panel

When DOM-scraping the transcript panel, use `opacity: 0` (not `visibility: hidden`) — YouTube doesn't render `innerText` for hidden elements. All DOM selectors are structural (component names, IDs) to be language-agnostic.

### Options UI

`src/options-ui/` — allows Firefox users to customize the keyboard shortcut. Chrome users are directed to `chrome://extensions/shortcuts`.

## Key Conventions

- No framework or bundler — vanilla JS with script tag loading order defined in `src/app/index.html`
- Global functions (`div`, `input`, `span`, `ul`, etc.) and `$refs` are created by `component.js` and used throughout the app components
- `Utilities` is a global object on `window` containing all subtitle fetching, searching, and messaging logic
- Version is tracked only in `manifest.json`
