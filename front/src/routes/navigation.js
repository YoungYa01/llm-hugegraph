import { paths } from "./paths.js";

const PROJECT_ITEMS = [
	["overview", "项目总览"],
	["architecture", "系统架构拓扑"],
	["logs", "日志解析检测"],
	["incidents", "故障根因定位"],
	["reports", "综合分析报告"],
];

export function buildNavigationModel({ project = null, current = "projects", isAdmin = false } = {}) {
	const sections = [
		{
			key: "workspace",
			label: "项目空间",
			items: [
				{
					key: "projects",
					label: "项目列表",
					to: paths.projects(),
					disabled: false,
				},
			],
		},
		{
			key: "project",
			label: "项目工作台",
			hint: project ? project.name : "请先选择项目",
			items: PROJECT_ITEMS.map(([key, label]) => ({
				key,
				label,
				to: project?.id ? paths.project(project.id, key) : "",
				disabled: !project?.id,
			})),
		},
	];

	if (isAdmin) {
		sections.push({
			key: "system",
			label: "系统管理",
			items: [
				{
					key: "users",
					label: "用户与权限管理",
					to: paths.projects("users"),
					disabled: false,
				},
				{
					key: "graph",
					label: "图谱管理",
					to: paths.projects("graph"),
					disabled: false,
				},
			],
		});
	}

	return sections.map((section) => ({
		...section,
		active: section.items.some((item) => item.key === current),
		items: section.items.map((item) => ({
			...item,
			active: item.key === current,
		})),
	}));
}
