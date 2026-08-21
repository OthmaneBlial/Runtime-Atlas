import { Braces, Check, Clock3, Code2, Copy, Crosshair, LoaderCircle, MousePointer2, Radio } from "lucide-react";
import { useEffect, useState } from "react";
import type { AtlasNode, NodeMetric, RuntimeEvent, TraceSummary } from "../types";
import { KindIcon } from "./KindIcon";

function buildMetric(nodeId: string, traces: TraceSummary[]): NodeMetric {
  const finishes = traces.flatMap((trace) => trace.events).filter(
    (event) => event.nodeId === nodeId && (event.type === "span:finish" || event.type === "span:error"),
  );
  return {
    calls: finishes.length,
    errors: finishes.filter((event) => event.type === "span:error").length,
    totalDuration: finishes.reduce((sum, event) => sum + (event.duration ?? 0), 0),
    lastDuration: finishes.at(0)?.duration,
  };
}

export function Inspector({
  node,
  traces,
  visibleEvents,
}: {
  node?: AtlasNode;
  traces: TraceSummary[];
  visibleEvents: RuntimeEvent[];
}) {
  const [copied, setCopied] = useState(false);
  const [sourceSnippet, setSourceSnippet] = useState<{
    file: string;
    focusLine: number;
    lines: Array<{ number: number; text: string }>;
  }>();
  const [sourceLoading, setSourceLoading] = useState(false);

  useEffect(() => setCopied(false), [node?.id]);

  useEffect(() => {
    setSourceSnippet(undefined);
    if (!node || node.source.runtimeOnly) {
      setSourceLoading(false);
      return;
    }
    const controller = new AbortController();
    setSourceLoading(true);
    const query = new URLSearchParams({ file: node.source.file, line: String(node.source.line) });
    fetch(`/api/source?${query}`, { signal: controller.signal })
      .then((response) => response.ok ? response.json() : undefined)
      .then((snippet: unknown) => {
        if (
          snippet &&
          typeof snippet === "object" &&
          "lines" in snippet &&
          Array.isArray(snippet.lines)
        ) {
          setSourceSnippet(snippet as typeof sourceSnippet);
        }
      })
      .catch((error: unknown) => {
        if (!(error instanceof DOMException && error.name === "AbortError")) setSourceSnippet(undefined);
      })
      .finally(() => {
        if (!controller.signal.aborted) setSourceLoading(false);
      });
    return () => controller.abort();
  }, [node]);

  if (!node) {
    return (
      <aside className="inspector inspector-empty" aria-label="Node inspector">
        <div className="panel-title"><span>INSPECTOR</span><Crosshair size={13} /></div>
        <div className="inspector-prompt">
          <MousePointer2 size={22} />
          <strong>Select a runtime node</strong>
          <p>See the source declaration, ownership metadata, and measured latency.</p>
        </div>
      </aside>
    );
  }

  const metric = buildMetric(node.id, traces);
  const current = visibleEvents.filter((event) => event.nodeId === node.id).at(-1);
  const average = metric.calls ? Math.round(metric.totalDuration / metric.calls) : undefined;

  return (
    <aside className="inspector" aria-label={`${node.label} inspector`}>
      <div className="panel-title"><span>INSPECTOR</span><Crosshair size={13} /></div>
      <div className={`inspector-hero kind-${node.kind}`}>
        <span className="inspector-icon"><KindIcon kind={node.kind} size={19} /></span>
        <small>{node.kind} / {node.id}</small>
        <h2>{node.label}</h2>
        <p>{node.description}</p>
      </div>
      <div className="inspector-stats">
        <div><small>LAST</small><strong>{metric.lastDuration != null ? `${metric.lastDuration}ms` : "—"}</strong></div>
        <div><small>MEAN</small><strong>{average != null ? `${average}ms` : "—"}</strong></div>
        <div><small>CALLS</small><strong>{metric.calls}</strong></div>
      </div>
      <div className="inspector-section">
        <h3><Braces size={13} /> SOURCE DECLARATION</h3>
        {node.source.runtimeOnly ? (
          <div className="source-link source-runtime">
            <code>{node.source.file}</code>
            <Radio size={13} />
          </div>
        ) : (
          <button
            type="button"
            className="source-link"
            title="Copy source location"
            onClick={() => {
              void navigator.clipboard?.writeText(`${node.source.file}:${node.source.line}`).then(() => setCopied(true));
            }}
          >
            <code>{node.source.file}:{node.source.line}</code>
            {copied ? <Check size={13} /> : <Copy size={13} />}
          </button>
        )}
        {sourceLoading && (
          <div className="source-loading"><LoaderCircle size={13} /> Reading analyzed source</div>
        )}
        {sourceSnippet && (
          <div className="source-snippet" aria-label={`Source around line ${sourceSnippet.focusLine}`}>
            <div><Code2 size={12} /> ANALYZER CONTEXT</div>
            <pre>
              {sourceSnippet.lines.map((line) => (
                <span key={line.number} className={line.number === sourceSnippet.focusLine ? "is-focus" : ""}>
                  <i>{line.number}</i><code>{line.text || " "}</code>
                </span>
              ))}
            </pre>
          </div>
        )}
      </div>
      <div className="inspector-section">
        <h3><Clock3 size={13} /> RUNTIME STATE</h3>
        <div className="runtime-readout">
          <span>Latest event</span>
          <strong>{current?.type.replace("span:", "") ?? "not observed"}</strong>
        </div>
        {node.meta && Object.entries(node.meta).map(([key, value]) => (
          <div className="runtime-readout" key={key}>
            <span>{key}</span><strong>{value}</strong>
          </div>
        ))}
      </div>
    </aside>
  );
}
