import { Spin } from "@douyinfe/semi-ui";
import { useEffect, useState } from "react";

export function GraphDeleteProgress({ operation }) {
	const [seconds, setSeconds] = useState(0);
	useEffect(() => {
		const tick = () => setSeconds(Math.floor((Date.now() - operation.startedAt) / 1000));
		tick();
		const timer = setInterval(tick, 1000);
		return () => clearInterval(timer);
	}, [operation.startedAt]);
	return (
		<div role="status" aria-live="polite" style={{ padding: "12px 0", lineHeight: 1.8 }}>
			<div style={{ display: "flex", alignItems: "center", gap: 12 }}>
				<Spin size="middle" />
				<strong>{operation.label}</strong>
			</div>
			<p style={{ marginTop: 16 }}>正在删除并读取最新图谱，已等待 {seconds} 秒。</p>
			<p style={{ color: "var(--ink-500)", marginBottom: 0 }}>
				{seconds >= 15
					? "处理时间较长，可能涉及较多相邻关系或图数据库响应较慢。请求尚未结束，请勿重复提交或关闭页面。"
					: operation.kind.includes("node")
						? "删除节点会同时清理相邻关系。请等待服务器返回实际结果，请勿重复操作。"
						: "正在删除所选关系，保留关系两端的节点。请等待服务器返回实际结果，请勿重复操作。"}
			</p>
		</div>
	);
}
