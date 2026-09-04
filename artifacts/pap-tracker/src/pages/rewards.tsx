import { useListRewards, useCreateRedemption, getGetDashboardSummaryQueryKey, useGetMe, useCheckRewardSkillEligibility, type SkillAuditResult } from "@workspace/api-client-react";
import { Card, CardContent, CardFooter, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { CheckCircle2, Clock3, Loader2, Repeat2, ShieldCheck, ShoppingCart, XCircle } from "lucide-react";
import { useToast } from "@/hooks/use-toast";
import { useQueryClient } from "@tanstack/react-query";
import { useTranslation } from "react-i18next";
import { useParams } from "wouter";
import { getErrorMessage } from "@/lib/api-error";
import { useState } from "react";

export function TacticalRewards() {
  const { id } = useParams<{ id: string }>();
  return <Rewards identityGroupId={Number(id)} />;
}

export function Rewards({ identityGroupId }: { identityGroupId?: number } = {}) {
  const { t } = useTranslation();
  const { data: user } = useGetMe();
  const group = user?.tacticalGroups?.find((candidate) => candidate.id === identityGroupId);
  const allowed = identityGroupId === undefined || Boolean(user?.modules.identity && group);
  const { data: visibleRewards, isLoading, error } = useListRewards(undefined, { query: {
    queryKey: ["rewards", user?.corporationId, user?.id], enabled: Boolean(user && allowed),
  } });
  const rewards = identityGroupId === undefined ? visibleRewards : visibleRewards?.filter((reward) => reward.identityGroupId === identityGroupId);
  const createRedemption = useCreateRedemption();
  const checkSkillEligibility = useCheckRewardSkillEligibility();
  const [skillAudits, setSkillAudits] = useState<Record<number, SkillAuditResult>>({});
  const [skillErrors, setSkillErrors] = useState<Record<number, string>>({});
  const { toast } = useToast();
  const queryClient = useQueryClient();

  const handleRedeem = (rewardId: number, name: string) => {
    createRedemption.mutate(
      { data: { rewardId } },
      {
        onSuccess: () => {
          toast({
            title: t("rewards.redemptionRequested"),
            description: t("rewards.redemptionRequestedDesc", { name }),
          });
          queryClient.invalidateQueries({ queryKey: getGetDashboardSummaryQueryKey() });
          queryClient.invalidateQueries({ queryKey: ["rewards"] });
          queryClient.invalidateQueries({ queryKey: ["adminRewards"] });
          queryClient.invalidateQueries({ queryKey: ["/api/redemptions"] });
          queryClient.invalidateQueries({ queryKey: ["/api/auth/me"] });
        },
        onError: (err: any) => {
          queryClient.invalidateQueries({ queryKey: ["rewards"] });
          queryClient.invalidateQueries({ queryKey: ["/api/auth/me"] });
          const errorCode = err?.data?.code;
          const errorMessage = err?.data?.error;
          if (["REWARD_SKILL_REQUIREMENTS_NOT_MET", "REWARD_SKILL_REQUIREMENTS_CHANGED", "SKILL_AUTHORIZATION_REQUIRED"].includes(errorCode)) {
            setSkillAudits((current) => {
              const next = { ...current };
              delete next[rewardId];
              return next;
            });
          }
          toast({
            title: t("rewards.redemptionFailed"),
            description: errorCode === "REWARD_ELIGIBILITY_EXPIRED"
              ? t("rewards.eligibilityExpiredDesc")
              : errorCode === "CORPORATION_JOIN_DATE_UNAVAILABLE"
                ? t("rewards.eligibilityVerificationUnavailable")
                : errorCode === "REWARD_REDEMPTION_LIMIT_REACHED"
                  ? t("rewards.redemptionLimitReachedDesc")
                  : errorCode === "REWARD_SKILL_REQUIREMENTS_NOT_MET"
                    ? t("rewards.skillRequirementsNotMet")
                    : errorCode === "REWARD_SKILL_REQUIREMENTS_CHANGED"
                      ? t("rewards.skillRequirementsChanged")
                      : errorCode === "SKILL_AUTHORIZATION_REQUIRED"
                        ? t("rewards.skillAuthorizationRequired")
                : errorMessage || t("rewards.insufficientPap"),
            variant: "destructive",
          });
        }
      }
    );
  };

  const handleSkillCheck = (rewardId: number) => {
    setSkillErrors((current) => {
      const next = { ...current };
      delete next[rewardId];
      return next;
    });
    checkSkillEligibility.mutate(
      { id: rewardId },
      {
        onSuccess: (audit) => {
          setSkillAudits((current) => ({ ...current, [rewardId]: audit }));
        },
        onError: (error) => {
          setSkillAudits((current) => {
            const next = { ...current };
            delete next[rewardId];
            return next;
          });
          setSkillErrors((current) => ({ ...current, [rewardId]: getErrorMessage(error) }));
        },
      },
    );
  };

  if (!allowed) return <div className="p-6 text-sm text-muted-foreground">{t("rewards.groupAccessDenied")}</div>;

  return (
    <div className="space-y-6 animate-in fade-in slide-in-from-bottom-4 duration-500">
      <div>
        <h1 className="text-2xl font-bold font-mono tracking-wider text-foreground mb-1 uppercase">{group ? t("rewards.groupExclusive", { name: group.name }) : t("rewards.title")}</h1>
        <p className="text-muted-foreground font-mono text-sm">{group ? t("rewards.groupSubtitle") : t("rewards.subtitle")}</p>
      </div>

      {isLoading ? (
        <div className="flex justify-center p-12">
          <Loader2 className="w-8 h-8 animate-spin text-primary" />
        </div>
      ) : error ? (
        <div className="p-6 text-sm text-destructive">{getErrorMessage(error)}</div>
      ) : !rewards?.length ? (
        <Card className="bg-card/40 backdrop-blur border-border/50 rounded-sm">
          <CardContent className="p-12 text-center text-muted-foreground font-mono">
            {t("rewards.noItems")}
          </CardContent>
        </Card>
      ) : (
        <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-6">
          {rewards.map((reward) => {
            const eligibilityExpired = reward.isEligible === false;
            const redemptionLimitReached = reward.hasReachedRedemptionLimit === true;
            const requiresSkillCheck = reward.requiredSkillPlans.length > 0;
            const skillAudit = skillAudits[reward.id];
            const skillError = skillErrors[reward.id];
            const skillCheckPending = checkSkillEligibility.isPending
              && checkSkillEligibility.variables?.id === reward.id;
            const inactivePlan = reward.requiredSkillPlans.some((plan) => !plan.isActive);
            const skillPassed = !requiresSkillCheck || skillAudit?.passed === true;
            const incompletePlans = skillAudit?.plans?.filter((plan) => !plan.passed) ?? [];

            return (
              <Card key={reward.id} className="bg-card/40 backdrop-blur border-border/50 rounded-sm flex flex-col">
                <CardHeader className="pb-4">
                  <div className="flex justify-between items-start gap-4">
                    <CardTitle className="text-lg font-mono tracking-wider">{reward.name}</CardTitle>
                    <Badge variant="outline" className="font-mono bg-primary/10 text-primary border-primary/20 shrink-0">
                      {reward.papCost} PAP
                    </Badge>
                  </div>
                  {reward.identityGroupId != null && <Badge variant="outline" className="w-fit text-violet-300 border-violet-400/30">{t("rewards.groupExclusive", { name: reward.identityGroupName ?? `#${reward.identityGroupId}` })}</Badge>}
                </CardHeader>
                <CardContent className="flex-1">
                  <p className="text-sm text-muted-foreground font-mono mb-4">{reward.description || "Standard issue item."}</p>
                  <div className="flex items-center gap-2 text-xs font-mono">
                    <span className="text-muted-foreground">{t("rewards.stock")}:</span>
                    <span className={reward.stock === 0 ? "text-destructive" : "text-foreground"}>
                      {reward.stock === null ? t("rewards.unlimited") : reward.stock}
                    </span>
                  </div>
                  {reward.eligibilityMonths !== null && (
                    <div className={`flex items-center gap-2 text-xs font-mono mt-3 ${eligibilityExpired ? "text-destructive" : "text-amber-400"}`}>
                      <Clock3 className="w-3.5 h-3.5 shrink-0" />
                      <span>
                        {eligibilityExpired
                          ? t("rewards.eligibilityExpired")
                          : t("rewards.limitedToNewMembers", { months: reward.eligibilityMonths })}
                      </span>
                    </div>
                  )}
                  {reward.maxRedemptionsPerUser !== null && (
                    <div className={`flex items-center gap-2 text-xs font-mono mt-3 ${redemptionLimitReached ? "text-destructive" : "text-primary"}`}>
                      <Repeat2 className="w-3.5 h-3.5 shrink-0" />
                      <span>
                        {redemptionLimitReached
                          ? t("rewards.redemptionLimitReached")
                          : t("rewards.redemptionsRemaining", {
                            remaining: reward.remainingRedemptions ?? 0,
                            limit: reward.maxRedemptionsPerUser,
                          })}
                      </span>
                    </div>
                  )}
                  {requiresSkillCheck && (
                    <div className="mt-4 space-y-2 rounded-sm border border-cyan-400/20 bg-cyan-400/5 p-3 font-mono text-xs">
                      <div className="flex items-center gap-2 text-cyan-300">
                        <ShieldCheck className="h-3.5 w-3.5" />
                        <span>{t("rewards.skillGate", {
                          mode: reward.skillPlanMatchMode === "any" ? t("rewards.matchAny") : t("rewards.matchAll"),
                        })}</span>
                      </div>
                      <div className="text-muted-foreground">
                        {reward.requiredSkillPlans.map((plan) => plan.name).join("、")}
                      </div>
                      {inactivePlan && <p className="text-amber-400">{t("rewards.inactiveSkillPlan")}</p>}
                      {skillAudit?.passed === true && (
                        <p className="flex items-center gap-1.5 text-emerald-400">
                          <CheckCircle2 className="h-3.5 w-3.5" /> {t("rewards.skillCheckPassed")}
                        </p>
                      )}
                      {skillAudit?.passed === false && (
                        <div className="text-destructive">
                          <p className="flex items-center gap-1.5">
                            <XCircle className="h-3.5 w-3.5" /> {t("rewards.skillCheckFailed")}
                          </p>
                          {incompletePlans.length > 0 && (
                            <p className="mt-1 pl-5">{t("rewards.incompletePlans", { plans: incompletePlans.map((plan) => plan.name).join("、") })}</p>
                          )}
                        </div>
                      )}
                      {skillError && <p className="text-destructive">{skillError}</p>}
                    </div>
                  )}
                </CardContent>
                <CardFooter className="pt-4 border-t border-border/30">
                  {requiresSkillCheck && !skillPassed ? (
                    <Button
                      variant="outline"
                      className="w-full rounded-sm font-mono text-xs tracking-wider"
                      disabled={inactivePlan || skillCheckPending}
                      onClick={() => handleSkillCheck(reward.id)}
                    >
                      {skillCheckPending
                        ? <Loader2 className="h-4 w-4 animate-spin" />
                        : <><ShieldCheck className="mr-2 h-4 w-4" />{skillAudit ? t("rewards.recheckSkills") : t("rewards.checkSkills")}</>}
                    </Button>
                  ) : (
                    <Button
                      className="w-full font-mono text-xs tracking-wider rounded-sm"
                      disabled={!reward.isAvailable || reward.stock === 0 || eligibilityExpired || redemptionLimitReached || !skillPassed || createRedemption.isPending}
                      onClick={() => handleRedeem(reward.id, reward.name)}
                    >
                      {createRedemption.isPending
                        ? <Loader2 className="w-4 h-4 animate-spin" />
                        : eligibilityExpired
                          ? t("rewards.eligibilityExpired")
                          : redemptionLimitReached
                            ? t("rewards.redemptionLimitReached")
                            : <><ShoppingCart className="w-4 h-4 mr-2" /> {t("rewards.requisition")}</>}
                    </Button>
                  )}
                </CardFooter>
              </Card>
            );
          })}
        </div>
      )}
    </div>
  );
}
