import { Button } from "@/components/ui/button";
import { useGetMe, useLogout } from "@workspace/api-client-react";
import { Link, useLocation } from "wouter";
import { 
  LayoutDashboard, 
  History, 
  Gift, 
  LogOut, 
  ShieldAlert,
  Users,
  Swords,
  Database,
  ClipboardList,
  BookOpen,
  Inbox
} from "lucide-react";
import {
  Sidebar,
  SidebarContent,
  SidebarFooter,
  SidebarGroup,
  SidebarGroupContent,
  SidebarGroupLabel,
  SidebarHeader,
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem,
  SidebarProvider,
  SidebarTrigger,
} from "@/components/ui/sidebar";

export function Layout({ children }: { children: React.ReactNode }) {
  const { data: user } = useGetMe();
  const logoutMutation = useLogout();
  const [, setLocation] = useLocation();
  const [location] = useLocation();

  const handleLogout = () => {
    logoutMutation.mutate(undefined, {
      onSuccess: () => {
        setLocation("/");
      }
    });
  };

  const isAdmin = user?.role === 'admin';

  return (
    <SidebarProvider>
      <div className="flex min-h-screen w-full bg-background dark">
        <Sidebar className="border-r border-border/50 bg-sidebar/50 backdrop-blur-xl">
          <SidebarHeader className="h-16 flex items-center px-4 border-b border-border/50">
            <div className="flex items-center gap-2 font-mono text-primary font-bold tracking-wider">
              <ShieldAlert className="w-5 h-5" />
              <span>PAP TRACKER</span>
            </div>
          </SidebarHeader>
          <SidebarContent>
            <SidebarGroup>
              <SidebarGroupLabel className="text-xs uppercase tracking-widest text-muted-foreground font-mono">Member</SidebarGroupLabel>
              <SidebarGroupContent>
                <SidebarMenu>
                  <SidebarMenuItem>
                    <SidebarMenuButton asChild isActive={location === "/dashboard"}>
                      <Link href="/dashboard" className="font-mono flex items-center gap-3">
                        <LayoutDashboard className="w-4 h-4" />
                        <span>Dashboard</span>
                      </Link>
                    </SidebarMenuButton>
                  </SidebarMenuItem>
                  <SidebarMenuItem>
                    <SidebarMenuButton asChild isActive={location === "/history"}>
                      <Link href="/history" className="font-mono flex items-center gap-3">
                        <History className="w-4 h-4" />
                        <span>History</span>
                      </Link>
                    </SidebarMenuButton>
                  </SidebarMenuItem>
                  <SidebarMenuItem>
                    <SidebarMenuButton asChild isActive={location === "/rewards"}>
                      <Link href="/rewards" className="font-mono flex items-center gap-3">
                        <Gift className="w-4 h-4" />
                        <span>Rewards</span>
                      </Link>
                    </SidebarMenuButton>
                  </SidebarMenuItem>
                  <SidebarMenuItem>
                    <SidebarMenuButton asChild isActive={location === "/redemptions"}>
                      <Link href="/redemptions" className="font-mono flex items-center gap-3">
                        <ClipboardList className="w-4 h-4" />
                        <span>Requisitions</span>
                      </Link>
                    </SidebarMenuButton>
                  </SidebarMenuItem>
                </SidebarMenu>
              </SidebarGroupContent>
            </SidebarGroup>

            {isAdmin && (
              <SidebarGroup>
                <SidebarGroupLabel className="text-xs uppercase tracking-widest text-primary font-mono">Command</SidebarGroupLabel>
                <SidebarGroupContent>
                  <SidebarMenu>
                    <SidebarMenuItem>
                      <SidebarMenuButton asChild isActive={location === "/admin"}>
                        <Link href="/admin" className="font-mono flex items-center gap-3">
                          <Database className="w-4 h-4" />
                          <span>Overview</span>
                        </Link>
                      </SidebarMenuButton>
                    </SidebarMenuItem>
                    <SidebarMenuItem>
                      <SidebarMenuButton asChild isActive={location.startsWith("/admin/users")}>
                        <Link href="/admin/users" className="font-mono flex items-center gap-3">
                          <Users className="w-4 h-4" />
                          <span>Personnel</span>
                        </Link>
                      </SidebarMenuButton>
                    </SidebarMenuItem>
                    <SidebarMenuItem>
                      <SidebarMenuButton asChild isActive={location.startsWith("/admin/fleets")}>
                        <Link href="/admin/fleets" className="font-mono flex items-center gap-3">
                          <Swords className="w-4 h-4" />
                          <span>Fleets</span>
                        </Link>
                      </SidebarMenuButton>
                    </SidebarMenuItem>
                    <SidebarMenuItem>
                      <SidebarMenuButton asChild isActive={location.startsWith("/admin/rewards")}>
                        <Link href="/admin/rewards" className="font-mono flex items-center gap-3">
                          <Gift className="w-4 h-4" />
                          <span>Rewards</span>
                        </Link>
                      </SidebarMenuButton>
                    </SidebarMenuItem>
                    <SidebarMenuItem>
                      <SidebarMenuButton asChild isActive={location.startsWith("/admin/redemptions")}>
                        <Link href="/admin/redemptions" className="font-mono flex items-center gap-3">
                          <Inbox className="w-4 h-4" />
                          <span>Requisitions</span>
                        </Link>
                      </SidebarMenuButton>
                    </SidebarMenuItem>
                    <SidebarMenuItem>
                      <SidebarMenuButton asChild isActive={location.startsWith("/admin/pap")}>
                        <Link href="/admin/pap" className="font-mono flex items-center gap-3">
                          <BookOpen className="w-4 h-4" />
                          <span>PAP Ledger</span>
                        </Link>
                      </SidebarMenuButton>
                    </SidebarMenuItem>
                  </SidebarMenu>
                </SidebarGroupContent>
              </SidebarGroup>
            )}
          </SidebarContent>
          <SidebarFooter className="border-t border-border/50 p-4">
            <div className="flex flex-col gap-4">
              <div className="text-xs font-mono text-muted-foreground flex flex-col gap-1">
                <span className="text-foreground">{user?.eveCharacterName || user?.eveCharacterId || 'Unknown Pilot'}</span>
                <span>{user?.corporationName}</span>
                <span className="text-primary">{user?.totalPap} PAP</span>
              </div>
              <Button 
                variant="outline" 
                className="w-full justify-start text-muted-foreground hover:text-destructive hover:bg-destructive/10 font-mono text-xs border-border/50"
                onClick={handleLogout}
              >
                <LogOut className="w-4 h-4 mr-2" />
                DISCONNECT
              </Button>
            </div>
          </SidebarFooter>
        </Sidebar>
        
        <main className="flex-1 flex flex-col min-h-screen overflow-hidden bg-[radial-gradient(ellipse_at_top,_var(--tw-gradient-stops))] from-background via-background to-black">
          <div className="h-16 border-b border-border/50 flex items-center px-4 shrink-0 bg-background/50 backdrop-blur-md sticky top-0 z-10">
            <SidebarTrigger className="text-primary hover:text-primary/80" />
          </div>
          <div className="flex-1 overflow-y-auto p-6 md:p-8">
            <div className="max-w-6xl mx-auto w-full h-full">
              {children}
            </div>
          </div>
        </main>
      </div>
    </SidebarProvider>
  );
}