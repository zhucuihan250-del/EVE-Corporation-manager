import { useMemo, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import {
  useApplyIdentityGroup,
  useCreateIdentityGroup,
  useGetMe,
  useListCharacters,
  useListIdentityApplications,
  useListIdentityGroups,
  useReviewIdentityApplication,
  useUpdateIdentityGroup,
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
import { CheckCircle2, ShieldCheck, UsersRound, XCircle } from "lucide-react";

const ROLE_LEVELS = ["member", "fc", "admin", "controller"];

export function IdentityGroups() {
  const { i18n } = useTranslation();
  const zh = i18n.language.startsWith("zh");
  const tr = (cn: string, en: string) => zh ? cn : en;
  const queryClient = useQueryClient();
  const { toast } = useToast();
  const { data: user } = useGetMe();
  const groups = useListIdentityGroups();
  const characters = useListCharacters();
  const applications = useListIdentityApplications();
  const apply = useApplyIdentityGroup();
  const review = useReviewIdentityApplication();
  const create = useCreateIdentityGroup();
  const update = useUpdateIdentityGroup();
  const [characterByGroup, setCharacterByGroup] = useState<Record<number, string>>({});
  const [statementByGroup, setStatementByGroup] = useState<Record<number, string>>({});
  const [createForm, setCreateForm] = useState({ name: "", category: "combat", description: "", skills: "" });
  const [editing, setEditing] = useState<IdentityGroup | null>(null);
  const [editSkills, setEditSkills] = useState("");

  const canManage = Boolean(
    user?.permissions.includes("identity.manage")
    || ROLE_LEVELS.indexOf(user?.role ?? "member") >= ROLE_LEVELS.indexOf("admin"),
  );

  const parseSkills = (value: string): RequiredSkill[] | null => {
    if (!value.trim()) return [];
    const rows: RequiredSkill[] = [];
    for (const line of value.split("\n").map((item) => item.trim()).filter(Boolean)) {
      const [id, name, level] = line.split(",").map((item) => item.trim());
      const skillId = Number(id);
      const minimum = Number(level);
      if (!Number.isInteger(skillId) || skillId <= 0 || !name || !Number.isInteger(minimum) || minimum < 1 || minimum > 5) return null;
      rows.push({ skillId, name, level: minimum });
    }
    return rows;
  };

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
        toast({
          title: result.status === "rejected" ? tr("技能审核未通过", "Skill audit failed") : tr("申请已提交", "Application submitted"),
          description: result.rejectionReason ?? tr("技能审核通过，已进入人工审核。", "Skill audit passed and the application is awaiting review."),
          variant: result.status === "rejected" ? "destructive" : "default",
        });
      },
      onError: (error) => toast({ title: tr("提交失败", "Submission failed"), description: getErrorMessage(error), variant: "destructive" }),
    });
  };

  const skillText = (requirements: RequiredSkill[]) => requirements
    .map((skill) => `${skill.skillId}, ${skill.name}, ${skill.level}`)
    .join("\n");

  const statusText = useMemo(() => ({
    pending_skill_audit: tr("技能审核中", "Skill audit"), pending_review: tr("等待审核", "Pending review"),
    needs_information: tr("需要补充", "Needs information"), approved: tr("已批准", "Approved"),
    rejected: tr("已拒绝", "Rejected"), withdrawn: tr("已撤回", "Withdrawn"),
  }), [zh]);

  return (
    <div className="p-6 space-y-6 overflow-auto">
      <div>
        <h1 className="text-2xl font-bold font-mono tracking-wider">{tr("身份组", "IDENTITY GROUPS")}</h1>
        <p className="text-sm text-muted-foreground mt-1">{tr("作战能力自动核验，管理身份由军团审核。", "Combat skills are checked automatically; management identities require corporation review.")}</p>
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
                <div className="font-medium mb-2">{tr("技能要求", "Skill requirements")}</div>
                {group.requiredSkills.length ? group.requiredSkills.map((skill) => (
                  <div key={skill.skillId} className="flex justify-between text-muted-foreground"><span>{skill.name}</span><span>Lv. {skill.level}</span></div>
                )) : <span className="text-muted-foreground">{tr("暂未配置技能门槛", "No skill threshold configured")}</span>}
              </div>
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
                  <Button onClick={() => submitApplication(group.id)} disabled={apply.isPending}>{tr("提交申请并自动审核技能", "Apply and audit skills")}</Button>
                </div>
              )}
              {canManage && <Button variant="outline" size="sm" onClick={() => { setEditing(group); setEditSkills(skillText(group.requiredSkills)); }}>{tr("编辑技能要求", "Edit skill requirements")}</Button>}
            </CardContent>
          </Card>
        ))}
      </div>

      {canManage && editing && (
        <Card>
          <CardHeader><CardTitle>{tr("编辑技能要求", "Edit skill requirements")} · {editing.name}</CardTitle><CardDescription>{tr("每行填写：技能ID, 技能名称, 最低等级", "One per line: skill ID, skill name, minimum level")}</CardDescription></CardHeader>
          <CardContent className="space-y-3">
            <Textarea rows={6} value={editSkills} onChange={(event) => setEditSkills(event.target.value)} placeholder="28656, Black Ops, 4" />
            <div className="flex gap-2"><Button onClick={() => {
              const requiredSkills = parseSkills(editSkills);
              if (!requiredSkills) { toast({ title: tr("技能格式不正确", "Invalid skill format"), variant: "destructive" }); return; }
              update.mutate({ id: editing.id, data: { name: editing.name, category: editing.category, description: editing.description, requiredSkills, isActive: editing.isActive } }, { onSuccess: async () => { setEditing(null); await refresh(); }, onError: (error) => toast({ title: getErrorMessage(error), variant: "destructive" }) });
            }}>{tr("保存", "Save")}</Button><Button variant="outline" onClick={() => setEditing(null)}>{tr("取消", "Cancel")}</Button></div>
          </CardContent>
        </Card>
      )}

      {canManage && (
        <Card>
          <CardHeader><CardTitle className="flex items-center gap-2"><UsersRound className="h-5 w-5" />{tr("身份组管理", "Identity group management")}</CardTitle></CardHeader>
          <CardContent className="grid gap-3 md:grid-cols-2">
            <div className="space-y-2"><Label>{tr("名称", "Name")}</Label><Input value={createForm.name} onChange={(event) => setCreateForm({ ...createForm, name: event.target.value })} /></div>
            <div className="space-y-2"><Label>{tr("类别", "Category")}</Label><select className="w-full h-10 rounded-md border border-input bg-background px-3" value={createForm.category} onChange={(event) => setCreateForm({ ...createForm, category: event.target.value })}><option value="combat">{tr("作战与能力", "Combat")}</option><option value="management">{tr("管理身份", "Management")}</option></select></div>
            <div className="space-y-2 md:col-span-2"><Label>{tr("说明", "Description")}</Label><Input value={createForm.description} onChange={(event) => setCreateForm({ ...createForm, description: event.target.value })} /></div>
            <div className="space-y-2 md:col-span-2"><Label>{tr("技能要求：每行 技能ID, 名称, 等级", "Skills: one line per ID, name, level")}</Label><Textarea rows={4} value={createForm.skills} onChange={(event) => setCreateForm({ ...createForm, skills: event.target.value })} /></div>
            <Button onClick={() => {
              const requiredSkills = parseSkills(createForm.skills);
              if (!requiredSkills || !createForm.name.trim()) { toast({ title: tr("请检查身份组和技能格式", "Check the group and skill format"), variant: "destructive" }); return; }
              create.mutate({ data: { name: createForm.name.trim(), category: createForm.category as "combat" | "management", description: createForm.description.trim(), requiredSkills } }, { onSuccess: async () => { setCreateForm({ name: "", category: "combat", description: "", skills: "" }); await refresh(); } });
            }}>{tr("创建身份组", "Create group")}</Button>
          </CardContent>
        </Card>
      )}

      <Card>
        <CardHeader><CardTitle>{canManage ? tr("申请审核", "Application review") : tr("我的申请", "My applications")}</CardTitle></CardHeader>
        <CardContent className="space-y-3">
          {(applications.data ?? []).length === 0 ? <p className="text-sm text-muted-foreground">{tr("暂无申请", "No applications")}</p> : (applications.data ?? []).map((application) => (
            <div key={application.id} className="rounded-md border border-border/50 p-4 space-y-2">
              <div className="flex flex-wrap items-center justify-between gap-2"><div className="font-medium">{application.groupName ?? `#${application.groupId}`} · {application.characterName ?? application.applicantName}</div><Badge variant="outline">{statusText[application.status]}</Badge></div>
              {application.statement && <p className="text-sm text-muted-foreground">{application.statement}</p>}
              {application.skillAudit && <div className="text-xs text-muted-foreground">{application.skillAudit.skills.map((skill) => `${skill.name} ${skill.trainedLevel}/${skill.level}${skill.passed ? " ✓" : " ✗"}`).join(" · ") || tr("无技能门槛", "No skill threshold")}</div>}
              {application.rejectionReason && <div className="flex gap-2 text-sm text-destructive"><XCircle className="h-4 w-4 mt-0.5" />{application.rejectionReason}</div>}
              {canManage && application.status === "pending_review" && <div className="flex gap-2"><Button size="sm" onClick={() => review.mutate({ id: application.id, data: { status: "approved", reviewerNotes: tr("审核通过", "Approved") } }, { onSuccess: refresh })}>{tr("批准", "Approve")}</Button><Button size="sm" variant="destructive" onClick={() => review.mutate({ id: application.id, data: { status: "rejected", reviewerNotes: tr("人工审核未通过", "Manual review rejected") } }, { onSuccess: refresh })}>{tr("拒绝", "Reject")}</Button></div>}
            </div>
          ))}
        </CardContent>
      </Card>
    </div>
  );
}
