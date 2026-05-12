"use client";

import React, { useEffect, useState } from "react";
import { getArtifactContent } from "@/lib/api";
import type { Artifact } from "@alook/shared";
import { Loader2, Download } from "lucide-react";
import { Streamdown } from "streamdown";

const TEXT_TYPES = new Set([
  "application/json",
  "application/xml",
  "application/javascript",
  "application/typescript",
  "application/x-yaml",
  "application/toml",
  "application/sql",
]);

export function isTextType(contentType: string): boolean {
  if (contentType.startsWith("text/")) return true;
  if (TEXT_TYPES.has(contentType)) return true;
  return false;
}

export function isHtmlType(contentType: string): boolean {
  return contentType.startsWith("text/html");
}

export function isImageType(contentType: string): boolean {
  return contentType.startsWith("image/");
}

export function isPreviewable(artifact: Artifact): boolean {
  return isTextType(artifact.content_type) || isImageType(artifact.content_type);
}

export function getArtifactUrl(id: string, workspaceId: string, download?: boolean): string {
  const params = new URLSearchParams({ workspace_id: workspaceId });
  if (download) params.set("download", "1");
  return `/api/artifacts/${id}/content?${params}`;
}

function isMarkdown(filename: string): boolean {
  return /\.md$/i.test(filename);
}

interface ArtifactContentRendererProps {
  artifact: Artifact;
  workspaceId: string;
}

export function ArtifactContentRenderer({ artifact, workspaceId }: ArtifactContentRendererProps) {
  const [content, setContent] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  const url = getArtifactUrl(artifact.id, workspaceId);

  useEffect(() => {
    if (isTextType(artifact.content_type) && !isHtmlType(artifact.content_type)) {
      setLoading(true);
      setContent(null);
      getArtifactContent(artifact.id, workspaceId)
        .then(setContent)
        .catch(() => setContent("(failed to load content)"))
        .finally(() => setLoading(false));
    }
  }, [artifact.id, artifact.content_type, workspaceId]);

  if (loading) {
    return (
      <div className="flex justify-center py-8">
        <Loader2 className="size-5 animate-spin text-muted-foreground" />
      </div>
    );
  }

  if (isImageType(artifact.content_type)) {
    return (
      <div className="flex justify-center">
        <img
          src={url}
          alt={artifact.filename}
          className="max-w-full rounded-md"
        />
      </div>
    );
  }

  if (isHtmlType(artifact.content_type)) {
    return <HtmlArtifactFrame url={url} title={artifact.filename} />;
  }

  if (isTextType(artifact.content_type)) {
    if (isMarkdown(artifact.filename)) {
      return (
        <div className="markdown text-sm">
          <Streamdown>{content ?? ""}</Streamdown>
        </div>
      );
    }
    return (
      <pre className="whitespace-pre-wrap text-sm font-mono text-foreground">{content}</pre>
    );
  }

  return (
    <div className="flex flex-col items-center gap-3 py-8 text-center">
      <p className="text-sm text-muted-foreground">
        This file type cannot be previewed.
      </p>
      <a
        href={getArtifactUrl(artifact.id, workspaceId, true)}
        download={artifact.filename}
        className="inline-flex items-center gap-1.5 rounded-md border border-input bg-background px-3 py-1.5 text-sm font-medium hover:bg-accent hover:text-accent-foreground transition-colors"
      >
        <Download className="size-3.5" />
        Download
      </a>
    </div>
  );
}

function HtmlArtifactFrame({ url, title }: { url: string; title: string }) {
  return (
    <iframe
      src={url}
      sandbox="allow-same-origin"
      className="w-full h-full rounded-b-xl overflow-hidden"
      style={{ border: "none", display: "block" }}
      title={title}
    />
  );
}
