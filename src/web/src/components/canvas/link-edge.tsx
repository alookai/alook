"use client";

import { memo, useCallback, useState } from "react";
import {
  getSmoothStepPath,
  EdgeLabelRenderer,
  type EdgeProps,
} from "@xyflow/react";

interface LinkEdgeData {
  instruction?: string;
  onEdgeClick?: (edgeId: string) => void;
  [key: string]: unknown;
}

function LinkEdgeInner({
  id,
  sourceX,
  sourceY,
  targetX,
  targetY,
  sourcePosition,
  targetPosition,
  selected,
  data,
}: EdgeProps) {
  const { instruction, onEdgeClick } = (data ?? {}) as LinkEdgeData;
  const [hovered, setHovered] = useState(false);

  const [edgePath, labelX, labelY] = getSmoothStepPath({
    sourceX,
    sourceY,
    targetX,
    targetY,
    sourcePosition,
    targetPosition,
    borderRadius: 16,
  });

  const strokeColor = selected
    ? "var(--color-primary)"
    : hovered
      ? "var(--color-muted-foreground)"
      : "var(--color-border)";
  const strokeWidth = selected || hovered ? 2 : 1.5;

  const handleLabelClick = useCallback((e: React.MouseEvent) => {
    e.stopPropagation();
    onEdgeClick?.(id);
  }, [onEdgeClick, id]);

  const hasInstruction = !!instruction && instruction !== "" && instruction !== "<p></p>";

  return (
    <>
      <path
        d={edgePath}
        fill="none"
        stroke={strokeColor}
        strokeWidth={strokeWidth}
        style={{ transition: "stroke 150ms, stroke-width 150ms" }}
        onMouseEnter={() => setHovered(true)}
        onMouseLeave={() => setHovered(false)}
      />
      <EdgeLabelRenderer>
        <button
          type="button"
          style={{
            position: "absolute",
            transform: `translate(-50%, -50%) translate(${labelX}px,${labelY}px)`,
            pointerEvents: "auto",
          }}
          className={`text-[11px] leading-tight bg-background/90 px-2 py-1 rounded-md truncate cursor-pointer transition-colors italic ${hovered ? "text-muted-foreground" : "text-muted-foreground/40"
            }`}
          onClick={handleLabelClick}
          onMouseEnter={() => setHovered(true)}
          onMouseLeave={() => setHovered(false)}
        >
          {hasInstruction ? "edit" : "define"}
        </button>
      </EdgeLabelRenderer>
    </>
  );
}

export const LinkEdge = memo(LinkEdgeInner);
