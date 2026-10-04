import { useEffect, useRef, useState } from "react";
import type { CanonicalFit } from "../../lib/fitting-workbench-types";

export function FittingShipPreview({ fit }: { fit: CanonicalFit }) {
  const frame = useRef<HTMLIFrameElement>(null), [attempt, setAttempt] = useState(0), [status, setStatus] = useState("loading");
  const subsystems = fit.slots.filter(slot => slot.rack === "subsystem").map(slot => slot.typeId).join(",");
  const source = `/fitting-preview.html?ship=${fit.shipTypeId}&subsystems=${encodeURIComponent(subsystems)}&attempt=${attempt}&v=20261004-layers`;
  useEffect(() => {
    setStatus("loading");
    const listener = (event: MessageEvent) => {
      if (event.origin === location.origin && event.source === frame.current?.contentWindow
        && event.data?.type === "fitting-3d-status" && event.data.typeId === fit.shipTypeId) setStatus(event.data.status === "ready" ? "ready" : "error");
    };
    window.addEventListener("message", listener); return () => window.removeEventListener("message", listener);
  }, [source, fit.shipTypeId]);
  return <div className="fit-3d-preview">
    <iframe ref={frame} key={source} src={source} title="可旋转的真实舰船 3D 模型" referrerPolicy="no-referrer" className="fit-3d-frame" />
    {status === "error" && <button type="button" className="fit-3d-retry" onClick={() => setAttempt(value => value + 1)}>重试 3D 预览</button>}
  </div>;
}
