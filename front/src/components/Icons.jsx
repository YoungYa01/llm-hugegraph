import {
	IconAlertTriangle,
	IconApps,
	IconBarChartVStroked,
	IconFlowChartStroked,
	IconHomeStroked,
	IconPulse,
	IconServerStroked,
	IconUserGroup,
} from "@douyinfe/semi-icons";

/**
 * Navigation icon registry.
 * All icons intentionally come from @douyinfe/semi-icons so the product has
 * one visual language and one set of sizing/baseline rules.
 */
export const Icons = {
	projects: <IconApps size="default" />,
	overview: <IconHomeStroked size="default" />,
	architecture: <IconFlowChartStroked size="default" />,
	logs: <IconPulse size="default" />,
	incidents: <IconAlertTriangle size="default" />,
	reports: <IconBarChartVStroked size="default" />,
	users: <IconUserGroup size="default" />,
	graph: <IconServerStroked size="default" />,
};
