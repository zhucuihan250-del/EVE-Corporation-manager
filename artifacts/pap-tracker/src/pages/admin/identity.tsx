import { useMemo, useState, type ClipboardEvent } from "react";
import { useQueryClient } from "@tanstack/react-query";
import {
  useCreateIdentityGroup,
  useCreateIdentitySkillPlan,
  useDeleteIdentityGroup,
  useDeleteIdentitySkillPlan,
  useImportIdentitySkillPlan,
  useListIdentityApplications,
  useListIdentityGroupMembers,
  useListIdentityGroups,
  useListIdentitySkillPlans,
  useReviewIdentityApplication,
  useSetIdentityGroupApplicationWindow,
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
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { useToast } from "@/hooks/use-toast";
import { getErrorMessage } from "@/lib/api-error";
import { CheckCircle2, ClipboardPaste, KeyRound, Loader2, LockKeyhole, LockOpen, Pencil, ShieldCheck, Trash2, UsersRound, XCircle } from "lucide-react";

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
  applicationOpen: boolean;
  isActive: boolean;
};

type PlanDraft = {
  id: number | null;
  name: string;
  description: string;
  skills: string;
  parsedText: string;
  parsedSkills: RequiredSkill[];
  unresolvedLines: string[];
  isActive: boolean;
};

type DeleteTarget = {
  kind: "group" | "plan";
  id: number;
  name: string;
};

const emptyGroup = (): GroupDraft => ({ id: null, name: "", category: "combat", description: "", requiredSkills: [], permissions: [], skillPlanIds: [], skillPlanMatchMode: "all", applicationOpen: true, isActive: true });
const emptyPlan = (): PlanDraft => ({ id: null, name: "", description: "", skills: "", parsedText: "", parsedSkills: [], unresolvedLines: [], isActive: true });

export function AdminIdentity() {
  const { i18n } = useTranslation();
  const zh = i18n.language.startsWith("zh");
  const tr = (cn: string, en: string) => zh ? cn : en;
  const { toast } = useToast();
  const queryClient = useQueryClient();
  const groups = useListIdentityGroups({ includeInactive: true });
  const plans = useListIdentitySkillPlans();
  const applications = useListIdentityApplications();
  const [selectedGroupId, setSelectedGroupId] = useState<number | null>(null);
  const groupMembers = useListIdentityGroupMembers(selectedGroupId ?? 0, {
    query: { enabled: selectedGroupId !== null, queryKey: ["/api/identity-groups", selectedGroupId, "members"] },
  });
  const createGroup = useCreateIdentityGroup();
  const updateGroup = useUpdateIdentityGroup();
  const deleteGroup = useDeleteIdentityGroup();
  const setApplicationWindow = useSetIdentityGroupApplicationWindow();
  const importPlan = useImportIdentitySkillPlan();
  const createPlan = useCreateIdentitySkillPlan();
  const updatePlan = useUpdateIdentitySkillPlan();
  const deletePlan = useDeleteIdentitySkillPlan();
  const review = useReviewIdentityApplication();
  const [groupDraft, setGroupDraft] = useState<GroupDraft>(emptyGroup);
  const [planDraft, setPlanDraft] = useState<PlanDraft>(emptyPlan);
  const [reviewNotes, setReviewNotes] = useState<Record<number, string>>({});
  const [showHistory, setShowHistory] = useState(false);
  const [deleteTarget, setDeleteTarget] = useState<DeleteTarget | null>(null);
  const selectedGroup = (groups.data ?? []).find((group) => group.id === selectedGroupId) ?? null;

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
      queryClient.invalidateQueries({ queryKey: ["/api/auth/me"] }),
    ]);
  };

  const skillText = (plan: CorporationSkillPlan) => plan.requiredSkills.map((skill) => `${skill.skillId}, ${skill.name}, ${skill.level}`).join("\n");

  const parseSkillText = async (text: string, showSuccess = true): Promise<RequiredSkill[] | null> => {
    try {
      const result = await importPlan.mutateAsync({ data: { text } });
      setPlanDraft((current) => current.skills === text ? {
        ...current,
        parsedText: text,
        parsedSkills: result.requiredSkills,
        unresolvedLines: result.unresolvedLines,
      } : current);
      if (result.unresolvedLines.length) {
        toast({
          title: tr("有技能行未能识别", "Some skill lines could not be recognized"),
          description: tr("请检查下方标出的内容后再保存。", "Review the highlighted lines before saving."),
          variant: "destructive",
        });
        return null;
      }
      if (showSuccess) {
        toast({
          title: tr(`已读取 ${result.requiredSkills.length} 项技能`, `Imported ${result.requiredSkills.length} skills`),
          description: tr("重复等级已自动合并为最高要求。", "Repeated levels were merged into the highest requirement."),
        });
      }
      return result.requiredSkills;
    } catch (error) {
      toast({ title: tr("技能方案读取失败", "Skill plan import failed"), description: getErrorMessage(error), variant: "destructive" });
      return null;
    }
  };

  const handleSkillPaste = (event: ClipboardEvent<HTMLTextAreaElement>) => {
    const pasted = event.clipboardData.getData("text");
    if (!pasted.includes("<localized")) return;
    event.preventDefault();
    const start = event.currentTarget.selectionStart;
    const end = event.currentTarget.selectionEnd;
    const nextText = `${planDraft.skills.slice(0, start)}${pasted}${planDraft.skills.slice(end)}`;
    setPlanDraft({ ...planDraft, skills: nextText, parsedText: "", parsedSkills: [], unresolvedLines: [] });
    void parseSkillText(nextText);
  };

  const editGroup = (group: IdentityGroup) => setGroupDraft({
    id: group.id,
    name: group.name,
    category: group.category,
    description: group.description,
    requiredSkills: group.requiredSkills,
    permissions: group.permissions,
    skillPlanIds: group.skillPlans.map((plan) => plan.id),
    skillPlanMatchMode: group.skillPlanMatchMode,
    applicationOpen: group.applicationOpen,
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
      applicationOpen: groupDraft.applicationOpen,
      isActive: groupDraft.isActive,
    };
    const options = {
      onSuccess: async () => { setGroupDraft(emptyGroup()); await refreshIdentity(); toast({ title: tr("身份组已保存", "Identity group saved") }); },
      onError: (error: unknown) => toast({ title: tr("保存失败", "Save failed"), description: getErrorMessage(error), variant: "destructive" as const }),
    };
    if (groupDraft.id) updateGroup.mutate({ id: groupDraft.id, data }, options);
    else createGroup.mutate({ data }, options);
  };

  const savePlan = async () => {
    if (!planDraft.name.trim()) {
      toast({ title: tr("请输入方案名称", "Enter a plan name"), variant: "destructive" });
      return;
    }
    const requiredSkills = planDraft.parsedText === planDraft.skills && planDraft.unresolvedLines.length === 0
      ? planDraft.parsedSkills
      : await parseSkillText(planDraft.skills, false);
    if (!requiredSkills) return;
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

  const confirmDelete = () => {
    const target = deleteTarget;
    if (!target) return;
    const options = {
      onSuccess: async () => {
        if (target.kind === "group") {
          if (groupDraft.id === target.id) setGroupDraft(emptyGroup());
          if (selectedGroupId === target.id) setSelectedGroupId(null);
        } else if (planDraft.id === target.id) {
          setPlanDraft(emptyPlan());
        }
        setDeleteTarget(null);
        await refreshIdentity();
        toast({ title: target.kind === "group" ? tr("身份组已删除", "Identity group deleted") : tr("技能方案已删除", "Skill plan deleted") });
      },
      onError: (error: unknown) => {
        setDeleteTarget(null);
        toast({
          title: target.kind === "group" ? tr("无法删除身份组", "Unable to delete identity group") : tr("无法删除技能方案", "Unable to delete skill plan"),
          description: getErrorMessage(error),
          variant: "destructive" as const,
        });
      },
    };
    if (target.kind === "group") deleteGroup.mutate({ id: target.id }, options);
    else deletePlan.mutate({ id: target.id }, options);
  };

  const toggleApplicationWindow = (group: IdentityGroup) => {
    const applicationOpen = !group.applicationOpen;
    setApplicationWindow.mutate({ id: group.id, data: { applicationOpen } }, {
      onSuccess: async () => {
        if (groupDraft.id === group.id) {
          setGroupDraft((current) => ({ ...current, applicationOpen }));
        }
        await refreshIdentity();
        toast({
          title: applicationOpen ? tr("身份组申请已开放", "Identity-group applications opened") : tr("身份组申请已关闭", "Identity-group applications closed"),
          description: applicationOpen
            ? tr(`成员现在可以申请“${group.name}”。`, `Members can now apply to “${group.name}”.`)
            : tr(`“${group.name}”不再接受新申请，现有成员和待审核记录不受影响。`, `“${group.name}” no longer accepts new applications. Existing members and pending reviews are unchanged.`),
        });
      },
      onError: (error) => toast({ title: tr("申请开关更新失败", "Unable to update application window"), description: getErrorMessage(error), variant: "destructive" }),
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
          <label className="flex items-center gap-2 pb-2 text-sm md:col-span-2"><input type="checkbox" checked={groupDraft.applicationOpen} onChange={(event) => setGroupDraft({ ...groupDraft, applicationOpen: event.target.checked })} />{tr("开放成员申请（关闭后不影响现有成员与待审核申请）", "Accept member applications (closing does not affect existing members or pending reviews)")}</label>
          <div className="space-y-2 md:col-span-2"><Label>{tr("批准后自动授予的权限", "Permissions granted after approval")}</Label><div className="grid gap-2 rounded-md border border-border/50 p-3 md:grid-cols-2">{PERMISSIONS.map(([permission, cn, en]) => <label key={permission} className="flex items-center gap-2 text-sm"><input type="checkbox" checked={groupDraft.permissions.includes(permission)} onChange={(event) => setGroupDraft({ ...groupDraft, permissions: event.target.checked ? [...groupDraft.permissions, permission] : groupDraft.permissions.filter((item) => item !== permission) })} />{tr(cn, en)}</label>)}</div></div>
          <div className="flex gap-2 md:col-span-2"><Button onClick={saveGroup}>{tr("保存身份组", "Save identity group")}</Button>{groupDraft.id && <Button variant="outline" onClick={() => setGroupDraft(emptyGroup())}>{tr("取消编辑", "Cancel editing")}</Button>}</div>
          <div className="space-y-2 md:col-span-2 border-t border-border/50 pt-4"><Label>{tr("现有身份组", "Existing identity groups")}</Label><div className="grid gap-2 md:grid-cols-2">{(groups.data ?? []).map((group) => <div key={group.id} className="flex items-center justify-between gap-3 rounded-md border border-border/50 p-3"><div><div className="font-medium">{group.name} {!group.isActive && <Badge variant="outline">{tr("停用", "Inactive")}</Badge>} {!group.applicationOpen && <Badge variant="outline" className="border-amber-500/40 text-amber-300">{tr("申请关闭", "Applications closed")}</Badge>}</div><div className="text-xs text-muted-foreground">{group.skillPlans.map((plan) => plan.name).join(" · ") || tr("未套用方案", "No plans")}</div></div><div className="flex shrink-0 gap-2"><Button size="sm" variant={group.applicationOpen ? "outline" : "secondary"} disabled={setApplicationWindow.isPending} onClick={() => toggleApplicationWindow(group)}>{group.applicationOpen ? <LockKeyhole className="mr-1 h-3 w-3" /> : <LockOpen className="mr-1 h-3 w-3" />}{group.applicationOpen ? tr("关闭申请", "Close") : tr("开放申请", "Open")}</Button><Button size="sm" variant={selectedGroupId === group.id ? "secondary" : "outline"} onClick={() => setSelectedGroupId(group.id)}><UsersRound className="mr-1 h-3 w-3" />{tr("成员", "Members")}</Button><Button size="sm" variant="outline" onClick={() => editGroup(group)}><Pencil className="mr-1 h-3 w-3" />{tr("编辑", "Edit")}</Button><Button size="icon" variant="destructive" aria-label={tr(`删除身份组 ${group.name}`, `Delete identity group ${group.name}`)} onClick={() => setDeleteTarget({ kind: "group", id: group.id, name: group.name })}><Trash2 className="h-3.5 w-3.5" /></Button></div></div>)}</div></div>
          {selectedGroup && <div className="space-y-3 rounded-md border border-primary/25 bg-primary/5 p-4 md:col-span-2"><div className="flex flex-wrap items-center justify-between gap-2"><div><div className="font-medium">{selectedGroup.name} · {tr("组内成员", "Group members")}</div><div className="text-xs text-muted-foreground">{tr("名单仅对本军团身份组管理员可见。", "This roster is visible only to identity managers in this corporation.")}</div></div><Badge variant="secondary">{tr(`${groupMembers.data?.length ?? 0} 人`, `${groupMembers.data?.length ?? 0} members`)}</Badge></div>{groupMembers.isLoading ? <p className="text-sm text-muted-foreground">{tr("正在读取成员…", "Loading members…")}</p> : groupMembers.isError ? <p className="text-sm text-destructive">{getErrorMessage(groupMembers.error)}</p> : (groupMembers.data?.length ?? 0) === 0 ? <p className="text-sm text-muted-foreground">{tr("该身份组暂无成员。", "This identity group has no members.")}</p> : <div className="grid gap-2 md:grid-cols-2">{groupMembers.data?.map((member) => <div key={member.id} className="rounded border border-border/50 bg-background/50 p-3"><div className="flex items-center justify-between gap-2"><span className="font-medium">{member.characterName ?? member.mainCharacterName ?? `#${member.userId}`}</span><Badge variant="outline">{member.role.toUpperCase()}</Badge></div>{member.characterName && member.mainCharacterName && member.characterName !== member.mainCharacterName && <div className="mt-1 text-xs text-muted-foreground">{tr("主角色", "Main character")}: {member.mainCharacterName}</div>}<div className="mt-1 text-xs text-muted-foreground">{tr("加入身份组", "Joined group")}: {new Date(member.joinedAt).toLocaleString()}</div></div>)}</div>}</div>}
        </CardContent>
      </Card>

      <Card>
        <CardHeader><CardTitle>{planDraft.id ? tr("编辑技能方案", "Edit skill plan") : tr("军团技能方案", "Corporation skill plans")}</CardTitle><CardDescription>{tr("从游戏内复制军团技能训练方案后直接粘贴；网站会读取技能名称、解析技能 ID，并把重复的 1→目标等级自动合并为最高等级。", "Copy a corporation skill plan in the EVE client and paste it here. The site resolves skill IDs and merges repeated levels into the highest requirement.")}</CardDescription></CardHeader>
        <CardContent className="grid gap-4 md:grid-cols-2">
          <div className="space-y-2"><Label>{tr("方案名称", "Plan name")}</Label><Input value={planDraft.name} onChange={(event) => setPlanDraft({ ...planDraft, name: event.target.value })} /></div>
          <label className="flex items-center gap-2 self-end pb-2 text-sm"><input type="checkbox" checked={planDraft.isActive} onChange={(event) => setPlanDraft({ ...planDraft, isActive: event.target.checked })} />{tr("方案启用", "Plan active")}</label>
          <div className="space-y-2 md:col-span-2"><Label>{tr("说明", "Description")}</Label><Input value={planDraft.description} onChange={(event) => setPlanDraft({ ...planDraft, description: event.target.value })} /></div>
          <div className="space-y-2 md:col-span-2"><Label>{tr("游戏内技能方案", "In-game skill plan")}</Label><Textarea rows={12} placeholder={'<localized hint="Black Ops">黑隐特勤舰操作*</localized> 4'} value={planDraft.skills} onPaste={handleSkillPaste} onChange={(event) => setPlanDraft({ ...planDraft, skills: event.target.value, parsedText: "", parsedSkills: [], unresolvedLines: [] })} /><p className="text-xs text-muted-foreground">{tr("支持游戏内中文复制格式、英文“技能名 等级”，并继续兼容“技能ID, 名称, 等级”旧格式。粘贴游戏格式后会自动读取。", "Supports EVE localized clipboard text, English skill-name and level lines, and the legacy skill-ID, name, level format. EVE clipboard text is imported automatically on paste.")}</p></div>
          <div className="flex flex-wrap gap-2 md:col-span-2"><Button type="button" variant="outline" disabled={importPlan.isPending} onClick={() => void parseSkillText(planDraft.skills)}>{importPlan.isPending ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : <ClipboardPaste className="mr-2 h-4 w-4" />}{tr("读取并预览", "Import and preview")}</Button><Button onClick={() => void savePlan()} disabled={importPlan.isPending || createPlan.isPending || updatePlan.isPending}>{tr("保存技能方案", "Save skill plan")}</Button>{planDraft.id && <Button variant="outline" onClick={() => setPlanDraft(emptyPlan())}>{tr("取消编辑", "Cancel editing")}</Button>}</div>
          {planDraft.parsedText === planDraft.skills && <div className="space-y-3 rounded-md border border-border/50 p-3 md:col-span-2"><div className="text-sm font-medium text-emerald-400">{tr(`已识别并去重 ${planDraft.parsedSkills.length} 项技能`, `${planDraft.parsedSkills.length} skills recognized and deduplicated`)}</div><div className="flex max-h-44 flex-wrap gap-2 overflow-auto">{planDraft.parsedSkills.map((skill) => <Badge key={skill.skillId} variant="secondary">{skill.name} Lv.{skill.level}</Badge>)}</div>{planDraft.unresolvedLines.length > 0 && <div className="rounded border border-destructive/50 bg-destructive/10 p-3 text-xs text-destructive"><div className="mb-1 font-medium">{tr(`未识别 ${planDraft.unresolvedLines.length} 行，保存前必须修正`, `${planDraft.unresolvedLines.length} unrecognized lines must be fixed before saving`)}</div>{planDraft.unresolvedLines.slice(0, 8).map((line, index) => <div key={`${line}-${index}`} className="break-all">{line}</div>)}</div>}</div>}
          <div className="space-y-2 md:col-span-2 border-t border-border/50 pt-4"><div className="grid gap-2 md:grid-cols-2">{(plans.data ?? []).map((plan) => <div key={plan.id} className="flex items-center justify-between gap-3 rounded-md border border-border/50 p-3"><div className="min-w-0"><div className="font-medium">{plan.name} {!plan.isActive && <Badge variant="outline">{tr("停用", "Inactive")}</Badge>}</div><div className="truncate text-xs text-muted-foreground">{plan.requiredSkills.map((skill) => `${skill.name} Lv.${skill.level}`).join(" · ") || tr("无技能", "No skills")}</div></div><div className="flex shrink-0 gap-2"><Button size="sm" variant="outline" onClick={() => { const skills = skillText(plan); setPlanDraft({ id: plan.id, name: plan.name, description: plan.description, skills, parsedText: skills, parsedSkills: plan.requiredSkills, unresolvedLines: [], isActive: plan.isActive }); }}><Pencil className="mr-1 h-3 w-3" />{tr("编辑", "Edit")}</Button><Button size="icon" variant="destructive" aria-label={tr(`删除技能方案 ${plan.name}`, `Delete skill plan ${plan.name}`)} onClick={() => setDeleteTarget({ kind: "plan", id: plan.id, name: plan.name })}><Trash2 className="h-3.5 w-3.5" /></Button></div></div>)}</div></div>
        </CardContent>
      </Card>

      <AlertDialog open={deleteTarget !== null} onOpenChange={(open) => { if (!open) setDeleteTarget(null); }}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>{deleteTarget?.kind === "group" ? tr("确认删除身份组", "Delete identity group?") : tr("确认删除技能方案", "Delete skill plan?")}</AlertDialogTitle>
            <AlertDialogDescription>
              {deleteTarget?.kind === "group"
                ? tr(`将永久删除“${deleteTarget.name}”。仅没有成员和申请历史的身份组可以删除；已使用的身份组请改为停用。`, `“${deleteTarget.name}” will be permanently deleted. Only groups with no members or application history can be deleted; deactivate groups that have been used.`)
                : tr(`将永久删除“${deleteTarget?.name ?? ""}”。如果仍有身份组使用该方案，系统会阻止删除并列出需要先取消关联的身份组。`, `“${deleteTarget?.name ?? ""}” will be permanently deleted. If any identity group still uses it, deletion will be blocked and the groups to unlink will be listed.`)}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>{tr("取消", "Cancel")}</AlertDialogCancel>
            <AlertDialogAction className="bg-destructive text-destructive-foreground hover:bg-destructive/90" disabled={deleteGroup.isPending || deletePlan.isPending} onClick={confirmDelete}>
              {(deleteGroup.isPending || deletePlan.isPending) && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
              {tr("永久删除", "Delete permanently")}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}
