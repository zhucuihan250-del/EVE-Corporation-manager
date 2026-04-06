import { Button } from "@/components/ui/button";
import { ShieldAlert } from "lucide-react";
import { useGetMe } from "@workspace/api-client-react";
import { useLocation } from "wouter";
import { useEffect } from "react";

export function Login() {
  const { data: user, isLoading } = useGetMe();
  const [, setLocation] = useLocation();

  useEffect(() => {
    if (!isLoading && user) {
      setLocation("/dashboard");
    }
  }, [user, isLoading, setLocation]);

  if (isLoading) return null;

  return (
    <div className="min-h-screen w-full flex items-center justify-center bg-black dark relative overflow-hidden">
      <div className="absolute inset-0 bg-[radial-gradient(circle_at_center,_var(--tw-gradient-stops))] from-primary/10 via-background to-black z-0 pointer-events-none" />
      
      <div className="z-10 w-full max-w-md p-8 border border-primary/20 bg-background/80 backdrop-blur-xl shadow-2xl shadow-primary/5 rounded-lg flex flex-col items-center">
        <div className="w-16 h-16 rounded-full bg-primary/10 border border-primary/30 flex items-center justify-center mb-8 shadow-[0_0_15px_rgba(250,204,21,0.2)]">
          <ShieldAlert className="w-8 h-8 text-primary" />
        </div>
        
        <h1 className="text-2xl font-mono text-foreground font-bold tracking-widest mb-2 text-center uppercase">Secure Login</h1>
        <p className="text-sm font-mono text-muted-foreground mb-8 text-center">Authentication required to access Alliance Tactical Network</p>
        
        <Button 
          asChild 
          className="w-full h-12 font-mono text-sm tracking-widest bg-primary hover:bg-primary/90 text-primary-foreground rounded-none shadow-[0_0_10px_rgba(250,204,21,0.3)] hover:shadow-[0_0_20px_rgba(250,204,21,0.5)] transition-all duration-300"
        >
          <a href="/api/auth/eve/login">
            AUTHORIZE VIA EVE SSO
          </a>
        </Button>
      </div>
    </div>
  );
}