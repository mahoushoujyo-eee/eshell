/// Reads the clipboard, returning an empty string when it is unavailable.
///
/// `navigator.clipboard` needs a secure context and can reject when the document
/// is not focused or the user denied the permission, so callers must treat an
/// empty result as "nothing to paste" rather than as an error.
export const readTextFromClipboard = async () => {
  if (typeof navigator === "undefined" || !navigator.clipboard?.readText) {
    return "";
  }
  try {
    return await navigator.clipboard.readText();
  } catch {
    return "";
  }
};

export const copyTextToClipboard = async (value) => {
  const text = String(value || "");
  if (!text) {
    return false;
  }

  if (typeof navigator !== "undefined" && navigator.clipboard?.writeText) {
    await navigator.clipboard.writeText(text);
    return true;
  }

  if (typeof document === "undefined") {
    return false;
  }

  const textArea = document.createElement("textarea");
  textArea.value = text;
  textArea.setAttribute("readonly", "");
  textArea.style.position = "fixed";
  textArea.style.opacity = "0";
  document.body.appendChild(textArea);
  textArea.select();
  const copied = document.execCommand("copy");
  document.body.removeChild(textArea);
  return copied;
};
