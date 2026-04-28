/**
 * Pure: merge a fetched work item (and optionally its parent) into an existing
 * meta item. Returns the new item and per-field `changed` flags.
 *
 * No IO. No defaults beyond what's needed to compute the merge.
 *
 * @param {object} input
 * @param {string} input.itemName
 * @param {object} input.item            current meta.items[name]
 * @param {object} input.fetchedWi       { id, title, description, ... }
 * @param {object|null} input.fetchedParent  parent WI or null
 * @returns {{ item: object, changed: { wiTitle: boolean, wiDescription: boolean, parentWiTitle: boolean, parentWiDescription: boolean } }}
 */
export function computeTicketSync({ item, fetchedWi, fetchedParent }) {
  const newItem = {
    ...item,
    wiTitle: fetchedWi.title,
    wiDescription: fetchedWi.description,
  };

  let parentWiTitleChanged = false;
  let parentWiDescriptionChanged = false;
  if (fetchedParent) {
    newItem.parentWiTitle = fetchedParent.title;
    newItem.parentWiDescription = fetchedParent.description;
    parentWiTitleChanged = item.parentWiTitle !== fetchedParent.title;
    parentWiDescriptionChanged = item.parentWiDescription !== fetchedParent.description;
  }

  return {
    item: newItem,
    changed: {
      wiTitle: item.wiTitle !== fetchedWi.title,
      wiDescription: item.wiDescription !== fetchedWi.description,
      parentWiTitle: parentWiTitleChanged,
      parentWiDescription: parentWiDescriptionChanged,
    },
  };
}
