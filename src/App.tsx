import {
  useEffect,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent as ReactKeyboardEvent,
} from "react";
import {
  Activity,
  AlertTriangle,
  Command,
  GitBranch,
  Play,
  Radio,
  Search,
  Send,
  Sparkles,
  X,
} from "lucide-react";
import { Inspector } from "./components/Inspector";
import { RuntimeCanvas } from "./components/RuntimeCanvas";
import { Timeline } from "./components/Timeline";
import { TraceRail } from "./components/TraceRail";
import { useAtlas } from "./hooks/useAtlas";
import type { AtlasNode } from "./types";

function percentile95(values: number[]): number | undefined {
  if (!values.length) return undefined;
  const ordered = [...values].sort((a, b) => a - b);
  return ordered[
    Math.min(ordered.length - 1, Math.ceil(ordered.length * 0.95) - 1)
  ];
}

export default function App() {
  const {
    topology,
    traces,
    connected,
    error,
    requesting,
    inFlight,
    launchRequest,
    clearTraces,
    reload,
    dismissError,
  } = useAtlas();
  const [selectedTraceId, setSelectedTraceId] = useState<string>();
  const [selectedNode, setSelectedNode] = useState<AtlasNode>();
  const [cursor, setCursor] = useState<number | null>(null);
  const [playing, setPlaying] = useState(false);
  const [now, setNow] = useState(Date.now());
  const [view, setView] = useState<"live" | "topology">("live");
  const [searchOpen, setSearchOpen] = useState(false);
  const [searchQuery, setSearchQuery] = useState("");
  const [followingLive, setFollowingLive] = useState(true);
  const searchButtonRef = useRef<HTMLButtonElement>(null);
  const searchDialogRef = useRef<HTMLElement>(null);

  const selectedTrace =
    traces.find((trace) => trace.id === selectedTraceId) ?? traces[0];
  const visibleEvents =
    selectedTrace?.events.slice(0, cursor ?? selectedTrace.events.length) ?? [];
  const cursorValue = cursor ?? selectedTrace?.events.length ?? 0;

  useEffect(() => {
    const newest = traces[0];
    if (!newest) return;
    if (
      followingLive ||
      !traces.some((trace) => trace.id === selectedTraceId)
    ) {
      setSelectedTraceId(newest.id);
      if (newest.id !== selectedTraceId) {
        setCursor(null);
        setPlaying(false);
      }
    }
  }, [followingLive, selectedTraceId, traces]);

  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), 100);
    return () => window.clearInterval(timer);
  }, []);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "k") {
        event.preventDefault();
        if (searchOpen) closeSearch();
        else setSearchOpen(true);
      }
      if (event.key === "Escape") {
        setSearchOpen(false);
        searchButtonRef.current?.focus();
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [searchOpen]);

  useEffect(() => {
    if (!playing || !selectedTrace) return;
    const timer = window.setInterval(() => {
      setCursor((current) => {
        const next = (current ?? 0) + 1;
        if (next >= selectedTrace.events.length) {
          setPlaying(false);
          return selectedTrace.events.length;
        }
        return next;
      });
    }, 145);
    return () => window.clearInterval(timer);
  }, [playing, selectedTrace]);

  const p95 = useMemo(
    () => percentile95(traces.flatMap((trace) => trace.duration ?? [])),
    [traces],
  );

  const selectTrace = (id: string) => {
    setView("live");
    setSelectedTraceId(id);
    setFollowingLive(false);
    setCursor(null);
    setPlaying(false);
  };

  const replay = () => {
    if (!selectedTrace?.events.length) return;
    setView("live");
    setCursor(0);
    setPlaying(true);
  };

  const filteredNodes = (topology?.nodes ?? []).filter((node) => {
    const query = searchQuery.trim().toLowerCase();
    return (
      !query ||
      [node.label, node.id, node.kind, node.symbol].some((value) =>
        value.toLowerCase().includes(query),
      )
    );
  });

  const inject = (kind: "checkout" | "search") => {
    setView("live");
    setFollowingLive(true);
    void launchRequest(kind);
  };

  const closeSearch = () => {
    setSearchOpen(false);
    searchButtonRef.current?.focus();
  };

  const trapDialogFocus = (event: ReactKeyboardEvent<HTMLElement>) => {
    if (event.key !== "Tab" || !searchDialogRef.current) return;
    const focusable = [
      ...searchDialogRef.current.querySelectorAll<HTMLElement>(
        "button, input, [href]",
      ),
    ].filter((element) => !element.hasAttribute("disabled"));
    if (!focusable.length) return;
    const first = focusable[0];
    const last = focusable.at(-1)!;
    if (event.shiftKey && document.activeElement === first) {
      event.preventDefault();
      last.focus();
    } else if (!event.shiftKey && document.activeElement === last) {
      event.preventDefault();
      first.focus();
    }
  };

  if (!topology) {
    return (
      <main className="boot-screen">
        <div className="boot-mark">
          <i />
          <i />
          <i />
        </div>
        <p role="status">READING APPLICATION TOPOLOGY</p>
        {error && <span>{error}</span>}
        {error && (
          <button type="button" onClick={reload}>
            Retry connection
          </button>
        )}
      </main>
    );
  }

  return (
    <main className="app-shell">
      <header className="topbar">
        <a className="brand" href="/" aria-label="Runtime Atlas home">
          <span className="brand-sigil">
            <i />
            <i />
            <i />
          </span>
          <span>
            <strong>RUNTIME</strong>
            <em>ATLAS</em>
          </span>
        </a>
        <div className="project-identity" aria-label="Current project">
          <span className="project-icon">RA</span>
          <span>
            <small>PROJECT</small>
            <strong>{topology.project?.name ?? "runtime-atlas"}</strong>
          </span>
        </div>
        <nav className="topnav" aria-label="Workspace views">
          <button
            type="button"
            className={view === "live" ? "is-active" : ""}
            aria-pressed={view === "live"}
            onClick={() => setView("live")}
          >
            <Activity size={14} /> LIVE MAP
          </button>
          <button
            type="button"
            className={view === "topology" ? "is-active" : ""}
            aria-pressed={view === "topology"}
            onClick={() => setView("topology")}
          >
            <GitBranch size={14} /> TOPOLOGY
          </button>
        </nav>
        <button
          ref={searchButtonRef}
          type="button"
          className="command-search"
          aria-label="Find a node"
          onClick={() => setSearchOpen(true)}
        >
          <Search size={13} />
          <span>Find a node</span>
          <kbd>
            <Command size={10} /> K
          </kbd>
        </button>
        <div
          className={`connection-pill ${connected ? "is-online" : ""}`}
          role="status"
          aria-live="polite"
          aria-label={
            connected ? "Live stream connected" : "Live stream reconnecting"
          }
        >
          <i /> {connected ? "STREAM LIVE" : "RECONNECTING"}
        </div>
      </header>

      <section className="mission-bar">
        <div className="mission-copy">
          <span className="eyebrow">
            <Sparkles size={12} /> REQUEST FLIGHT RECORDER{" "}
            {topology.project?.demo && <b>LOCAL DEMO</b>}
          </span>
          <h1>
            See where it went.
            <br />
            <em>See the code behind it.</em>
          </h1>
        </div>
        <div className="system-metrics" aria-label="Runtime summary">
          <div>
            <small>DISCOVERED</small>
            <strong>
              {topology.nodes.length}
              <span> nodes</span>
            </strong>
          </div>
          <div>
            <small>IN FLIGHT</small>
            <strong className={inFlight ? "metric-hot" : ""}>
              {inFlight}
              <span> req</span>
            </strong>
          </div>
          <div>
            <small>P95 LATENCY</small>
            <strong>
              {p95 ?? "—"}
              <span>{p95 ? " ms" : ""}</span>
            </strong>
          </div>
          <div>
            <small>CODE LINKS</small>
            <strong>
              {topology.edges.length}
              <span> edges</span>
            </strong>
          </div>
        </div>
        {topology.project?.demo !== false ? (
          <div className="request-launcher">
            <small>RUN A LOCAL SCENARIO</small>
            <div>
              <button
                type="button"
                className="launch-primary"
                disabled={!!requesting}
                onClick={() => inject("checkout")}
              >
                {requesting === "checkout" ? (
                  <Radio className="spin-pulse" size={14} />
                ) : (
                  <Send size={14} />
                )}
                POST /checkout
              </button>
              <button
                type="button"
                disabled={!!requesting}
                onClick={() => inject("search")}
              >
                {requesting === "search" ? (
                  <Radio className="spin-pulse" size={14} />
                ) : (
                  <Play size={14} />
                )}
                GET /search
              </button>
              <button
                type="button"
                className="launch-danger"
                disabled={!!requesting}
                onClick={() => {
                  setView("live");
                  setFollowingLive(true);
                  void launchRequest("failure");
                }}
              >
                {requesting === "failure" ? (
                  <Radio className="spin-pulse" size={14} />
                ) : (
                  <AlertTriangle size={14} />
                )}
                FAIL /payment
              </button>
            </div>
          </div>
        ) : (
          <div className="external-listener">
            <Radio size={15} />
            <span>
              <small>COLLECTOR ARMED</small>
              <strong>Waiting for {topology.project?.name} requests</strong>
            </span>
          </div>
        )}
      </section>

      <div className="workspace">
        <TraceRail
          traces={traces}
          selectedId={selectedTrace?.id}
          onSelect={(trace) => selectTrace(trace.id)}
          canClear={topology.project?.canClearTraces === true}
          followingLive={followingLive}
          onClear={() => {
            void clearTraces().then((cleared) => {
              if (cleared) {
                setSelectedTraceId(undefined);
                setFollowingLive(true);
              }
            });
          }}
          onFollowLive={() => {
            setFollowingLive(true);
            setSelectedTraceId(traces[0]?.id);
            setCursor(null);
          }}
        />
        <div className="map-column">
          <RuntimeCanvas
            topology={topology}
            events={view === "topology" ? [] : visibleEvents}
            selectedNodeId={selectedNode?.id}
            onSelectNode={setSelectedNode}
            now={
              cursor !== null
                ? (visibleEvents.at(-1)?.timestamp ??
                  selectedTrace?.startedAt ??
                  now)
                : now
            }
            topologyMode={view === "topology"}
          />
          <Timeline
            trace={selectedTrace}
            cursor={cursorValue}
            playing={playing}
            onCursor={(value) => {
              setCursor(value);
              setPlaying(false);
            }}
            onReplay={replay}
            onToggle={() => {
              if (cursorValue >= (selectedTrace?.events.length ?? 0))
                setCursor(0);
              setPlaying((current) => !current);
            }}
          />
        </div>
        <Inspector
          node={selectedNode}
          traces={traces}
          visibleEvents={visibleEvents}
        />
      </div>

      <footer className="statusbar">
        <span>
          <i className="status-ok" /> ANALYZER <b>READY</b>
        </span>
        <span>
          source: <b>{topology.sourceRoot || "."}</b>
        </span>
        <span>
          generated{" "}
          <b>
            {new Date(topology.generatedAt).toLocaleTimeString([], {
              hour: "2-digit",
              minute: "2-digit",
            })}
          </b>
        </span>
        <span className="status-spacer" />
        <span>
          {topology.project?.environment ?? "local"} instrumentation ·{" "}
          <b>{topology.project?.name ?? "runtime-atlas"}</b>
          {topology.project?.demo && <em>DEMO</em>}
        </span>
      </footer>
      {searchOpen && (
        <div
          className="search-overlay"
          role="presentation"
          onMouseDown={(event) => {
            if (event.target === event.currentTarget) closeSearch();
          }}
        >
          <section
            ref={searchDialogRef}
            className="search-dialog"
            role="dialog"
            aria-modal="true"
            aria-labelledby="search-dialog-title"
            onKeyDown={trapDialogFocus}
          >
            <h2 className="sr-only" id="search-dialog-title">
              Find a runtime node
            </h2>
            <div className="search-input-wrap">
              <Search size={15} />
              <input
                autoFocus
                value={searchQuery}
                onChange={(event) => setSearchQuery(event.target.value)}
                placeholder="Route, service, dependency…"
                aria-label="Search runtime nodes"
              />
              <button
                type="button"
                onClick={closeSearch}
                aria-label="Close node search"
              >
                <X size={15} />
              </button>
            </div>
            <div className="search-results">
              {filteredNodes.map((node) => (
                <button
                  type="button"
                  key={node.id}
                  onClick={() => {
                    setSelectedNode(node);
                    closeSearch();
                  }}
                >
                  <span>{node.kind}</span>
                  <strong>{node.label}</strong>
                  <code>
                    {node.source.file}
                    {node.source.runtimeOnly ? "" : `:${node.source.line}`}
                  </code>
                </button>
              ))}
              {!filteredNodes.length && <p>No nodes match “{searchQuery}”.</p>}
            </div>
          </section>
        </div>
      )}
      {error && (
        <div className="error-toast" role="alert">
          <span>{error}</span>
          <button
            type="button"
            onClick={dismissError}
            aria-label="Dismiss error"
          >
            <X size={13} />
          </button>
        </div>
      )}
    </main>
  );
}
