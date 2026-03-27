import type { Artifact, Part } from "../types/a2a_v1";
import { useState } from "react";

interface ArtifactPreviewProps {
  artifact: Artifact;
  onDownload?: () => void;
}

function getPartContent(
  part: Part
): { type: "text" | "json" | "image" | "file"; content?: string; mimeType?: string } | null {
  if (part.text != null) return { type: "text", content: part.text };

  if (part.data != null) {
    return { type: "json", content: JSON.stringify(part.data, null, 2) };
  }

  if (part.raw != null) {
    // base64-encoded bytes
    const mimeType = part.mediaType ?? "application/octet-stream";
    if (mimeType.startsWith("image/")) {
      return { type: "image", content: `data:${mimeType};base64,${part.raw}`, mimeType };
    }
    if (mimeType === "application/json" || mimeType === "text/plain") {
      try {
        return { type: mimeType === "application/json" ? "json" : "text", content: atob(part.raw) };
      } catch {
        return { type: "text", content: part.raw };
      }
    }
    return { type: "file", mimeType };
  }

  if (part.url != null) {
    const mimeType = part.mediaType ?? "application/octet-stream";
    if (mimeType.startsWith("image/")) {
      return { type: "image", content: part.url, mimeType };
    }
    return { type: "file", mimeType };
  }

  return null;
}

export default function ArtifactPreview({ artifact, onDownload }: ArtifactPreviewProps) {
  const [expanded, setExpanded] = useState(false);

  const handleDownload = () => {
    if (onDownload) {
      onDownload();
      return;
    }

    const part = artifact.parts?.[0];
    if (!part) return;

    let blob: Blob | null = null;
    const filename = part.filename ?? artifact.name ?? "artifact";
    const mimeType = part.mediaType ?? "application/octet-stream";

    if (part.raw != null) {
      try {
        const binary = atob(part.raw);
        const bytes = new Uint8Array(binary.length);
        for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
        blob = new Blob([bytes], { type: mimeType });
      } catch (e) {
        console.error("Failed to decode raw bytes:", e);
        return;
      }
    } else if (part.url != null) {
      window.open(part.url, "_blank");
      return;
    } else if (part.data != null) {
      blob = new Blob([JSON.stringify(part.data, null, 2)], { type: "application/json" });
    } else if (part.text != null) {
      blob = new Blob([part.text], { type: "text/plain" });
    }

    if (blob) {
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = filename;
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      URL.revokeObjectURL(url);
    }
  };

  const part = artifact.parts?.[0];
  const content = part ? getPartContent(part) : null;

  if (!content) {
    return (
      <div className="rounded-xl bg-slate-800/50 p-4 text-slate-400">
        <p className="text-sm">No preview available</p>
        {artifact.name && <p className="text-xs text-slate-500 mt-1">{artifact.name}</p>}
      </div>
    );
  }

  return (
    <div className="rounded-xl border border-slate-700 bg-slate-800/50 overflow-hidden">
      <div className="flex items-center justify-between border-b border-slate-700 px-4 py-2 bg-slate-900/50">
        <div className="flex items-center gap-2">
          <span className="text-xs font-semibold text-slate-300">
            {artifact.name || "Artifact"}
          </span>
          {content.mimeType && (
            <span className="text-[10px] rounded-full bg-slate-700/50 px-2 py-0.5 text-slate-400">
              {content.mimeType}
            </span>
          )}
        </div>
        <div className="flex items-center gap-2">
          {(content.type === "text" || content.type === "json") && (
            <button
              type="button"
              onClick={() => setExpanded(!expanded)}
              className="text-xs text-cyan-400 hover:text-cyan-300"
            >
              {expanded ? "Collapse" : "Expand"}
            </button>
          )}
          <button
            type="button"
            onClick={handleDownload}
            className="text-xs text-emerald-400 hover:text-emerald-300"
            title="Download artifact"
          >
            Download
          </button>
        </div>
      </div>

      <div className="p-4">
        {content.type === "image" && content.content && (
          <img
            src={content.content}
            alt={artifact.name ?? "Artifact image"}
            className="max-w-full h-auto rounded-lg"
          />
        )}

        {content.type === "json" && (
          <pre
            className={`text-xs text-slate-300 overflow-x-auto bg-slate-900/50 rounded-lg p-3 ${
              expanded ? "" : "max-h-32 overflow-y-hidden"
            }`}
          >
            {content.content}
          </pre>
        )}

        {content.type === "text" && (
          <div
            className={`text-sm text-slate-300 whitespace-pre-wrap ${
              expanded ? "" : "max-h-32 overflow-y-hidden line-clamp-6"
            }`}
          >
            {content.content}
          </div>
        )}

        {content.type === "file" && (
          <div className="text-sm text-slate-400">
            <p>Binary file ({content.mimeType})</p>
            <button
              type="button"
              onClick={handleDownload}
              className="mt-2 text-emerald-400 hover:text-emerald-300"
            >
              Click to download
            </button>
          </div>
        )}

        {artifact.description && (
          <p className="mt-3 text-xs text-slate-500 border-t border-slate-700 pt-2">
            {artifact.description}
          </p>
        )}
      </div>
    </div>
  );
}
