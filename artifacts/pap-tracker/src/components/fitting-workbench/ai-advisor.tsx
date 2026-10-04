import { useEffect, useRef, useState } from "react";
import { AlertTriangle, Check, Copy, Loader2, Sparkles } from "lucide-react";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { fittingWorkbenchApi } from "@/lib/fitting-workbench-api";
import {
  createAdviceRequestGate,
  FITTING_ADVICE_TIMEOUT_MS,
  fittingAdviceContextKey,
  fittingAdviceErrorText,
  parseFittingAdviceBudget,
  snapshotFittingAdvice,
  type AdviceRequestTicket,
  type FittingAdviceSnapshot,
} from "@/lib/fitting-ai-advice";
import {
  durationLabel,
  numberLabel,
  rackNames,
  rackOrder,
  stateNames,
} from "@/lib/fitting-workbench-presentation";
import type {
  CanonicalFit,
  FittingAdviceMode,
  FittingAdviceChangeItem,
  FittingAdvicePrice,
  FittingAdviceResponse,
  FittingAdviceSimulation,
  FittingAdviceSuggestion,
  WorkbenchCatalogItem,
} from "@/lib/fitting-workbench-types";
import "./ai-advisor.css";

type Tr = (zh: string, en: string) => string;
type AdviceResult = {
  snapshot: FittingAdviceSnapshot;
  goal: string;
  budgetIsk?: number;
  response: FittingAdviceResponse;
};

function Price({ price, tr }: { price: FittingAdvicePrice; tr: Tr }) {
  return (
    <div className="fit-ai-price">
      <strong>
        {price.estimatedTotalIsk === null
          ? tr("价格未知", "Price unknown")
          : `${numberLabel(price.estimatedTotalIsk, 2)} ISK`}
      </strong>
      <span>{price.complete ? tr("Jita 4-4 最低卖价估算", "Jita 4-4 lowest-sell estimate") : tr("报价不完整，总价未知", "Incomplete pricing; total unknown")}</span>
      {price.missingTypeIds.length > 0 && <span className="fit-ai-warning">{tr(`缺少 ${price.missingTypeIds.length} 种物品行情，预算无法确认。`, `${price.missingTypeIds.length} item prices are missing; budget compliance is unknown.`)}</span>}
      <small>{tr("行情时间：", "Price time: ")}{dateLabel(price.checkedAt)}</small>
      <p>{price.note}</p>
    </div>
  );
}

function dateLabel(value: string) {
  const date = new Date(value);
  return Number.isFinite(date.getTime()) ? date.toLocaleString() : "—";
}

function Metrics({ simulation, delta, tr }: { simulation: FittingAdviceSimulation; delta?: FittingAdviceSuggestion["delta"]; tr: Tr }) {
  const stats = simulation.stats;
  const signed = (value: number, unit = "") => `${value > 0 ? "+" : ""}${numberLabel(value)}${unit}`;
  const values = [
    ["CPU", `${numberLabel(simulation.resources.cpu.used)} / ${numberLabel(simulation.resources.cpu.limit)} tf`, delta ? signed(delta.cpuLoad, " tf") : ""],
    [tr("能量栅格", "Powergrid"), `${numberLabel(simulation.resources.powergrid.used)} / ${numberLabel(simulation.resources.powergrid.limit)} MW`, delta ? signed(delta.powergridLoad, " MW") : ""],
    [tr("校准", "Calibration"), `${numberLabel(simulation.resources.calibration.used, 0)} / ${numberLabel(simulation.resources.calibration.limit, 0)}`, ""],
    [tr("理论火力", "Theoretical DPS"), `${numberLabel(stats.offense.dps)} DPS`, delta ? signed(delta.dps, " DPS") : ""],
    [tr("含换弹持续火力", "Sustained DPS"), `${numberLabel(stats.offense.sustainedDps)} DPS`, delta ? signed(delta.sustainedDps, " DPS") : ""],
    ["EHP", numberLabel(stats.defense.ehp, 0), delta ? signed(delta.ehp) : ""],
    [tr("电容", "Capacitor"), stats.capacitor.stable ? tr(`稳定 ${numberLabel(stats.capacitor.stablePercent)}%`, `Stable at ${numberLabel(stats.capacitor.stablePercent)}%`) : tr(`耗尽 ${durationLabel(stats.capacitor.secondsToEmpty)}`, `Depletes in ${durationLabel(stats.capacitor.secondsToEmpty)}`), ""],
    [tr("速度", "Speed"), `${numberLabel(stats.navigation.speed)} m/s`, delta ? signed(delta.speed, " m/s") : ""],
    [tr("对齐时间", "Align time"), `${numberLabel(stats.navigation.alignSeconds, 2)} s`, delta ? signed(delta.alignSeconds, " s") : ""],
  ];
  return (
    <>
      <dl className="fit-ai-metrics">
        {values.map(([label, value, change]) => <div key={label}><dt>{label}</dt><dd>{value}</dd>{change && <small>{tr("较原配置 ", "vs original ")}{change}</small>}</div>)}
      </dl>
      <p className="fit-ai-muted">{tr("持续火力为满装弹仓理论循环。弹药记录数量用于报价，不改变此理论循环；CPU / PG 差值为占用量变化，并非越高越好。", "Sustained DPS assumes theoretical full-magazine cycles. Recorded charge quantities are priced but do not alter this theoretical cycle. CPU/PG deltas are usage changes; higher is not necessarily better.")}</p>
    </>
  );
}

function Equipment({ fit, names, tr, zh }: { fit: CanonicalFit; names: Map<number, string>; tr: Tr; zh: boolean }) {
  const name = (id: number) => names.get(id) ?? `#${id}`;
  return (
    <div className="fit-ai-equipment">
      {rackOrder.map(rack => {
        const slots = fit.slots.filter(slot => slot.rack === rack).sort((a, b) => a.index - b.index);
        return slots.length > 0 && <section key={rack}><h4>{rackNames[rack][zh ? 0 : 1]}</h4>{slots.map(slot => (
          <div className="fit-ai-equipment-row" key={`${rack}:${slot.index}`}>
            <span>{slot.index + 1}</span>
            <div><strong>{name(slot.typeId)}</strong><small>{stateNames[slot.state][zh ? 0 : 1]}{slot.chargeTypeId ? ` · ${tr("装填", "Loaded")}: ${name(slot.chargeTypeId)} × ${numberLabel(slot.chargeQuantity ?? 1, 0)}` : ""}</small></div>
          </div>
        ))}</section>;
      })}
      {fit.drones.length > 0 && <section><h4>{tr("无人机 / 铁骑舰载机", "Drones / fighters")}</h4>{fit.drones.map((entry, index) => <div className="fit-ai-equipment-row" key={`${entry.typeId}:${index}`}><div><strong>{name(entry.typeId)}</strong><small>{tr(`携带 ${entry.quantity} · 出战 ${entry.activeQuantity}`, `${entry.quantity} carried · ${entry.activeQuantity} launched`)}</small></div></div>)}</section>}
      {fit.cargo.length > 0 && <section><h4>{tr("货舱 / 备用弹药", "Cargo / spare charges")}</h4>{fit.cargo.map((entry, index) => <div className="fit-ai-equipment-row" key={`${entry.typeId}:${index}`}><div><strong>{name(entry.typeId)}</strong><small>× {numberLabel(entry.quantity, 0)}</small></div></div>)}</section>}
      {(fit.implants?.length || fit.boosters?.length) ? <section><h4>{tr("保留的植入体 / 增效剂", "Retained implants / boosters")}</h4>{[...(fit.implants ?? []), ...(fit.boosters ?? [])].map((entry, index) => <div className="fit-ai-equipment-row" key={`${entry.typeId}:${index}`}><div><strong>{name(entry.typeId)}</strong></div></div>)}</section> : null}
    </div>
  );
}

function changeLabel(item: FittingAdviceChangeItem | null, tr: Tr, zh: boolean) {
  if (!item) return tr("无", "None");
  const parts = [`${item.name} × ${numberLabel(item.quantity, 0)}`];
  if (item.state) parts.push(Object.hasOwn(stateNames, item.state) ? stateNames[item.state as keyof typeof stateNames][zh ? 0 : 1] : item.state);
  if (item.chargeTypeId) parts.push(`${tr("装填", "Loaded")}: ${item.chargeName ?? `#${item.chargeTypeId}`} × ${numberLabel(item.chargeQuantity ?? 1, 0)}`);
  if (item.activeQuantity !== null) parts.push(tr(`出战 ${numberLabel(item.activeQuantity, 0)}`, `${numberLabel(item.activeQuantity, 0)} launched`));
  return parts.join(" · ");
}

/** This component deliberately receives no edit/save/apply callback. */
export function FittingAiAdvisor({ open, onOpenChange, fit, actorKey, language, lookup, characterName }: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  fit: CanonicalFit;
  actorKey: string;
  language: "zh" | "en";
  lookup: Map<number, WorkbenchCatalogItem>;
  characterName?: string;
}) {
  const zh = language === "zh", tr: Tr = (cn, en) => zh ? cn : en;
  const [gate] = useState(createAdviceRequestGate);
  const [mode, setMode] = useState<FittingAdviceMode>("optimize");
  const [goal, setGoal] = useState("");
  const [budget, setBudget] = useState("");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [feedback, setFeedback] = useState("");
  const [copyNotice, setCopyNotice] = useState("");
  const [result, setResult] = useState<AdviceResult | null>(null);
  const [names, setNames] = useState<Map<number, string>>(new Map());
  const busyRef = useRef(false);
  const deadline = useRef<{ ticket: AdviceRequestTicket; timer: number } | null>(null);
  const contextKey = fittingAdviceContextKey(fit, actorKey, language);
  const currentContext = useRef(contextKey);
  const previousContext = useRef(contextKey);
  const previousActor = useRef(actorKey);
  const openRef = useRef(open);
  currentContext.current = contextKey;
  openRef.current = open;
  const visibleResult = result?.snapshot.contextKey === contextKey ? result : null;
  const clearDeadline = (ticket?: AdviceRequestTicket) => {
    if (deadline.current && (!ticket || deadline.current.ticket === ticket)) {
      window.clearTimeout(deadline.current.timer);
      deadline.current = null;
    }
  };

  const stop = (reason: "cancelled" | "closed") => {
    clearDeadline();
    gate.cancel(reason);
    busyRef.current = false;
    setLoading(false);
    if (reason === "cancelled") setFeedback(tr("已取消生成，当前配装未改变。", "Generation cancelled; your fitting is unchanged."));
  };
  const close = () => {
    stop("closed");
    setResult(null);
    setError("");
    setFeedback("");
    setCopyNotice("");
    onOpenChange(false);
  };

  useEffect(() => {
    openRef.current = open;
    return () => { openRef.current = false; clearDeadline(); gate.cancel("unmounted"); };
  }, [gate]);
  useEffect(() => {
    if (!open) {
      clearDeadline();
      gate.cancel("closed");
      busyRef.current = false;
      setLoading(false);
      setResult(null);
      setError("");
      setFeedback("");
      setCopyNotice("");
    }
  }, [open, gate]);
  useEffect(() => {
    if (previousContext.current === contextKey) return;
    const changedActor = previousActor.current !== actorKey;
    previousContext.current = contextKey;
    previousActor.current = actorKey;
    clearDeadline();
    gate.cancel("stale");
    busyRef.current = false;
    setLoading(false);
    setResult(null);
    setError("");
    setCopyNotice("");
    setNames(new Map());
    setFeedback(open && !changedActor && (loading || result)
      ? tr("配装、技能或语言已变更，旧快照建议已作废，请重新生成。", "Your fitting, skills or language changed. Previous snapshot advice was discarded; generate again.") : "");
    if (changedActor) { setGoal(""); setBudget(""); setMode("optimize"); }
  }, [contextKey, actorKey, gate]);

  useEffect(() => {
    if (!open || !visibleResult) return;
    const controller = new AbortController();
    const response = visibleResult.response;
    const known = new Map([...lookup].map(([id, item]) => [id, item.name]));
    for (const simulation of [response.baselineSimulation, ...response.suggestions.map(item => item.simulation)]) {
      known.set(simulation.ship.typeId, simulation.ship.name);
      for (const item of simulation.modules) known.set(item.typeId, item.name);
    }
    for (const suggestion of response.suggestions) for (const change of suggestion.changes) {
      for (const item of [change.before, change.after]) if (item) {
        known.set(item.typeId, item.name);
        if (item.chargeTypeId && item.chargeName) known.set(item.chargeTypeId, item.chargeName);
      }
    }
    setNames(known);
    const ids = [...new Set(response.suggestions.flatMap(({ fit: suggestion }) => [
      ...suggestion.slots.flatMap(slot => [slot.typeId, slot.chargeTypeId ?? 0]),
      ...suggestion.drones.map(item => item.typeId), ...suggestion.cargo.map(item => item.typeId),
      ...(suggestion.implants ?? []).map(item => item.typeId), ...(suggestion.boosters ?? []).map(item => item.typeId),
    ]))].filter(id => id > 0 && !known.has(id));
    if (ids.length) void Promise.all(Array.from({ length: Math.ceil(ids.length / 100) }, (_, index) =>
      fittingWorkbenchApi.catalog({ typeIds: ids.slice(index * 100, (index + 1) * 100).join(","), language }, controller.signal),
    )).then(chunks => {
      if (controller.signal.aborted || !openRef.current || currentContext.current !== contextKey) return;
      const complete = new Map(known);
      for (const chunk of chunks) for (const item of chunk.items) complete.set(item.typeId, item.name);
      setNames(complete);
    }).catch(() => { /* Numeric type IDs and the complete EFT remain available. */ });
    return () => controller.abort();
  }, [visibleResult, lookup, language, open, contextKey]);

  const generate = async () => {
    if (busyRef.current) return;
    setError(""); setFeedback(""); setCopyNotice("");
    if (!fit.shipTypeId) { setError(tr("请先选择要配装的舰船。", "Select a hull first.")); return; }
    if (!goal.trim() || goal.trim().length > 500) { setError(tr("请填写 1–500 字的用途和作战场景。", "Describe your goal and scenario in 1–500 characters.")); return; }
    const budgetIsk = parseFittingAdviceBudget(budget);
    if (budgetIsk === null) { setError(tr("预算须为 0–10 万亿 ISK，最多两位小数；留空表示不设预算。", "Budget must be 0–10 trillion ISK, with up to two decimals; leave blank for no budget.")); return; }
    const snapshot = snapshotFittingAdvice(fit, actorKey, language);
    const ticket = gate.begin(snapshot);
    const requestedGoal = goal.trim();
    busyRef.current = true;
    setLoading(true);
    setResult(null);
    const timer = window.setTimeout(() => {
      clearDeadline(ticket);
      if (!openRef.current || !gate.isCurrent(ticket, currentContext.current)) return;
      if (gate.cancelTicket(ticket, "timeout")) {
        busyRef.current = false; setLoading(false);
        setError(fittingAdviceErrorText(Object.assign(new Error(), { code: "FITTING_AI_TIMEOUT" }), zh));
      }
    }, FITTING_ADVICE_TIMEOUT_MS);
    deadline.current = { ticket, timer };
    try {
      const response = await fittingWorkbenchApi.advice({
        fit: snapshot.fit, mode, goal: requestedGoal, language,
        ...(budgetIsk === undefined ? {} : { budgetIsk }),
      }, ticket.controller.signal);
      if (!openRef.current || !gate.isCurrent(ticket, currentContext.current)) return;
      setResult({ snapshot, goal: requestedGoal, budgetIsk, response });
    } catch (caught) {
      if (openRef.current && gate.isCurrent(ticket, currentContext.current)) setError(fittingAdviceErrorText(caught, zh));
    } finally {
      clearDeadline(ticket);
      if (gate.isCurrent(ticket, currentContext.current)) {
        gate.finish(ticket); busyRef.current = false; setLoading(false);
      }
    }
  };

  const clearPrevious = () => { setResult(null); setError(""); setFeedback(""); setCopyNotice(""); };
  const copy = async (suggestion: FittingAdviceSuggestion) => {
    const snapshotKey = visibleResult?.snapshot.contextKey;
    if (!snapshotKey || snapshotKey !== currentContext.current) return;
    try {
      await navigator.clipboard.writeText(suggestion.eft);
      if (openRef.current && snapshotKey === currentContext.current) setCopyNotice(tr("建议 EFT 已复制；请自行在游戏中检查、使用。网站当前配装未改变。", "Suggested EFT copied. Check and use it yourself in-game; the website fitting is unchanged."));
    } catch {
      if (openRef.current && snapshotKey === currentContext.current) setCopyNotice(tr("无法自动复制，请在下方 EFT 文本框中选择并手动复制。", "Automatic copy is unavailable. Select and copy the EFT text below manually."));
    }
  };
  const hullName = lookup.get(fit.shipTypeId)?.name ?? `#${fit.shipTypeId}`;
  const skillLabel = fit.skillProfile.mode === "all5" ? tr("全 V 技能（理论）", "All V skills (theoretical)")
    : fit.skillProfile.mode === "none" ? tr("无技能", "No skills") : characterName ?? tr("本人角色技能", "Your character skills");

  return (
    <Dialog open={open} onOpenChange={next => next ? onOpenChange(true) : close()}>
      <DialogContent className="fit-ai-dialog">
        <DialogHeader>
          <DialogTitle className="fit-ai-title"><Sparkles size={18} />{tr("AI 配船建议", "AI fitting advice")}</DialogTitle>
          <DialogDescription>{tr("只提供建议，不替换当前配装，也不保存或修改任何配置。", "Advice only: this does not replace, save or modify any fitting.")}</DialogDescription>
        </DialogHeader>
        <div className="fit-ai-context"><strong>{tr("固定船体：", "Fixed hull: ")}{hullName}</strong><span>{tr("继承技能：", "Inherited skills: ")}{skillLabel}</span><span>{tr("继承当前伤害模型、舰船模式、植入体与增效剂。要换船请关闭此窗口，在装备浏览器选择船体。", "Current damage profile, hull mode, implants and boosters are retained. To change hulls, close this window and select one in the equipment browser.")}</span></div>
        <fieldset className="fit-ai-modes" disabled={loading}>
          <legend>{tr("建议类型", "Advice mode")}</legend>
          <label><input type="radio" name="fitting-ai-mode" value="optimize" checked={mode === "optimize"} onChange={() => { clearPrevious(); setMode("optimize"); }} /><span><strong>{tr("优化当前配装", "Optimize current fitting")}</strong><small>{tr("根据现有装备给出调整方案", "Suggest adjustments to existing equipment")}</small></span></label>
          <label><input type="radio" name="fitting-ai-mode" value="new" checked={mode === "new"} onChange={() => { clearPrevious(); setMode("new"); }} /><span><strong>{tr("从当前船体重新配装", "Build a new fitting for this hull")}</strong><small>{tr("重建装备、无人机和货舱；船体不变", "Rebuild modules, drones and cargo; same hull")}</small></span></label>
        </fieldset>
        {mode === "optimize" && !fit.slots.length && !fit.drones.length && <p className="fit-ai-muted">{tr("当前尚无装备，可选择“从当前船体重新配装”获得完整建议。", "This hull has no modules yet. Choose a new fitting for a complete suggestion.")}</p>}
        <div className="fit-ai-form">
          <label htmlFor="fitting-ai-goal">{tr("用途与作战场景", "Goal and combat scenario")}<textarea id="fitting-ai-goal" value={goal} maxLength={500} disabled={loading} placeholder={tr("例如：低安单人游走，近距离缠斗，优先机动和控制；请说明 PvE / PvP、单人或舰队、敌人和距离。", "Example: solo low-sec roaming, close-range brawling, prioritize mobility and tackle. Include PvE/PvP, solo/fleet, targets and range.")} onChange={event => { clearPrevious(); setGoal(event.target.value); }} /></label>
          <label htmlFor="fitting-ai-budget">{tr("预算上限（ISK，可留空）", "Budget cap (ISK, optional)")}<input id="fitting-ai-budget" inputMode="decimal" value={budget} disabled={loading} maxLength={20} placeholder="50000000" onChange={event => { clearPrevious(); setBudget(event.target.value); }} /><small>{tr("总预算包括船体、装备、指定弹药、无人机、货舱及保留的植入体、增效剂。0 表示零预算。", "Total budget includes hull, modules, specified charges, drones, cargo and retained implants/boosters. 0 means a zero budget.")}</small></label>
        </div>
        <div className="fit-ai-actions">
          <button type="button" className="fit-ai-button is-primary" disabled={loading || !fit.shipTypeId || !goal.trim()} onClick={() => void generate()}>{loading ? <Loader2 className="fit-ai-spinner" size={14} /> : <Sparkles size={14} />}{tr("生成配船建议", "Generate fitting advice")}</button>
          {loading && <button type="button" className="fit-ai-button" onClick={() => stop("cancelled")}>{tr("取消生成", "Cancel generation")}</button>}
          <button type="button" className="fit-ai-button" onClick={close}>{tr("关闭", "Close")}</button>
        </div>
        {loading && <p className="fit-ai-muted" role="status">{tr("正在生成并逐项核验装备、技能与行情…当前配装不会改变。", "Generating and checking equipment, skills and market estimates… Your fitting will not change.")}</p>}
        {error && <div className="fit-ai-error" role="alert"><AlertTriangle size={14} /><span>{error}</span></div>}
        {feedback && <p className="fit-ai-warning" role="status">{feedback}</p>}
        {copyNotice && <p className="fit-ai-muted" role="status">{copyNotice}</p>}
        {visibleResult && <div className="fit-ai-results">
          <div className="fit-ai-summary"><h3>{tr("本次请求的建议", "Advice for this request")}</h3><p>{visibleResult.goal}</p><p>{visibleResult.response.summary}</p><small>AI · {visibleResult.response.model} · {dateLabel(visibleResult.response.generatedAt)}</small></div>
          <p className="fit-ai-verification"><Check size={14} />{tr("数值由 Dogma 引擎校验；AI 的适用性和取舍判断不等于实战最优或游戏内逐项实测。", "Numbers are checked by the Dogma engine. AI suitability and trade-offs are not proof of optimal combat performance or item-by-item in-game testing.")}</p>
          {visibleResult.response.skillSource.mode === "all5" && <p className="fit-ai-warning">{tr("这些建议使用全 V 理论技能，未验证你的角色是否能驾驶或使用装备。", "These suggestions use theoretical all V skills. Your character's ability to fly the hull or use its equipment is not verified.")}</p>}
          {visibleResult.response.skillSource.mode === "character" && <p className="fit-ai-muted">{tr("核验角色：", "Verified character: ")}{visibleResult.response.skillSource.characterName ?? characterName}{" · "}{tr("技能读取时间：", "Skills checked: ")}{visibleResult.response.skillSource.checkedAt ? dateLabel(visibleResult.response.skillSource.checkedAt) : "—"}</p>}
          {visibleResult.response.warnings.length > 0 && <ul className="fit-ai-warning-list">{visibleResult.response.warnings.map((warning, index) => <li key={index}>{warning}</li>)}</ul>}
          <details className="fit-ai-baseline"><summary>{tr("查看请求时的原配置基准", "Original fitting at request time")}</summary><Metrics simulation={visibleResult.response.baselineSimulation} tr={tr} /><Price price={visibleResult.response.baselinePrice} tr={tr} /></details>
          {visibleResult.response.suggestions.map((suggestion, index) => <article className="fit-ai-candidate" key={suggestion.id}>
            <header><h3>{index + 1}. {suggestion.title}</h3><span className="fit-ai-verified">{tr("装配校验通过", "Fitting checks passed")}</span></header>
            <p><strong>{tr("AI 建议理由：", "AI rationale: ")}</strong>{suggestion.rationale}</p>
            {suggestion.tradeoffs.length > 0 && <div><h4>{tr("取舍与风险", "Trade-offs and risks")}</h4><ul>{suggestion.tradeoffs.map((item, i) => <li key={i}>{item}</li>)}</ul></div>}
            <Metrics simulation={suggestion.simulation} delta={suggestion.delta} tr={tr} />
            <Price price={suggestion.price} tr={tr} />
            <p className={suggestion.withinBudget === false || (!suggestion.price.complete && visibleResult.budgetIsk !== undefined) ? "fit-ai-warning" : "fit-ai-muted"}>{suggestion.withinBudget === false ? tr("此建议超出设定预算。装配通过不等于预算达标。", "This suggestion exceeds your budget. Fitting validity does not mean budget compliance.") : visibleResult.budgetIsk === undefined ? tr("未设置预算上限。", "No budget cap was set.") : suggestion.withinBudget === true && suggestion.price.complete ? tr(`按此行情估算在 ${numberLabel(visibleResult.budgetIsk, 2)} ISK 预算内，不保证实际成交价。`, `Within your ${numberLabel(visibleResult.budgetIsk, 2)} ISK budget at this estimate; execution price is not guaranteed.`) : tr("预算是否达标未知；请核对完整行情。", "Budget compliance is unknown; check complete market prices.")}</p>
            <details open><summary>{tr("具体装备、弹药与无人机", "Modules, charges and drones")}</summary><Equipment fit={suggestion.fit} names={names} tr={tr} zh={zh} /></details>
            {suggestion.changes.length > 0 && <details><summary>{tr(`相对原配置的 ${suggestion.changes.length} 项变化`, `${suggestion.changes.length} changes from the original`)}</summary><ul>{suggestion.changes.map((change, i) => <li key={i}>{change.rack ? `${rackNames[change.rack][zh ? 0 : 1]} ${(change.index ?? 0) + 1} · ` : `${change.section === "drone" ? tr("无人机", "Drone") : tr("货舱", "Cargo")} · `}{changeLabel(change.before, tr, zh)} → {changeLabel(change.after, tr, zh)}</li>)}</ul></details>}
            {[...suggestion.warnings, ...suggestion.eftWarnings].length > 0 && <ul className="fit-ai-warning-list">{[...suggestion.warnings, ...suggestion.eftWarnings].map((warning, i) => <li key={i}>{warning}</li>)}</ul>}
            <details><summary>{tr("建议 EFT 文本（自行使用）", "Suggested EFT text (use yourself)")}</summary><textarea className="fit-ai-eft" readOnly value={suggestion.eft} aria-label={tr(`建议 EFT：${suggestion.title}`, `Suggested EFT: ${suggestion.title}`)} onFocus={event => event.currentTarget.select()} /></details>
            <button type="button" className="fit-ai-button" onClick={() => void copy(suggestion)}><Copy size={13} />{tr("复制建议 EFT", "Copy suggested EFT")}</button>
          </article>)}
          {visibleResult.response.rejectedSuggestions > 0 && <p className="fit-ai-muted">{tr(`已剔除 ${visibleResult.response.rejectedSuggestions} 个未通过核验的候选。`, `${visibleResult.response.rejectedSuggestions} unverified candidates were discarded.`)}</p>}
          {visibleResult.response.usage && <p className="fit-ai-muted">{tr("本次用量：", "This request: ")}{tr(`输入 ${numberLabel(visibleResult.response.usage.inputTokens, 0)} / 输出 ${numberLabel(visibleResult.response.usage.outputTokens, 0)} / 共 ${numberLabel(visibleResult.response.usage.totalTokens, 0)} tokens；这不是费用或剩余额度。`, `${numberLabel(visibleResult.response.usage.inputTokens, 0)} input / ${numberLabel(visibleResult.response.usage.outputTokens, 0)} output / ${numberLabel(visibleResult.response.usage.totalTokens, 0)} total tokens; not a bill or remaining quota.`)}</p>}
        </div>}
      </DialogContent>
    </Dialog>
  );
}
