/** A file shipped in public/, under the build's base path (the GitHub Pages demo lives below the repository's path). */
export function assetUrl(path: string): string {
  if (/^(https?:|data:|blob:)/.test(path)) return path;
  const base = import.meta.env?.BASE_URL ?? "/";
  return `${base}${path.replace(/^\//, "")}`;
}
