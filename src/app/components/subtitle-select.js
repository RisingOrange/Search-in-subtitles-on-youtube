function SubtitleSelect(props) {
  let result = select({ ...props });
  for (const option of props.items) {
    let curOption = document.createElement("option");
    curOption.textContent = option;
    result.appendChild(curOption);
  }
  result.value = props.value;
  if (props.items.length == 1) result.disabled = true;

  return result;
}
