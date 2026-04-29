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
} from "lucide-react";

export default function AgentFilesPage() {
  const params = useParams();
  const agentId = params.id as string;
  const { workspaceId } = useWorkspace();
  const { subscribeWs, runtimes, agents } = useAgentContext();
  const isMobile = useIsMobile();

  const agent = agents.find((a) => a.id === agentId);
  const runtime = agent ? runtimes.find((r) => r.id === agent.runtime_id) : null;
  const isOnline = runtime?.status === "online";

  const [currentPath, setCurrentPath] = useState(".");
  const [entries, setEntries] = useState<WorkspaceFileEntry[]>([]);
  const [loading, setLoading] = useState(true);
  const [treeError, setTreeError] = useState<string | null>(null);

  const [selectedFile, setSelectedFile] = useState<string | null>(null);
  const [fileContent, setFileContent] = useState<string | null>(null);
  const [fileBinary, setFileBinary] = useState(false);
  const [fileLoading, setFileLoading] = useState(false);
  const [fileError, setFileError] = useState<string | null>(null);
  const [viewMode, setViewMode] = useState<"raw" | "preview">("preview");

  const pendingTreeReqRef = useRef<string | null>(null);
  const pendingFileReqRef = useRef<string | null>(null);

  const rootLabel = `~/.alook/workspaces/${workspaceId}/${agentId}/workdir`;

  // --- Requests ---

  const requestTree = useCallback(
    async (path: string) => {
      setLoading(true);
      setTreeError(null);
      try {
        const { request_id } = await requestWorkspaceBrowse(agentId, workspaceId, "tree", path);
        pendingTreeReqRef.current = request_id;
      } catch {
        setTreeError("Failed to request file list");
        setLoading(false);
      }
    },
    [agentId, workspaceId],
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
        pendingFileReqRef.current = request_id;
      } catch {
        setFileError("Failed to request file");
        setFileLoading(false);
      }
    },
    [agentId, workspaceId],
  );

  // --- Effects ---

  useEffect(() => {
    requestTree(currentPath);
  }, [currentPath, requestTree]);

  useEffect(() => {
    return subscribeWs((msg: WsMessage) => {
      if (msg.type !== "workspace.files" || msg.agentId !== agentId) return;

      if (msg.requestType === "tree" && msg.requestId === pendingTreeReqRef.current) {
        pendingTreeReqRef.current = null;
        if (msg.result.error) {
          setTreeError(msg.result.error);
          setEntries([]);
        } else {
          setEntries(msg.result.entries ?? []);
          setTreeError(null);
        }
        setLoading(false);
      }

      if (msg.requestType === "read" && msg.requestId === pendingFileReqRef.current) {
        pendingFileReqRef.current = null;
        if (msg.result.error) {
          setFileError(msg.result.error);
        } else {
          setFileContent(msg.result.content ?? null);
          setFileBinary(msg.result.isBinary ?? false);
        }
        setFileLoading(false);
      }
    });
  }, [subscribeWs, agentId]);

  // --- Navigation ---

  const pathParts = currentPath === "." ? [] : currentPath.split("/");

  const navigateTo = (path: string) => {
    setCurrentPath(path);
    if (isMobile) {
      setSelectedFile(null);
      setFileContent(null);
    }
  };

  const goUp = () => {
    if (pathParts.length === 0) return;
    navigateTo(pathParts.slice(0, -1).join("/") || ".");
  };

  const handleEntryClick = (entry: WorkspaceFileEntry) => {
    if (entry.isDirectory) {
      navigateTo(entry.path);
    } else {
      requestFile(entry.path);
    }
  };

  const handleCopyPath = () => {
    const full = currentPath === "." ? rootLabel : `${rootLabel}/${currentPath}`;
    navigator.clipboard.writeText(full).catch(() => {});
  };

  // --- Offline state ---

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

  // --- Shared UI pieces ---

  const breadcrumb = (
    <div className="flex items-center gap-1 px-4 py-2 border-b border-border/50 text-xs text-muted-foreground shrink-0 min-w-0">
      <button
        onClick={() => navigateTo(".")}
        className="hover:text-foreground transition-colors shrink-0"
      >
        workdir
      </button>
      {pathParts.map((part, i) => (
        <span key={i} className="flex items-center gap-1 min-w-0">
          <ChevronRight className="size-3 opacity-40 shrink-0" />
          <button
            onClick={() => navigateTo(pathParts.slice(0, i + 1).join("/"))}
            className="hover:text-foreground transition-colors truncate"
          >
            {part}
          </button>
        </span>
      ))}
      <button
        onClick={handleCopyPath}
        className="ml-auto hover:text-foreground transition-colors shrink-0"
        title="Copy path"
      >
        <Copy className="size-3" />
      </button>
    </div>
  );

  const fileList = (
    <ScrollArea className="h-full">
      {loading ? (
        <div className="p-3 space-y-1">
          {Array.from({ length: 8 }).map((_, i) => (
            <Skeleton key={i} className="h-7 w-full rounded" />
          ))}
        </div>
      ) : treeError ? (
        <div className="p-4 text-sm text-destructive">{treeError}</div>
      ) : entries.length === 0 ? (
        <div className="p-4 text-sm text-muted-foreground">Empty directory</div>
      ) : (
        <div className="py-0.5">
          {currentPath !== "." && (
            <button
              onClick={goUp}
              className="w-full flex items-center gap-2 px-3 py-1.5 text-sm text-muted-foreground hover:bg-muted/50 transition-colors"
            >
              <ArrowLeft className="size-3.5 shrink-0" />
              <span>..</span>
            </button>
          )}
          {entries.map((entry) => (
            <button
              key={entry.path}
              onClick={() => handleEntryClick(entry)}
              className={`w-full flex items-center gap-2 px-3 py-1.5 text-sm hover:bg-muted/50 transition-colors text-left ${
                selectedFile === entry.path ? "bg-muted text-foreground" : ""
              }`}
            >
              {entry.isDirectory ? (
                <Folder className="size-3.5 text-blue-500/70 shrink-0" />
              ) : (
                <FileIcon name={entry.name} />
              )}
              <span className="truncate">{entry.name}</span>
              {!entry.isDirectory && (
                <span className="ml-auto text-[10px] text-muted-foreground/60 shrink-0 tabular-nums">
                  {formatSize(entry.size)}
                </span>
              )}
            </button>
          ))}
        </div>
      )}
    </ScrollArea>
  );

  const selectedFileName = selectedFile?.split("/").pop() ?? "";
  const isMarkdown = selectedFileName.endsWith(".md");

  const fileViewer = (
    <div className="flex-1 min-h-0 flex flex-col">
      {/* Header: filename + view mode toggle */}
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
                  viewMode === "raw"
                    ? "bg-muted text-foreground"
                    : "text-muted-foreground hover:text-foreground"
                }`}
              >
                Raw
              </button>
              <button
                onClick={() => setViewMode("preview")}
                className={`text-[10px] px-1.5 py-0.5 rounded transition-colors ${
                  viewMode === "preview"
                    ? "bg-muted text-foreground"
                    : "text-muted-foreground hover:text-foreground"
                }`}
              >
                Preview
              </button>
            </>
          )}
        </div>
      </div>
      {/* Content */}
      <ScrollArea className="flex-1">
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
          <div className="p-4 prose prose-sm dark:prose-invert max-w-none text-sm leading-relaxed whitespace-pre-wrap break-words">
            {fileContent}
          </div>
        ) : (
          <pre className="p-4 text-[11px] font-mono whitespace-pre-wrap break-all leading-relaxed text-foreground/80">
            {fileContent}
          </pre>
        )}
      </ScrollArea>
    </div>
  );

  // --- Layout ---

  if (isMobile) {
    if (selectedFile) {
      return <div className="flex-1 flex flex-col min-h-0 overflow-hidden">{fileViewer}</div>;
    }
    return (
      <div className="flex-1 flex flex-col min-h-0 overflow-hidden">
        {breadcrumb}
        <div className="flex-1 min-h-0">{fileList}</div>
      </div>
    );
  }

  // Desktop: resizable panels
  return (
    <div className="flex-1 flex flex-col min-h-0 overflow-hidden">
      {breadcrumb}
      <ResizablePanels
        storageKey="agent-files-panel-sizes"
        panels={[
          {
            defaultWidth: 280,
            minWidth: 180,
            maxWidth: 480,
            children: fileList,
            className: "overflow-hidden",
          },
          {
            children: selectedFile ? (
              fileViewer
            ) : (
              <div className="flex-1 flex items-center justify-center text-muted-foreground text-xs h-full">
                Select a file to view
              </div>
            ),
            className: "overflow-hidden flex flex-col",
          },
        ]}
      />
    </div>
  );
}

// --- Helpers ---

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
