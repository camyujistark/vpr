/**
 * Default-fill optional fields in meta. Safe to call multiple times (idempotent).
 * - Adds dependsOn: [] to every item that lacks it.
 * - Does NOT inject mergedAt/abandoned/itemDone onto sent records (absence = in-flight).
 * @param {object} meta
 * @returns {object}
 */
export function migrateMeta(meta) {
  const items = Object.fromEntries(
    Object.entries(meta.items ?? {}).map(([name, item]) => [
      name,
      'dependsOn' in item ? item : { ...item, dependsOn: [] },
    ])
  );
  return { ...meta, items };
}
