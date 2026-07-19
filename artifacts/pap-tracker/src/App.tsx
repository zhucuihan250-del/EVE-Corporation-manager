import { Switch, Route, Router as WouterRouter, useLocation } from "wouter";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { Toaster } from "@/components/ui/toaster";
import { TooltipProvider } from "@/components/ui/tooltip";
import { useGetMe } from "@workspace/api-client-react";
import { Loader2 } from "lucide-react";
import { useEffect } from "react";
import { AppErrorBoundary, AppLoadError } from "@/components/app-error-boundary";
import { isUnauthorizedError } from "@/lib/api-error";

import NotFound from "@/pages/not-found";
import { Login } from "@/pages/login";
import { Layout } from "@/components/layout";
import { Dashboard } from "@/pages/dashboard";
import { History } from "@/pages/history";
import { Rewards } from "@/pages/rewards";
import { Redemptions } from "@/pages/redemptions";

import { AdminDashboard } from "@/pages/admin";
import { AdminUsers } from "@/pages/admin/users";
import { AdminFleets } from "@/pages/admin/fleets";
import { AdminRewards } from "@/pages/admin/rewards";
import { AdminRedemptions } from "@/pages/admin/redemptions";
import { AdminPap } from "@/pages/admin/pap";
import { AdminAnnouncements } from "@/pages/admin/announcements";
import { Characters } from "@/pages/characters";

const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      retry: false,
      refetchOnWindowFocus: false,
    },
  },
});

const ROLE_LEVELS = ["member", "fc", "admin", "controller"] as const;
type Role = typeof ROLE_LEVELS[number];

function hasRole(userRole: string, minRole: Role): boolean {
  return ROLE_LEVELS.indexOf(userRole as Role) >= ROLE_LEVELS.indexOf(minRole);
}

function ProtectedRoute({ component: Component, minRole }: { component: any, minRole?: Role }) {
  const { data: user, isLoading, isError, error } = useGetMe();
  const [, setLocation] = useLocation();
  const isUnauthorized = isUnauthorizedError(error);

  useEffect(() => {
    if (isLoading) return;

    if (isError) {
      if (isUnauthorized) {
        setLocation("/");
      }
      return;
    }

    if (!user) {
      setLocation("/");
    } else if (!isLoading && user && minRole && !hasRole(user.role, minRole)) {
      setLocation("/dashboard");
    }
  }, [isLoading, isError, isUnauthorized, user, setLocation, minRole]);

  if (isLoading) {
    return (
      <div className="min-h-screen w-full flex items-center justify-center bg-background text-primary">
        <Loader2 className="w-8 h-8 animate-spin" />
      </div>
    );
  }

  if (isError && !isUnauthorized) {
    return <AppLoadError title="Unable to initialize the application" error={error} />;
  }

  if (isError || !user || (minRole && !hasRole(user.role, minRole))) {
    return null;
  }

  return (
    <Layout>
      <Component />
    </Layout>
  );
}

function Router() {
  return (
    <Switch>
      <Route path="/" component={Login} />
      <Route path="/dashboard">
        {() => <ProtectedRoute component={Dashboard} />}
      </Route>
      <Route path="/history">
        {() => <ProtectedRoute component={History} />}
      </Route>
      <Route path="/rewards">
        {() => <ProtectedRoute component={Rewards} />}
      </Route>
      <Route path="/redemptions">
        {() => <ProtectedRoute component={Redemptions} />}
      </Route>
      <Route path="/characters">
        {() => <ProtectedRoute component={Characters} />}
      </Route>
      
      {/* Admin Routes - admin & controller only */}
      <Route path="/admin">
        {() => <ProtectedRoute component={AdminDashboard} minRole="admin" />}
      </Route>
      <Route path="/admin/users">
        {() => <ProtectedRoute component={AdminUsers} minRole="admin" />}
      </Route>
      <Route path="/admin/rewards">
        {() => <ProtectedRoute component={AdminRewards} minRole="admin" />}
      </Route>
      <Route path="/admin/redemptions">
        {() => <ProtectedRoute component={AdminRedemptions} minRole="admin" />}
      </Route>
      <Route path="/admin/pap">
        {() => <ProtectedRoute component={AdminPap} minRole="admin" />}
      </Route>
      {/* FC Routes - fc, admin & controller */}
      <Route path="/admin/fleets">
        {() => <ProtectedRoute component={AdminFleets} minRole="fc" />}
      </Route>
      <Route path="/admin/announcements">
        {() => <ProtectedRoute component={AdminAnnouncements} minRole="fc" />}
      </Route>
      
      <Route component={NotFound} />
    </Switch>
  );
}

function App() {
  return (
    <QueryClientProvider client={queryClient}>
      <TooltipProvider>
        <AppErrorBoundary>
          <WouterRouter base={import.meta.env.BASE_URL.replace(/\/$/, "")}>
            <Router />
          </WouterRouter>
        </AppErrorBoundary>
        <Toaster />
      </TooltipProvider>
    </QueryClientProvider>
  );
}

export default App;
