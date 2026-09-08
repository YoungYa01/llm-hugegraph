import {
	IconAlertCircle,
	IconChevronRight,
	IconEditStroked,
	IconFlag,
	IconInfoCircle,
	IconTickCircle,
} from "@douyinfe/semi-icons";
import { Button, Card, Select, Table } from "@douyinfe/semi-ui";
import { useEffect, useMemo, useState } from "react";
import { Link } from "react-router-dom";
import { ProjectModal } from "../components/ProjectModal.jsx";
import { Badge, EmptyState, ErrorState, LoadingState } from "../components/Ui.jsx";
import { paths } from "../routes/paths.js";
import { api } from "../utils/api.js";
import { formatDate } from "../utils/ui.js";

function Stat({ label, value, hint }) {
	return (
		<Card className="card stat-card semi-stat-card" bodyStyle={{ padding: 18 }}>
			<div className="stat-label">{label}</div>
			<div className="stat-value">{value ?? 0}</div>
			<div className="stat-hint">{hint}</div>
		</Card>
	);
}

function WorkflowStep({ id, number, title, detail, route }) {
	return (
		<Link to={paths.project(id, route)} className="overview-workflow-step">
			<span className="overview-workflow-number">{number}</span>
			<div>
				<strong>{title}</strong>
				<small>{detail}</small>
			</div>
			<span className="overview-workflow-arrow">
				<IconChevronRight size="small" />
			</span>
		</Link>
	);
}

function SeverityBar({ sev, total }) {
	if (!total)
		return (
			<div
				style={{
					height: 6,
					borderRadius: 3,
					background: "var(--surface-soft)",
				}}
			/>
		);
	const parts = [
		["critical", "#dc2626", "严重"],
		["high", "#f97316", "高"],
		["medium", "#eab308", "中"],
		["low", "#22c55e", "低"],
	];
	return (
		<div
			style={{
				height: 8,
				borderRadius: 4,
				overflow: "hidden",
				display: "flex",
				background: "var(--surface)",
			}}
		>
			{parts.map(([key, color, label]) => (
				<div
					key={key}
					style={{
						width: `${Math.round(((sev[key] || 0) / total) * 100)}%`,
						background: color,
					}}
					title={`${label}: ${sev[key] || 0}`}
				/>
			))}
		</div>
	);
}

export function OverviewPage({ project, onProjectUpdated }) {
	const [state, setState] = useState({
		loading: true,
		error: null,
		dashboard: null,
		batches: [],
	});
	const [batchId, setBatchId] = useState("all");
	const [editing, setEditing] = useState(false);

	async function load() {
		setState((s) => ({ ...s, loading: true }));
		try {
			const [{ dashboard }, logsData] = await Promise.all([api.dashboard(project.id), api.logs(project.id)]);
			setState({
				loading: false,
				error: null,
				dashboard,
				batches: logsData.items || [],
			});
		} catch (error) {
			setState({ loading: false, error, dashboard: null, batches: [] });
		}
	}
	useEffect(() => {
		load();
	}, [project.id]);

	const posture = useMemo(() => {
		const dashboard = state.dashboard || {};
		let sev = { critical: 0, high: 0, medium: 0, low: 0 };
		let st = { open: 0, in_progress: 0, resolved: 0 };
		let total = 0;
		if (batchId === "all") {
			sev = dashboard.severity_dist || sev;
			st = dashboard.status_dist || st;
			total = Number(dashboard.incidents || 0);
		} else {
			const target = state.batches.find((b) => b.id === batchId);
			if (target) {
				sev = target.severity_dist || sev;
				total = Number(target.summary?.incidents || 0);
				const resolved = Number(target.resolved_count || 0);
				st = { open: Math.max(0, total - resolved), in_progress: 0, resolved };
			}
		}
		return {
			sev,
			st,
			total,
			resolvedPct: total ? Math.round(((st.resolved || 0) / total) * 100) : 0,
		};
	}, [batchId, state.dashboard, state.batches]);

	if (state.loading) return <LoadingState message="正在汇总项目状态…" />;
	if (state.error) return <ErrorState error={state.error} onRetry={load} />;

	const d = state.dashboard;
	const recent = d.recent_incidents || [];
	const batches = state.batches;
	const batchOptions = [
		{ value: "all", label: "全项目汇总 (所有批次)" },
		...batches.map((b) => ({
			value: b.id,
			label: `批次：${b.filename} (${formatDate(b.created_at)})`,
		})),
	];
	const logColumns = [
		{
			title: "日志批次",
			render: (_, b) => (
				<div>
					<span className="table-title">{b.filename}</span>
					<span className="table-subtitle">{formatDate(b.created_at)}</span>
				</div>
			),
		},
		{
			title: "事件",
			render: (_, b) => (
				<>
					<strong>{b.summary?.events ?? "—"}</strong>
					<span className="table-subtitle">条日志</span>
				</>
			),
		},
		{
			title: "异常段",
			render: (_, b) => (
				<Link to={paths.incidents(project.id, { batch: b.id })} style={{ fontWeight: 700, color: "var(--brand)" }}>
					{b.summary?.incidents ?? 0} 段异常
				</Link>
			),
		},
		{
			title: "操作",
			render: (_, b) => (
				<Link className="button button-secondary button-small" to={paths.incidents(project.id, { batch: b.id })}>
					查看故障
				</Link>
			),
		},
	];
	const incidentColumns = [
		{
			title: "故障",
			render: (_, item) => (
				<div>
					<Link className="table-title" to={paths.incident(project.id, item.id)}>
						{item.title}
					</Link>
					<span className="table-subtitle">{formatDate(item.created_at)}</span>
				</div>
			),
		},
		{
			title: "等级",
			dataIndex: "severity",
			render: (value) => <Badge value={value} type="severity" />,
		},
		{
			title: "状态",
			dataIndex: "status",
			render: (value) => <Badge value={value} />,
		},
	];

	return (
		<>
			<div
				className="page-header"
				style={{
					display: "flex",
					alignItems: "center",
					justifyContent: "space-between",
					flexWrap: "wrap",
					gap: 12,
				}}
			>
				<div>
					<h1 style={{ margin: "0 0 4px 0" }}>{project.name}</h1>
					<p style={{ margin: 0 }}>{project.description || "项目架构与日志根因分析工作台"}</p>
				</div>
				<Button
					className="button button-secondary button-small"
					icon={<IconEditStroked />}
					onClick={() => setEditing(true)}
				>
					编辑项目配置
				</Button>
			</div>

			<div className="grid grid-3" style={{ marginBottom: 16 }}>
				<Stat label="日志检测批次" value={d.log_batches} hint="成功完成分析" />
				<Stat
					label="待处理故障数"
					value={(d.status_dist?.open || 0) + (d.status_dist?.in_progress || 0)}
					hint="待处理 + 处理中"
				/>
				<Stat
					label="故障解决率"
					value={`${d.incidents ? Math.round(((d.status_dist?.resolved || 0) / d.incidents) * 100) : 0}%`}
					hint={`累计故障 ${d.incidents || 0} 起 (${d.status_dist?.resolved || 0} 已闭环)`}
				/>
			</div>

			<Card className="card" bodyStyle={{ padding: "16px 20px" }} style={{ marginBottom: 20 }}>
				<div
					style={{
						display: "flex",
						alignItems: "center",
						justifyContent: "space-between",
						marginBottom: 12,
					}}
				>
					<h2 style={{ fontSize: 14, fontWeight: 700, margin: 0 }}>推荐分析工作流</h2>
				</div>
				<div className="overview-workflow-grid">
					<WorkflowStep
						id={project.id}
						number="01"
						title="导入架构描述"
						detail="由大模型抽取节点与服务依赖"
						route="architecture"
					/>
					<WorkflowStep
						id={project.id}
						number="02"
						title="日志解析检测"
						detail="滑动窗口检测日志并提取证据"
						route="logs"
					/>
					<WorkflowStep
						id={project.id}
						number="03"
						title="验证根因与链路"
						detail="结合图谱联合推理定位根因"
						route="incidents"
					/>
					<WorkflowStep
						id={project.id}
						number="04"
						title="生成综合报告"
						detail="汇总节点频次、传播路径与治理建议"
						route="reports"
					/>
				</div>
			</Card>

			<section className="card overview-posture" style={{ marginBottom: 20 }}>
				<div className="card-header overview-posture-header">
					<div className="overview-posture-heading">
						<h2>故障治理与等级分布态势</h2>
					</div>
					<div className="overview-posture-filter">
						<span>数据范围</span>
						<Select
							className="select overview-posture-select"
							value={batchId}
							optionList={batchOptions}
							onChange={setBatchId}
						/>
					</div>
				</div>

				<div className="card-body overview-posture-body">
					<div className="overview-posture-layout">
						<section className="overview-posture-panel overview-posture-severity-panel">
							<div className="overview-posture-panel-title">
								<div>
									<h3>故障等级分布</h3>
									<p>按严重程度查看当前故障风险构成</p>
								</div>
								<div className="overview-posture-total">
									<strong>{posture.total}</strong>
									<span>起故障</span>
								</div>
							</div>

							<div className="overview-severity-bar-wrap">
								<SeverityBar sev={posture.sev} total={posture.total} />
							</div>

							<div className="overview-severity-legend">
								{[
									["critical", "严重", "#dc2626", IconAlertCircle],
									["high", "高", "#ea580c", IconFlag],
									["medium", "中", "#ca8a04", IconInfoCircle],
									["low", "低", "#16a34a", IconTickCircle],
								].map(([key, label, color, SeverityIcon]) => {
									const value = Number(posture.sev[key] || 0);
									const percent = posture.total ? Math.round((value / posture.total) * 100) : 0;
									return (
										<div className="overview-severity-legend-item" key={key}>
											<span className="overview-severity-legend-name" style={{ color }}>
												<SeverityIcon size="extra-small" />
												{label}
											</span>
											<strong>{value}</strong>
											<small>{percent}%</small>
										</div>
									);
								})}
							</div>
						</section>

						<section className="overview-posture-panel overview-posture-governance-panel">
							<div className="overview-posture-panel-title">
								<div>
									<h3>故障治理进度</h3>
									<p>关注待处理、处理中与已闭环故障</p>
								</div>
							</div>

							<div className="overview-governance-content">
								<div className="overview-resolution-ring" style={{ "--resolved-pct": posture.resolvedPct }}>
									<div className="overview-resolution-ring-inner">
										<strong>{posture.resolvedPct}%</strong>
										<span>已闭环</span>
									</div>
								</div>
								<div className="overview-governance-list">
									{[
										["待处理", posture.st.open || 0, "#dc6b32"],
										["处理中", posture.st.in_progress || 0, "#3157d5"],
										["已解决", posture.st.resolved || 0, "#16a36a"],
									].map(([label, value, color]) => (
										<div className="overview-governance-item" key={label}>
											<span className="overview-governance-label">
												<i style={{ background: color }} />
												{label}
											</span>
											<strong>{value}</strong>
										</div>
									))}
								</div>
							</div>
						</section>
					</div>
				</div>
			</section>

			<div className="grid grid-2">
				<section className="card">
					<div className="card-header">
						<div>
							<h2>最近日志检测批次</h2>
							<p>最近解析的 Spring 日志及异常挖掘产物。</p>
						</div>
						<Link className="link inline-link-icon" to={paths.logs(project.id)}>
							新建批次 <IconChevronRight size="small" />
						</Link>
					</div>
					<div className="card-body flush">
						{batches.length ? (
							<Table
								className="logscope-semi-table"
								rowKey="id"
								columns={logColumns}
								dataSource={batches.slice(0, 5)}
								pagination={false}
								showHeader={false}
							/>
						) : (
							<EmptyState title="暂无日志批次" detail="点击上方开始上传日志进行解析检测。" />
						)}
					</div>
				</section>
				<section className="card">
					<div className="card-header">
						<div>
							<h2>最近故障事件</h2>
							<p>优先处理未关闭的高严重度事件。</p>
						</div>
						<Link className="link inline-link-icon" to={paths.incidents(project.id)}>
							查看全部 <IconChevronRight size="small" />
						</Link>
					</div>
					<div className="card-body flush">
						{recent.length ? (
							<Table
								className="logscope-semi-table"
								rowKey="id"
								columns={incidentColumns}
								dataSource={recent.slice(0, 5)}
								pagination={false}
								showHeader={false}
							/>
						) : (
							<EmptyState title="暂无故障事件" detail="分析日志后，生成的故障事件会出现在这里。" />
						)}
					</div>
				</section>
			</div>

			{editing ? (
				<ProjectModal
					project={project}
					onClose={() => setEditing(false)}
					onSaved={async (updated) => {
						onProjectUpdated?.(updated);
						await load();
					}}
				/>
			) : null}
		</>
	);
}
