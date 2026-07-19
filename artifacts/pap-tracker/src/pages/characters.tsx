import { useListCharacters } from "@workspace/api-client-react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Loader2, UserSquare2, Plus, Star } from "lucide-react";
import { useTranslation } from "react-i18next";
import { useToast } from "@/hooks/use-toast";
import { useEffect } from "react";
import { useSearch } from "wouter";
import { apiUrl } from "@/lib/api";

export function Characters() {
  const { t } = useTranslation();
  const { data: characters, isLoading } = useListCharacters({ query: { queryKey: ["characters"] } });
  const { toast } = useToast();
  const search = useSearch();

  useEffect(() => {
    const params = new URLSearchParams(search);
    if (params.get("linked") === "true") {
      toast({ title: t("characters.altLinked"), description: t("characters.altLinkedDesc") });
    } else if (params.get("error") === "already_linked") {
      toast({ title: t("characters.alreadyLinked"), description: t("characters.alreadyLinkedDesc"), variant: "destructive" });
    }
  }, []);

  const handleLinkAlt = () => {
    window.location.href = apiUrl("/api/auth/eve/link-alt");
  };

  return (
    <div className="space-y-6 animate-in fade-in slide-in-from-bottom-4 duration-500">
      <div className="flex justify-between items-start">
        <div>
          <h1 className="text-2xl font-bold font-mono tracking-wider text-foreground mb-1 uppercase">{t("characters.title")}</h1>
          <p className="text-muted-foreground font-mono text-sm">{t("characters.subtitle")}</p>
        </div>
        <Button
          onClick={handleLinkAlt}
          className="font-mono rounded-sm text-xs tracking-wider"
          variant="outline"
        >
          <Plus className="w-4 h-4 mr-2" />
          {t("characters.addAlt")}
        </Button>
      </div>

      <Card className="bg-card/20 border-border/50 rounded-sm">
        <CardHeader className="border-b border-border/30 pb-4">
          <CardTitle className="text-sm font-mono tracking-wider uppercase flex items-center gap-2">
            <UserSquare2 className="w-4 h-4 text-primary" />
            {t("characters.charName")}
          </CardTitle>
        </CardHeader>
        <CardContent className="p-0">
          {isLoading ? (
            <div className="p-8 flex justify-center">
              <Loader2 className="w-6 h-6 animate-spin text-primary" />
            </div>
          ) : !characters?.length ? (
            <div className="p-8 text-center text-muted-foreground font-mono text-sm">
              {t("characters.noCharacters")}
            </div>
          ) : (
            <Table>
              <TableHeader>
                <TableRow className="border-border/30 hover:bg-transparent">
                  <TableHead className="font-mono text-xs text-muted-foreground">{t("characters.charName")}</TableHead>
                  <TableHead className="font-mono text-xs text-muted-foreground">{t("characters.corp")}</TableHead>
                  <TableHead className="font-mono text-xs text-muted-foreground text-right">TYPE</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {characters.map((char) => (
                  <TableRow key={char.id} className="border-border/30 border-b last:border-0 hover:bg-primary/5 transition-colors">
                    <TableCell className="font-mono text-sm text-foreground">
                      <div className="flex items-center gap-2">
                        {char.isMain && <Star className="w-3 h-3 text-primary fill-primary" />}
                        <span>{char.eveCharacterName || `Character #${char.eveCharacterId}`}</span>
                      </div>
                    </TableCell>
                    <TableCell className="font-mono text-sm text-muted-foreground">
                      {char.corporationName || "—"}
                    </TableCell>
                    <TableCell className="text-right">
                      <Badge
                        variant={char.isMain ? "default" : "secondary"}
                        className="font-mono text-[10px] rounded-sm"
                      >
                        {char.isMain ? t("characters.main") : t("characters.alt")}
                      </Badge>
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          )}
        </CardContent>
      </Card>

      <Card className="bg-card/20 border-primary/10 border rounded-sm">
        <CardContent className="p-4 flex items-start gap-3">
          <Plus className="w-5 h-5 text-primary mt-0.5 flex-shrink-0" />
          <div>
            <p className="font-mono text-sm font-semibold text-foreground mb-1">{t("characters.addAltTitle")}</p>
            <p className="font-mono text-xs text-muted-foreground">{t("characters.addAltDesc")}</p>
          </div>
        </CardContent>
      </Card>
    </div>
  );
}
