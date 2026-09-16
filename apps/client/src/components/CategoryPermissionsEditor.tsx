import type { Category } from '@gusvoice/shared';
import { api } from '../api';
import { CATEGORY_PERMS, OverwriteEditor, type OverwriteSource } from './OverwriteEditor';

/**
 * Per-category permission overwrite editor. EVERY channel in the category inherits these as its base;
 * a channel's own overwrites then override them. A category "private" restricts all its channels at
 * once, except those a channel explicitly re-opens.
 */
export function CategoryPermissionsEditor({ category }: { category: Category }) {
  const source: OverwriteSource = {
    serverId: category.serverId,
    list: () => api.listCategoryOverwrites(category.id),
    set: (o) => api.setCategoryOverwrite(category.id, o),
    remove: (t, id) => api.deleteCategoryOverwrite(category.id, t, id),
  };
  return <OverwriteEditor source={source} perms={CATEGORY_PERMS} />;
}
