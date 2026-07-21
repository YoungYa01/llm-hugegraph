import { api } from "../api.js";
import { acceptSession } from "../auth.js";
import { API_BASE, APP_VERSION } from "../config.js";
import { escapeHtml, setBusy, toast } from "../ui.js";

export function renderAuthPage(root, { onAuthenticated }) {
  let mode = "login";

  function paint() {
    const registerFields = mode === "register" ? `
      <div class="field"><label for="display-name">显示名称</label><input class="input" id="display-name" name="display_name" required maxlength="80" placeholder="例如：运维工程师" /></div>` : "";
    root.innerHTML = `<div class="auth-shell">
      <section class="auth-story">
        <a class="brand" href="#"><span class="brand-mark">L</span><span>LogScope RCA <small class="brand-version">${escapeHtml(APP_VERSION)}</small></span></a>
        <div class="auth-copy">
          <h1>从异常日志，走到可验证的根因。</h1>
          <p>把系统架构、调用依赖与滑动窗口日志分析放进同一张知识图谱，保留每一个推断依据和处理结果。</p>
          <div class="auth-pipeline">
            <div class="pipeline-step"><span>1</span>维护项目架构与依赖拓扑</div>
            <div class="pipeline-step"><span>2</span>检测异常窗口并还原错误传播</div>
            <div class="pipeline-step"><span>3</span>定位、验证并关闭故障工单</div>
          </div>
        </div>
        <small style="color:rgba(255,255,255,.5)">Local-first · Qwen + HugeGraph + LogFaultAlgorithm</small>
      </section>
      <section class="auth-form-side">
        <div class="auth-card">
          <div class="tabs" style="width:max-content;margin-bottom:28px">
            <button class="tab ${mode === "login" ? "active" : ""}" data-mode="login">登录</button>
            <button class="tab ${mode === "register" ? "active" : ""}" data-mode="register">注册</button>
          </div>
          <h1 style="margin-bottom:8px">${mode === "login" ? "欢迎回来" : "创建账户"}</h1>
          <p style="color:var(--ink-600);margin-bottom:26px">${mode === "login" ? "登录后继续管理项目故障。" : "首个注册账户自动成为管理员。"}</p>
          <form id="auth-form" class="form-stack">
            ${registerFields}
            <div class="field"><label for="username">用户名</label><input class="input" id="username" name="username" required minlength="${mode === "register" ? 3 : 1}" maxlength="40" autocomplete="username" placeholder="your.name" /></div>
            <div class="field"><label for="password">密码</label><input class="input" id="password" name="password" type="password" required minlength="${mode === "register" ? 8 : 1}" maxlength="128" autocomplete="${mode === "register" ? "new-password" : "current-password"}" placeholder="${mode === "register" ? "至少 8 位" : "输入密码"}" /></div>
            <button class="button button-primary button-block" id="auth-submit" type="submit">${mode === "login" ? "登录系统" : "注册并进入"}</button>
          </form>
          <p class="field-hint" style="margin-top:18px">API：${escapeHtml(API_BASE)}</p>
        </div>
      </section>
    </div>`;

    root.querySelectorAll("[data-mode]").forEach((button) => button.addEventListener("click", () => {
      mode = button.dataset.mode;
      paint();
    }));
    root.querySelector("#auth-form")?.addEventListener("submit", async (event) => {
      event.preventDefault();
      const button = root.querySelector("#auth-submit");
      const values = Object.fromEntries(new FormData(event.currentTarget));
      setBusy(button, true, mode === "login" ? "正在登录…" : "正在创建…");
      try {
        const data = mode === "login" ? await api.login(values) : await api.register(values);
        acceptSession(data);
        toast(mode === "login" ? "登录成功" : "账户创建成功");
        onAuthenticated();
      } catch (error) {
        toast(error.message, "error");
        setBusy(button, false);
      }
    });
  }

  paint();
}
