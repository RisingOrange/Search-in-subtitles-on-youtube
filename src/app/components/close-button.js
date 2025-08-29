function CloseButton(props) {
  const ns = "http://www.w3.org/2000/svg";
  const svg = document.createElementNS(ns, "svg");
  svg.setAttribute("height", "17px");
  svg.setAttribute("width", "17");
  svg.setAttribute("viewBox", "0 0 512 512");
  const path = document.createElementNS(ns, "path");
  path.setAttribute(
    "d",
    "M437.5,386.6L306.9,256l130.6-130.6c14.1-14.1,14.1-36.8,0-50.9c-14.1-14.1-36.8-14.1-50.9,0L256,205.1L125.4,74.5 c-14.1-14.1-36.8-14.1-50.9,0c-14.1,14.1-14.1,36.8,0,50.9L205.1,256L74.5,386.6c-14.1,14.1-14.1,36.8,0,50.9 c14.1,14.1,36.8,14.1,50.9,0L256,306.9l130.6,130.6c14.1,14.1,36.8,14.1,50.9,0C451.5,423.4,451.5,400.6,437.5,386.6z",
  );
  svg.appendChild(path);

  return div({ ...props, className: "close-container", children: svg });
}
