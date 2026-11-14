/** The vault folder the hub writes its read-only copies into (docs/vault.md §"99 Conclave"). Fixed, so its protection never goes stale. */
export const MIRROR_FOLDER = '99 Conclave';
/** Is this vault-relative path ("99 Conclave/a.md", no leading slash) the folder or inside it? */
export const inMirrorFolder = (rel: string): boolean => {
  const p = rel.replace(/^\/+/, '');
  return p === MIRROR_FOLDER || p.startsWith(`${MIRROR_FOLDER}/`);
};
