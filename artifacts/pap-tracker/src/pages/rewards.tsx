import { useListRewards, useCreateRedemption, getGetDashboardSummaryQueryKey } from "@workspace/api-client-react";
import { Card, CardContent, CardFooter, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Loader2, ShoppingCart } from "lucide-react";
import { useToast } from "@/hooks/use-toast";
import { useQueryClient } from "@tanstack/react-query";
import { useTranslation } from "react-i18next";

export function Rewards() {
  const { t } = useTranslation();
  const { data: rewards, isLoading } = useListRewards({ query: { queryKey: ["rewards"] } });
  const createRedemption = useCreateRedemption();
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
        },
        onError: (err: any) => {
          toast({
            title: t("rewards.redemptionFailed"),
            description: err.error || t("rewards.insufficientPap"),
            variant: "destructive",
          });
        }
      }
    );
  };

  return (
    <div className="space-y-6 animate-in fade-in slide-in-from-bottom-4 duration-500">
      <div>
        <h1 className="text-2xl font-bold font-mono tracking-wider text-foreground mb-1 uppercase">{t("rewards.title")}</h1>
        <p className="text-muted-foreground font-mono text-sm">{t("rewards.subtitle")}</p>
      </div>

      {isLoading ? (
        <div className="flex justify-center p-12">
          <Loader2 className="w-8 h-8 animate-spin text-primary" />
        </div>
      ) : !rewards?.length ? (
        <Card className="bg-card/40 backdrop-blur border-border/50 rounded-sm">
          <CardContent className="p-12 text-center text-muted-foreground font-mono">
            {t("rewards.noItems")}
          </CardContent>
        </Card>
      ) : (
        <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-6">
          {rewards.map((reward) => (
            <Card key={reward.id} className="bg-card/40 backdrop-blur border-border/50 rounded-sm flex flex-col">
              <CardHeader className="pb-4">
                <div className="flex justify-between items-start gap-4">
                  <CardTitle className="text-lg font-mono tracking-wider">{reward.name}</CardTitle>
                  <Badge variant="outline" className="font-mono bg-primary/10 text-primary border-primary/20 shrink-0">
                    {reward.papCost} PAP
                  </Badge>
                </div>
              </CardHeader>
              <CardContent className="flex-1">
                <p className="text-sm text-muted-foreground font-mono mb-4">{reward.description || "Standard issue item."}</p>
                <div className="flex items-center gap-2 text-xs font-mono">
                  <span className="text-muted-foreground">{t("rewards.stock")}:</span>
                  <span className={reward.stock === 0 ? "text-destructive" : "text-foreground"}>
                    {reward.stock === null ? t("rewards.unlimited") : reward.stock}
                  </span>
                </div>
              </CardContent>
              <CardFooter className="pt-4 border-t border-border/30">
                <Button 
                  className="w-full font-mono text-xs tracking-wider rounded-sm" 
                  disabled={!reward.isAvailable || reward.stock === 0 || createRedemption.isPending}
                  onClick={() => handleRedeem(reward.id, reward.name)}
                >
                  {createRedemption.isPending ? <Loader2 className="w-4 h-4 animate-spin" /> : <><ShoppingCart className="w-4 h-4 mr-2" /> {t("rewards.requisition")}</>}
                </Button>
              </CardFooter>
            </Card>
          ))}
        </div>
      )}
    </div>
  );
}
