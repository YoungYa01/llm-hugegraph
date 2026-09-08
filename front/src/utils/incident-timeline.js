export const CONTINUOUS_EVENT_GAP_MS = 60_000;

export function parseTimelineTime(value) {
	if (value === null || value === undefined || value === "") return null;
	const time = new Date(String(value).trim().replace(" ", "T").replace(",", ".")).getTime();
	return Number.isNaN(time) ? null : time;
}

export function rawTimelineTime(value) {
	return String(value || "时间未知")
		.replace("T", " ")
		.replace(/Z$/, " UTC");
}

export function relativeTimelineLabel(time, baseline, hasFaultStart) {
	if (time === null || baseline === null) return "相对时间未知";
	const delta = time - baseline;
	const prefix = hasFaultStart ? "故障" : "时间线";
	if (Math.abs(delta) < 1) return hasFaultStart ? "故障开始" : "时间线起点";
	const minutes = Math.floor(Math.abs(delta) / 60000);
	const seconds = ((Math.abs(delta) % 60000) / 1000).toFixed(Math.abs(delta) % 1000 ? 3 : 0);
	const duration = minutes ? `${minutes}分${seconds === "0" ? "" : `${seconds}秒`}` : `${seconds}秒`;
	return `${prefix}${delta < 0 ? "前" : "后"} ${duration}`;
}

export function timelineRole(item) {
	const role = String(item?.incident_role || "").toLowerCase();
	const level = String(item?.level || "LOG").toUpperCase();
	if (["root", "root_candidate", "root-candidate"].includes(role)) return "根因日志";
	if (item?.root_cause || item?.root_exception_class || item?.exception_class) return "关键异常";
	if (["FATAL", "CRITICAL", "ERROR"].includes(level)) return "错误事件";
	if (["WARN", "WARNING"].includes(level)) return "告警事件";
	return "上下文事件";
}

// Use exactly the same text for display and grouping. Metadata and secondary
// messages do not split identical root-cause descriptions; originals are kept.
export function timelineMessage(item) {
	for (const field of ["root_cause", "semantic_message", "message"]) {
		const value = String(item?.[field] ?? "")
			.replace(/\r\n?/g, "\n")
			.trim();
		if (value) return value;
	}
	return "";
}

function eventSignature(item) {
	return timelineMessage(item).replace(/\s+/g, " ") || null;
}

function eventPriority(item) {
	if (timelineRole(item) === "根因日志") return 6;
	const level = String(item.level || "").toUpperCase();
	if (["FATAL", "CRITICAL"].includes(level)) return 5;
	if (level === "ERROR") return 4;
	if (timelineRole(item) === "关键异常") return 3;
	return ["WARN", "WARNING"].includes(level) ? 2 : 1;
}

export function groupTimelineEvents(items, maxGapMs = CONTINUOUS_EVENT_GAP_MS) {
	const ordered = (Array.isArray(items) ? items : [])
		.filter((item) => item && typeof item === "object")
		.map((item, index) => ({ item, index, time: parseTimelineTime(item.timestamp) }))
		.sort((a, b) =>
			a.time === null
				? b.time === null
					? a.index - b.index
					: 1
				: b.time === null
					? -1
					: a.time - b.time || a.index - b.index,
		);
	const groups = [];
	for (const entry of ordered) {
		const signature = eventSignature(entry.item);
		const root = timelineRole(entry.item) === "根因日志";
		const previous = groups.at(-1);
		if (
			previous &&
			signature !== null &&
			previous.signature === signature &&
			entry.time !== null &&
			previous.last.time !== null &&
			entry.time - previous.last.time <= maxGapMs
		) {
			previous.entries.push(entry);
			previous.last = entry;
			previous.root ||= root;
			if (eventPriority(entry.item) > eventPriority(previous.representative.item)) {
				previous.representative = entry;
			}
		} else {
			groups.push({
				key: `event-${entry.index}`,
				signature,
				root,
				representative: entry,
				first: entry,
				last: entry,
				entries: [entry],
			});
		}
	}
	return groups;
}
