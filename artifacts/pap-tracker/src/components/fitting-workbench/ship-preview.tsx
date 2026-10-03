import { useEffect, useRef, useState } from "react";
import type { CanonicalFit } from "../../lib/fitting-workbench-types";

export function FittingShipPreview({ fit }: { fit: CanonicalFit }) {
  const frame = useRef<HTMLIFrameElement>(null), [attempt, setAttempt] = useState(0), [status, setStatus] = useState("loading");
  const subsystems = fit.slots.filter(slot => slot.rack === "subsystem").map(slot => slot.typeId).join(",");
  const source = `/fitting-preview.html?ship=${fit.shipTypeId}&subsystems=${encodeURIComponent(subsystems)}&attempt=${attempt}`;
  useEffect(() => {
    setStatus("loading");
    const listener = (event: MessageEvent) => {
      if (event.origin === location.origin && event.source === frame.current?.contentWindow
        && event.data?.type === "fitting-3d-status" && event.data.typeId === fit.shipTypeId) setStatus(event.data.status === "ready" ? "ready" : "error");
    };
    window.addEventListener("message", listener); return () => window.removeEventListener("message", listener);
  }, [source, fit.shipTypeId]);
  return <div style={{ width: "100%", height: "100%", position: "relative" }}>
    <iframe ref={frame} key={source} src={source} title="可旋转的真实舰船 3D 模型" referrerPolicy="no-referrer" style={{ border: 0, width: "100%", height: "100%", background: "transparent" }} />
    {status === "error" && <button type="button" onClick={() => setAttempt(value => value + 1)} style={{ position: "absolute", bottom: 8, left: "50%", transform: "translateX(-50%)", background: "#102737", color: "#b8d9ed", border: "1px solid #416781", borderRadius: 3, padding: "4px 9px", fontSize: 10 }}>重试 3D 预览</button>}
  </div>;
}
