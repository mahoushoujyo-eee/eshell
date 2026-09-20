const LARGE_TEXT_EDITOR_OPEN_BYTES = 50 * 1024 * 1024;

const COMMON_BINARY_EXTENSIONS = new Set([
  "7z",
  "a",
  "apk",
  "avif",
  "bin",
  "bmp",
  "class",
  "dat",
  "db",
  "dll",
  "dmg",
  "doc",
  "docx",
  "dylib",
  "ear",
  "eot",
  "exe",
  "gif",
  "gz",
  "ico",
  "iso",
  "jar",
  "jpeg",
  "jpg",
  "lib",
  "lock",
  "mov",
  "mp3",
  "mp4",
  "o",
  "otf",
  "pdf",
  "png",
  "ppt",
  "pptx",
  "pyc",
  "so",
  "sqlite",
  "tar",
  "ttf",
  "war",
  "wasm",
  "webm",
  "webp",
  "woff",
  "woff2",
  "xls",
  "xlsx",
  "zip",
]);

const getExtension = (path) => {
  const fileName = String(path || "")
    .split("/")
    .pop()
    ?.trim()
    .toLowerCase();
  if (!fileName || !fileName.includes(".")) {
    return "";
  }
  return fileName.split(".").pop() || "";
};

export function getSftpTextOpenGuard(entry) {
  if (!entry || entry.entryType === "directory") {
    return null;
  }

  const reasons = [];
  const extension = getExtension(entry.path || entry.name);
  const size = Number(entry.size) || 0;
  const isLarge = size > LARGE_TEXT_EDITOR_OPEN_BYTES;
  const isBinaryLike = extension ? COMMON_BINARY_EXTENSIONS.has(extension) : false;

  if (isLarge) {
    reasons.push("This file is larger than 50 MB and may be slow to load in the text editor.");
  }

  if (isBinaryLike) {
    reasons.push(
      extension
        ? `.${extension} is a common binary format, so the content may be unreadable as text.`
        : "This file looks like a common binary format, so the content may be unreadable as text.",
    );
  }

  if (reasons.length === 0) {
    return null;
  }

  return {
    extension,
    size,
    isLarge,
    isBinaryLike,
    reasons,
  };
}

export { LARGE_TEXT_EDITOR_OPEN_BYTES };
