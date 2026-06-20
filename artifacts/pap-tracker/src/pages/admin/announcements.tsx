import {
  useListAnnouncements,
  useCreateAnnouncement,
  useDeleteAnnouncement,
  getListAnnouncementsQueryKey,
} from "@workspace/api-client-react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Loader2, Radio, Plus, Trash2, CalendarClock } from "lucide-react";
import { useQueryClient } from "@tanstack/react-query";
import { useToast } from "@/hooks/use-toast";
import { useState } from "react";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Textarea } from "@/components/ui/textarea";
import { Badge } from "@/components/ui/badge";
import { format } from "date-fns";
import { useTranslation } from "react-i18next";

const RALLY_LEVELS = ["MAX CTA", "CTA", "战略", "散打"] as const;
type RallyLevel = typeof RALLY_LEVELS[number];

const RALLY_LEVEL_COLORS: Record<RallyLevel, string> = {
  "MAX CTA": "bg-red-500/20 text-red-400 border-red-500/30 border",
  "CTA": "bg-orange-500/20 text-orange-400 border-orange-500/30 border",
  "战略": "bg-yellow-500/20 text-yellow-400 border-yellow-500/30 border",
  "散打": "bg-green-500/20 text-green-400 border-green-500/30 border",
};

export function AdminAnnouncements() {
  const { t } = useTranslation();
  const { data: announcements, isLoading } = useListAnnouncements({ query: { queryKey: ["adminAnnouncements"] } });
  const createAnnouncement = useCreateAnnouncement();
  const deleteAnnouncement = useDeleteAnnouncement();
  const queryClient = useQueryClient();
  const { toast } = useToast();

  const [modalOpen, setModalOpen] = useState(false);
  const [fc, setFc] = useState("");
  const [scheduledAt, setScheduledAt] = useState("");
  const [rallyPoint, setRallyPoint] = useState("");
  const [rallyLevel, setRallyLevel] = useState<RallyLevel | "">("");
  const [notes, setNotes] = useState("");
  const [deletingId, setDeletingId] = useState<number | null>(null);

  const resetForm = () => {
    setFc("");
    setScheduledAt("");
    setRallyPoint("");
    setRallyLevel("");
    setNotes("");
  };

  const handleCreate = () => {
    if (!fc || !scheduledAt || !rallyPoint || !rallyLevel) return;
    createAnnouncement.mutate(
      { data: { fc, scheduledAt: new Date(scheduledAt).toISOString(), rallyPoint, rallyLevel, notes: notes || undefined } },
      {
        onSuccess: () => {
          toast({ title: t("announcements.created"), description: t("announcements.createdDesc") });
          queryClient.invalidateQueries({ queryKey: getListAnnouncementsQueryKey() });
          setModalOpen(false);
          resetForm();
        },
      }
    );
  };

  const handleDelete = (id: number) => {
    setDeletingId(id);
    deleteAnnouncement.mutate(
      { id },
      {
        onSuccess: () => {
          toast({ title: t("announcements.deleted"), description: t("announcements.deletedDesc") });
          queryClient.invalidateQueries({ queryKey: getListAnnouncementsQueryKey() });
        },
        onSettled: () => setDeletingId(null),
      }
    );
  };

  return (
    <div className="space-y-6 animate-in fade-in slide-in-from-bottom-4 duration-500">
      <div className="flex justify-between items-start">
        <div>
          <h1 className="text-2xl font-bold font-mono tracking-wider text-foreground mb-1 uppercase">{t("announcements.title")}</h1>
          <p className="text-muted-foreground font-mono text-sm">{t("announcements.subtitle")}</p>
        </div>
        <Button onClick={() => setModalOpen(true)} className="font-mono rounded-sm text-xs tracking-wider">
          <Plus className="w-4 h-4 mr-2" /> {t("announcements.create")}
        </Button>
      </div>

      <div className="space-y-3">
        {isLoading ? (
          <div className="p-8 flex justify-center">
            <Loader2 className="w-6 h-6 animate-spin text-primary" />
          </div>
        ) : !announcements?.length ? (
          <Card className="bg-card/20 border-border/50 rounded-sm">
            <CardContent className="p-8 text-center text-muted-foreground font-mono text-sm">
              {t("announcements.noAnnouncements")}
            </CardContent>
          </Card>
        ) : (
          announcements.map((ann) => {
            const level = ann.rallyLevel as RallyLevel;
            const colorClass = RALLY_LEVEL_COLORS[level] ?? "bg-muted/20 text-muted-foreground border-border/30 border";
            return (
              <Card key={ann.id} className="bg-card/20 border-border/50 rounded-sm hover:border-primary/20 transition-colors">
                <CardContent className="p-4">
                  <div className="flex items-start justify-between gap-4">
                    <div className="flex-1 space-y-2">
                      <div className="flex items-center gap-3 flex-wrap">
                        <Badge className={`font-mono text-xs rounded-sm px-2 py-0.5 ${colorClass}`}>
                          {ann.rallyLevel}
                        </Badge>
                        <div className="flex items-center gap-1.5 text-muted-foreground font-mono text-xs">
                          <CalendarClock className="w-3.5 h-3.5" />
                          {format(new Date(ann.scheduledAt), "yyyy-MM-dd HH:mm")}
                        </div>
                      </div>
                      <div className="grid grid-cols-2 gap-x-8 gap-y-1">
                        <div className="flex items-center gap-2">
                          <span className="font-mono text-xs text-muted-foreground uppercase tracking-wider">{t("announcements.fc")}:</span>
                          <span className="font-mono text-sm text-foreground font-medium">{ann.fc}</span>
                        </div>
                        <div className="flex items-center gap-2">
                          <span className="font-mono text-xs text-muted-foreground uppercase tracking-wider">{t("announcements.rallyPoint")}:</span>
                          <span className="font-mono text-sm text-foreground">{ann.rallyPoint}</span>
                        </div>
                      </div>
                      {ann.notes && (
                        <p className="font-mono text-xs text-muted-foreground/80 italic">{ann.notes}</p>
                      )}
                    </div>
                    <Button
                      variant="ghost"
                      size="sm"
                      className="text-muted-foreground hover:text-destructive hover:bg-destructive/10 rounded-sm h-8 w-8 p-0 flex-shrink-0"
                      onClick={() => handleDelete(ann.id)}
                      disabled={deletingId === ann.id}
                    >
                      {deletingId === ann.id ? <Loader2 className="w-4 h-4 animate-spin" /> : <Trash2 className="w-4 h-4" />}
                    </Button>
                  </div>
                </CardContent>
              </Card>
            );
          })
        )}
      </div>

      <Dialog open={modalOpen} onOpenChange={(open) => { setModalOpen(open); if (!open) resetForm(); }}>
        <DialogContent className="sm:max-w-[480px] bg-card border-primary/20 rounded-sm font-mono">
          <DialogHeader>
            <DialogTitle className="tracking-wider uppercase text-primary flex items-center gap-2">
              <Radio className="w-5 h-5" /> {t("announcements.create")}
            </DialogTitle>
            <DialogDescription className="text-muted-foreground text-xs">
              {t("announcements.subtitle")}
            </DialogDescription>
          </DialogHeader>
          <div className="grid gap-4 py-4">
            <div className="grid grid-cols-4 items-center gap-4">
              <Label className="text-right text-xs tracking-widest">{t("announcements.fcLabel")}</Label>
              <Input
                value={fc}
                onChange={(e) => setFc(e.target.value)}
                className="col-span-3 bg-background/50 border-border/50 rounded-sm"
                placeholder={t("announcements.fcPlaceholder")}
              />
            </div>
            <div className="grid grid-cols-4 items-center gap-4">
              <Label className="text-right text-xs tracking-widest leading-tight">{t("announcements.scheduledAtLabel")}</Label>
              <Input
                type="datetime-local"
                value={scheduledAt}
                onChange={(e) => setScheduledAt(e.target.value)}
                className="col-span-3 bg-background/50 border-border/50 rounded-sm"
              />
            </div>
            <div className="grid grid-cols-4 items-center gap-4">
              <Label className="text-right text-xs tracking-widest leading-tight">{t("announcements.rallyPointLabel")}</Label>
              <Input
                value={rallyPoint}
                onChange={(e) => setRallyPoint(e.target.value)}
                className="col-span-3 bg-background/50 border-border/50 rounded-sm"
                placeholder={t("announcements.rallyPointPlaceholder")}
              />
            </div>
            <div className="grid grid-cols-4 items-center gap-4">
              <Label className="text-right text-xs tracking-widest leading-tight">{t("announcements.rallyLevelLabel")}</Label>
              <Select value={rallyLevel} onValueChange={(v) => setRallyLevel(v as RallyLevel)}>
                <SelectTrigger className="col-span-3 bg-background/50 border-border/50 rounded-sm">
                  <SelectValue placeholder="Select level..." />
                </SelectTrigger>
                <SelectContent>
                  {RALLY_LEVELS.map((lvl) => (
                    <SelectItem key={lvl} value={lvl} className="font-mono">
                      <span className={`font-bold ${
                        lvl === "MAX CTA" ? "text-red-400" :
                        lvl === "CTA" ? "text-orange-400" :
                        lvl === "战略" ? "text-yellow-400" : "text-green-400"
                      }`}>{lvl}</span>
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div className="grid grid-cols-4 items-start gap-4">
              <Label className="text-right text-xs tracking-widest mt-2">{t("announcements.notesLabel")}</Label>
              <Textarea
                value={notes}
                onChange={(e) => setNotes(e.target.value)}
                className="col-span-3 bg-background/50 border-border/50 rounded-sm resize-none"
                placeholder={t("announcements.notesPlaceholder")}
                rows={2}
              />
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => { setModalOpen(false); resetForm(); }} className="rounded-sm">
              {t("announcements.abort")}
            </Button>
            <Button
              onClick={handleCreate}
              disabled={createAnnouncement.isPending || !fc || !scheduledAt || !rallyPoint || !rallyLevel}
              className="rounded-sm"
            >
              {createAnnouncement.isPending ? <Loader2 className="w-4 h-4 animate-spin" /> : t("announcements.publish")}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
