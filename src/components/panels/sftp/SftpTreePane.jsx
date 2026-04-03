import { ChevronDown, ChevronRight, Folder, FolderOpen, Loader2 } from "lucide-react";

function TreeRow({
  node,
  depth,
  expanded,
  isLoading,
  isSelected,
  onToggle,
  onSelect,
  children,
}) {
  return (
    <div>
      <div
        className={[
          "flex items-center transition-colors",
          isSelected ? "bg-accent-soft/70" : "hover:bg-accent-soft/40",
        ].join(" ")}
        style={{ paddingLeft: `${Math.max(0, depth * 14)}px` }}
      >
        <button
          type="button"
          className="inline-flex h-7 w-7 items-center justify-center text-muted transition-colors hover:text-text"
          aria-label={expanded ? `Collapse ${node.name}` : `Expand ${node.name}`}
          onClick={(event) => {
            event.stopPropagation();
            void onToggle(node.path);
          }}
        >
          {isLoading ? (
            <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden="true" />
          ) : expanded ? (
            <ChevronDown className="h-3.5 w-3.5" aria-hidden="true" />
          ) : (
            <ChevronRight className="h-3.5 w-3.5" aria-hidden="true" />
          )}
        </button>

        <button
          type="button"
          className="flex min-w-0 flex-1 items-center gap-1.5 px-1 py-1 text-left text-xs"
          onClick={() => void onSelect(node.path)}
          title={node.path}
        >
          {expanded ? (
            <FolderOpen className="h-3.5 w-3.5 shrink-0 text-amber-500" aria-hidden="true" />
          ) : (
            <Folder className="h-3.5 w-3.5 shrink-0 text-amber-500" aria-hidden="true" />
          )}
          <span className="truncate">{node.name}</span>
        </button>
      </div>

      {expanded ? children : null}
    </div>
  );
}

export default function SftpTreePane({
  activeSessionId,
  expandedPaths,
  loadingPaths,
  selectedTreePath,
  treeNodesByPath,
  onToggleNode,
  onSelectDirectory,
  onReloadRoot,
}) {
  const renderTreeRows = (parentPath, depth = 0) => {
    const children = treeNodesByPath[parentPath] || [];

    return children
      .filter((node) => node.path !== parentPath)
      .map((node) => (
        <TreeRow
          key={node.path}
          node={node}
          depth={depth}
          expanded={Boolean(expandedPaths[node.path])}
          isLoading={Boolean(loadingPaths[node.path])}
          isSelected={selectedTreePath === node.path}
          onToggle={onToggleNode}
          onSelect={onSelectDirectory}
        >
          {renderTreeRows(node.path, depth + 1)}
        </TreeRow>
      ));
  };

  return (
    <div
      className="h-full overflow-auto border-r border-border bg-surface/30 p-2 text-xs"
      onContextMenu={(event) => {
        event.preventDefault();
        void onReloadRoot();
      }}
    >
      {!activeSessionId ? (
        <div className="px-2 py-1 text-muted">Connect SSH first</div>
      ) : (
        <>
          <TreeRow
            node={{ name: "/", path: "/" }}
            depth={0}
            expanded={Boolean(expandedPaths["/"])}
            isLoading={Boolean(loadingPaths["/"])}
            isSelected={selectedTreePath === "/"}
            onToggle={onToggleNode}
            onSelect={onSelectDirectory}
          >
            {renderTreeRows("/", 1)}
          </TreeRow>
        </>
      )}
    </div>
  );
}
