"use client";

import { useState, useEffect, useCallback, useRef } from "react";
import { useParams } from "next/navigation";
import { useAgentContext } from "@/contexts/agent-context";
import { useWorkspace } from "@/contexts/workspace-context";
import { requestWorkspaceBrowse } from "@/lib/api";
import { Skeleton } from "@/components/ui/skeleton";
import { ScrollArea } from "@/components/ui/scroll-area";
import { ResizablePanels } from "@/components/ui/resizable-panels";
import { useIsMobile } from "@/hooks/use-mobile";
import { Streamdown } from "streamdown";
import type { WsMessage, WorkspaceFileEntry } from "@alook/shared";
import {
  ArrowLeft,
  ChevronRight,
  Copy,
  File,
  FileText,
  FileCode,
  Folder,
  FolderOpen,
  Loader2,
} from "lucide-react";

// --- Tree node state ---

interface TreeNode {
  entry: WorkspaceFileEntry;
  children: TreeNode[] | null; // null = not loaded
  loading: boolean;
  expanded: boolean;
}

export default function AgentFilesPage() {
  const params = useParams();
  const agentId = params.id as string;
  const { workspaceId } = useWorkspace();
  const { subscribeWs, runtimes, agents } = useAgentContext();
  const isMobile = useIsMobile();

  const agent = agents.find((a) => a.id === agentId);
  const runtime = agent ? runtimes.find((r) => r.id === agent.runtime_id) : null;
  const isOnline = runtime?.status === "online";

  // Tree state: top-level entries + nested children per directory
  const [rootNodes, setRootNodes] = useState<TreeNode[]>([]);
  const [rootLoading, setRootLoading] = useState(true);
  const [rootError, setRootError] = useState<string | null>(null);

  // File viewer state
  const [selectedFile, setSelectedFile] = useState<string | null>(null);
  const [fileContent, setFileContent] = useState<string | null>(null);
  const [fileBinary, setFileBinary] = useState(false);
  const [fileLoading, setFileLoading] = useState(false);
  const [fileError, setFileError] = useState<string | null>(null);
  const [viewMode, setViewMode] = useState<"raw" | "preview">("preview");

  // Pending request tracking: map requestId -> { type, path, timer }
  const pendingRef = useRef<Map<string, { type: "tree" | "read"; path: string; timer: ReturnType<typeof setTimeout> }>>(new Map());

  const rootLabel = `~/.alook/workspaces/${workspaceId}/${agentId}/workdir`;

  const REQUEST_TIMEOUT_MS = 15_000;

  const clearPending = useCallback((requestId: string) => {
    const entry = pendingRef.current.get(requestId);
    if (entry) {
      clearTimeout(entry.timer);
      pendingRef.current.delete(requestId);
    }
  }, []);

  const setNodeLoading = useCallback((path: string, loading: boolean) => {
    setRootNodes((prev) => updateNodeRecursive(prev, path, (n) => ({ ...n, loading })));
  }, []);

  // --- Request helpers ---

  const requestTree = useCallback(
    async (path: string) => {
      try {
        const { request_id } = await requestWorkspaceBrowse(agentId, workspaceId, "tree", path);
        const timer = setTimeout(() => {
          if (pendingRef.current.has(request_id)) {
            pendingRef.current.delete(request_id);
            if (path === ".") {
              setRootError("Request timed out — daemon may be offline");
              setRootLoading(false);
            } else {
              setNodeLoading(path, false);
            }
          }
        }, REQUEST_TIMEOUT_MS);
        pendingRef.current.set(request_id, { type: "tree", path, timer });
        return request_id;
      } catch {
        return null;
      }
    },
    [agentId, workspaceId, setNodeLoading],
  );

  const requestFile = useCallback(
    async (path: string) => {
      setFileLoading(true);
      setFileError(null);
      setFileContent(null);
      setFileBinary(false);
      setSelectedFile(path);
      setViewMode("preview");
      try {
        const { request_id } = await requestWorkspaceBrowse(agentId, workspaceId, "read", path);
        const timer = setTimeout(() => {
          if (pendingRef.current.has(request_id)) {
            pendingRef.current.delete(request_id);
            setFileError("Request timed out — daemon may be offline");
            setFileLoading(false);
          }
        }, REQUEST_TIMEOUT_MS);
        pendingRef.current.set(request_id, { type: "read", path, timer });
      } catch {
        setFileError("Failed to request file");
        setFileLoading(false);
      }
    },
    [agentId, workspaceId],
  );

  // --- Load root on mount + cleanup timers ---

  useEffect(() => {
    setRootLoading(true);
    setRootError(null);
    requestTree(".");
    const pending = pendingRef.current;
    return () => {
      for (const entry of pending.values()) clearTimeout(entry.timer);
      pending.clear();
    };
  }, [requestTree]);

  // --- Update tree node helper ---

  const updateNodeChildren = useCallback(
    (path: string, children: WorkspaceFileEntry[]) => {
      const childNodes: TreeNode[] = children.map((e) => ({
        entry: e,
        children: null,
        loading: false,
        expanded: false,
      }));

      if (path === ".") {
        setRootNodes(childNodes);
        setRootLoading(false);
        return;
      }

      setRootNodes((prev) => updateNodeRecursive(prev, path, (n) => ({ ...n, children: childNodes, loading: false, expanded: true })));
    },
    [],
  );

  // --- WS handler ---

  useEffect(() => {
    return subscribeWs((msg: WsMessage) => {
      if (msg.type !== "workspace.files" || msg.agentId !== agentId) return;

      const pending = pendingRef.current.get(msg.requestId);
      if (!pending) return;
      clearPending(msg.requestId);

      if (pending.type === "tree") {
        if (msg.result.error) {
          if (pending.path === ".") {
            setRootError(msg.result.error);
            setRootLoading(false);
          } else {
            setNodeLoading(pending.path, false);
          }
        } else {
          updateNodeChildren(pending.path, msg.result.entries ?? []);
        }
      }

      if (pending.type === "read") {
        if (msg.result.error) {
          setFileError(msg.result.error);
        } else {
          setFileContent(msg.result.content ?? null);
          setFileBinary(msg.result.isBinary ?? false);
        }
        setFileLoading(false);
      }
    });
  }, [subscribeWs, agentId, updateNodeChildren, setNodeLoading, clearPending]);

  // --- Toggle directory ---

  const toggleDir = useCallback(
    (path: string, node: TreeNode) => {
      if (node.expanded) {
        // Collapse
        setRootNodes((prev) => updateNodeRecursive(prev, path, (n) => ({ ...n, expanded: false })));
        return;
      }
      // Expand: load if needed
      if (node.children === null) {
        setNodeLoading(path, true);
        requestTree(path);
      }
      setRootNodes((prev) => updateNodeRecursive(prev, path, (n) => ({ ...n, expanded: true })));
    },
    [requestTree, setNodeLoading],
  );

  const handleCopyPath = () => {
    navigator.clipboard.writeText(rootLabel).catch(() => {});
  };

  // --- Offline ---

  if (!isOnline) {
    return (
      <div className="flex-1 flex items-center justify-center text-muted-foreground text-sm p-8">
        <div className="text-center space-y-2">
          <FolderOpen className="size-8 mx-auto opacity-40" />
          <p>Agent runtime is offline</p>
          <p className="text-xs">File browsing requires the daemon to be running.</p>
        </div>
      </div>
    );
  }

  // --- Shared UI ---

  const pathBar = (
    <div className="flex items-center gap-1.5 px-4 py-2 border-b border-border/50 text-xs text-muted-foreground shrink-0 min-w-0">
      <button
        onClick={handleCopyPath}
        className="hover:text-foreground transition-colors shrink-0"
        title="Copy full path"
      >
        <Copy className="size-3" />
      </button>
      <span className="truncate opacity-60">{rootLabel}</span>
    </div>
  );

  const treePanel = (
    <ScrollArea className="h-full">
      {rootLoading ? (
        <div className="p-3 space-y-1">
          {Array.from({ length: 6 }).map((_, i) => (
            <Skeleton key={i} className="h-6 w-full rounded" />
          ))}
        </div>
      ) : rootError ? (
        <div className="p-4 text-sm text-destructive">{rootError}</div>
      ) : rootNodes.length === 0 ? (
        <div className="p-4 text-sm text-muted-foreground">Empty directory</div>
      ) : (
        <div className="py-0.5">
          {rootNodes.map((node) => (
            <TreeNodeRow
              key={node.entry.path}
              node={node}
              depth={0}
              selectedFile={selectedFile}
              onToggleDir={toggleDir}
              onSelectFile={requestFile}
            />
          ))}
        </div>
      )}
    </ScrollArea>
  );

  const selectedFileName = selectedFile?.split("/").pop() ?? "";
  const isMarkdown = selectedFileName.endsWith(".md");

  const fileViewer = selectedFile ? (
    <div className="flex-1 min-h-0 flex flex-col">
      <div className="flex items-center justify-between px-4 py-2 border-b border-border/50 shrink-0">
        <div className="flex items-center gap-2 min-w-0">
          {isMobile && (
            <button
              onClick={() => { setSelectedFile(null); setFileContent(null); }}
              className="text-muted-foreground hover:text-foreground transition-colors shrink-0"
            >
              <ArrowLeft className="size-4" />
            </button>
          )}
          <span className="text-xs font-medium truncate">{selectedFileName}</span>
        </div>
        <div className="flex items-center gap-0.5 shrink-0 ml-2">
          {isMarkdown && !fileBinary && !fileError && !fileLoading && (
            <>
              <button
                onClick={() => setViewMode("raw")}
                className={`text-[10px] px-1.5 py-0.5 rounded transition-colors ${
                  viewMode === "raw" ? "bg-muted text-foreground" : "text-muted-foreground hover:text-foreground"
                }`}
              >
                Raw
              </button>
              <button
                onClick={() => setViewMode("preview")}
                className={`text-[10px] px-1.5 py-0.5 rounded transition-colors ${
                  viewMode === "preview" ? "bg-muted text-foreground" : "text-muted-foreground hover:text-foreground"
                }`}
              >
                Preview
              </button>
            </>
          )}
        </div>
      </div>
      <ScrollArea className="flex-1 min-h-0">
        {fileLoading ? (
          <div className="p-4 space-y-2">
            {Array.from({ length: 10 }).map((_, i) => (
              <Skeleton key={i} className="h-3.5 w-full rounded" />
            ))}
          </div>
        ) : fileError ? (
          <div className="p-4 text-sm text-destructive">{fileError}</div>
        ) : fileBinary ? (
          <div className="flex-1 flex items-center justify-center p-8 text-sm text-muted-foreground">
            Binary file — cannot display
          </div>
        ) : isMarkdown && viewMode === "preview" ? (
          <div className="markdown text-sm p-4">
            <Streamdown>{fileContent ?? ""}</Streamdown>
          </div>
        ) : (
          <pre className="p-4 text-[11px] font-mono whitespace-pre-wrap break-all leading-relaxed text-foreground/80">
            {fileContent}
          </pre>
        )}
      </ScrollArea>
    </div>
  ) : (
    <div className="flex-1 flex items-center justify-center text-muted-foreground text-xs h-full">
      Select a file to view
    </div>
  );

  // --- Layout ---

  if (isMobile) {
    if (selectedFile) {
      return <div className="flex-1 flex flex-col min-h-0 overflow-hidden">{fileViewer}</div>;
    }
    return (
      <div className="flex-1 flex flex-col min-h-0 overflow-hidden">
        {pathBar}
        <div className="flex-1 min-h-0">{treePanel}</div>
      </div>
    );
  }

  return (
    <div className="flex-1 flex flex-col min-h-0 overflow-hidden">
      {pathBar}
      <ResizablePanels
        storageKey="agent-files-panel-sizes"
        panels={[
          {
            defaultWidth: 280,
            minWidth: 180,
            maxWidth: 480,
            children: treePanel,
            className: "overflow-hidden",
          },
          {
            children: fileViewer,
            className: "overflow-hidden flex flex-col",
          },
        ]}
      />
    </div>
  );
}

// --- Tree node row ---

function TreeNodeRow({
  node,
  depth,
  selectedFile,
  onToggleDir,
  onSelectFile,
}: {
  node: TreeNode;
  depth: number;
  selectedFile: string | null;
  onToggleDir: (path: string, node: TreeNode) => void;
  onSelectFile: (path: string) => void;
}) {
  const { entry } = node;
  const paddingLeft = 12 + depth * 16;

  if (entry.isDirectory) {
    return (
      <>
        <button
          onClick={() => onToggleDir(entry.path, node)}
          className="w-full flex items-center gap-1.5 py-1 text-sm hover:bg-muted/50 transition-colors text-left"
          style={{ paddingLeft }}
        >
          <ChevronRight
            className={`size-3 text-muted-foreground/60 shrink-0 transition-transform duration-150 ${
              node.expanded ? "rotate-90" : ""
            }`}
          />
          {node.expanded ? (
            <FolderOpen className="size-3.5 text-blue-500/70 shrink-0" />
          ) : (
            <Folder className="size-3.5 text-blue-500/70 shrink-0" />
          )}
          <span className="truncate">{entry.name}</span>
          {node.loading && <Loader2 className="size-3 text-muted-foreground animate-spin shrink-0 ml-auto mr-2" />}
        </button>
        {node.expanded && node.children && node.children.map((child) => (
          <TreeNodeRow
            key={child.entry.path}
            node={child}
            depth={depth + 1}
            selectedFile={selectedFile}
            onToggleDir={onToggleDir}
            onSelectFile={onSelectFile}
          />
        ))}
        {node.expanded && node.children && node.children.length === 0 && (
          <div className="text-[10px] text-muted-foreground/50 py-0.5" style={{ paddingLeft: paddingLeft + 24 }}>
            empty
          </div>
        )}
      </>
    );
  }

  return (
    <button
      onClick={() => onSelectFile(entry.path)}
      className={`w-full flex items-center gap-1.5 py-1 text-sm hover:bg-muted/50 transition-colors text-left ${
        selectedFile === entry.path ? "bg-muted text-foreground" : ""
      }`}
      style={{ paddingLeft: paddingLeft + 15 }}
    >
      <FileIcon name={entry.name} />
      <span className="truncate">{entry.name}</span>
      <span className="ml-auto text-[10px] text-muted-foreground/50 shrink-0 tabular-nums mr-2">
        {formatSize(entry.size)}
      </span>
    </button>
  );
}

// --- Recursive tree update helper ---

function updateNodeRecursive(
  nodes: TreeNode[],
  targetPath: string,
  updater: (node: TreeNode) => TreeNode,
): TreeNode[] {
  return nodes.map((node) => {
    if (node.entry.path === targetPath) return updater(node);
    if (node.children && targetPath.startsWith(node.entry.path + "/")) {
      return { ...node, children: updateNodeRecursive(node.children, targetPath, updater) };
    }
    return node;
  });
}

// --- Misc helpers ---

function FileIcon({ name }: { name: string }) {
  if (name.endsWith(".md") || name.endsWith(".txt")) {
    return <FileText className="size-3.5 text-muted-foreground shrink-0" />;
  }
  if (/\.(js|ts|tsx|jsx|py|sh|go|rs|rb|css|html|sql)$/.test(name)) {
    return <FileCode className="size-3.5 text-muted-foreground shrink-0" />;
  }
  return <File className="size-3.5 text-muted-foreground shrink-0" />;
}

function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes}B`;
  if (bytes < 1048576) return `${(bytes / 1024).toFixed(1)}K`;
  return `${(bytes / 1048576).toFixed(1)}M`;
}
