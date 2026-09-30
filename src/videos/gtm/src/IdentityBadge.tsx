import React from "react";
import { Badge } from "@/components/ui/badge";
import { ProviderLogo } from "@/components/provider-logo";
const backends: Record<string, { provider: string; label: string; background: string }> = {
  Milo: { provider: "codex", label: "Codex", background: "rgba(55, 175, 100, 0.24)" },
  Nova: { provider: "claude", label: "Claude Code", background: "rgba(235, 139, 45, 0.26)" },
  Remy: { provider: "opencode", label: "OpenCode", background: "rgba(60, 145, 225, 0.24)" },
  Pip: { provider: "cursor", label: "Cursor", background: "rgba(153, 90, 215, 0.23)" },
};


export function IdentityBadge({name}:{name:string}) {
 const backend=backends[name];
 if (!backend) return null;
 return <Badge variant="ghost" style={{color:"#4c5554",backgroundColor:backend?.background??"rgba(143,145,140,0.17)",borderRadius:4,fontSize:12,gap:5,padding:"0 6px",height:20}}>
  {backend&&<ProviderLogo provider={backend.provider} className="video-message-backend-icon"/>}
  {backend?.label??"Human"}
 </Badge>;
}
