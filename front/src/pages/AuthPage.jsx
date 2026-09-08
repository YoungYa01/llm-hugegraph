import { Button, Input, TabPane, Tabs } from "@douyinfe/semi-ui";
import { useState } from "react";
import { api } from "../utils/api.js";
import { acceptSession } from "../utils/auth.js";
import { APP_LOGO, APP_NAME, APP_VERSION } from "../utils/config.js";
import { toast } from "../utils/ui.js";

const initialValues = {
	display_name: "",
	employee_id: "",
	username: "",
	password: "",
};

export function AuthPage({ onAuthenticated }) {
	const [mode, setMode] = useState("login");
	const [busy, setBusy] = useState(false);
	const [values, setValues] = useState(initialValues);

	const patch = (key, value) => setValues((current) => ({ ...current, [key]: value }));

	async function submit(event) {
		event.preventDefault();
		if (busy) return;
		if (!values.username.trim() || !values.password) return toast("请输入用户名和密码", "error");
		if (mode === "register" && (!values.display_name.trim() || !values.employee_id.trim()))
			return toast("请完善注册信息", "error");
		setBusy(true);
		try {
			const payload =
				mode === "login"
					? { username: values.username.trim(), password: values.password }
					: {
							...values,
							display_name: values.display_name.trim(),
							employee_id: values.employee_id.trim(),
							username: values.username.trim(),
						};
			const data = mode === "login" ? await api.login(payload) : await api.register(payload);
			acceptSession(data);
			toast(mode === "login" ? "登录成功" : "账户创建成功");
			onAuthenticated(data.user);
		} catch (error) {
			toast(error.message, "error");
			setBusy(false);
		}
	}

	return (
		<div className="auth-shell">
			<section className="auth-story">
				<div className="brand">
					{/*<span className="brand-mark">L</span>*/}
					<div className="brand-mark">
						<img src={APP_LOGO} alt="" style={{ width: "100%", height: "100%" }} />
					</div>
					<span>
						{APP_NAME} <small className="brand-version">{APP_VERSION}</small>
					</span>
				</div>
				<div className="auth-copy">
					<h1>从异常日志，走到可验证的根因。</h1>
					<p>把系统架构、调用依赖与滑动窗口日志分析放进同一张知识图谱，保留每一个推断依据和处理结果。</p>
					<div className="auth-pipeline">
						<div className="pipeline-step">
							<span>1</span>维护项目架构与依赖拓扑
						</div>
						<div className="pipeline-step">
							<span>2</span>检测异常窗口并还原错误传播
						</div>
						<div className="pipeline-step">
							<span>3</span>定位、验证并关闭故障工单
						</div>
					</div>
				</div>
				<small style={{ color: "rgba(255,255,255,.5)" }}> </small>
			</section>

			<section className="auth-form-side">
				<div className="auth-card">
					<Tabs
						activeKey={mode}
						onChange={(key) => {
							setMode(key);
							setBusy(false);
						}}
						type="button"
						keepDOM={false}
						className="auth-semi-tabs"
					>
						<TabPane tab="登录" itemKey="login" />
						<TabPane tab="注册" itemKey="register" />
					</Tabs>
					<h1 style={{ marginBottom: 8 }}>{mode === "login" ? "欢迎回来" : "创建账户"}</h1>
					<form className="form-stack" onSubmit={submit}>
						{mode === "register" && (
							<>
								<div className="field">
									<label htmlFor="display-name">显示名称</label>
									<Input
										id="display-name"
										className="input"
										value={values.display_name}
										required
										maxLength={80}
										autoComplete="name"
										placeholder="例如：运维工程师"
										onChange={(value) => patch("display_name", value)}
									/>
								</div>
								<div className="field">
									<label htmlFor="employee-id">工号</label>
									<Input
										id="employee-id"
										className="input"
										value={values.employee_id}
										required
										maxLength={64}
										autoComplete="off"
										placeholder="请输入工号"
										onChange={(value) => patch("employee_id", value)}
									/>
								</div>
							</>
						)}
						<div className="field">
							<label htmlFor="username">用户名</label>
							<Input
								id="username"
								className="input"
								value={values.username}
								required
								minLength={mode === "register" ? 3 : 1}
								maxLength={40}
								autoComplete="username"
								placeholder="your.name"
								onChange={(value) => patch("username", value)}
							/>
						</div>
						<div className="field">
							<label htmlFor="password">密码</label>
							<Input
								id="password"
								className="input"
								mode="password"
								value={values.password}
								required
								minLength={mode === "register" ? 8 : 1}
								maxLength={128}
								autoComplete={mode === "register" ? "new-password" : "current-password"}
								placeholder={mode === "register" ? "至少 8 位" : "输入密码"}
								onChange={(value) => patch("password", value)}
							/>
						</div>
						<Button
							htmlType="submit"
							theme="solid"
							type="primary"
							loading={busy}
							block
							className="button button-primary button-block"
						>
							{busy ? (mode === "login" ? "正在登录…" : "正在创建…") : mode === "login" ? "登录系统" : "注册并进入"}
						</Button>
					</form>
				</div>
			</section>
		</div>
	);
}
