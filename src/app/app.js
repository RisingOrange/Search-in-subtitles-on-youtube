window.addEventListener("load", async function () {
  const app = document.getElementById("app");
  const divWithClass = (className, children) => div({ className, children });
  app.appendChild(
    divWithClass("container", divWithClass("relative", await App())),
  );

  let HEIGHT = null;

  setInterval(function () {
    if (document.body.scrollHeight !== HEIGHT) {
      HEIGHT = document.body.scrollHeight;
      Utilities.postMessage({
        action: "SEARCH.UPDATE_HEIGHT",
        payload: HEIGHT + 20 + "px",
      });
    }
  }, 1);

  window.addEventListener("message", function (message) {
    if (message.data == "FOCUS_INPUT") {
      try {
        document.querySelector("input").focus();
      } catch (err) {
        // dont show error when there are no subtitles and pressing hotkey
      }
    }
  });
});
