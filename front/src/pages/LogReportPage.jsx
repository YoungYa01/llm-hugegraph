import { IconBarChartVStroked, IconChevronLeft, IconRefresh } from "@douyinfe/semi-icons";
import { Table, Tag } from "@douyinfe/semi-ui";
import React, { useCallback, useEffect, useRef, useState } from "react";
import { Link, useNavigate } from "react-router-dom";
import { AppButton } from "../components/SemiAdapter.jsx";
import { EmptyState, ErrorState, LoadingState } from "../components/Ui.jsx";
import { paths } from "../routes/paths.js";
import { renderReportCharts } from "../tools/report-charts.js";
import { api } from "../utils/api.js";
import { formatConfidence, formatDate } from "../utils/ui.js";

function SectionHeading({ number, title, detail = "" }) {
	return (
		<div className="batch-report-section-heading">
			<span>{number}</span>
			<div>
				<h2>{title}</h2>
				<p>{detail}</p>
			</div>
		</div>
	);
}

function MetaItem({ label, value }) {
	return (
		<div>
			<span>{label}</span>
			<strong>{value || "—"}</strong>
		</div>
	);
}

function Figure({ label, value, hint }) {
	return (
		<article>
			<span>{label}</span>
			<strong>{value ?? "—"}</strong>
			<small>{hint}</small>
		</article>
	);
}

function CountChip({ label, value, severity }) {
	return (
		<span className={`batch-report-count-chip${severity ? ` count-${severity}` : ""}`}>
			<b>{value}</b>
			{label}
		</span>
	);
}

function NodeTable({ nodes }) {
	if (!nodes.length) return null;
	const columns = [
		{
			title: "节点",
			dataIndex: "node",
			render: (value) => <strong>{value}</strong>,
		},
		{
			title: "根因命中",
			dataIndex: "root_hits",
			render: (value) => <b className="report-number report-number-primary">{value || 0}</b>,
		},
		{
			title: "传播链出现",
			dataIndex: "chain_hits",
			render: (value) => <b className="report-number">{value || 0}</b>,
		},
		{
			title: "关联故障",
			dataIndex: "incident_count",
			render: (value) => value || 0,
		},
		{
			title: "根因占比",
			dataIndex: "root_ratio",
			render: (value) => `${Math.round(Number(value || 0) * 100)}%`,
		},
		{
			title: "主要模式",
			dataIndex: "fault_modes",
			render: (items = []) =>
				items.length ? (
					<div className="report-mode-tags">
						{items.map((item) => (
							<Tag key={item} color="blue">
								{item}
							</Tag>
						))}
					</div>
				) : (
					"—"
				),
		},
		{ title: "最近出现", dataIndex: "latest_incident_at", render: formatDate },
	];
	return (
		<div className="batch-report-table-scroll batch-report-node-table">
			<Table
				className="logscope-semi-table"
				columns={columns}
				dataSource={nodes}
				rowKey={(item) => item.node}
				pagination={false}
			/>
		</div>
	);
}

function FaultModeList({ items }) {
	if (!items.length) return null;
	return (
		<div className="batch-report-compact-list">
			{items.slice(0, 6).map((item, index) => (
				<div key={`${item.label}-${index}`}>
					<strong>{item.label}</strong>
					<span>主要根因：{item.top_root_node || "待确认"}</span>
					<b>{item.count || 0} 次</b>
				</div>
			))}
		</div>
	);
}

function RecommendationList({ items }) {
	if (!items.length) return <EmptyState title="暂无治理建议" detail="需要先形成有效的 RCA 故障结论。" />;
	return (
		<div className="batch-report-recommendations">
			{items.map((item, index) => (
				<article key={`${item.title}-${item.id}`}>
					<span className={`priority priority-${String(item.priority || "P2").toLowerCase()}`}>
						{item.priority || "P2"}
					</span>
					<div>
						<h3>{item.title}</h3>
						<p>{item.description}</p>
						{item.nodes?.length ? <small>涉及节点：{item.nodes.join("、")}</small> : null}
					</div>
				</article>
			))}
		</div>
	);
}

function FocusNodeCards({ items, projectId }) {
	if (!items.length) return <EmptyState title="暂无重点节点" detail="本批次没有被判定为根因的节点。" />;
	return (
		<div className="batch-report-focus-grid">
			{items.map((item, index) => (
				<article key={`${item.node}-${item.id}`}>
					<div className="batch-report-focus-title">
						<span>{String(index + 1).padStart(2, "0")}</span>
						<div>
							<h3>{item.node}</h3>
							<p>{item.description}</p>
						</div>
					</div>
					<dl>
						<div>
							<dt>根因命中</dt>
							<dd>{item.root_hits || 0} 次</dd>
						</div>
						<div>
							<dt>传播链出现</dt>
							<dd>{item.chain_hits || 0} 次</dd>
						</div>
						<div>
							<dt>关联故障</dt>
							<dd>{item.incident_count || 0} 个</dd>
						</div>
					</dl>
					<div className="batch-report-focus-tags">
						{(item.fault_modes || []).map((mode) => (
							<span key={`m-${mode}`}>{mode}</span>
						))}
						{(item.affected_nodes || []).map((node) => (
							<span className="affected" key={`a-${node}`}>
								影响 {node}
							</span>
						))}
					</div>
					{item.representative_evidence ? (
						<blockquote>
							<b>代表证据</b>
							{item.representative_evidence}
						</blockquote>
					) : null}
					<div className="batch-report-incident-links">
						{(item.incident_ids || []).slice(0, 5).map((id) => (
							<Link key={id} to={paths.incident(projectId, id)}>
								查看故障 {String(id).slice(0, 8)}
							</Link>
						))}
					</div>
				</article>
			))}
		</div>
	);
}

export function LogReportPage({ project, batchId }) {
	const navigate = useNavigate();
	const [state, setState] = useState({
		loading: true,
		batch: null,
		report: null,
		error: null,
	});
	const nodeRef = useRef(null);
	const modeRef = useRef(null);
	const pathRef = useRef(null);

	const load = useCallback(async () => {
		setState((current) => ({ ...current, loading: true, error: null }));
		try {
			const { batch, report } = await api.logReport(project.id, batchId);
			setState({ loading: false, batch, report: report || {}, error: null });
		} catch (error) {
			setState({ loading: false, batch: null, report: null, error });
		}
	}, [project.id, batchId]);

	useEffect(() => {
		load();
	}, [load]);

	useEffect(() => {
		if (!state.report || !nodeRef.current || !modeRef.current || !pathRef.current) return;
		renderReportCharts(
			{
				nodeFrequency: nodeRef.current,
				faultModes: modeRef.current,
				propagationPaths: pathRef.current,
			},
			state.report,
			{
				onPathClick: (path) => {
					const incidentId = path.incidentIds?.[0];
					if (incidentId) navigate(paths.incident(project.id, incidentId));
				},
			},
		);
	}, [state.report, project.id, navigate]);

	if (state.loading && !state.report) return <LoadingState message="正在读取批次 RCA 综合报告…" />;
	if (state.error) return <ErrorState error={state.error} onRetry={load} />;

	const batch = state.batch || {};
	const report = state.report || {};
	const summary = report.summary || {};
	const nodes = report.node_frequencies || [];

	return (
		<div className="batch-report-page">
			<header className="batch-report-header">
				<div>
					<Link className="batch-report-back" to={paths.reports(project.id)}>
						<IconChevronLeft size="small" />
						返回综合分析报告
					</Link>
					<div className="batch-report-kicker">BATCH RCA REPORT</div>
					<h1>综合诊断报告</h1>
					<p>汇总本批次已经完成根因分析的故障结论，定位高频故障节点、共性模式与治理优先级。</p>
				</div>
				<div className="page-actions">
					<AppButton icon={<IconRefresh />} className="button button-secondary" type="button" onClick={load}>
						刷新报告
					</AppButton>
					<Link
						className="button button-primary link-button-with-icon"
						to={paths.incidents(project.id, { batch: batchId })}
					>
						<IconBarChartVStroked size="small" />
						查看关联故障
					</Link>
				</div>
			</header>

			<section className="batch-report-meta" aria-label="报告批次信息">
				<MetaItem label="日志批次" value={batch.filename || "日志批次"} />
				<MetaItem label="完成时间" value={formatDate(batch.completed_at || batch.created_at)} />
				<MetaItem label="报告生成" value={formatDate(report.generated_at)} />
				<MetaItem label="日志规模" value={`${summary.event_count ?? 0} 条事件 / ${summary.window_count ?? 0} 个窗口`} />
			</section>

			<section className="batch-report-figures" aria-label="批次关键统计">
				<Figure label="RCA 故障" value={summary.incident_count ?? 0} hint="本批次形成的根因结论" />
				<Figure
					label="根因节点"
					value={summary.root_node_count ?? 0}
					hint={`传播涉及 ${summary.node_count ?? 0} 个节点`}
				/>
				<Figure label="平均置信度" value={formatConfidence(summary.average_confidence)} hint="全部 RCA 结论平均值" />
				<Figure
					label="治理闭环"
					value={`${summary.resolved_count ?? 0} / ${summary.incident_count ?? 0}`}
					hint={`${Math.round(Number(summary.resolution_rate || 0) * 100)}% 已解决`}
				/>
			</section>

			<section className="batch-report-section batch-report-conclusion">
				<SectionHeading number="01" title="本批次综合结论" />
				{(report.executive_conclusions || []).length ? (
					<ol className="batch-report-conclusion-list">
						{report.executive_conclusions.map((item, index) => (
							<li key={item.id}>{item}</li>
						))}
					</ol>
				) : (
					<EmptyState title="暂无综合结论" detail="本批次尚未形成可汇总的 RCA 故障记录。" />
				)}
				<div className="batch-report-status-strip">
					<CountChip label="严重" value={summary.severity_dist?.critical || 0} severity="critical" />
					<CountChip label="高" value={summary.severity_dist?.high || 0} severity="high" />
					<CountChip label="中" value={summary.severity_dist?.medium || 0} severity="medium" />
					<CountChip label="低" value={summary.severity_dist?.low || 0} severity="low" />
					<span className="batch-report-status-divider" />
					<CountChip label="待处理" value={summary.status_dist?.open || 0} />
					<CountChip label="处理中" value={summary.status_dist?.in_progress || 0} />
					<CountChip label="已解决" value={summary.status_dist?.resolved || 0} />
					<CountChip label="已忽略" value={summary.status_dist?.ignored || 0} />
				</div>
			</section>

			<section className="batch-report-section">
				<SectionHeading number="02" title="节点故障频次" />
				<div className="batch-report-legend">
					<span>
						<i className="legend-root" />
						根因命中
					</span>
					<span>
						<i className="legend-chain" />
						传播链出现
					</span>
				</div>
				<div className="report-chart report-chart-wide" ref={nodeRef} />
				<NodeTable nodes={nodes} />
			</section>

			<div className="batch-report-two-column">
				<section className="batch-report-section">
					<SectionHeading number="03" title="故障模式分布" />
					<div className="report-chart" ref={modeRef} />
					<FaultModeList items={report.fault_modes || []} />
				</section>
				<section className="batch-report-section">
					<SectionHeading number="04" title="治理优先级" detail="优先级由影响频次、根因集中度与未闭环数量共同确定。" />
					<RecommendationList items={report.governance_recommendations || []} />
				</section>
			</div>

			<section className="batch-report-section">
				<SectionHeading number="05" title="重点故障节点分析" />
				<FocusNodeCards items={report.focus_nodes || []} projectId={project.id} />
			</section>

			<section className="batch-report-section">
				<SectionHeading
					number="06"
					title="高频故障传播路径"
					detail="按完整传播链聚合排名；点击路径可查看其代表故障。"
				/>
				<div className="report-chart report-chart-wide" ref={pathRef} />
			</section>
		</div>
	);
}
