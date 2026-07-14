# 前端依赖整理成纯本地依赖的流程

你的内网机器报 `rolldown` 缺失，本质是：只拷贝了项目源码，或者 `node_modules` / pnpm store 没有完整带过去。Vite 8 依赖 rolldown，pnpm 的依赖又是软链接式结构，不能随便只拷贝一部分 `node_modules`。

下面给三种方案，推荐优先级从高到低。

## 方案 A：只部署构建产物，内网不安装前端依赖

适合演示、交付、内网运行。

在有网机器上：

```powershell
cd frontend
pnpm install --frozen-lockfile
pnpm build
```

把这些内容拷贝到内网：

```text
frontend/dist/
```

在内网机器上直接启动静态服务：

```powershell
cd frontend/dist
python -m http.server 5173
```

浏览器打开：

```text
http://127.0.0.1:5173
```

如果后端地址不是 `http://127.0.0.1:8000`，构建前在有网机器上设置：

```powershell
$env:VITE_API_BASE="http://内网后端IP:8000"
pnpm build
```

这个方案最稳，因为内网不需要 npm、pnpm、node_modules，也不会再报 rolldown 缺失。

## 方案 B：准备 pnpm 离线依赖包，内网仍可 pnpm dev

适合内网还要改前端代码。

注意：要在和内网机器相同的系统/CPU 上准备依赖。你是 Windows，就在 Windows x64 有网机器上准备，不要在 Linux/Mac 上准备，否则 rolldown 这类原生/平台相关包可能不匹配。

在有网机器上：

```powershell
cd frontend
corepack enable
pnpm install --frozen-lockfile
pnpm store path
```

把上面 `pnpm store path` 输出的 store 目录完整复制出来，例如打包成：

```text
frontend-offline-store.zip
```

同时拷贝这些文件/目录到内网：

```text
frontend/package.json
frontend/pnpm-lock.yaml
frontend/index.html
frontend/src/
frontend-offline-store.zip
```

内网机器上：

```powershell
cd frontend
mkdir .pnpm-store
# 把 frontend-offline-store.zip 解压到 .pnpm-store，确保里面是 pnpm store 的内容
pnpm install --offline --frozen-lockfile --store-dir .pnpm-store
pnpm dev
```

如果仍然提示缺包，说明离线 store 没带完整，回到有网机器执行：

```powershell
cd frontend
pnpm fetch --frozen-lockfile --prod=false
pnpm install --frozen-lockfile
```

然后重新打包 pnpm store。

## 方案 C：直接拷贝完整 node_modules

适合临时救急，不是最推荐。

在同系统/同 CPU 的有网机器上：

```powershell
cd frontend
pnpm install --frozen-lockfile
```

完整拷贝整个 `frontend` 目录，包括：

```text
node_modules/
.pnpm-store/ 或全局 pnpm store
package.json
pnpm-lock.yaml
src/
index.html
```

注意 pnpm 的 `node_modules` 里有大量链接，普通压缩工具、网盘、U 盘同步工具可能会破坏链接。Windows 下建议用 7-Zip 打包整个 `frontend` 目录，或者优先用方案 A。

## 本项目备用方案：frontend-vanilla

如果只是内网演示，不想再处理任何前端依赖，直接使用本项目的 `frontend-vanilla`：

```powershell
cd frontend-vanilla
python -m http.server 5174
```

它是纯 HTML + 原生 JS + Canvas，不需要 npm / pnpm / node_modules。
