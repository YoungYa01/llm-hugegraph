import { IconBarChartVStroked, IconPlus, IconSearch } from "@douyinfe/semi-icons";
import { Input, Pagination, Select, Table, Tag } from "@douyinfe/semi-ui";
import { useEffect, useMemo, useRef, useState } from "react";
import { Link, useSearchParams } from "react-router-dom";
import { Badge, EmptyState, ErrorState, LoadingState } from "../components/Ui.jsx";
import { paths } from "../routes/paths.js";
import { api } from "../utils/api.js";
import { formatConfidence, formatDate } from "../utils/ui.js";

const PAGE_SIZES = [10, 20, 50];

function stateFromParams(params) {
	const requestedSize = Number(params.get("page_size") || 10);
	return {
		status: params.get("status") || "",
		severity: params.get("severity") || "",
		batch_id: params.get("batch") || params.get("batch_id") || "",
		q: params.get("q") || "",
		page: Math.max(1, Number(params.get("page") || 1) || 1),
		page_size: PAGE_SIZES.includes(requestedSize) ? requestedSize : 10,
	};
}

function paramsFromState(state) {
	const params = new URLSearchParams();
	if (state.batch_id) params.set("batch", state.batch_id);
	if (state.status) params.set("status", state.status);
	if (state.severity) params.set("severity", state.severity);
	if (state.q) params.set("q", state.q);
	params.set("page", String(state.page));
	params.set("page_size", String(state.page_size));
	return params;
}

export function IncidentsPage({ project }) {
	const [searchParams, setSearchParams] = useSearchParams();
	const [filters, setFilters] = useState(() => stateFromParams(searchParams));
	const [searchText, setSearchText] = useState(() => stateFromParams(searchParams).q);
	const [data, setData] = useState({
		items: [],
		total: 0,
		totalPages: 1,
		batches: [],
	});
	const [loading, setLoading] = useState(true);
	const [error, setError] = useState(null);
	const requestRef = useRef(0);

	useEffect(() => {
		const timer = setTimeout(() => {
			setFilters((prev) => (prev.q === searchText ? prev : { ...prev, q: searchText, page: 1 }));
		}, 320);
		return () => clearTimeout(timer);
	}, [searchText]);

	useEffect(() => {
		const version = ++requestRef.current;
		setSearchParams(paramsFromState(filters), { replace: true });
		setLoading(true);
		Promise.all([api.incidents(project.id, filters), api.logs(project.id)])
			.then(([incidentsRes, batchesRes]) => {
				if (version !== requestRef.current) return;
				setData({
					items: incidentsRes.items || [],
					total: Number(incidentsRes.total || 0),
					totalPages: Number(incidentsRes.total_pages || 1),
					batches: batchesRes.items || [],
				});
				const normalizedPage = Number(incidentsRes.page || filters.page);
				const normalizedSize = Number(incidentsRes.page_size || filters.page_size);
				if (normalizedPage !== filters.page || normalizedSize !== filters.page_size) {
					setFilters((prev) => ({
						...prev,
						page: normalizedPage,
						page_size: normalizedSize,
					}));
				}
				setError(null);
			})
			.catch((err) => {
				if (version === requestRef.current) setError(err);
			})
			.finally(() => {
				if (version === requestRef.current) setLoading(false);
			});
	}, [project.id, filters, setSearchParams]);

	const batchMap = useMemo(() => Object.fromEntries(data.batches.map((b) => [b.id, b])), [data.batches]);
	const selectedBatch = batchMap[filters.batch_id];
	const returnPath = `${paths.incidents(project.id)}?${paramsFromState(filters).toString()}`;
	const patch = (next) => setFilters((prev) => ({ ...prev, ...next }));

	const columns = useMemo(
		() => [
			{
				title: "序号",
				width: 80,
				render: (_, __, index) => index + 1,
			},
			{
				title: "故障摘要",
				dataIndex: "title",
				render: (_, item) => (
					<div>
						<Link
							className="table-title"
							style={{ whiteSpace: "normal", overflowWrap: "anywhere", lineHeight: 1.6 }}
							to={paths.incident(project.id, item.id, { return: returnPath })}
						>
							{item.title || "故障摘要待生成"}
						</Link>
						<span className="table-subtitle">
							{item.external_incident_id} · {item.fault_mode || "未分类"}
						</span>
					</div>
				),
			},
			{
				title: "所属批次",
				dataIndex: "log_batch_id",
				width: 120,
				render: (id) => {
					const batch = batchMap[id];
					return batch ? (
						<Tag
							className="badge badge-subtle"
							style={{ cursor: "pointer" }}
							onClick={() => patch({ batch_id: batch.id, page: 1 })}
						>
							{batch.filename}
						</Tag>
					) : (
						<span className="table-subtitle">—</span>
					);
				},
			},
			{
				title: "根因候选",
				width: 120,
				dataIndex: "root_candidate",
				render: (value) => <strong>{value || "—"}</strong>,
			},
			{
				title: "因果链",
				dataIndex: "chain",
				render: (value) => (
					<span className="table-subtitle" style={{ maxWidth: 240 }}>
						{(value || []).join(" → ") || "—"}
					</span>
				),
			},
			{
				title: "等级",
				dataIndex: "severity",
				width: 100,
				render: (value) => <Badge value={value} type="severity" />,
			},
			{
				title: "状态",
				dataIndex: "status",
				width: 100,
				render: (value) => <Badge value={value} />,
			},
			{
				title: "评分",
				dataIndex: "root_confidence",
				width: 100,
				render: (value) => <strong>{formatConfidence(value)}</strong>,
			},
			{
				title: "时间",
				dataIndex: "created_at",
				width: 100,
				render: (value) => formatDate(value),
			},
		],
		[batchMap, project.id, returnPath, patch],
	);

	if (loading && !data.items.length && !data.batches.length) return <LoadingState message="正在读取故障列表…" />;
	if (error && !data.items.length)
		return <ErrorState error={error} onRetry={() => setFilters((prev) => ({ ...prev }))} />;

	return (
		<>
			<div className="page-header">
				<div>
					<h1>故障根因定位</h1>
					<p></p>
				</div>
				<div className="page-actions">
					{selectedBatch ? (
						<Link className="button button-secondary link-button-with-icon" to={paths.reports(project.id)}>
							<IconBarChartVStroked />
							进入综合报告中心
						</Link>
					) : null}
					<Link className="button button-primary link-button-with-icon" to={paths.logs(project.id)}>
						<IconPlus />
						分析新日志
					</Link>
				</div>
			</div>

			<div className="toolbar incident-list-toolbar">
				<div className="filters">
					<Input
						className="input"
						value={searchText}
						onChange={setSearchText}
						prefix={<IconSearch />}
						placeholder="搜索标题、候选、故障模式或批次"
						style={{ minWidth: 240 }}
						showClear
					/>
					<Select
						className="select"
						value={filters.batch_id}
						onChange={(value) => patch({ batch_id: value, page: 1 })}
						optionList={[
							{ value: "", label: `全部日志批次 (${data.batches.length})` },
							...data.batches.map((b) => ({
								value: b.id,
								label: `${b.filename} (${formatDate(b.created_at)})`,
							})),
						]}
					/>
					<Select
						className="select"
						value={filters.status}
						onChange={(value) => patch({ status: value, page: 1 })}
						optionList={[
							{ value: "", label: "全部状态" },
							{ value: "open", label: "待处理" },
							{ value: "in_progress", label: "处理中" },
							{ value: "resolved", label: "已解决" },
							{ value: "ignored", label: "已忽略" },
						]}
					/>
					<Select
						className="select"
						value={filters.severity}
						onChange={(value) => patch({ severity: value, page: 1 })}
						optionList={[
							{ value: "", label: "全部等级" },
							{ value: "critical", label: "严重" },
							{ value: "high", label: "高" },
							{ value: "medium", label: "中" },
							{ value: "low", label: "低" },
						]}
					/>
				</div>
				<span style={{ color: "var(--ink-500)" }}>共 {data.total} 条记录</span>
			</div>

			<section className="card">
				<div className="card-body flush">
					{!data.items.length ? (
						<EmptyState title="没有匹配的故障记录" detail="调整筛选条件，或先上传日志执行异常检测。" />
					) : (
						<Table
							className="logscope-semi-table"
							rowKey="id"
							sticky
							columns={columns}
							dataSource={data.items}
							pagination={false}
							loading={loading}
						/>
					)}
				</div>
			</section>

			<div className="incident-pagination">
				<Pagination
					total={data.total}
					currentPage={filters.page}
					pageSize={filters.page_size}
					pageSizeOpts={PAGE_SIZES}
					showSizeChanger
					showTotal
					onPageChange={(page) => patch({ page })}
					onPageSizeChange={(page_size) => patch({ page_size, page: 1 })}
				/>
			</div>
		</>
	);
}
