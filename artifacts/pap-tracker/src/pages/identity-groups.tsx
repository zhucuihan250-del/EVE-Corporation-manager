import { useMemo, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import {
  useApplyIdentityGroup,
  useGetMe,
  useListCharacters,
  useListIdentityApplications,
  useListIdentityGroups,
  type IdentityGroup,
} from "@workspace/api-client-react";
import { useTranslation } from "react-i18next";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Textarea } from "@/components/ui/textarea";
import { useToast } from "@/hooks/use-toast";
import { getErrorMessage } from "@/lib/api-error";
import { CheckCircle2, KeyRound, ShieldCheck, XCircle } from "lucide-react";

const PERMISSION_LABELS: Record<string, [string, string]> = {
  "activity.manage": ["活跃度管理", "Activity management"],
  "diplomacy.manage": ["外交管理", "Diplomacy management"],
  "economy.manage": ["经济管理", "Economy management"],
  "economy.view": ["经济查看", "Economy access"],
  "fleet.manage": ["FC与舰队管理", "FC and fleet management"],
  "identity.manage": ["身份组管理", "Identity management"],
  "recruitment.manage": ["招新管理", "Recruitment management"],
  "reimbursement.manage": ["补损审核", "Reimbursement review"],
  "reimbursement.window.manage": ["补损窗口管理", "Reimbursement window management"],
};

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
            ? tr("管理身份审批通过后，系统会立即授予对应权限。", "The configured permissions will be granted immediately after approval.")
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

  const renderSkillPlans = (group: IdentityGroup) => {
    if (!group.skillPlans.length) {
      return group.requiredSkills.length ? (
        <div className="space-y-1">
          {group.requiredSkills.map((skill) => (
            <div key={skill.skillId} className="flex justify-between text-muted-foreground"><span>{skill.name}</span><span>Lv. {skill.level}</span></div>
          ))}
        </div>
      ) : <span className="text-muted-foreground">{tr("暂未配置技能门槛", "No skill threshold configured")}</span>;
    }
    return (
      <div className="space-y-3">
        <Badge variant="outline">
          {group.skillPlanMatchMode === "any" ? tr("满足任意一套方案", "Match any one plan") : tr("需要满足全部方案", "Match all plans")}
        </Badge>
        {group.skillPlans.map((plan) => (
          <div key={plan.id} className="rounded border border-border/40 p-2">
            <div className="font-medium text-foreground">{plan.name}</div>
            {plan.requiredSkills.map((skill) => (
              <div key={skill.skillId} className="mt-1 flex justify-between text-muted-foreground"><span>{skill.name}</span><span>Lv. {skill.level}</span></div>
            ))}
          </div>
        ))}
      </div>
    );
  };

  return (
    <div className="p-6 space-y-6 overflow-auto">
      <div>
        <h1 className="text-2xl font-bold font-mono tracking-wider">{tr("身份组", "IDENTITY GROUPS")}</h1>
        <p className="text-sm text-muted-foreground mt-1">{tr("作战与能力组自动审核并授予身份；管理组通过人工审核后立即获得对应权限。", "Combat groups are granted after automatic skill checks; management-group permissions are granted immediately after review.")}</p>
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
              <div className="rounded-md border border-border/50 bg-muted/20 p-3 text-sm">
                <div className="font-medium mb-2">{tr("技能方案", "Skill plans")}</div>
                {renderSkillPlans(group)}
              </div>
              {group.permissions.length > 0 && (
                <div className="rounded-md border border-primary/30 bg-primary/5 p-3 text-sm">
                  <div className="mb-2 flex items-center gap-2 font-medium"><KeyRound className="h-4 w-4 text-primary" />{tr("批准后自动获得", "Granted automatically after approval")}</div>
                  <div className="flex flex-wrap gap-2">{group.permissions.map((permission) => <Badge key={permission} variant="secondary">{PERMISSION_LABELS[permission]?.[zh ? 0 : 1] ?? permission}</Badge>)}</div>
                </div>
              )}
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
              {application.skillAudit?.plans?.map((plan) => <div key={`${application.id}-${plan.planId}`} className="text-xs text-muted-foreground">{plan.name}: {plan.passed ? "✓" : "✗"} · {plan.skills.map((skill) => `${skill.name} ${skill.trainedLevel}/${skill.level}`).join(" · ")}</div>)}
              {application.skillAudit && !application.skillAudit.plans?.length && <div className="text-xs text-muted-foreground">{application.skillAudit.skills.map((skill) => `${skill.name} ${skill.trainedLevel}/${skill.level}${skill.passed ? " ✓" : " ✗"}`).join(" · ") || tr("无技能门槛", "No skill threshold")}</div>}
              {application.rejectionReason && <div className="flex gap-2 text-sm text-destructive"><XCircle className="h-4 w-4 mt-0.5" />{application.rejectionReason}</div>}
            </div>
          ))}
        </CardContent>
      </Card>
    </div>
  );
}
