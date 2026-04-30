/**
 * True iff at least one sent record for the item exists with abandoned !== true.
 * @param {string} itemName
 * @param {Record<string, object>} sent
 * @returns {boolean}
 */
export function isReleased(itemName, sent) {
  return Object.values(sent).some(r => r.itemName === itemName && r.abandoned !== true);
}

/**
 * True iff every sent record for the item has itemDone === true.
 * Returns false when no sent records exist for the item.
 * @param {string} itemName
 * @param {Record<string, object>} sent
 * @returns {boolean}
 */
export function isDone(itemName, sent) {
  const records = Object.values(sent).filter(r => r.itemName === itemName);
  return records.length > 0 && records.every(r => r.itemDone === true);
}

/**
 * True iff item is not done and every dep in item.dependsOn is released.
 * @param {{ name: string, dependsOn: string[] }} item
 * @param {Record<string, object>} sent
 * @returns {boolean}
 */
export function isReady(item, sent) {
  if (isDone(item.name, sent)) return false;
  return (item.dependsOn ?? []).every(dep => isReleased(dep, sent));
}
