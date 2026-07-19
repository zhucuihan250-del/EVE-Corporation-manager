import { Button } from "@/components/ui/button";
import { ShieldAlert } from "lucide-react";
import { useGetMe } from "@workspace/api-client-react";
import { useLocation } from "wouter";
import { useEffect } from "react";
import { useTranslation } from "react-i18next";
import { apiUrl } from "@/lib/api";
import { getErrorMessage, isUnauthorizedError } from "@/lib/api-error";

export function Login() {
  const { t } = useTranslation();
  const { data: user, isLoading, isError, error } = useGetMe();
  const [, setLocation] = useLocation();
  const hasApiError = isError && !isUnauthorizedError(error);

  useEffect(() => {
    if (!isLoading && user) {
      setLocation("/dashboard");
    }
  }, [user, isLoading, setLocation]);

  return (
    <div className="min-h-screen w-full flex items-center justify-center bg-black dark relative overflow-hidden">
      <div className="absolute inset-0 bg-[radial-gradient(circle_at_center,_var(--tw-gradient-stops))] from-primary/10 via-background to-black z-0 pointer-events-none" />
      
      <div className="z-10 w-full max-w-md p-8 border border-primary/20 bg-background/80 backdrop-blur-xl shadow-2xl shadow-primary/5 rounded-lg flex flex-col items-center">
        <div className="w-16 h-16 rounded-full bg-primary/10 border border-primary/30 flex items-center justify-center mb-8 shadow-[0_0_15px_rgba(250,204,21,0.2)]">
          <ShieldAlert className="w-8 h-8 text-primary" />
        </div>
        
        <h1 className="text-2xl font-mono text-foreground font-bold tracking-widest mb-2 text-center uppercase">{t("login.title")}</h1>
        <p className="text-sm font-mono text-muted-foreground mb-8 text-center">{t("login.subtitle")}</p>

        {isLoading && (
          <p className="mb-4 font-mono text-xs text-muted-foreground">Checking session...</p>
        )}

        {hasApiError && (
          <div className="mb-4 w-full rounded-sm border border-destructive/40 bg-destructive/10 p-3">
            <p className="font-mono text-xs text-destructive">
              {getErrorMessage(error)}
            </p>
          </div>
        )}
        
        <Button 
          asChild 
          className="w-full h-12 font-mono text-sm tracking-widest bg-primary hover:bg-primary/90 text-primary-foreground rounded-none shadow-[0_0_10px_rgba(250,204,21,0.3)] hover:shadow-[0_0_20px_rgba(250,204,21,0.5)] transition-all duration-300"
        >
          <a href={apiUrl("/api/auth/eve/login")}>
            {t("login.button")}
          </a>
        </Button>
      </div>
    </div>
  );
}
