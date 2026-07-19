import { Component, type ErrorInfo, type ReactNode } from "react";
import { AlertTriangle } from "lucide-react";
import { Button } from "@/components/ui/button";
import { API_BASE_URL } from "@/lib/api";
import { getErrorMessage } from "@/lib/api-error";

type Props = {
  children: ReactNode;
};

type State = {
  error: unknown;
};

export class AppErrorBoundary extends Component<Props, State> {
  state: State = { error: null };

  static getDerivedStateFromError(error: unknown): State {
    return { error };
  }

  componentDidCatch(error: unknown, info: ErrorInfo): void {
    console.error("Application render error", error, info);
  }

  render() {
    if (this.state.error) {
      return <AppLoadError title="Application failed to render" error={this.state.error} />;
    }

    return this.props.children;
  }
}

export function AppLoadError({ title, error }: { title: string; error: unknown }) {
  return (
    <div className="min-h-screen w-full flex items-center justify-center bg-black dark p-6">
      <div className="w-full max-w-xl border border-destructive/40 bg-background/90 rounded-sm p-6 shadow-2xl">
        <div className="flex items-start gap-3">
          <AlertTriangle className="w-6 h-6 text-destructive shrink-0 mt-1" />
          <div className="space-y-3">
            <div>
              <h1 className="font-mono text-lg font-bold text-foreground">{title}</h1>
              <p className="mt-2 font-mono text-sm text-muted-foreground">
                {getErrorMessage(error)}
              </p>
            </div>
            <div className="rounded-sm border border-border/50 bg-muted/30 p-3 font-mono text-xs text-muted-foreground">
              API endpoint: {API_BASE_URL || "same origin /api"}
            </div>
            <Button
              type="button"
              variant="outline"
              className="font-mono rounded-sm"
              onClick={() => window.location.reload()}
            >
              Reload
            </Button>
          </div>
        </div>
      </div>
    </div>
  );
}
