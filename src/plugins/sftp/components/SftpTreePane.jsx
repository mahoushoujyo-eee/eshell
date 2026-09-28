import { ChevronDown, ChevronRight, Folder, FolderOpen, Loader2 } from "lucide-react";
import { useI18n } from "../../../lib/i18n";

function TreeRow({
  node,
  depth,
  expanded,
  isLoading,
  isSelected,
  onToggle,
  onSelect,
  onContextMenu,
  children,
}) {
  const { t } = useI18n();
  return (
    <div>
      <div
        className={[
          "flex h-6 items-center rounded-md transition-colors duration-150",
          isSelected ? "bg-accent-soft text-text" : "text-text/90 hover:bg-hover",
        ].join(" ")}
        style={{ paddingLeft: `${Math.max(0, depth * 12)}px` }}
      >
        <button
          type="button"
          className="inline-flex h-6 w-5 shrink-0 items-center justify-center text-subtle transition-colors hover:text-text"
          aria-label={
            expanded
              ? t("Collapse {name}", { name: node.name })
              : t("Expand {name}", { name: node.name })
          }
          onClick={(event) => {
            event.stopPropagation();
            void onToggle(node.path);
          }}
        >
          {isLoading ? (
            <Loader2 className="h-3 w-3 animate-spin" aria-hidden="true" />
          ) : expanded ? (
            <ChevronDown className="h-3 w-3" aria-hidden="true" />
          ) : (
            <ChevronRight className="h-3 w-3" aria-hidden="true" />
          )}
        </button>

        <button
          type="button"
          className="flex h-full min-w-0 flex-1 items-center gap-1.5 pr-1.5 text-left text-xs"
          onClick={() => void onSelect(node.path)}
          onContextMenu={(event) => onContextMenu?.(node, event)}
          title={node.path}
        >
          {expanded ? (
            <FolderOpen className="h-3.5 w-3.5 shrink-0 text-warning" aria-hidden="true" />
          ) : (
            <Folder className="h-3.5 w-3.5 shrink-0 text-warning" aria-hidden="true" />
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
  onNodeContextMenu,
}) {
  const { t } = useI18n();

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
          onContextMenu={onNodeContextMenu}
        >
          {renderTreeRows(node.path, depth + 1)}
        </TreeRow>
      ));
  };

  return (
    <div
      className="scroll-region h-full overflow-auto bg-surface px-1.5 py-1.5 text-xs"
      onContextMenu={(event) => {
        event.preventDefault();
        void onReloadRoot();
      }}
    >
      {!activeSessionId ? (
        <div className="px-2 py-1.5 text-muted">{t("Connect SSH first")}</div>
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
            onContextMenu={onNodeContextMenu}
          >
            {renderTreeRows("/", 1)}
          </TreeRow>
        </>
      )}
    </div>
  );
}
