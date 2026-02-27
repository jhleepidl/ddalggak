import path from "node:path";

export function resolveInside(root, relPath) {
  const rootAbs = path.resolve(root);
  const full = path.resolve(rootAbs, relPath);

  const rootWithSep = rootAbs.endsWith(path.sep) ? rootAbs : rootAbs + path.sep;
  if (full !== rootAbs && !full.startsWith(rootWithSep)) {
    throw new Error(`Path escapes workspace: ${relPath}`);
  }
  return full;
}
