import { useQueryClient } from "@tanstack/react-query";
import {
  getGetMeQueryKey,
  useGetMe,
  useUpdateReimbursementWindow,
  type CurrentUser,
} from "@workspace/api-client-react";
import { useTranslation } from "react-i18next";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { useToast } from "@/hooks/use-toast";
import { getErrorMessage } from "@/lib/api-error";
import { Loader2, LockKeyhole, UnlockKeyhole } from "lucide-react";

export function ReimbursementSettings() {
  const { i18n } = useTranslation();
  const zh = i18n.language.startsWith("zh");
  const tr = (cn: string, en: string) => zh ? cn : en;
  const { data: user } = useGetMe();
  const queryClient = useQueryClient();
  const { toast } = useToast();
  const updateWindow = useUpdateReimbursementWindow();
  const isOpen = user?.reimbursementOpen !== false;

  const toggleWindow = () => {
    updateWindow.mutate({ data: { open: !isOpen } }, {
      onSuccess: (result) => {
        queryClient.setQueryData<CurrentUser>(getGetMeQueryKey(), (current) => (
          current ? { ...current, reimbursementOpen: result.open } : current
        ));
        toast({
          title: result.open
            ? tr("补损窗口已开启", "Reimbursement window opened")
            : tr("补损窗口已关闭", "Reimbursement window closed"),
          description: tr(
            `设置仅作用于 ${user?.corporationName ?? "当前军团"}。`,
            `This setting only affects ${user?.corporationName ?? "the current corporation"}.`,
          ),
        });
      },
      onError: (error) => toast({
        title: tr("操作失败", "Update failed"),
        description: getErrorMessage(error),
        variant: "destructive",
      }),
    });
  };

  return (
    <div className="p-6 space-y-6 overflow-auto">
      <div>
        <h1 className="text-2xl font-bold font-mono tracking-wider">{tr("补损窗口", "REIMBURSEMENT WINDOW")}</h1>
        <p className="text-sm text-muted-foreground mt-1">
          {tr("总监可以开启或关闭所属军团的补损入口。其他军团不会受到影响。", "Directors can open or close reimbursement for their own corporation. Other corporations are unaffected.")}
        </p>
      </div>

      <Card className={isOpen ? "border-emerald-500/40" : "border-zinc-600/60"}>
        <CardHeader>
          <div className="flex flex-wrap items-start justify-between gap-3">
            <div className="space-y-1.5">
              <CardTitle className="flex items-center gap-2">
                {isOpen ? <UnlockKeyhole className="h-5 w-5 text-emerald-400" /> : <LockKeyhole className="h-5 w-5 text-muted-foreground" />}
                {user?.corporationName}
              </CardTitle>
              <CardDescription>
                {isOpen
                  ? tr("成员目前可以进入补损并提交 zKillboard 损失。", "Members can currently access reimbursement and submit zKillboard losses.")
                  : tr("成员的补损入口已灰显，所有补损接口均已锁定。", "The reimbursement entry is disabled and all reimbursement operations are locked.")}
              </CardDescription>
            </div>
            <Badge variant={isOpen ? "default" : "secondary"}>
              {isOpen ? tr("已开启", "Open") : tr("已关闭", "Closed")}
            </Badge>
          </div>
        </CardHeader>
        <CardContent>
          <Button
            variant={isOpen ? "destructive" : "default"}
            disabled={updateWindow.isPending}
            onClick={toggleWindow}
          >
            {updateWindow.isPending
              ? <Loader2 className="h-4 w-4 mr-2 animate-spin" />
              : isOpen
                ? <LockKeyhole className="h-4 w-4 mr-2" />
                : <UnlockKeyhole className="h-4 w-4 mr-2" />}
            {isOpen ? tr("关闭本军团补损", "Close corporation reimbursement") : tr("开启本军团补损", "Open corporation reimbursement")}
          </Button>
        </CardContent>
      </Card>
    </div>
  );
}
