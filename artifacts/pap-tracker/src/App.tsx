import { Switch, Route, Router as WouterRouter, useLocation } from "wouter";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { Toaster } from "@/components/ui/toaster";
import { TooltipProvider } from "@/components/ui/tooltip";
import { useGetMe } from "@workspace/api-client-react";
import { Loader2 } from "lucide-react";
import {
  lazy,
  Suspense,
  useEffect,
  type ComponentType,
  type LazyExoticComponent,
} from "react";
import {
  AppErrorBoundary,
  AppLoadError,
} from "@/components/app-error-boundary";
import { isUnauthorizedError } from "@/lib/api-error";
import {
  defaultLanding,
  hasRole,
  REIMBURSEMENT_REVIEW_PERMISSIONS,
  type Role,
} from "@/lib/navigation";

import NotFound from "@/pages/not-found";
import { Login } from "@/pages/login";
import type { CorporationModules } from "@workspace/api-client-react";

const Layout = lazy(() => import("@/components/layout").then((module) => ({ default: module.Layout })));
const Dashboard = lazy(() => import("@/pages/dashboard").then((module) => ({ default: module.Dashboard })));
const History = lazy(() => import("@/pages/history").then((module) => ({ default: module.History })));
const Rewards = lazy(() => import("@/pages/rewards").then((module) => ({ default: module.Rewards })));
const Redemptions = lazy(() => import("@/pages/redemptions").then((module) => ({ default: module.Redemptions })));
const Characters = lazy(() => import("@/pages/characters").then((module) => ({ default: module.Characters })));
const Fitting = lazy(() => import("@/pages/fitting").then((module) => ({ default: module.Fitting })));
const BattleReportDetail = lazy(() => import("@/pages/battle-reports").then((module) => ({ default: module.BattleReportDetail })));
const BattleReports = lazy(() => import("@/pages/battle-reports").then((module) => ({ default: module.BattleReports })));
const BattleReplayWorkbench = lazy(() => import("@/pages/battle-replays").then((module) => ({ default: module.BattleReplayWorkbench })));
const BattleReplays = lazy(() => import("@/pages/battle-replays").then((module) => ({ default: module.BattleReplays })));
const IdentityGroups = lazy(() => import("@/pages/identity-groups").then((module) => ({ default: module.IdentityGroups })));
const Diplomacy = lazy(() => import("@/pages/diplomacy").then((module) => ({ default: module.Diplomacy })));
const Courier = lazy(() => import("@/pages/courier").then((module) => ({ default: module.Courier })));
const Reimbursements = lazy(() => import("@/pages/reimbursements").then((module) => ({ default: module.Reimbursements })));
const TacticalReimbursements = lazy(() => import("@/pages/reimbursements").then((module) => ({ default: module.TacticalReimbursements })));
const TacticalDashboard = lazy(() => import("@/pages/tactical-dashboard").then((module) => ({ default: module.TacticalDashboard })));
const ReimbursementSettings = lazy(() => import("@/pages/reimbursement-settings").then((module) => ({ default: module.ReimbursementSettings })));
const Economy = lazy(() => import("@/pages/economy").then((module) => ({ default: module.Economy })));
const Structures = lazy(() => import("@/pages/structures").then((module) => ({ default: module.Structures })));
const AdminDashboard = lazy(() => import("@/pages/admin").then((module) => ({ default: module.AdminDashboard })));
const AdminUsers = lazy(() => import("@/pages/admin/users").then((module) => ({ default: module.AdminUsers })));
const AdminFleets = lazy(() => import("@/pages/admin/fleets").then((module) => ({ default: module.AdminFleets })));
const AdminRewards = lazy(() => import("@/pages/admin/rewards").then((module) => ({ default: module.AdminRewards })));
const AdminRedemptions = lazy(() => import("@/pages/admin/redemptions").then((module) => ({ default: module.AdminRedemptions })));
const AdminPap = lazy(() => import("@/pages/admin/pap").then((module) => ({ default: module.AdminPap })));
const AdminAnnouncements = lazy(() => import("@/pages/admin/announcements").then((module) => ({ default: module.AdminAnnouncements })));
const AdminActivity = lazy(() => import("@/pages/admin/activity").then((module) => ({ default: module.AdminActivity })));
const AdminIdentity = lazy(() => import("@/pages/admin/identity").then((module) => ({ default: module.AdminIdentity })));
const AdminCourier = lazy(() => import("@/pages/admin/courier").then((module) => ({ default: module.AdminCourier })));

const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      staleTime: 30_000,
      gcTime: 120_000,
      retry: false,
      refetchOnWindowFocus: false,
    },
  },
});

type RouteComponent = ComponentType | LazyExoticComponent<ComponentType>;

function RouteLoading() {
  return (
    <div className="min-h-screen w-full flex items-center justify-center bg-background text-primary">
      <Loader2 className="w-7 h-7 animate-spin" />
    </div>
  );
}

function ProtectedRoute({
  component: Component,
  minRole,
  module,
  permission,
  permissionAlternative,
  permissionAlternatives,
  requiresReimbursementOpen,
}: {
  component: RouteComponent;
  minRole?: Role;
  module?: keyof CorporationModules;
  permission?: string;
  permissionAlternative?: string;
  permissionAlternatives?: readonly string[];
  requiresReimbursementOpen?: boolean;
}) {
  const { data: user, isLoading, isError, error } = useGetMe();
  const [, setLocation] = useLocation();
  const isUnauthorized = isUnauthorizedError(error);
  const hasAlternativePermission = Boolean(
    user
    && ((permissionAlternative && user.permissions.includes(permissionAlternative))
      || permissionAlternatives?.some((candidate) => user.permissions.includes(candidate))),
  );

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
      && ((minRole && !hasRole(user.role, minRole) && !hasAlternativePermission)
        || (module && !user.modules[module])
        || (requiresReimbursementOpen && !user.reimbursementOpen)
        || (permission && !user.permissions.includes(permission)))
    ) {
      setLocation(defaultLanding(user));
    }
  }, [isLoading, isError, isUnauthorized, user, setLocation, minRole, module, permission, hasAlternativePermission, requiresReimbursementOpen]);

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
    || (minRole && !hasRole(user.role, minRole) && !hasAlternativePermission)
    || (module && !user.modules[module])
    || (requiresReimbursementOpen && !user.reimbursementOpen)
    || (permission && !user.permissions.includes(permission))
  ) {
    return null;
  }

  return (
    <Suspense fallback={<RouteLoading />}>
      <Layout>
        <Component />
      </Layout>
    </Suspense>
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
      <Route path="/courier">
        {() => <ProtectedRoute component={Courier} module="courier" />}
      </Route>
      <Route path="/reimbursements">
        {() => <ProtectedRoute component={Reimbursements} module="reimbursement" requiresReimbursementOpen />}
      </Route>
      <Route path="/tactical/:id/reimbursements">
        {() => <ProtectedRoute component={TacticalReimbursements} module="reimbursement" requiresReimbursementOpen />}
      </Route>
      <Route path="/tactical/:id">
        {() => <ProtectedRoute component={TacticalDashboard} module="identity" />}
      </Route>
      <Route path="/reimbursement-settings">
        {() => <ProtectedRoute component={ReimbursementSettings} minRole="admin" module="reimbursement" permissionAlternatives={REIMBURSEMENT_REVIEW_PERMISSIONS} />}
      </Route>
      <Route path="/economy">
        {() => <ProtectedRoute component={Economy} module="economy" permission="economy.view" />}
      </Route>
      <Route path="/structures">
        {() => <ProtectedRoute component={Structures} minRole="admin" module="structures" />}
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
      <Route path="/admin/activity">
        {() => <ProtectedRoute component={AdminActivity} minRole="admin" module="pap" permissionAlternative="activity.manage" />}
      </Route>
      <Route path="/admin/identity">
        {() => <ProtectedRoute component={AdminIdentity} minRole="admin" module="identity" permissionAlternative="identity.manage" />}
      </Route>
      <Route path="/admin/courier">
        {() => <ProtectedRoute component={AdminCourier} minRole="admin" module="courier" />}
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
