import { useMemo, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import {
  useApplyIdentityGroup,
  useGetMe,
  useListCharacters,
  useListIdentityApplications,
  useListIdentityGroups,
} from "@workspace/api-client-react";
import { useTranslation } from "react-i18next";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Textarea } from "@/components/ui/textarea";
import { useToast } from "@/hooks/use-toast";
import { getErrorMessage } from "@/lib/api-error";
import { CheckCircle2, ShieldCheck, XCircle } from "lucide-react";

export function IdentityGroups() {
  const { i18n } = useTranslation();
  const zh = i18n.language.startsWith("zh");
  const tr = (cn: string, en: string) => zh ? cn : en;
  const queryClient = useQueryClient();
  const { toast } = useToast();
  const { data: user } = useGetMe();
  const groups = useListIdentityGroups();
  const characters = useListCharacters();
  const applications = useListIdentityApplications({ mine: true });
  const apply = useApplyIdentityGroup();
  const [characterByGroup, setCharacterByGroup] = useState<Record<number, string>>({});
  const [statementByGroup, setStatementByGroup] = useState<Record<number, string>>({});

  const refresh = async () => {
    await Promise.all([
      queryClient.invalidateQueries({ queryKey: ["/api/identity-groups"] }),
      queryClient.invalidateQueries({ queryKey: ["/api/identity-applications"] }),
      queryClient.invalidateQueries({ queryKey: ["/api/auth/me"] }),
    ]);
  };

  const submitApplication = (groupId: number) => {
    const characterId = Number(characterByGroup[groupId]);
    if (!characterId) {
      toast({ title: tr("请选择申请角色", "Select an applying character"), variant: "destructive" });
      return;
    }
    apply.mutate({ id: groupId, data: { characterId, statement: statementByGroup[groupId] ?? "" } }, {
      onSuccess: async (result) => {
        await refresh();
        const title = result.status === "rejected"
          ? tr("技能审核未通过", "Skill audit failed")
          : result.status === "approved"
            ? tr("技能审核通过，已自动加入", "Skill audit passed and membership granted")
            : tr("申请已进入管理审核", "Application sent for management review");
        toast({
          title,
          description: result.rejectionReason ?? (result.status === "pending_review"
            ? tr("请等待军团管理人员审核。", "Please wait for corporation management review.")
            : undefined),
          variant: result.status === "rejected" ? "destructive" : "default",
        });
      },
      onError: (error) => toast({ title: tr("提交失败", "Submission failed"), description: getErrorMessage(error), variant: "destructive" }),
    });
  };

  const statusText = useMemo(() => ({
    pending_skill_audit: tr("技能审核中", "Skill audit"),
    pending_review: tr("等待管理审核", "Pending management review"),
    needs_information: tr("需要补充", "Needs information"),
    approved: tr("已批准", "Approved"),
    rejected: tr("已拒绝", "Rejected"),
    withdrawn: tr("已撤回", "Withdrawn"),
  }), [zh]);

  return (
    <div className="p-6 space-y-6 overflow-auto">
      <div>
        <h1 className="text-2xl font-bold font-mono tracking-wider">{tr("身份组", "IDENTITY GROUPS")}</h1>
        <p className="text-sm text-muted-foreground mt-1">{tr("作战与能力组自动审核；管理组由军团管理人员审核。", "Combat groups are reviewed automatically; management groups are reviewed by corporation management.")}</p>
      </div>

      <div className="grid gap-4 lg:grid-cols-2">
        {(groups.data ?? []).map((group) => (
          <Card key={group.id} className="border-border/60">
            <CardHeader>
              <div className="flex items-center justify-between gap-3">
                <CardTitle className="flex items-center gap-2"><ShieldCheck className="h-5 w-5 text-primary" />{group.name}</CardTitle>
                <Badge variant={group.category === "combat" ? "default" : "secondary"}>{group.category === "combat" ? tr("作战与能力", "Combat") : tr("管理身份", "Management")}</Badge>
              </div>
              <CardDescription>{group.description || tr("暂无说明", "No description")}</CardDescription>
            </CardHeader>
            <CardContent className="space-y-4">
              {group.isMember ? (
                <div className="flex items-center gap-2 text-sm text-emerald-400"><CheckCircle2 className="h-4 w-4" />{tr("您已加入该身份组", "You are a member")}</div>
              ) : group.latestApplication && ["pending_skill_audit", "pending_review", "needs_information"].includes(group.latestApplication.status) ? (
                <Badge variant="outline">{statusText[group.latestApplication.status]}</Badge>
              ) : (
                <div className="space-y-3">
                  <select className="w-full h-10 rounded-md border border-input bg-background px-3 text-sm" value={characterByGroup[group.id] ?? ""} onChange={(event) => setCharacterByGroup((current) => ({ ...current, [group.id]: event.target.value }))}>
                    <option value="">{tr("选择申请角色", "Select character")}</option>
                    {(characters.data ?? []).filter((character) => character.corporationId === user?.corporationId).map((character) => <option key={character.id} value={character.id}>{character.eveCharacterName}</option>)}
                  </select>
                  <Textarea value={statementByGroup[group.id] ?? ""} onChange={(event) => setStatementByGroup((current) => ({ ...current, [group.id]: event.target.value }))} placeholder={tr("申请说明（可选）", "Application statement (optional)")} />
                  <Button onClick={() => submitApplication(group.id)} disabled={apply.isPending}>{group.category === "combat" ? tr("提交并自动审核技能", "Apply and audit skills") : tr("提交管理身份申请", "Submit management application")}</Button>
                </div>
              )}
            </CardContent>
          </Card>
        ))}
      </div>

      <Card>
        <CardHeader><CardTitle>{tr("我的申请", "My applications")}</CardTitle></CardHeader>
        <CardContent className="space-y-3">
          {(applications.data ?? []).length === 0 ? <p className="text-sm text-muted-foreground">{tr("暂无申请", "No applications")}</p> : (applications.data ?? []).map((application) => (
            <div key={application.id} className="rounded-md border border-border/50 p-4 space-y-2">
              <div className="flex flex-wrap items-center justify-between gap-2"><div className="font-medium">{application.groupName ?? `#${application.groupId}`} · {application.characterName ?? application.applicantName}</div><Badge variant="outline">{statusText[application.status]}</Badge></div>
              {application.statement && <p className="text-sm text-muted-foreground">{application.statement}</p>}
              {application.rejectionReason && <div className="flex gap-2 text-sm text-destructive"><XCircle className="h-4 w-4 mt-0.5" />{application.rejectionReason}</div>}
            </div>
          ))}
        </CardContent>
      </Card>
    </div>
  );
}
