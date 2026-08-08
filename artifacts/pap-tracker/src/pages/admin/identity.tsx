import { useMemo, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import {
  useCreateIdentityGroup,
  useCreateIdentitySkillPlan,
  useListIdentityApplications,
  useListIdentityGroups,
  useListIdentitySkillPlans,
  useReviewIdentityApplication,
  useUpdateIdentityGroup,
  useUpdateIdentitySkillPlan,
  type CorporationSkillPlan,
  type IdentityGroup,
  type RequiredSkill,
} from "@workspace/api-client-react";
import { useTranslation } from "react-i18next";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { useToast } from "@/hooks/use-toast";
import { getErrorMessage } from "@/lib/api-error";
import { CheckCircle2, KeyRound, Pencil, ShieldCheck, UsersRound, XCircle } from "lucide-react";

const PERMISSIONS = [
  ["fleet.manage", "FC与舰队管理", "FC and fleet management"],
  ["recruitment.manage", "招新管理", "Recruitment management"],
  ["diplomacy.manage", "外交管理", "Diplomacy management"],
  ["reimbursement.manage", "补损审核", "Reimbursement review"],
  ["reimbursement.window.manage", "补损窗口管理", "Reimbursement window management"],
  ["activity.manage", "活跃度管理", "Activity management"],
  ["economy.view", "经济查看", "Economy access"],
  ["economy.manage", "经济管理", "Economy management"],
  ["identity.manage", "身份组管理", "Identity management"],
] as const;

type GroupDraft = {
  id: number | null;
  name: string;
  category: "combat" | "management";
  description: string;
  requiredSkills: RequiredSkill[];
  permissions: string[];
  skillPlanIds: number[];
  skillPlanMatchMode: "all" | "any";
  isActive: boolean;
};

type PlanDraft = {
  id: number | null;
  name: string;
  description: string;
  skills: string;
  isActive: boolean;
};

const emptyGroup = (): GroupDraft => ({ id: null, name: "", category: "combat", description: "", requiredSkills: [], permissions: [], skillPlanIds: [], skillPlanMatchMode: "all", isActive: true });
const emptyPlan = (): PlanDraft => ({ id: null, name: "", description: "", skills: "", isActive: true });

export function AdminIdentity() {
  const { i18n } = useTranslation();
  const zh = i18n.language.startsWith("zh");
  const tr = (cn: string, en: string) => zh ? cn : en;
  const { toast } = useToast();
  const queryClient = useQueryClient();
  const groups = useListIdentityGroups({ includeInactive: true });
  const plans = useListIdentitySkillPlans();
  const applications = useListIdentityApplications();
  const createGroup = useCreateIdentityGroup();
  const updateGroup = useUpdateIdentityGroup();
  const createPlan = useCreateIdentitySkillPlan();
  const updatePlan = useUpdateIdentitySkillPlan();
  const review = useReviewIdentityApplication();
  const [groupDraft, setGroupDraft] = useState<GroupDraft>(emptyGroup);
  const [planDraft, setPlanDraft] = useState<PlanDraft>(emptyPlan);
  const [reviewNotes, setReviewNotes] = useState<Record<number, string>>({});
  const [showHistory, setShowHistory] = useState(false);

  const statusText = useMemo(() => ({
    pending_skill_audit: tr("技能审核中", "Skill audit"),
    pending_review: tr("等待审核", "Pending review"),
    needs_information: tr("需要补充", "Needs information"),
    approved: tr("已批准", "Approved"),
    rejected: tr("已拒绝", "Rejected"),
    withdrawn: tr("已撤回", "Withdrawn"),
  }), [zh]);

  const visibleApplications = (applications.data ?? []).filter((application) => showHistory || application.status === "pending_review" || application.status === "needs_information");

  const refreshIdentity = async () => {
    await Promise.all([
      queryClient.invalidateQueries({ queryKey: ["/api/identity-groups"] }),
      queryClient.invalidateQueries({ queryKey: ["/api/identity-applications"] }),
      queryClient.invalidateQueries({ queryKey: ["/api/identity-skill-plans"] }),
    ]);
  };

  const parseSkills = (value: string): RequiredSkill[] | null => {
    if (!value.trim()) return [];
    const result: RequiredSkill[] = [];
    for (const line of value.split("\n").map((item) => item.trim()).filter(Boolean)) {
      const [id, name, level] = line.split(",").map((item) => item.trim());
      const skillId = Number(id);
      const requiredLevel = Number(level);
      if (!Number.isInteger(skillId) || skillId <= 0 || !name || !Number.isInteger(requiredLevel) || requiredLevel < 1 || requiredLevel > 5) return null;
      result.push({ skillId, name, level: requiredLevel });
    }
    return result;
  };

  const skillText = (plan: CorporationSkillPlan) => plan.requiredSkills.map((skill) => `${skill.skillId}, ${skill.name}, ${skill.level}`).join("\n");

  const editGroup = (group: IdentityGroup) => setGroupDraft({
    id: group.id,
    name: group.name,
    category: group.category,
    description: group.description,
    requiredSkills: group.requiredSkills,
    permissions: group.permissions,
    skillPlanIds: group.skillPlans.map((plan) => plan.id),
    skillPlanMatchMode: group.skillPlanMatchMode,
    isActive: group.isActive,
  });

  const saveGroup = () => {
    if (!groupDraft.name.trim()) {
      toast({ title: tr("请输入身份组名称", "Enter an identity-group name"), variant: "destructive" });
      return;
    }
    const data = {
      name: groupDraft.name.trim(),
      category: groupDraft.category,
      description: groupDraft.description.trim(),
      requiredSkills: groupDraft.requiredSkills,
      permissions: groupDraft.permissions,
      skillPlanIds: groupDraft.skillPlanIds,
      skillPlanMatchMode: groupDraft.skillPlanMatchMode,
      isActive: groupDraft.isActive,
    };
    const options = {
      onSuccess: async () => { setGroupDraft(emptyGroup()); await refreshIdentity(); toast({ title: tr("身份组已保存", "Identity group saved") }); },
      onError: (error: unknown) => toast({ title: tr("保存失败", "Save failed"), description: getErrorMessage(error), variant: "destructive" as const }),
    };
    if (groupDraft.id) updateGroup.mutate({ id: groupDraft.id, data }, options);
    else createGroup.mutate({ data }, options);
  };

  const savePlan = () => {
    const requiredSkills = parseSkills(planDraft.skills);
    if (!planDraft.name.trim() || !requiredSkills) {
      toast({ title: tr("请检查方案名称和技能格式", "Check the plan name and skill format"), variant: "destructive" });
      return;
    }
    const data = { name: planDraft.name.trim(), description: planDraft.description.trim(), requiredSkills, isActive: planDraft.isActive };
    const options = {
      onSuccess: async () => { setPlanDraft(emptyPlan()); await refreshIdentity(); toast({ title: tr("技能方案已保存", "Skill plan saved") }); },
      onError: (error: unknown) => toast({ title: tr("保存失败", "Save failed"), description: getErrorMessage(error), variant: "destructive" as const }),
    };
    if (planDraft.id) updatePlan.mutate({ id: planDraft.id, data }, options);
    else createPlan.mutate({ data }, options);
  };

  const reviewApplication = (id: number, status: "approved" | "rejected" | "needs_information") => {
    const notes = reviewNotes[id]?.trim() ?? "";
    if (status !== "approved" && !notes) {
      toast({ title: tr("拒绝或要求补充时必须填写审核说明", "Review notes are required for rejection or more information"), variant: "destructive" });
      return;
    }
    review.mutate({ id, data: { status, reviewerNotes: notes || tr("审核通过，权限已自动授予", "Approved; permissions granted automatically") } }, {
      onSuccess: async () => { await refreshIdentity(); toast({ title: status === "approved" ? tr("已批准并授予权限", "Approved and permissions granted") : tr("审核结果已保存", "Review saved") }); },
      onError: (error) => toast({ title: tr("审核失败", "Review failed"), description: getErrorMessage(error), variant: "destructive" }),
    });
  };

  return (
    <div className="p-6 space-y-6 overflow-auto">
      <div><h1 className="flex items-center gap-2 text-2xl font-bold font-mono tracking-wider"><ShieldCheck className="h-6 w-6 text-primary" />{tr("身份组审核与管理", "IDENTITY REVIEW & MANAGEMENT")}</h1><p className="mt-1 text-sm text-muted-foreground">{tr("集中审核管理身份申请、配置自动授予权限，并复用军团技能方案。", "Review management applications, configure automatically granted permissions, and reuse corporation skill plans.")}</p></div>

      <Card>
        <CardHeader className="gap-3 sm:flex-row sm:items-center sm:justify-between"><div><CardTitle className="flex items-center gap-2"><UsersRound className="h-5 w-5" />{tr("管理身份申请审核", "Management application review")}</CardTitle><CardDescription>{tr("批准后系统立即创建身份组成员关系，相应权限无需再次手动配置。", "Approval immediately creates membership and grants the group's permissions.")}</CardDescription></div><Button variant="outline" onClick={() => setShowHistory((value) => !value)}>{showHistory ? tr("只看待审核", "Pending only") : tr("查看审核历史", "Show history")}</Button></CardHeader>
        <CardContent className="space-y-3">
          {visibleApplications.length === 0 ? <p className="text-sm text-muted-foreground">{tr("暂无待审核申请", "No applications awaiting review")}</p> : visibleApplications.map((application) => (
            <div key={application.id} className="rounded-md border border-border/50 p-4 space-y-3">
              <div className="flex flex-wrap items-center justify-between gap-2"><div className="font-medium">{application.groupName ?? `#${application.groupId}`} · {application.characterName ?? application.applicantName}</div><Badge variant="outline">{statusText[application.status]}</Badge></div>
              {application.statement && <p className="text-sm text-muted-foreground">{application.statement}</p>}
              {application.skillAudit?.plans?.map((plan) => <div key={`${application.id}-${plan.planId}`} className="rounded border border-border/40 p-2 text-xs"><span className={plan.passed ? "text-emerald-400" : "text-destructive"}>{plan.passed ? "✓" : "✗"} {plan.name}</span><span className="ml-2 text-muted-foreground">{plan.skills.map((skill) => `${skill.name} ${skill.trainedLevel}/${skill.level}`).join(" · ")}</span></div>)}
              {!!application.groupPermissions?.length && <div className="flex flex-wrap items-center gap-2 text-sm"><KeyRound className="h-4 w-4 text-primary" />{application.groupPermissions.map((permission) => <Badge key={permission} variant="secondary">{PERMISSIONS.find(([key]) => key === permission)?.[zh ? 1 : 2] ?? permission}</Badge>)}</div>}
              {(application.status === "pending_review" || application.status === "needs_information") && <><Textarea placeholder={tr("审核说明", "Review notes")} value={reviewNotes[application.id] ?? ""} onChange={(event) => setReviewNotes((current) => ({ ...current, [application.id]: event.target.value }))} /><div className="flex flex-wrap gap-2"><Button size="sm" onClick={() => reviewApplication(application.id, "approved")}><CheckCircle2 className="mr-2 h-4 w-4" />{tr("批准并授予权限", "Approve and grant")}</Button><Button size="sm" variant="outline" onClick={() => reviewApplication(application.id, "needs_information")}>{tr("要求补充", "Request information")}</Button><Button size="sm" variant="destructive" onClick={() => reviewApplication(application.id, "rejected")}><XCircle className="mr-2 h-4 w-4" />{tr("拒绝", "Reject")}</Button></div></>}
            </div>
          ))}
        </CardContent>
      </Card>

      <Card>
        <CardHeader><CardTitle>{groupDraft.id ? tr("编辑身份组", "Edit identity group") : tr("创建身份组", "Create identity group")}</CardTitle><CardDescription>{tr("黑隐等特殊组可选择多套方案并设置为“满足任意一套”。", "Special groups such as Black Ops can attach multiple plans and use match-any mode.")}</CardDescription></CardHeader>
        <CardContent className="grid gap-4 md:grid-cols-2">
          <div className="space-y-2"><Label>{tr("名称", "Name")}</Label><Input value={groupDraft.name} onChange={(event) => setGroupDraft({ ...groupDraft, name: event.target.value })} /></div>
          <div className="space-y-2"><Label>{tr("类别", "Category")}</Label><select className="h-10 w-full rounded-md border border-input bg-background px-3" value={groupDraft.category} onChange={(event) => setGroupDraft({ ...groupDraft, category: event.target.value as GroupDraft["category"] })}><option value="combat">{tr("作战与能力（技能通过后自动加入）", "Combat (auto-granted after skills pass)")}</option><option value="management">{tr("管理身份（需要人工审核）", "Management (manual review)")}</option></select></div>
          <div className="space-y-2 md:col-span-2"><Label>{tr("说明", "Description")}</Label><Textarea value={groupDraft.description} onChange={(event) => setGroupDraft({ ...groupDraft, description: event.target.value })} /></div>
          <div className="space-y-2 md:col-span-2"><Label>{tr("套用军团技能方案", "Apply corporation skill plans")}</Label><div className="grid gap-2 rounded-md border border-border/50 p-3 md:grid-cols-2">{(plans.data ?? []).map((plan) => <label key={plan.id} className="flex items-start gap-2 text-sm"><input type="checkbox" className="mt-1" checked={groupDraft.skillPlanIds.includes(plan.id)} onChange={(event) => setGroupDraft({ ...groupDraft, skillPlanIds: event.target.checked ? [...groupDraft.skillPlanIds, plan.id] : groupDraft.skillPlanIds.filter((id) => id !== plan.id) })} /><span>{plan.name}{!plan.isActive && <Badge className="ml-2" variant="outline">{tr("停用", "Inactive")}</Badge>}<span className="block text-xs text-muted-foreground">{plan.requiredSkills.length} {tr("项技能", "skills")}</span></span></label>)}</div></div>
          <div className="space-y-2"><Label>{tr("多方案规则", "Multiple-plan rule")}</Label><select className="h-10 w-full rounded-md border border-input bg-background px-3" value={groupDraft.skillPlanMatchMode} onChange={(event) => setGroupDraft({ ...groupDraft, skillPlanMatchMode: event.target.value as GroupDraft["skillPlanMatchMode"] })}><option value="all">{tr("需要满足全部方案", "Must satisfy every plan")}</option><option value="any">{tr("满足任意一套即可", "Any one plan is enough")}</option></select></div>
          <label className="flex items-center gap-2 self-end pb-2 text-sm"><input type="checkbox" checked={groupDraft.isActive} onChange={(event) => setGroupDraft({ ...groupDraft, isActive: event.target.checked })} />{tr("身份组启用", "Identity group active")}</label>
          <div className="space-y-2 md:col-span-2"><Label>{tr("批准后自动授予的权限", "Permissions granted after approval")}</Label><div className="grid gap-2 rounded-md border border-border/50 p-3 md:grid-cols-2">{PERMISSIONS.map(([permission, cn, en]) => <label key={permission} className="flex items-center gap-2 text-sm"><input type="checkbox" checked={groupDraft.permissions.includes(permission)} onChange={(event) => setGroupDraft({ ...groupDraft, permissions: event.target.checked ? [...groupDraft.permissions, permission] : groupDraft.permissions.filter((item) => item !== permission) })} />{tr(cn, en)}</label>)}</div></div>
          <div className="flex gap-2 md:col-span-2"><Button onClick={saveGroup}>{tr("保存身份组", "Save identity group")}</Button>{groupDraft.id && <Button variant="outline" onClick={() => setGroupDraft(emptyGroup())}>{tr("取消编辑", "Cancel editing")}</Button>}</div>
          <div className="space-y-2 md:col-span-2 border-t border-border/50 pt-4"><Label>{tr("现有身份组", "Existing identity groups")}</Label><div className="grid gap-2 md:grid-cols-2">{(groups.data ?? []).map((group) => <div key={group.id} className="flex items-center justify-between rounded-md border border-border/50 p-3"><div><div className="font-medium">{group.name} {!group.isActive && <Badge variant="outline">{tr("停用", "Inactive")}</Badge>}</div><div className="text-xs text-muted-foreground">{group.skillPlans.map((plan) => plan.name).join(" · ") || tr("未套用方案", "No plans")}</div></div><Button size="sm" variant="outline" onClick={() => editGroup(group)}><Pencil className="mr-1 h-3 w-3" />{tr("编辑", "Edit")}</Button></div>)}</div></div>
        </CardContent>
      </Card>

      <Card>
        <CardHeader><CardTitle>{planDraft.id ? tr("编辑技能方案", "Edit skill plan") : tr("军团技能方案", "Corporation skill plans")}</CardTitle><CardDescription>{tr("技能方案可被多个身份组直接套用；每行填写：技能ID, 技能名称, 最低等级。", "Skill plans can be reused by multiple identity groups. One line per skill ID, name, and minimum level.")}</CardDescription></CardHeader>
        <CardContent className="grid gap-4 md:grid-cols-2">
          <div className="space-y-2"><Label>{tr("方案名称", "Plan name")}</Label><Input value={planDraft.name} onChange={(event) => setPlanDraft({ ...planDraft, name: event.target.value })} /></div>
          <label className="flex items-center gap-2 self-end pb-2 text-sm"><input type="checkbox" checked={planDraft.isActive} onChange={(event) => setPlanDraft({ ...planDraft, isActive: event.target.checked })} />{tr("方案启用", "Plan active")}</label>
          <div className="space-y-2 md:col-span-2"><Label>{tr("说明", "Description")}</Label><Input value={planDraft.description} onChange={(event) => setPlanDraft({ ...planDraft, description: event.target.value })} /></div>
          <div className="space-y-2 md:col-span-2"><Label>{tr("技能清单", "Skills")}</Label><Textarea rows={6} placeholder="28656, Black Ops, 4" value={planDraft.skills} onChange={(event) => setPlanDraft({ ...planDraft, skills: event.target.value })} /></div>
          <div className="flex gap-2 md:col-span-2"><Button onClick={savePlan}>{tr("保存技能方案", "Save skill plan")}</Button>{planDraft.id && <Button variant="outline" onClick={() => setPlanDraft(emptyPlan())}>{tr("取消编辑", "Cancel editing")}</Button>}</div>
          <div className="space-y-2 md:col-span-2 border-t border-border/50 pt-4"><div className="grid gap-2 md:grid-cols-2">{(plans.data ?? []).map((plan) => <div key={plan.id} className="flex items-center justify-between rounded-md border border-border/50 p-3"><div><div className="font-medium">{plan.name} {!plan.isActive && <Badge variant="outline">{tr("停用", "Inactive")}</Badge>}</div><div className="text-xs text-muted-foreground">{plan.requiredSkills.map((skill) => `${skill.name} Lv.${skill.level}`).join(" · ") || tr("无技能", "No skills")}</div></div><Button size="sm" variant="outline" onClick={() => setPlanDraft({ id: plan.id, name: plan.name, description: plan.description, skills: skillText(plan), isActive: plan.isActive })}><Pencil className="mr-1 h-3 w-3" />{tr("编辑", "Edit")}</Button></div>)}</div></div>
        </CardContent>
      </Card>
    </div>
  );
}
