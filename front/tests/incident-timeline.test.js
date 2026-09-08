import assert from "node:assert/strict";
import test from "node:test";
import { groupTimelineEvents, timelineMessage, timelineRole } from "../src/utils/incident-timeline.js";

const event = (seconds, patch = {}) => ({
	timestamp: new Date(Date.UTC(2026, 8, 2, 10, 0, seconds)).toISOString(),
	service: "api-gateway",
	instance: "gateway-1",
	level: "WARN",
	message: "Session not started for path: /security/system/getEnv",
	...patch,
});
const sizes = (events) => groupTimelineEvents(events).map((group) => group.entries.length);

test("folds only adjacent identical events and keeps each occurrence", () => {
	const input = [event(0), event(1), event(2), event(3, { message: "different" }), event(4), event(5)];
	const grouped = groupTimelineEvents(input);
	assert.deepEqual(
		grouped.map((group) => group.entries.length),
		[3, 1, 2],
	);
	assert.deepEqual(
		grouped.flatMap((group) => group.entries.map((entry) => entry.item)),
		input,
	);
});

test("sorts by timestamp without mutating original input", () => {
	const input = [event(2), event(0), event(1)];
	const before = JSON.stringify(input);
	const group = groupTimelineEvents(input)[0];
	assert.deepEqual(
		group.entries.map((entry) => entry.index),
		[1, 2, 0],
	);
	assert.equal(JSON.stringify(input), before);
});

test("root event joins identical content and becomes the highlighted representative", () => {
	const groups = groupTimelineEvents([
		event(0),
		event(1),
		event(2, { incident_role: "root_candidate" }),
		event(3),
		event(4),
	]);
	assert.equal(groups.length, 1);
	assert.equal(groups[0].entries.length, 5);
	assert.equal(groups[0].root, true);
	assert.equal(groups[0].representative.index, 2);
	assert.equal(timelineRole(event(1, { incident_role: "root_candidate" })), "根因日志");
});

test("an interval longer than one minute starts another segment", () => {
	assert.deepEqual(sizes([event(0), event(60), event(121), event(122)]), [2, 2]);
});

test("metadata differences no longer split identical display text", () => {
	for (const patch of [
		{ instance: "gateway-2" },
		{ service: "uaa" },
		{ level: "ERROR" },
		{ ip: "10.0.0.2" },
		{ port: 6380 },
	]) {
		assert.deepEqual(sizes([event(0), event(1, patch)]), [2]);
	}
});

test("different display texts split but the same root cause ignores secondary messages", () => {
	assert.deepEqual(
		sizes([event(0), event(1, { message: "Session not started for path: /uaa/oauth/authorize" })]),
		[1, 1],
	);
	assert.deepEqual(
		sizes([event(0, { root_cause: "timeout" }), event(1, { root_cause: "timeout", message: "another request" })]),
		[2],
	);
});

test("trace and source line are occurrence metadata, retained inside the group", () => {
	const group = groupTimelineEvents([
		event(0, { trace_id: "a", source_line: 1 }),
		event(1, { trace_id: "b", source_line: 2 }),
	])[0];
	assert.equal(group.entries.length, 2);
	assert.deepEqual(
		group.entries.map((entry) => entry.item.trace_id),
		["a", "b"],
	);
});

test("different raw headers and stack traces do not split the same display text", () => {
	const a = event(0, { raw_block: "2026-09-02 10:00:00 WARN demo: message\n at same.Stack:1" });
	const b = event(1, { raw_block: "2026-09-02 10:00:01 WARN demo: message\n at same.Stack:1" });
	assert.deepEqual(sizes([a, b]), [2]);
	assert.deepEqual(sizes([a, { ...b, raw_block: "2026-09-02 10:00:01 WARN demo: message\n at other.Stack:2" }]), [2]);
});

test("unknown timestamps and empty messages are not assumed identical and continuous", () => {
	assert.deepEqual(sizes([event(0, { timestamp: "invalid" }), event(1, { timestamp: "invalid" })]), [1, 1]);
	assert.deepEqual(sizes([event(0, { message: "" }), event(1, { message: "" })]), [1, 1]);
	assert.deepEqual(groupTimelineEvents(null), []);
});

test("all 301 events survive grouping and a late root becomes the representative", () => {
	const input = Array.from({ length: 300 }, (_, index) => event(index));
	input.push(event(300, { incident_role: "root_candidate" }));
	const groups = groupTimelineEvents(input);
	assert.deepEqual(
		groups.map((group) => group.entries.length),
		[301],
	);
	assert.equal(
		groups.reduce((total, group) => total + group.entries.length, 0),
		301,
	);
	assert.equal(groups.at(-1).root, true);
	assert.equal(groups[0].representative.index, 300);
});

test("display and grouping share root_cause, semantic_message, message fallback order", () => {
	assert.equal(timelineMessage({ root_cause: "root", semantic_message: "semantic", message: "raw" }), "root");
	assert.equal(timelineMessage({ root_cause: " \n ", semantic_message: "semantic", message: "raw" }), "semantic");
	assert.equal(timelineMessage({ root_cause: "", semantic_message: "  ", message: "raw" }), "raw");
	assert.deepEqual(sizes([event(0, { root_cause: "timeout" }), event(1, { semantic_message: "timeout" })]), [2]);
});

test("root cause whitespace differences merge without losing original text", () => {
	const input = [event(0, { root_cause: " Redis:  cluster\n down " }), event(1, { root_cause: "Redis: cluster down" })];
	const groups = groupTimelineEvents(input);
	assert.equal(groups.length, 1);
	assert.equal(groups[0].entries[0].item.root_cause, " Redis:  cluster\n down ");
});

test("different root causes do not merge even when every other field matches", () => {
	assert.deepEqual(
		sizes([event(0, { root_cause: "redis-1:6379 timeout" }), event(1, { root_cause: "redis-2:6379 timeout" })]),
		[1, 1],
	);
});

test("mixed severity group chooses its strongest event instead of hiding it behind WARN", () => {
	const group = groupTimelineEvents([event(0), event(1, { level: "ERROR" }), event(2, { level: "FATAL" })])[0];
	assert.equal(group.entries.length, 3);
	assert.equal(group.representative.item.level, "FATAL");
});
