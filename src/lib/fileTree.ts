/** Build a collapsible tree structure from a flat list of file paths. */

export interface TreeNode {
  name: string;
  path: string;
  kind: 'folder' | 'file';
  children: TreeNode[];
}

/** Sorts folders before files, both alphabetically (case-insensitive). */
export function buildTree(paths: string[]): TreeNode[] {
  const root: TreeNode = { name: '', path: '', kind: 'folder', children: [] };

  for (const path of paths) {
    const segments = path.split('/');
    let node = root;
    segments.forEach((segment, index) => {
      const isFile = index === segments.length - 1;
      let child = node.children.find(
        (candidate) => candidate.name === segment && candidate.kind === (isFile ? 'file' : 'folder'),
      );
      if (!child) {
        child = {
          name: segment,
          path: segments.slice(0, index + 1).join('/'),
          kind: isFile ? 'file' : 'folder',
          children: [],
        };
        node.children.push(child);
      }
      node = child;
    });
  }

  sortTree(root);
  return root.children.map((child) => compactChains(child));
}

/**
 * VS Code "compact folders": folders that contain only a single child folder
 * are merged into one row (a/b/c). The node keeps the deepest folder's path.
 */
function compactChains(node: TreeNode): TreeNode {
  let name = node.name;
  let path = node.path;
  let children = node.children;
  if (node.kind === 'folder') {
    let chain = 0;
    while (children.length === 1 && children[0].kind === 'folder') {
      const child = children[0];
      name += `/${child.name}`;
      path = child.path;
      children = child.children;
      chain += 1;
      if (chain >= 8) break; // safety bound
    }
  }
  return {
    name,
    path,
    kind: node.kind,
    children: children.map((child) => compactChains(child)),
  };
}

function sortTree(node: TreeNode): void {
  node.children.sort((a, b) => {
    if (a.kind !== b.kind) return a.kind === 'folder' ? -1 : 1;
    return a.name.toLowerCase().localeCompare(b.name.toLowerCase());
  });
  node.children.forEach(sortTree);
}
