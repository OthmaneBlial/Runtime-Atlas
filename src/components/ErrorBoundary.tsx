import { Component, type ErrorInfo, type ReactNode } from "react";
import { AlertTriangle, RotateCcw } from "lucide-react";

export class ErrorBoundary extends Component<
  { children: ReactNode },
  { failed: boolean }
> {
  state = { failed: false };

  static getDerivedStateFromError() {
    return { failed: true };
  }

  componentDidCatch(error: Error, info: ErrorInfo) {
    if (import.meta.env.DEV)
      console.error("Runtime Atlas UI failed", error, info.componentStack);
  }

  render() {
    if (!this.state.failed) return this.props.children;
    return (
      <main className="fatal-screen">
        <AlertTriangle size={28} />
        <span>INTERFACE RECOVERY</span>
        <h1>Runtime Atlas hit an unexpected rendering error.</h1>
        <p>
          Your application traces remain in the local collector. Reload the
          interface to reconnect.
        </p>
        <button type="button" onClick={() => window.location.reload()}>
          <RotateCcw size={14} /> Reload interface
        </button>
      </main>
    );
  }
}
