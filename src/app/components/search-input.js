async function SearchInput() {
  let SUGGESTIONS_INDEX = -1;
  const SUBTITLES = await Utilities.getSubtitles();

  function renderAutoCompleteItem(item) {
    return li({ onClick: () => handleAutoCompleteItemClick(item) }, [
      strong({ innerText: item.word + " " }),
      span({ innerText: item.right.join(" ") }),
      small({ innerText: Utilities.fancyTimeFormat(item.time / 1000) }),
    ]);
  }

  function handleAutoCompleteItemClick(item) {
    Utilities.postMessage({
      action: "SKIP",
      payload: item.time / 1000,
    });

    $refs.search_input.value = "";
    while ($refs.dropdown.firstChild) {
      $refs.dropdown.removeChild($refs.dropdown.firstChild);
    }
    handleCloseButtonClicked();
  }

  function handleKeyDown(event) {
    let result = false;
    switch (event.keyCode) {
      // Enter
      case 13:
        if (SUGGESTIONS_INDEX > -1) {
          $refs.dropdown_ul.children[SUGGESTIONS_INDEX].click();
        }
        result = true;
        break;
      // Escape
      case 27:
        handleCloseButtonClicked();
        result = true;
        break;
      // ArrowUp and ArrowDown - prevent cursor movement
      case 38:
      case 40:
        result = true;
        break;
    }
    if (result) {
      event.preventDefault();
    }
    return result;
  }

  function handleKeyUp(event) {
    let result = false;
    switch (event.keyCode) {
      case 38:
        // ArrowUp
        result = true;
        if (SUGGESTIONS_INDEX - 1 >= 0) {
          if (SUGGESTIONS_INDEX !== null) {
            $refs.dropdown_ul.children[SUGGESTIONS_INDEX].classList.remove(
              "active",
            );
          }
          SUGGESTIONS_INDEX--;
          $refs.dropdown_ul.children[SUGGESTIONS_INDEX].classList.add("active");
        }
        break;
      case 40:
        // ArrowDown
        result = true;
        if (SUGGESTIONS_INDEX + 1 < $refs.dropdown_ul.children.length) {
          if (SUGGESTIONS_INDEX >= 0) {
            $refs.dropdown_ul.children[SUGGESTIONS_INDEX].classList.remove(
              "active",
            );
          }
          SUGGESTIONS_INDEX++;
          $refs.dropdown_ul.children[SUGGESTIONS_INDEX].classList.add("active");
        }
        break;
    }

    if (result) {
      return;
    }

    SUGGESTIONS_INDEX = -1;
    while ($refs.dropdown.firstChild) {
      $refs.dropdown.removeChild($refs.dropdown.firstChild);
    }

    const value = event.target.value.toLowerCase();

    if (value.length === 0) {
      return;
    }

    const searchResults = Utilities.searchSubtitles(value, SUBTITLES);

    $refs.dropdown.appendChild(
      DropDownList({
        render: renderAutoCompleteItem,
        items: searchResults.slice(0, 8),
      }),
    );
  }

  function handleCloseButtonClicked() {
    Utilities.postMessage({ action: "SEARCH.CLOSE" });
  }

  return [
    div({
      class: "relative",
      children: [
        input({
          onKeyDown: handleKeyDown,
          onKeyUp: handleKeyUp,
          ref: "search_input",
          spellcheck: "false",
          placeholder: "Search in video...",
          autocomplete: "off",
        }),
        CloseButton({ onClick: handleCloseButtonClicked }),
      ],
    }),
    div({ className: "autocomplate", ref: "dropdown" }),
  ];
}
