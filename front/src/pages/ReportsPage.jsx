import { IconEyeOpened, IconLightningStroked, IconPlus, IconSpin } from "@douyinfe/semi-icons";
import { Button, Table, Tag } from "@douyinfe/semi-ui";
import { useCallback, useEffect, useMemo, useState } from "react";
import { Link } from "react-router-dom";
import { Badge, EmptyState, ErrorState, LoadingState } from "../components/Ui.jsx";
import { paths } from "../routes/paths.js";
import { api } from "../utils/api.js";
import { formatDate, toast } from "../utils/ui.js";

const REPORT_STATUS = {
	not_generated: ["尚未生成", "neutral"],
	processing: ["智能分析中", "processing"],
	completed: ["报告已生成", "completed"],
	failed: ["生成失败", "failed"],
};

export function ReportsPage({ project }) {
	const [batches, setBatches] = useState([]);
	const [loading, setLoading] = useState(true);
	const [error, setError] = useState(null);
	const [busy, setBusy] = useState("");

	const load = useCallback(
		async ({ quiet = false } = {}) => {
			try {
				const items = (await api.logs(project.id)).items || [];
				setBatches(items);
				setError(null);
			} catch (err) {
				if (!quiet) setError(err);
			} finally {
				setLoading(false);
			}
		},
		[project.id],
	);

	useEffect(() => {
		load();
	}, [load]);
	useEffect(() => {
		if (!batches.some((b) => b.report_status === "processing")) return undefined;
		const timer = window.setTimeout(() => load({ quiet: true }), 1500);
		return () => clearTimeout(timer);
	}, [batches, load]);

	const analyzable = useMemo(() => batches.filter((b) => b.status === "completed"), [batches]);

	async function generate(item) {
		setBusy(item.id);
		try {
			const result = await api.generateLogReport(project.id, item.id);
			setBatches((list) =>
				list.map((b) =>
					b.id === item.id
						? {
								...b,
								...(result.batch || {}),
								report_status: result.batch?.report_status || "processing",
							}
						: b,
				),
			);
			if (result.message === "report_already_generated") toast("该批次报告已经生成，可以直接查看。", "success");
			else if (result.message === "report_analysis_in_progress") toast("该批次正在进行智能分析，请稍后查看。", "info");
			else toast("已开始智能分析。您可以离开此页面，完成后可直接查看报告。", "info");
		} catch (err) {
			toast(err.message, "error");
		} finally {
			setBusy("");
		}
	}

	const columns = useMemo(
		() => [
			{
				title: "日志批次",
				dataIndex: "filename",
				render: (_, item) => (
					<div>
						<strong>{item.filename}</strong>
						<span className="table-subtitle">{formatDate(item.created_at)}</span>
						{item.report_error_message ? (
							<span className="table-subtitle" style={{ color: "var(--danger)" }}>
								{item.report_error_message}
							</span>
						) : null}
					</div>
				),
			},
			{
				title: "RCA 状态",
				dataIndex: "status",
				render: (value) => <Badge value={value} />,
			},
			{
				title: "报告状态",
				dataIndex: "report_status",
				render: (value) => {
					const status = value || "not_generated";
					const [label, badgeType] = REPORT_STATUS[status] || REPORT_STATUS.not_generated;
					return (
						<Tag className={`badge badge-${badgeType}`}>
							{status === "processing" ? <IconSpin spin size="small" /> : null}
							{label}
						</Tag>
					);
				},
			},
			{
				title: "申请时间",
				dataIndex: "report_requested_at",
				render: formatDate,
			},
			{
				title: "完成时间",
				dataIndex: "report_generated_at",
				render: formatDate,
			},
			{
				title: "操作",
				render: (_, item) => {
					const status = item.report_status || "not_generated";
					const canGenerate = item.status === "completed" && ["not_generated", "failed"].includes(status);
					return (
						<div className="page-actions">
							{canGenerate ? (
								<Button
									className="button button-primary button-small"
									theme="solid"
									type="primary"
									icon={<IconLightningStroked />}
									loading={busy === item.id}
									onClick={() => generate(item)}
								>
									{status === "failed" ? "重新生成" : "生成报告"}
								</Button>
							) : null}
							{status === "processing" ? (
								<span className="report-processing-copy">正在汇总根因结论与传播链…</span>
							) : null}
							{status === "completed" ? (
								<Link
									className="button button-secondary button-small link-button-with-icon"
									to={paths.report(project.id, item.id)}
								>
									<IconEyeOpened />
									查看报告
								</Link>
							) : null}
							{item.status !== "completed" ? <span className="table-subtitle">等待 RCA 完成</span> : null}
						</div>
					);
				},
			},
		],
		[busy, project.id],
	);

	if (loading) return <LoadingState message="正在读取报告生成状态…" />;
	if (error) return <ErrorState error={error} onRetry={() => load()} />;

	return (
		<>
			<div className="page-header report-center-header">
				<div>
					<h1>综合分析报告</h1>
					<p></p>
				</div>
				<Link className="button button-secondary link-button-with-icon" to={paths.logs(project.id)}>
					<IconPlus />
					新建日志分析
				</Link>
			</div>

			<section className="card">
				<div className="card-header">
					<div>
						<h2>报告批次</h2>
						<p></p>
					</div>
				</div>
				<div className="card-body flush">
					{!batches.length ? (
						<EmptyState title="暂无日志批次" detail="请先上传日志并完成根因定位分析。">
							<Link className="button button-primary" to={paths.logs(project.id)}>
								开始日志分析
							</Link>
						</EmptyState>
					) : (
						<Table
							className="logscope-semi-table"
							rowKey="id"
							columns={columns}
							dataSource={batches}
							pagination={false}
						/>
					)}
				</div>
			</section>
		</>
	);
}
