import {
  Activity,
  CircleCheck,
  CircleX,
  Download,
  Radio,
  RotateCcw,
  Trash2,
} from "lucide-react";
import type { TraceSummary } from "../types";

function since(timestamp: number): string {
  const seconds = Math.max(0, Math.floor((Date.now() - timestamp) / 1000));
  if (seconds < 4) return "now";
  if (seconds < 60) return `${seconds}s`;
  return `${Math.floor(seconds / 60)}m`;
}

export function TraceRail({
  traces,
  selectedId,
  onSelect,
  canClear,
  followingLive,
  onClear,
  onFollowLive,
}: {
  traces: TraceSummary[];
  selectedId?: string;
  onSelect: (trace: TraceSummary) => void;
  canClear: boolean;
  followingLive: boolean;
  onClear: () => void;
  onFollowLive: () => void;
}) {
  return (
    <aside className="trace-rail" aria-label="Request traces">
      <div className="panel-title">
        <span>REQUESTS</span>
        <div className="panel-actions">
          <button
            type="button"
            className={followingLive ? "is-active" : ""}
            onClick={onFollowLive}
            aria-pressed={followingLive}
            aria-label="Follow newest live trace"
            title="Follow newest live trace"
          >
            <Radio size={11} />
          </button>
          <a
            href="/api/traces/export"
            aria-label="Export traces as JSON"
            title="Export traces as JSON"
          >
            <Download size={11} />
          </a>
          {canClear && (
            <button
              type="button"
              onClick={onClear}
              aria-label="Clear trace history"
              title="Clear trace history"
            >
              <Trash2 size={11} />
            </button>
          )}
          <b>{String(traces.length).padStart(2, "0")}</b>
        </div>
      </div>
      <div className="trace-list">
        {traces.map((trace) => {
          const StatusIcon =
            trace.outcome === "running"
              ? Radio
              : trace.outcome === "ok"
                ? CircleCheck
                : CircleX;
          return (
            <button
              type="button"
              key={trace.id}
              className={`trace-row trace-${trace.outcome} ${selectedId === trace.id ? "is-selected" : ""}`}
              onClick={() => onSelect(trace)}
              aria-pressed={selectedId === trace.id}
            >
              <span className="trace-status">
                <StatusIcon size={14} />
              </span>
              <span className="trace-main">
                <strong>
                  <em>{trace.method}</em> {trace.path.replace("/api/demo", "")}
                </strong>
                <small>
                  {trace.outcome === "running"
                    ? "in flight"
                    : `${trace.status} · ${trace.duration}ms`}{" "}
                  · {since(trace.startedAt)}
                </small>
              </span>
              <span className="trace-seq">{trace.id.slice(0, 4)}</span>
            </button>
          );
        })}
        {!traces.length && (
          <div className="trace-empty">
            <Activity size={18} />
            <p>No requests captured yet.</p>
            {!followingLive && (
              <button type="button" onClick={onFollowLive}>
                <RotateCcw size={11} /> Follow live
              </button>
            )}
          </div>
        )}
      </div>
      <div className="rail-foot">
        <span>
          <i className="legend-dot dot-forward" /> outbound
        </span>
        <span>
          <i className="legend-dot dot-return" /> return
        </span>
      </div>
    </aside>
  );
}
