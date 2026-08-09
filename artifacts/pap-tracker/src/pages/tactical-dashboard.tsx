import { useGetTacticalGroupDashboard } from "@workspace/api-client-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { getErrorMessage } from "@/lib/api-error";
import { Activity, Loader2, ReceiptText, ShieldCheck, Swords, Users } from "lucide-react";
import { useTranslation } from "react-i18next";
import { Link, useParams } from "wouter";

export function TacticalDashboard() {
  const { i18n } = useTranslation();
  const tr = (cn: string, en: string) => i18n.language.startsWith("zh") ? cn : en;
  const params = useParams<{ id: string }>();
  const identityGroupId = Number(params.id);
  const dashboard = useGetTacticalGroupDashboard(identityGroupId);

  if (dashboard.isLoading) {
    return <div className="flex items-center gap-2 p-6 text-sm text-muted-foreground"><Loader2 className="h-5 w-5 animate-spin" />{tr("正在读取战术面板…", "Loading tactical dashboard…")}</div>;
  }
  if (dashboard.isError || !dashboard.data) {
    return <div className="p-6 text-sm text-destructive">{getErrorMessage(dashboard.error)}</div>;
  }
  const data = dashboard.data;

  return (
    <div className="space-y-6 p-6">
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div>
          <div className="mb-1 flex items-center gap-2 text-violet-300"><ShieldCheck className="h-5 w-5" /><span className="font-mono text-xs uppercase tracking-[0.25em]">{tr("战术身份组", "TACTICAL IDENTITY GROUP")}</span></div>
          <h1 className="text-2xl font-bold font-mono tracking-wider">{data.group.name}</h1>
          <p className="mt-1 max-w-3xl text-sm text-muted-foreground">{data.group.description || tr("暂无身份组说明", "No group description")}</p>
        </div>
        <Button asChild><Link href={`/tactical/${identityGroupId}/reimbursements`}><ReceiptText className="mr-2 h-4 w-4" />{tr("进入专属补损", "Dedicated reimbursement")}</Link></Button>
      </div>

      <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
        <Metric label={tr("身份组成员", "Group members")} value={data.memberCount} icon={<Users className="h-4 w-4" />} />
        <Metric label={tr("当前活跃舰队", "Active fleets")} value={data.activeFleetCount} icon={<Activity className="h-4 w-4 text-emerald-400" />} />
        <Metric label={tr("我参加的舰队", "My fleets")} value={data.myFleetCount} icon={<Swords className="h-4 w-4" />} />
        <Metric label={tr("我的身份组PAP", "My group PAP")} value={data.myPap} icon={<ShieldCheck className="h-4 w-4 text-violet-300" />} />
      </div>

      <div className="grid gap-4 sm:grid-cols-2">
        <Card><CardHeader className="pb-2"><CardDescription>{tr("专属补损处理中", "Open dedicated claims")}</CardDescription></CardHeader><CardContent className="text-3xl font-bold text-amber-400">{data.openClaimCount}</CardContent></Card>
        <Card><CardHeader className="pb-2"><CardDescription>{tr("专属补损已打款", "Paid dedicated claims")}</CardDescription></CardHeader><CardContent className="text-3xl font-bold text-emerald-400">{data.paidClaimCount}</CardContent></Card>
      </div>

      <Card>
        <CardHeader><CardTitle>{tr("身份组舰队", "Tactical group fleets")}</CardTitle><CardDescription>{tr(`共记录 ${data.totalFleetCount} 支舰队，最近记录如下。`, `${data.totalFleetCount} fleets recorded; most recent are shown below.`)}</CardDescription></CardHeader>
        <CardContent className="p-0">
          <Table>
            <TableHeader><TableRow><TableHead>{tr("舰队", "Fleet")}</TableHead><TableHead>{tr("FC", "FC")}</TableHead><TableHead>{tr("职能", "Function")}</TableHead><TableHead>{tr("参与人数", "Pilots")}</TableHead><TableHead>{tr("状态", "Status")}</TableHead></TableRow></TableHeader>
            <TableBody>
              {data.recentFleets.map((fleet) => <TableRow key={fleet.id}><TableCell className="font-medium">{fleet.name}<div className="text-xs text-muted-foreground">{new Date(fleet.startedAt ?? fleet.createdAt).toLocaleString()}</div></TableCell><TableCell>{fleet.fleetCommander}</TableCell><TableCell>{fleet.fleetFunction}</TableCell><TableCell>{fleet.participantCount ?? 0}</TableCell><TableCell><Badge variant={fleet.isActive ? "default" : "secondary"}>{fleet.isActive ? tr("进行中", "Active") : tr("已结束", "Concluded")}</Badge></TableCell></TableRow>)}
              {data.recentFleets.length === 0 && <TableRow><TableCell colSpan={5} className="py-10 text-center text-muted-foreground">{tr("暂未登记身份组舰队", "No tactical group fleets registered yet")}</TableCell></TableRow>}
            </TableBody>
          </Table>
        </CardContent>
      </Card>
    </div>
  );
}

function Metric({ label, value, icon }: { label: string; value: number; icon: React.ReactNode }) {
  return <Card><CardHeader className="pb-2"><CardDescription className="flex items-center justify-between">{label}{icon}</CardDescription></CardHeader><CardContent className="text-3xl font-bold">{value}</CardContent></Card>;
}
