async function App() {
  const url = Utilities.getYouTubeURL();

  if (!url) return;
  try {
    const tracks = await Utilities.getCaptionTracks(url);
    if (tracks.length == 0) return;
  } catch (e) {
    return;
  }

  var searchInput = SearchInput();

  Utilities.postMessage({ action: "SEARCH.READY" });

  return searchInput;
}
