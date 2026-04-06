import { Switch, Route, Router as WouterRouter, useLocation } from "wouter";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { Toaster } from "@/components/ui/toaster";
import { TooltipProvider } from "@/components/ui/tooltip";
import { useGetMe } from "@workspace/api-client-react";
import { Loader2 } from "lucide-react";
import { useEffect } from "react";

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

const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      retry: false,
      refetchOnWindowFocus: false,
    },
  },
});

function ProtectedRoute({ component: Component, adminOnly = false }: { component: any, adminOnly?: boolean }) {
  const { data: user, isLoading, isError } = useGetMe();
  const [, setLocation] = useLocation();

  useEffect(() => {
    if (!isLoading && (isError || !user)) {
      setLocation("/");
    } else if (!isLoading && user && adminOnly && user.role !== 'admin') {
      setLocation("/dashboard");
    }
  }, [isLoading, isError, user, setLocation, adminOnly]);

  if (isLoading) {
    return (
      <div className="min-h-screen w-full flex items-center justify-center bg-background text-primary">
        <Loader2 className="w-8 h-8 animate-spin" />
      </div>
    );
  }

  if (isError || !user || (adminOnly && user.role !== 'admin')) {
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
      
      {/* Admin Routes */}
      <Route path="/admin">
        {() => <ProtectedRoute component={AdminDashboard} adminOnly />}
      </Route>
      <Route path="/admin/users">
        {() => <ProtectedRoute component={AdminUsers} adminOnly />}
      </Route>
      <Route path="/admin/fleets">
        {() => <ProtectedRoute component={AdminFleets} adminOnly />}
      </Route>
      <Route path="/admin/rewards">
        {() => <ProtectedRoute component={AdminRewards} adminOnly />}
      </Route>
      <Route path="/admin/redemptions">
        {() => <ProtectedRoute component={AdminRedemptions} adminOnly />}
      </Route>
      <Route path="/admin/pap">
        {() => <ProtectedRoute component={AdminPap} adminOnly />}
      </Route>
      
      <Route component={NotFound} />
    </Switch>
  );
}

function App() {
  return (
    <QueryClientProvider client={queryClient}>
      <TooltipProvider>
        <WouterRouter base={import.meta.env.BASE_URL.replace(/\/$/, "")}>
          <Router />
        </WouterRouter>
        <Toaster />
      </TooltipProvider>
    </QueryClientProvider>
  );
}

export default App;