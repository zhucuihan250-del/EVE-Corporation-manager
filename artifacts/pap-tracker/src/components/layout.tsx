import type { ElementType, ReactNode } from "react";
import { Button } from "@/components/ui/button";
import { useGetMe, useLogout } from "@workspace/api-client-react";
import { Link, useLocation } from "wouter";
import { useTranslation } from "react-i18next";
import {
  Activity, BookOpen, BrainCircuit, ClipboardList, Crosshair, Database, Gift, Handshake,
  History, Inbox, Languages, Landmark, LayoutDashboard, LogOut, Radio, ReceiptText,
  LockKeyhole, ShieldAlert, ShieldCheck, Swords, UserSquare2, Users, Wrench,
} from "lucide-react";
import {
  Sidebar, SidebarContent, SidebarFooter, SidebarGroup, SidebarGroupContent,
  SidebarGroupLabel, SidebarHeader, SidebarMenu, SidebarMenuButton, SidebarMenuItem,
  SidebarProvider, SidebarTrigger,
} from "@/components/ui/sidebar";
import i18n from "@/i18n";

type NavItem = { href: string; label: string; icon: ElementType; exact?: boolean; disabled?: boolean };

export function Layout({ children }: { children: ReactNode }) {
  const { t } = useTranslation();
  const zh = i18n.language.startsWith("zh");
  const tr = (cn: string, en: string) => zh ? cn : en;
  const { data: user } = useGetMe();
  const logoutMutation = useLogout();
  const [location, setLocation] = useLocation();
  const modules = user?.modules;

  const ROLE_LEVELS = ["member", "fc", "admin", "controller"] as const;
  type Role = (typeof ROLE_LEVELS)[number];
  const hasRole = (minRole: Role) => user ? ROLE_LEVELS.indexOf(user.role as Role) >= ROLE_LEVELS.indexOf(minRole) : false;
  const isAdmin = hasRole("admin");
  const isFc = hasRole("fc");
  const isController = hasRole("controller");
  const isFleetManager = isFc || Boolean(user?.permissions.includes("fleet.manage"));
  const isActivityManager = isAdmin || Boolean(user?.permissions.includes("activity.manage"));
  const isIdentityManager = isAdmin || Boolean(user?.permissions.includes("identity.manage"));

  const serviceItems: NavItem[] = [];
  if (modules?.pap) {
    serviceItems.push(
      { href: "/dashboard", label: t("nav.dashboard"), icon: LayoutDashboard, exact: true },
      { href: "/history", label: t("nav.history"), icon: History },
    );
  }
  if (modules?.identity) serviceItems.push({ href: "/identity-groups", label: tr("身份组", "Identity groups"), icon: ShieldCheck });
  if (modules?.reimbursement) serviceItems.push({
    href: "/reimbursements",
    label: tr("补损", "Reimbursement"),
    icon: ReceiptText,
    disabled: user?.reimbursementOpen === false,
  });
  if (modules?.diplomacy) serviceItems.push({ href: "/diplomacy", label: tr("外交", "Diplomacy"), icon: Handshake });
  if (modules?.fleet) {
    serviceItems.push(
      { href: "/battle-reports", label: t("nav.battleReports"), icon: Crosshair },
      { href: "/fitting", label: t("nav.fitting"), icon: Wrench },
    );
  }
  if (modules?.pap) {
    serviceItems.push(
      { href: "/rewards", label: t("nav.rewards"), icon: Gift },
      { href: "/redemptions", label: t("nav.requisitions"), icon: ClipboardList },
      { href: "/characters", label: t("nav.characters"), icon: UserSquare2 },
    );
  }

  const commandItems: NavItem[] = [];
  if (isAdmin && modules?.pap) {
    commandItems.push(
      { href: "/admin", label: t("nav.overview"), icon: Database, exact: true },
      { href: "/admin/users", label: t("nav.personnel"), icon: Users },
    );
  }
  if (isActivityManager && modules?.pap) {
    commandItems.push({ href: "/admin/activity", label: tr("活跃度查询", "Activity tracking"), icon: Activity });
  }
  if (isIdentityManager && modules?.identity) {
    commandItems.push({ href: "/admin/identity", label: tr("身份组审核", "Identity review"), icon: ShieldCheck });
  }
  if (isFleetManager && modules?.fleet) {
    commandItems.push(
      { href: "/admin/fleets", label: t("nav.fleets"), icon: Swords },
      { href: "/command/battle-replays", label: t("nav.battleReplay"), icon: BrainCircuit },
      { href: "/admin/announcements", label: t("nav.announcements"), icon: Radio },
    );
  }
  if (isAdmin && modules?.pap) {
    commandItems.push(
      { href: "/admin/rewards", label: t("nav.rewards"), icon: Gift },
      { href: "/admin/redemptions", label: t("nav.requisitions"), icon: Inbox },
      { href: "/admin/pap", label: t("nav.papLedger"), icon: BookOpen },
    );
  }

  const directorItems: NavItem[] = [];
  if (user?.permissions.includes("economy.view") && modules?.economy) {
    directorItems.push({ href: "/economy", label: tr("军团经济", "Corporation economy"), icon: Landmark });
  }
  if (user?.permissions.includes("reimbursement.window.manage") && modules?.reimbursement) {
    directorItems.push({ href: "/reimbursement-settings", label: tr("补损窗口", "Reimbursement window"), icon: LockKeyhole });
  }

  const renderItems = (items: NavItem[]) => items.map(({ href, label, icon: Icon, exact, disabled }) => {
    if (disabled) {
      return (
        <SidebarMenuItem key={href}>
          <SidebarMenuButton disabled className="cursor-not-allowed text-muted-foreground opacity-40" tooltip={tr("补损窗口已关闭", "Reimbursement window is closed")}>
            <Icon className="w-4 h-4" /><span>{label}</span><span className="ml-auto text-[10px]">{tr("已关闭", "Closed")}</span>
          </SidebarMenuButton>
        </SidebarMenuItem>
      );
    }
    return (
      <SidebarMenuItem key={href}>
        <SidebarMenuButton asChild isActive={exact ? location === href : location === href || location.startsWith(`${href}/`)}>
          <Link href={href} className="font-mono flex items-center gap-3"><Icon className="w-4 h-4" /><span>{label}</span></Link>
        </SidebarMenuButton>
      </SidebarMenuItem>
    );
  });

  return (
    <SidebarProvider>
      <div className="flex min-h-screen w-full bg-background dark">
        <Sidebar className="border-r border-border/50 bg-sidebar/50 backdrop-blur-xl">
          <SidebarHeader className="min-h-16 flex justify-center px-4 py-3 border-b border-border/50">
            <div className="flex items-center gap-2 font-mono text-primary font-bold tracking-wider"><ShieldAlert className="w-5 h-5 shrink-0" /><div className="min-w-0"><div className="truncate">CORP MANAGER</div><div className="truncate text-[10px] font-normal text-muted-foreground tracking-normal">{user?.corporationName}</div></div></div>
          </SidebarHeader>
          <SidebarContent>
            <SidebarGroup>
              <SidebarGroupLabel className="text-xs uppercase tracking-widest text-muted-foreground font-mono">{tr("功能", "Services")}</SidebarGroupLabel>
              <SidebarGroupContent><SidebarMenu>{renderItems(serviceItems)}</SidebarMenu></SidebarGroupContent>
            </SidebarGroup>

            {directorItems.length > 0 && (
              <SidebarGroup>
                <SidebarGroupLabel className="text-xs uppercase tracking-widest text-emerald-400 font-mono">{tr("总监专区", "Director")}</SidebarGroupLabel>
                <SidebarGroupContent><SidebarMenu>{renderItems(directorItems)}</SidebarMenu></SidebarGroupContent>
              </SidebarGroup>
            )}

            {commandItems.length > 0 && (
              <SidebarGroup>
                <SidebarGroupLabel className="text-xs uppercase tracking-widest text-primary font-mono">{t("nav.command")}{isController && <span className="ml-1 text-yellow-400">★</span>}</SidebarGroupLabel>
                <SidebarGroupContent><SidebarMenu>{renderItems(commandItems)}</SidebarMenu></SidebarGroupContent>
              </SidebarGroup>
            )}
          </SidebarContent>
          <SidebarFooter className="border-t border-border/50 p-4">
            <div className="flex flex-col gap-4">
              <div className="text-xs font-mono text-muted-foreground flex flex-col gap-1"><span className="text-foreground">{user?.eveCharacterName || user?.eveCharacterId || t("nav.unknownPilot")}</span><span>{user?.corporationName}</span>{modules?.pap && <span className="text-primary">{user?.totalPap} PAP</span>}</div>
              <Button variant="outline" className="w-full justify-start text-muted-foreground hover:text-primary hover:bg-primary/10 font-mono text-xs border-border/50" onClick={() => { const next = i18n.language === "en" ? "zh" : "en"; i18n.changeLanguage(next); localStorage.setItem("pap-lang", next); }}><Languages className="w-4 h-4 mr-2" />{i18n.language === "en" ? "中文" : "English"}</Button>
              <Button variant="outline" className="w-full justify-start text-muted-foreground hover:text-destructive hover:bg-destructive/10 font-mono text-xs border-border/50" onClick={() => logoutMutation.mutate(undefined, { onSuccess: () => setLocation("/") })}><LogOut className="w-4 h-4 mr-2" />{t("nav.disconnect")}</Button>
            </div>
          </SidebarFooter>
        </Sidebar>
        <main className="flex-1 flex flex-col min-h-screen overflow-hidden bg-[radial-gradient(ellipse_at_top,_var(--tw-gradient-stops))] from-background via-background to-black">
          <div className="h-16 border-b border-border/50 flex items-center px-4 shrink-0 bg-background/50 backdrop-blur-md sticky top-0 z-10"><SidebarTrigger className="text-primary hover:text-primary/80" /></div>
          <div className="flex-1 overflow-y-auto p-0 md:p-2"><div className="max-w-6xl mx-auto w-full min-h-full">{children}</div></div>
        </main>
      </div>
    </SidebarProvider>
  );
}
