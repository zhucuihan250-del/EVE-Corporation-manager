import type { ReactNode } from "react";
import {
  ChevronDown,
  Crosshair,
  Flame,
  Gauge,
  Shield,
  Target,
  Zap,
} from "lucide-react";
import type { WorkbenchSimulation } from "@/lib/fitting-workbench-types";
import {
  durationLabel,
  numberLabel,
} from "@/lib/fitting-workbench-presentation";

type Tr = (cn: string, en: string) => string;
function Attribute({
  label,
  value,
  unit = "",
}: {
  label: string;
  value: ReactNode;
  unit?: string;
}) {
  return (
    <div className="fit-attribute">
      <span>{label}</span>
      <strong>
        {value}
        <small>{unit && ` ${unit}`}</small>
      </strong>
    </div>
  );
}
function Section({
  label,
  icon,
  summary,
  children,
  open = true,
}: {
  label: string;
  icon: ReactNode;
  summary?: ReactNode;
  children: ReactNode;
  open?: boolean;
}) {
  return (
    <details className="fit-stat-section" open={open}>
      <summary>
        {icon}
        <span>{label}</span>
        <strong>{summary}</strong>
        <ChevronDown size={13} />
      </summary>
      <div className="fit-stat-body">{children}</div>
    </details>
  );
}
export function StatsPanel({
  simulation,
  tr,
  pending,
}: {
  simulation: WorkbenchSimulation | undefined;
  tr: Tr;
  pending: boolean;
}) {
  const stats = simulation?.stats;
  if (!stats)
    return (
      <aside className="fit-stats">
        <div className="fit-pane-title">
          <Gauge size={15} />
          {tr("舰船属性", "Ship attributes")}
        </div>
        <p className="fit-empty">
          {pending
            ? tr("正在计算…", "Calculating…")
            : tr(
                "选择舰船后显示装配属性。",
                "Select a hull to see attributes.",
              )}
        </p>
      </aside>
    );
  const { capacitor, offense, defense, repair, navigation, targeting, drones } =
    stats;
  return (
    <aside
      className={`fit-stats ${pending ? "fit-stats-pending" : ""}`}
      aria-label={tr("舰船属性", "Ship attributes")}
    >
      <div className="fit-pane-title">
        <Gauge size={15} />
        {tr("舰船属性", "Ship attributes")}
        <span className="fit-live-status">
          {pending ? tr("更新中", "Updating") : tr("即时模拟", "Live")}
        </span>
      </div>
      <Section
        label={tr("电容", "Capacitor")}
        icon={<Zap size={14} />}
        summary={
          capacitor.stable
            ? tr("稳定", "Stable")
            : durationLabel(capacitor.secondsToEmpty)
        }
      >
        <div
          className={`fit-cap-status ${capacitor.stable ? "is-stable" : "is-unstable"}`}
        >
          <div
            className="fit-cap-ring"
            style={
              {
                "--cap-level": `${Math.max(0, Math.min(100, capacitor.stable ? capacitor.stablePercent : 100))}%`,
              } as React.CSSProperties
            }
          >
            <Zap size={17} />
          </div>
          <div>
            <strong>
              {capacitor.stable
                ? `${tr("稳定于", "Stable at")} ${numberLabel(capacitor.stablePercent)}%`
                : `${tr("耗尽时间", "Depletes in")} ${durationLabel(capacitor.secondsToEmpty)}`}
            </strong>
            <small>
              {numberLabel(capacitor.capacity, 0)} GJ /{" "}
              {numberLabel(capacitor.rechargeSeconds, 0)} s
            </small>
          </div>
        </div>
        <Attribute
          label={tr("峰值回充", "Peak recharge")}
          value={numberLabel(capacitor.peakRecharge)}
          unit="GJ/s"
        />
        <Attribute
          label={tr("装配耗电", "Consumption")}
          value={numberLabel(capacitor.usage)}
          unit="GJ/s"
        />
        <Attribute
          label={tr("峰值余量", "Peak surplus")}
          value={numberLabel(capacitor.delta)}
          unit="GJ/s"
        />
      </Section>
      <Section
        label={tr("火力", "Offense")}
        icon={<Crosshair size={14} />}
        summary={`${numberLabel(offense.dps)} DPS`}
      >
        <div className="fit-offense-summary">
          <strong>
            {numberLabel(offense.dps)}
            <small>DPS</small>
          </strong>
          <span>
            {tr("齐射", "Volley")} <b>{numberLabel(offense.alpha, 0)}</b>
          </span>
        </div>
        <Attribute
          label={tr("武器", "Weapons")}
          value={numberLabel(offense.weaponDps)}
          unit="DPS"
        />
        <Attribute
          label={tr("无人机", "Drones")}
          value={numberLabel(offense.droneDps)}
          unit="DPS"
        />
        {offense.fighterDps > 0 && (
          <Attribute
            label={tr("铁骑舰载机", "Fighters")}
            value={numberLabel(offense.fighterDps)}
            unit="DPS"
          />
        )}
        <Attribute
          label={tr("含换弹火力（满装理论循环）", "Sustained (full magazine)")}
          value={numberLabel(offense.sustainedDps)}
          unit="DPS"
        />
        {offense.weapons.length > 0 && (
          <details className="fit-weapon-details">
            <summary>
              {tr("武器射程与命中", "Weapon range & application")}
            </summary>
            {offense.weapons.map((weapon) => (
              <div
                key={`${weapon.rack}:${weapon.index}`}
                className="fit-weapon-stat"
              >
                <b>
                  {tr("高槽", "High slot")} {weapon.index + 1}
                </b>
                <span>
                  {numberLabel(weapon.dps)} DPS ·{" "}
                  {numberLabel(weapon.cycleSeconds, 2)} s
                </span>
                {weapon.missileRange > 0 ? (
                  <span>
                    {tr("导弹射程", "Missile range")}{" "}
                    {numberLabel(weapon.missileRange / 1000, 2)} km
                  </span>
                ) : (
                  <>
                    <span>
                      {tr("最佳 / 失准", "Optimal / falloff")}{" "}
                      {numberLabel(weapon.optimal / 1000, 2)} /{" "}
                      {numberLabel(weapon.falloff / 1000, 2)} km
                    </span>
                    <span>
                      {tr("跟踪", "Tracking")} {numberLabel(weapon.tracking, 4)}
                    </span>
                  </>
                )}
              </div>
            ))}
          </details>
        )}
      </Section>
      <Section
        label={tr("防御", "Defense")}
        icon={<Shield size={14} />}
        summary={`${numberLabel(defense.ehp, 0)} EHP`}
      >
        <table className="fit-resist-table">
          <thead>
            <tr>
              <th>{tr("抗性", "Resists")}</th>
              <th className="damage-em" title={tr("电磁", "EM")}>
                EM
              </th>
              <th className="damage-thermal" title={tr("热能", "Thermal")}>
                TH
              </th>
              <th className="damage-kinetic" title={tr("动能", "Kinetic")}>
                KI
              </th>
              <th className="damage-explosive" title={tr("爆炸", "Explosive")}>
                EX
              </th>
            </tr>
          </thead>
          <tbody>
            {(["shield", "armor", "hull"] as const).map((layer, index) => (
              <tr key={layer}>
                <th>
                  <span>
                    {
                      [
                        tr("护盾", "Shield"),
                        tr("装甲", "Armor"),
                        tr("结构", "Hull"),
                      ][index]
                    }
                  </span>
                  <small>{numberLabel(defense[layer].hp, 0)} HP</small>
                </th>
                {(["em", "thermal", "kinetic", "explosive"] as const).map(
                  (damage) => (
                    <td key={damage}>
                      <span>
                        {numberLabel(
                          defense[layer].resistances[damage] * 100,
                          1,
                        )}
                        %
                      </span>
                      <i
                        style={{
                          width: `${Math.max(0, Math.min(100, defense[layer].resistances[damage] * 100))}%`,
                        }}
                        className={`damage-${damage}`}
                      />
                    </td>
                  ),
                )}
              </tr>
            ))}
          </tbody>
        </table>
        <Attribute
          label={tr("总有效生命", "Total EHP")}
          value={numberLabel(defense.ehp, 0)}
          unit="EHP"
        />
        <Attribute
          label={tr("被动护盾恢复", "Passive shield")}
          value={numberLabel(repair.passiveShield)}
          unit="HP/s"
        />
        <Attribute
          label={tr("护盾维修", "Shield repair")}
          value={numberLabel(repair.shield)}
          unit="HP/s"
        />
        <Attribute
          label={tr("装甲维修", "Armor repair")}
          value={numberLabel(repair.armor)}
          unit="HP/s"
        />
        {repair.hull > 0 && (
          <Attribute
            label={tr("结构维修", "Hull repair")}
            value={numberLabel(repair.hull)}
            unit="HP/s"
          />
        )}
        <Attribute
          label={tr("有效主动维修", "Effective active repair")}
          value={numberLabel(
            repair.shieldEffective +
              repair.armorEffective +
              repair.hullEffective,
          )}
          unit="EHP/s"
        />
      </Section>
      <Section
        label={tr("瞄准", "Targeting")}
        icon={<Target size={14} />}
        summary={`${numberLabel(targeting.range / 1000, 1)} km`}
        open={false}
      >
        <Attribute
          label={tr("锁定距离", "Target range")}
          value={numberLabel(targeting.range / 1000, 2)}
          unit="km"
        />
        <Attribute
          label={tr("最大目标", "Maximum targets")}
          value={targeting.maxTargets}
        />
        <Attribute
          label={tr("扫描分辨率", "Scan resolution")}
          value={numberLabel(targeting.scanResolution, 0)}
          unit="mm"
        />
        <Attribute
          label={tr("感应强度", "Sensor strength")}
          value={numberLabel(targeting.sensorStrength)}
        />
        <Attribute
          label={tr("信号半径", "Signature radius")}
          value={numberLabel(targeting.signatureRadius)}
          unit="m"
        />
      </Section>
      <Section
        label={tr("导航", "Navigation")}
        icon={<Gauge size={14} />}
        summary={`${numberLabel(navigation.speed, 0)} m/s`}
      >
        <Attribute
          label={tr("最大速度", "Maximum velocity")}
          value={numberLabel(navigation.speed, 0)}
          unit="m/s"
        />
        <Attribute
          label={tr("起跳对齐", "Align time")}
          value={numberLabel(navigation.alignSeconds, 2)}
          unit="s"
        />
        <Attribute
          label={tr("跃迁速度", "Warp speed")}
          value={numberLabel(navigation.warpSpeed, 2)}
          unit="AU/s"
        />
        <Attribute
          label={tr("质量", "Mass")}
          value={numberLabel(navigation.mass / 1000, 0)}
          unit="t"
        />
        <Attribute
          label={tr("惯性", "Inertia modifier")}
          value={numberLabel(navigation.agility, 3)}
        />
      </Section>
      <Section
        label={tr("无人机", "Drones")}
        icon={<Flame size={14} />}
        summary={`${drones.active} / ${drones.activeLimit}`}
        open={false}
      >
        <Attribute
          label={tr("无人机舱", "Drone bay")}
          value={`${numberLabel(drones.bayUsed)} / ${numberLabel(drones.bayCapacity)}`}
          unit="m³"
        />
        <Attribute
          label={tr("带宽", "Bandwidth")}
          value={`${numberLabel(drones.bandwidthUsed)} / ${numberLabel(drones.bandwidthCapacity)}`}
          unit="Mbit/s"
        />
        <Attribute
          label={tr("控制范围", "Control range")}
          value={numberLabel(drones.controlRange / 1000, 1)}
          unit="km"
        />
      </Section>
    </aside>
  );
}
