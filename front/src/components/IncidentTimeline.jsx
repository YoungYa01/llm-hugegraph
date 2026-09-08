import React, { useMemo } from "react";
import {
	groupTimelineEvents,
	parseTimelineTime,
	rawTimelineTime,
	relativeTimelineLabel,
	timelineMessage,
	timelineRole,
} from "../utils/incident-timeline.js";
import "../styles/incident-timeline.css";

function emphasis(item) {
	const role = timelineRole(item);
	return role === "根因日志"
		? " timeline-item-root"
		: ["关键异常", "错误事件"].includes(role)
			? " timeline-item-error"
			: "";
}

function EventLabels({ item }) {
	return (
		<span className="incident-timeline-labels">
			<span className="badge">{timelineRole(item)}</span>
			<strong>{item.service || "未知服务"}</strong>
			{item.instance ? <span>实例：{item.instance}</span> : null}
			<span>{String(item.level || "LOG").toUpperCase()}</span>
		</span>
	);
}

function GroupLabels({ group }) {
	const services = [...new Set(group.entries.map(({ item }) => item.service || "未知服务"))];
	const instances = [...new Set(group.entries.map(({ item }) => item.instance || "未知实例"))];
	const levels = [...new Set(group.entries.map(({ item }) => String(item.level || "LOG").toUpperCase()))];
	return (
		<span className="incident-timeline-labels">
			<span className="badge">{group.root ? "含根因日志" : timelineRole(group.representative.item)}</span>
			<strong title={services.join("、")}>
				{services.length === 1 ? services[0] : `涉及 ${services.length} 个服务`}
			</strong>
			<span title={instances.join("、")}>
				{instances.length === 1 ? `实例：${instances[0]}` : `涉及 ${instances.length} 个实例`}
			</span>
			<span>{levels.join(" / ")}</span>
		</span>
	);
}

function EventContent({ entry, baseline, hasFaultStart }) {
	const { item, time } = entry;
	return (
		<>
			<time>
				<strong>{relativeTimelineLabel(time, baseline, hasFaultStart)}</strong>
				<span>{rawTimelineTime(item.timestamp)}</span>
			</time>
			<EventLabels item={item} />
			<p>{timelineMessage(item) || "—"}</p>
			{String(item.message || "").trim() && String(item.message).trim() !== timelineMessage(item) ? (
				<small className="incident-timeline-source">原始消息：{item.message}</small>
			) : null}
			{item.trace_id ? <small className="incident-timeline-source">trace: {item.trace_id}</small> : null}
			{item.source_file ? (
				<small className="incident-timeline-source">
					{item.source_file}
					{item.source_line != null ? `:${item.source_line}` : ""}
				</small>
			) : null}
			{item.raw_block ? (
				<details className="incident-timeline-raw">
					<summary>查看原始日志与堆栈</summary>
					<pre>{String(item.raw_block)}</pre>
				</details>
			) : null}
		</>
	);
}

export default function IncidentTimeline({ items, faultStart }) {
	const groups = useMemo(() => groupTimelineEvents(items), [items]);
	if (!groups.length) return <p style={{ color: "var(--ink-500)" }}>没有生成可用时间线。</p>;
	const configuredStart = parseTimelineTime(faultStart);
	const baseline = configuredStart ?? groups.find((group) => group.first.time !== null)?.first.time ?? null;
	const hasFaultStart = configuredStart !== null;
	const total = groups.reduce((sum, group) => sum + group.entries.length, 0);
	const repeated = groups.filter((group) => group.entries.length > 1).length;
	return (
		<div className="incident-timeline">
			<p className="incident-timeline-overview">
				共 {total} 条事件 · {groups.length} 段{repeated ? ` · ${repeated} 段连续重复（默认折叠）` : " · 无连续重复事件"}
			</p>
			<div className="timeline">
				{groups.map((group) => {
					const { first, last, representative, entries } = group;
					if (entries.length === 1)
						return (
							<article className={`timeline-item${emphasis(first.item)}`} key={group.key}>
								<EventContent entry={first} baseline={baseline} hasFaultStart={hasFaultStart} />
							</article>
						);
					return (
						<details
							className={`timeline-item incident-timeline-group${emphasis(representative.item)}`}
							key={group.key}
						>
							<summary>
								<span className="incident-timeline-group-heading">
									<strong>连续重复 {entries.length} 次</strong>
									<span className="incident-timeline-expand">展开 {entries.length} 条原始事件</span>
									<span className="incident-timeline-collapse">收起原始事件</span>
								</span>
								<time>
									<strong>
										{relativeTimelineLabel(first.time, baseline, hasFaultStart)} →{" "}
										{relativeTimelineLabel(last.time, baseline, hasFaultStart)}
									</strong>
									<span>
										{rawTimelineTime(first.item.timestamp)} — {rawTimelineTime(last.item.timestamp)}
									</span>
								</time>
								<GroupLabels group={group} />
								{group.root ? (
									<small className="incident-timeline-source">
										根因日志时间：{rawTimelineTime(representative.item.timestamp)}
									</small>
								) : null}
								<span className="incident-timeline-message">{timelineMessage(representative.item)}</span>
							</summary>
							<div className="incident-timeline-occurrences">
								{entries.map((entry, index) => (
									<article className="incident-timeline-occurrence" key={entry.index}>
										<span className="incident-timeline-occurrence-number">
											第 {index + 1} / {entries.length} 次
										</span>
										<EventContent entry={entry} baseline={baseline} hasFaultStart={hasFaultStart} />
									</article>
								))}
							</div>
						</details>
					);
				})}
			</div>
		</div>
	);
}
