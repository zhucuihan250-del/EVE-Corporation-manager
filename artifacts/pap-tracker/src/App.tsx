import { Switch, Route, Router as WouterRouter, useLocation } from "wouter";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { Toaster } from "@/components/ui/toaster";
import { TooltipProvider } from "@/components/ui/tooltip";
import { useGetMe } from "@workspace/api-client-react";
import { Loader2 } from "lucide-react";
import { useEffect } from "react";
import {
  AppErrorBoundary,
  AppLoadError,
} from "@/components/app-error-boundary";
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
import { Fitting } from "@/pages/fitting";
import { BattleReportDetail, BattleReports } from "@/pages/battle-reports";
import { BattleReplayWorkbench, BattleReplays } from "@/pages/battle-replays";
import { IdentityGroups } from "@/pages/identity-groups";
import { Diplomacy } from "@/pages/diplomacy";
import { Reimbursements } from "@/pages/reimbursements";
import { Economy } from "@/pages/economy";
import type { CorporationModules, CurrentUser } from "@workspace/api-client-react";

const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      retry: false,
      refetchOnWindowFocus: false,
    },
  },
});

const ROLE_LEVELS = ["member", "fc", "admin", "controller"] as const;
type Role = (typeof ROLE_LEVELS)[number];

function hasRole(userRole: string, minRole: Role): boolean {
  return ROLE_LEVELS.indexOf(userRole as Role) >= ROLE_LEVELS.indexOf(minRole);
}

function defaultLanding(user: CurrentUser): string {
  if (user.modules.pap) return "/dashboard";
  if (user.modules.reimbursement) return "/reimbursements";
  if (user.modules.diplomacy) return "/diplomacy";
  return "/";
}

function ProtectedRoute({
  component: Component,
  minRole,
  module,
  permission,
  permissionAlternative,
}: {
  component: any;
  minRole?: Role;
  module?: keyof CorporationModules;
  permission?: string;
  permissionAlternative?: string;
}) {
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
    } else if (
      user
      && ((minRole && !hasRole(user.role, minRole) && !(permissionAlternative && user.permissions.includes(permissionAlternative)))
        || (module && !user.modules[module])
        || (permission && !user.permissions.includes(permission)))
    ) {
      setLocation(defaultLanding(user));
    }
  }, [isLoading, isError, isUnauthorized, user, setLocation, minRole, module, permission, permissionAlternative]);

  if (isLoading) {
    return (
      <div className="min-h-screen w-full flex items-center justify-center bg-background text-primary">
        <Loader2 className="w-8 h-8 animate-spin" />
      </div>
    );
  }

  if (isError && !isUnauthorized) {
    return (
      <AppLoadError
        title="Unable to initialize the application"
        error={error}
      />
    );
  }

  if (
    isError
    || !user
    || (minRole && !hasRole(user.role, minRole) && !(permissionAlternative && user.permissions.includes(permissionAlternative)))
    || (module && !user.modules[module])
    || (permission && !user.permissions.includes(permission))
  ) {
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
        {() => <ProtectedRoute component={Dashboard} module="pap" />}
      </Route>
      <Route path="/history">
        {() => <ProtectedRoute component={History} module="pap" />}
      </Route>
      <Route path="/rewards">
        {() => <ProtectedRoute component={Rewards} module="pap" />}
      </Route>
      <Route path="/redemptions">
        {() => <ProtectedRoute component={Redemptions} module="pap" />}
      </Route>
      <Route path="/characters">
        {() => <ProtectedRoute component={Characters} module="pap" />}
      </Route>
      <Route path="/fitting">
        {() => <ProtectedRoute component={Fitting} module="fleet" />}
      </Route>
      <Route path="/battle-reports/:id">
        {() => <ProtectedRoute component={BattleReportDetail} module="fleet" />}
      </Route>
      <Route path="/battle-reports">
        {() => <ProtectedRoute component={BattleReports} module="fleet" />}
      </Route>
      <Route path="/identity-groups">
        {() => <ProtectedRoute component={IdentityGroups} module="identity" />}
      </Route>
      <Route path="/diplomacy">
        {() => <ProtectedRoute component={Diplomacy} module="diplomacy" />}
      </Route>
      <Route path="/reimbursements">
        {() => <ProtectedRoute component={Reimbursements} module="reimbursement" />}
      </Route>
      <Route path="/economy">
        {() => <ProtectedRoute component={Economy} module="economy" permission="economy.view" />}
      </Route>
      <Route path="/command/battle-replays/:id">
        {() => (
          <ProtectedRoute component={BattleReplayWorkbench} minRole="fc" module="fleet" permissionAlternative="fleet.manage" />
        )}
      </Route>
      <Route path="/command/battle-replays">
        {() => <ProtectedRoute component={BattleReplays} minRole="fc" module="fleet" permissionAlternative="fleet.manage" />}
      </Route>

      {/* Admin Routes - admin & controller only */}
      <Route path="/admin">
        {() => <ProtectedRoute component={AdminDashboard} minRole="admin" module="pap" />}
      </Route>
      <Route path="/admin/users">
        {() => <ProtectedRoute component={AdminUsers} minRole="admin" module="pap" />}
      </Route>
      <Route path="/admin/rewards">
        {() => <ProtectedRoute component={AdminRewards} minRole="admin" module="pap" />}
      </Route>
      <Route path="/admin/redemptions">
        {() => <ProtectedRoute component={AdminRedemptions} minRole="admin" module="pap" />}
      </Route>
      <Route path="/admin/pap">
        {() => <ProtectedRoute component={AdminPap} minRole="admin" module="pap" />}
      </Route>
      {/* FC Routes - fc, admin & controller */}
      <Route path="/admin/fleets">
        {() => <ProtectedRoute component={AdminFleets} minRole="fc" module="fleet" permissionAlternative="fleet.manage" />}
      </Route>
      <Route path="/admin/announcements">
        {() => <ProtectedRoute component={AdminAnnouncements} minRole="fc" module="fleet" permissionAlternative="fleet.manage" />}
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
