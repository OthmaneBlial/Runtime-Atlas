import { Pause, Play, RotateCcw } from "lucide-react";
import type { TraceSummary } from "../types";

export function Timeline({
  trace,
  cursor,
  playing,
  onCursor,
  onReplay,
  onToggle,
}: {
  trace?: TraceSummary;
  cursor: number;
  playing: boolean;
  onCursor: (value: number) => void;
  onReplay: () => void;
  onToggle: () => void;
}) {
  const max = trace?.events.length ?? 0;
  const progress = max ? Math.round((cursor / max) * 100) : 0;
  return (
    <div className="timeline" aria-label="Trace timeline">
      <div className="timeline-controls">
        <button type="button" onClick={onReplay} disabled={!max} aria-label="Replay trace"><RotateCcw size={14} /></button>
        <button type="button" onClick={onToggle} disabled={!max} aria-label={playing ? "Pause replay" : "Play replay"}>
          {playing ? <Pause size={14} /> : <Play size={14} />}
        </button>
      </div>
      <div className="timeline-track">
        <div className="timeline-labels">
          <span>{trace ? `${trace.method} ${trace.path.replace("/api/demo", "")}` : "NO TRACE SELECTED"}</span>
          <b>{trace?.duration != null ? `${trace.duration} MS` : "LIVE"}</b>
        </div>
        <input
          type="range"
          min="0"
          max={Math.max(max, 1)}
          value={Math.min(cursor, Math.max(max, 1))}
          onChange={(event) => onCursor(Number(event.target.value))}
          disabled={!max}
          aria-label="Trace playback position"
          style={{ "--progress": `${progress}%` } as React.CSSProperties}
        />
      </div>
      <div className="timeline-count"><strong>{String(cursor).padStart(2, "0")}</strong><span>/ {String(max).padStart(2, "0")} EVENTS</span></div>
    </div>
  );
}
