/**
 * Path & URL helpers for resolving relative links and images in Windows local documents.
 */

export function encodeSlashPathForStream(slashPath: string): string {
  const clean = slashPath.replace(/\\/g, '/').replace(/^\/+/, '');
  return clean
    .split('/')
    .map((seg, idx) => {
      // Preserve drive colon like "D:" on first segment for clean relative resolution
      if (idx === 0 && /^[A-Za-z]:$/.test(seg)) {
        return seg;
      }
      return encodeURIComponent(seg);
    })
    .join('/');
}

export function buildAssetStreamUrl(assetBaseUrl: string, slashPath: string): string {
  if (!assetBaseUrl) return slashPath;
  return `${assetBaseUrl}/${encodeSlashPathForStream(slashPath)}`;
}

export function resolveRelativeSlashPath(baseDirSlash: string, relativeHref: string): string {
  let decodedHref = relativeHref;
  try {
    decodedHref = decodeURIComponent(relativeHref);
  } catch {
    // keep raw if malformed percent sequence
  }
  const cleanRel = decodedHref.replace(/\\/g, '/').split('#')[0].split('?')[0];

  // Already a Windows drive path (e.g. D:/foo/bar.png)
  if (/^[A-Za-z]:\//.test(cleanRel)) {
    return normalizeDotSegments(cleanRel);
  }
  if (cleanRel.startsWith('file:///')) {
    const withoutScheme = cleanRel.replace(/^file:\/\/\/+/, '');
    return normalizeDotSegments(withoutScheme);
  }

  const base = baseDirSlash.replace(/\\/g, '/').replace(/\/+$/, '');
  return normalizeDotSegments(`${base}/${cleanRel}`);
}

export function normalizeDotSegments(slashPath: string): string {
  const parts = slashPath.replace(/\\/g, '/').split('/');
  const stack: string[] = [];
  for (const part of parts) {
    if (!part || part === '.') continue;
    if (part === '..') {
      if (stack.length > 1) {
        stack.pop();
      }
    } else {
      stack.push(part);
    }
  }
  return stack.join('/');
}

export function slashToWindowsPath(slashPath: string): string {
  return slashPath.replace(/\//g, '\\');
}

export function isExternalUrl(href: string): boolean {
  return /^(https?:|mailto:|tel:|data:|blob:)/i.test(href.trim());
}

export function formatFileSize(bytes?: number): string {
  if (bytes === undefined || bytes === null) return '';
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(2)} MB`;
}
