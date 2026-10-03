"use client";

import { useAtom, useCreateAtom } from "@tanstack/react-store";
import { useCallback } from "react";
import { useQuery } from "@tanstack/react-query";
import { useParams } from "next/navigation";
import { useAgentContext } from "@/contexts/agent-context";
import { useWorkspaceOwner } from "@/contexts/workspace-context";
import { workspaceFileOptions } from "@/hooks/workspace/file-query-options";
import { Skeleton } from "@/components/ui/skeleton";
import { Tooltip, TooltipTrigger, TooltipContent } from "@/components/ui/tooltip";
import { ScrollArea } from "@/components/ui/scroll-area";
import { ResizablePanelGroup, ResizablePanel, ResizableHandle } from "@/components/ui/resizable";
import { useIsMobile } from "@/hooks/use-mobile";
import { Streamdown } from "streamdown";
import type { WorkspaceFileEntry } from "@alook/shared";
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

interface TreeNode {
  entry: WorkspaceFileEntry;
}

export default function AgentFilesPage() {
  const params = useParams();
  return <AgentFilesSurface key={params.id as string} agentId={params.id as string} />;
}

function AgentFilesSurface({ agentId }: { agentId: string }) {
  const owner = useWorkspaceOwner();
  const { workspaceId } = owner;
  const { subscribeWs, runtimes, agents } = useAgentContext();
  const isMobile = useIsMobile();
  const agent = agents.find((row) => row.id === agentId);
  const runtime = agent ? runtimes.find((row) => row.id === agent.runtime_id) : null;
  const isOnline = runtime?.status === "online";
  const [selectedFile, setSelectedFile] = useAtom(useCreateAtom<string | null>(null));
  const [viewMode, setViewMode] = useAtom(useCreateAtom<"raw" | "preview">("preview"));
  const rootQuery = useQuery({ ...workspaceFileOptions(owner, agentId, runtime?.id ?? null, "tree", ".", subscribeWs), enabled: isOnline });
  const fileQuery = useQuery({ ...workspaceFileOptions(owner, agentId, runtime?.id ?? null, "read", selectedFile ?? "", subscribeWs), enabled: isOnline && !!selectedFile });
  const rootNodes = (rootQuery.data?.entries ?? []).map((entry) => ({ entry }));
  const rootLoading = isOnline && rootQuery.isPending;
  const rootError = rootQuery.error?.message ?? null;
  const fileContent = fileQuery.data?.content ?? null;
  const fileBinary = fileQuery.data?.isBinary ?? false;
  const fileLoading = !!selectedFile && fileQuery.isPending;
  const fileError = fileQuery.error?.message ?? null;
  const workspacesRoot = runtime?.metadata?.workspaces_root;
  const rootLabel = `${workspacesRoot || "~/.alook/workspaces"}/${workspaceId}/${agentId}/workdir`;
  const requestFile = useCallback((path: string) => { setSelectedFile(path); setViewMode("preview"); }, [setSelectedFile, setViewMode]);
  const handleCopyPath = () => { navigator.clipboard.writeText(rootLabel).catch(() => {}); };


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
    <div className="flex items-center gap-2 px-4 py-2 border-b border-border/50 text-xs text-muted-foreground shrink-0 min-w-0">
      <Tooltip>
        <TooltipTrigger render={<button
          onClick={handleCopyPath}
          className="hover:text-foreground transition-colors shrink-0"
        />}>
          <Copy className="size-3" />
        </TooltipTrigger>
        <TooltipContent>Copy full path</TooltipContent>
      </Tooltip>
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
        <div className="py-1">
          {rootNodes.map((node) => (
            <TreeNodeRow
              key={`${runtime?.id}:${node.entry.path}`}
              node={node}
              depth={0}
              selectedFile={selectedFile}
              agentId={agentId}
              runtimeId={runtime?.id ?? null}
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
              onClick={() => setSelectedFile(null)}
              className="text-muted-foreground hover:text-foreground transition-colors shrink-0"
            >
              <ArrowLeft className="size-4" />
            </button>
          )}
          <span className="text-xs font-medium truncate">{selectedFileName}</span>
        </div>
        <div className="flex items-center gap-1 shrink-0 ml-2">
          {isMarkdown && !fileBinary && !fileError && !fileLoading && (
            <>
              <button
                onClick={() => setViewMode("raw")}
                className={`text-[10px] px-2 py-1 rounded transition-colors ${
                  viewMode === "raw" ? "bg-muted text-foreground" : "text-muted-foreground hover:text-foreground"
                }`}
              >
                Raw
              </button>
              <button
                onClick={() => setViewMode("preview")}
                className={`text-[10px] px-2 py-1 rounded transition-colors ${
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
      <ResizablePanelGroup orientation="horizontal">
        <ResizablePanel defaultSize="25%" minSize="15%" maxSize="40%" className="overflow-hidden">
          {treePanel}
        </ResizablePanel>
        <ResizableHandle withHandle />
        <ResizablePanel defaultSize="75%" className="overflow-hidden flex flex-col">
          {fileViewer}
        </ResizablePanel>
      </ResizablePanelGroup>
    </div>
  );
}

// --- Tree node row ---

function TreeNodeRow({
  node,
  depth,
  selectedFile,
  agentId,
  runtimeId,
  onSelectFile,
}: {
  node: TreeNode;
  depth: number;
  selectedFile: string | null;
  agentId: string;
  runtimeId: string | null;
  onSelectFile: (path: string) => void;
}) {
  const { entry } = node;
  const owner = useWorkspaceOwner();
  const { subscribeWs } = useAgentContext();
  const [expanded, setExpanded] = useAtom(useCreateAtom(false));
  const children = useQuery({ ...workspaceFileOptions(owner, agentId, runtimeId, "tree", entry.path, subscribeWs), enabled: entry.isDirectory && expanded });
  const paddingLeft = 12 + depth * 16;


  if (entry.isDirectory) {
    return (
      <>
        <button
          onClick={() => setExpanded((open) => !open)}
          className="w-full flex items-center gap-2 py-1 text-sm hover:bg-muted/50 transition-colors text-left"
          style={{ paddingLeft }}
        >
          <ChevronRight
            className={`size-3 text-muted-foreground/60 shrink-0 transition-transform duration-150 ${
              expanded ? "rotate-90" : ""
            }`}
          />
          {expanded ? (
            <FolderOpen className="size-3.5 text-blue-500/70 shrink-0" />
          ) : (
            <Folder className="size-3.5 text-blue-500/70 shrink-0" />
          )}
          <span className="truncate">{entry.name}</span>
          {expanded && children.isPending && <Loader2 className="size-3 text-muted-foreground animate-spin shrink-0 ml-auto mr-2" />}
        </button>
        {expanded && children.data?.entries?.map((child) => (
          <TreeNodeRow
            key={child.path}
            node={{ entry: child }}
            depth={depth + 1}
            selectedFile={selectedFile}
            agentId={agentId}
            runtimeId={runtimeId}
            onSelectFile={onSelectFile}
          />
        ))}
        {expanded && children.data?.entries?.length === 0 && (
          <div className="text-[10px] text-muted-foreground/50 py-1" style={{ paddingLeft: paddingLeft + 24 }}>
            empty
          </div>
        )}
        {expanded && children.error && <div className="text-xs text-destructive py-1" style={{ paddingLeft: paddingLeft + 24 }}>{children.error.message}</div>}
      </>
    );
  }

  return (
    <button
      onClick={() => onSelectFile(entry.path)}
      className={`w-full flex items-center gap-2 py-1 text-sm hover:bg-muted/50 transition-colors text-left ${
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
