/**
 * Normalizes a path by removing the "file:///" prefix
 * and converting backslashes to forward slashes on Windows.
 */
export function normalizePath(path: string): string {
  if (!path) {
    return path;
  }
  if (path.startsWith("file://")) {
    path = decodeURIComponent(path.slice("file://".length));
    // On Windows the remainder looks like "/C:/dir", so drop the leading
    // slash. On POSIX it looks like "/home/dir", which must keep it.
    if (/^\/[a-zA-Z]:/.test(path)) {
      path = path.slice(1);
    }
  }
  return path.replace(/\\/g, "/");
}

/**
 * Converts an absolute path to a path
 * relative to the current working directory.
 * Does nothing if the path is not under the current working directory.
 */
export function toRelativePath(
  absolutePath: string,
  currentDir: string,
): string {
  if (absolutePath.startsWith(currentDir)) {
    return "." + absolutePath.slice(currentDir.length);
  }
  return absolutePath;
}

/**
 * Returns the parent directory of a normalized path, without a trailing slash.
 */
export function parentDir(path: string): string {
  const normalized = normalizePath(path);
  const index = normalized.lastIndexOf("/");
  return index <= 0 ? normalized : normalized.slice(0, index);
}

/**
 * Returns the last segment of a normalized path.
 */
export function baseName(path: string): string {
  const normalized = normalizePath(path);
  return normalized.slice(normalized.lastIndexOf("/") + 1);
}

/**
 * Returns the last segment without its extension, so "mod.ts", "mod.tsx" and
 * "mod.js" all yield "mod". A leading dot is kept, so ".gitignore" is its own
 * stem rather than an empty string.
 */
export function stemName(path: string): string {
  const base = baseName(path);
  const dot = base.lastIndexOf(".");
  return dot <= 0 ? base : base.slice(0, dot);
}

/**
 * Resolves a relative specifier such as "../utils/mod.ts"
 * against the directory that contains the importing file.
 * Returns a normalized absolute path.
 */
export function resolveFrom(baseDir: string, relative: string): string {
  const segments = normalizePath(baseDir).split("/");
  for (const segment of normalizePath(relative).split("/")) {
    if (segment === "" || segment === ".") {
      continue;
    }
    if (segment === "..") {
      if (segments.length > 1) {
        segments.pop();
      }
      continue;
    }
    segments.push(segment);
  }
  return segments.join("/");
}

/**
 * Checks whether a normalized path lies inside a normalized directory.
 * Segment aware, so "/src/utils" does not contain "/src/utils-extra/mod.ts".
 */
export function isInsideDir(path: string, dir: string): boolean {
  return path.startsWith(dir.endsWith("/") ? dir : dir + "/");
}
