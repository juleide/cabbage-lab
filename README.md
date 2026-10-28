# 甘蓝检测多功能试验台

基于 Electron、React、TypeScript 和 Python 的桌面试验控制应用。界面面向 1024 × 600 横向触屏设计，并随窗口等比例缩放。

当前实现模拟设备控制、实时参数展示、64 × 64 压力云图、本地试验记录、CSV 导出及设置管理，尚未接入真实 PLC、执行机构或传感器。

## 功能概览

- **设备控制**：1 号电机、2 号电机、升降装置、夹爪气压设置、初始化、轴回零和传感器置零。
- **联动试验**：两个电机启动后可开始试验，运行中采集并保存参数，支持停止及急停锁定／确认解除。
- **实时参数**：法向力、按压接触面积、摩擦力、速度、动摩擦系数、气压、抓取接触面积和抓取力。
- **压力云图**：按压／抓取模式切换，Python 阵列模拟源经二进制拆包、校验和拼帧后驱动绘制，色标为相对强度。
- **数据管理**：SQLite 保存试验及采样数据，提供当前／归档两个逻辑记录库，支持最近记录查看、CSV 导出和运行日志查看。
- **应用设置**：白色／黑色／科技蓝主题、默认气压、采样间隔、记录前缀、默认记录库、数据目录及控制端诊断。主题自动保存，下次启动恢复。

> 当前所有设备参数和云图均为模拟数据。软件急停和停止操作不能替代硬件急停、安全联锁及设备侧保护。

## 技术架构

```text
React 界面
    │ 受限 preload API
Electron 主进程
    │ stdin / stdout JSONL
Python 控制进程
    ├── 设备状态与试验流程
    ├── 模拟设备与采样
    ├── JSON 配置
    └── SQLite 试验记录与日志
```

- **界面层**：React 19、TypeScript、CSS，负责展示、交互及云图绘制。
- **桌面层**：Electron 40，负责窗口、Python 子进程管理、受限 IPC、原生导出对话框和目录打开。
- **控制层**：Python 标准库实现，负责设备状态、命令校验、模拟采样、配置和记录存储。
- **构建工具**：electron-vite、Vite、electron-builder、pnpm。

设备状态以 Python 控制进程为唯一来源，React 不再自行生成设备状态或试验采样。控制端断开时，界面提示状态未知并限制设备操作。

## 开发环境

| 工具 | 版本要求 |
| --- | --- |
| Node.js | 22.12+，推荐 24 LTS |
| pnpm | 11.13.0 |
| Python | 3.10+ |

Python 后端当前仅使用标准库，无需安装额外的 pip 依赖。

### 安装与启动

```sh
cd lab-control-app
pnpm install --frozen-lockfile
pnpm dev
```

开发模式启动 Electron、前端开发服务器及 Python 控制进程。前端修改支持热更新；修改 Python 代码后，在设置页的「运行与诊断」中重启控制进程。修改启动逻辑或环境变量后，重新运行 `pnpm dev`。

首次启动保持待机，不会自动启动执行机构或联动试验。

项目的 `.npmrc` 默认使用 npm 镜像。如需使用官方源安装：

```sh
pnpm install --frozen-lockfile --registry=https://registry.npmjs.org
```

Electron 安装过程需要下载对应平台的运行文件，请勿跳过所需安装脚本。`pnpm-workspace.yaml` 已允许 Electron 和 esbuild 的构建脚本。

### 环境变量

| 变量 | 用途 |
| --- | --- |
| `LAB_PYTHON` | 指定开发运行时使用的 Python 解释器，默认 Windows 为 `python`，macOS／Linux 为 `python3` |
| `LAB_DATA_DIR` | 指定独立的控制配置、试验数据和日志根目录，适合本地调试 |

macOS／Linux：

```sh
LAB_PYTHON=/path/to/python3 LAB_DATA_DIR=/path/to/lab-data pnpm dev
```

Windows PowerShell：

```powershell
$env:LAB_PYTHON = "C:\Python312\python.exe"
$env:LAB_DATA_DIR = "D:\LabControlData"
pnpm dev
```

这些变量应在启动 Electron 前设置；`LAB_DATA_DIR` 不改变主题偏好的保存位置。

### 常用开发命令

| 命令 | 说明 |
| --- | --- |
| `pnpm dev` | 启动 Electron 开发模式 |
| `pnpm typecheck` | 检查主进程、preload、共享类型及 React 类型 |
| `pnpm build` | 类型检查并构建主进程、preload 和界面 |
| `pnpm preview` | 启动最近一次构建产物，需先执行 `pnpm build` |
| `pnpm package` | 构建并生成当前操作系统的安装包 |
| `pnpm test` | 运行 CSV 序列化、云图计算的轻量检查 |
| `pnpm backend:check` | 运行 Python 通信、模拟试验及数据保存的简短流程检查 |
| `pnpm test:desktop` | 运行 Electron 冒烟检查，需先构建并具备桌面运行环境 |

`backend:check` 命令使用 `python3`。Windows 或需要指定解释器时，可直接运行：

```sh
python scripts/controller-smoke.py
```

## 目录结构

```text
lab-control-app/
├── backend/src/lab_controller/
│   ├── __main__.py             # Python 控制端入口
│   ├── array/                  # 阵列协议、拼帧及 25Hz 模拟采集
│   ├── core/                   # 设备状态、试验流程及命令校验
│   ├── devices/                # 模拟设备适配
│   ├── ipc/                    # JSONL 协议、心跳与进程通信
│   └── storage/                # JSON 配置与 SQLite 存储
├── src/
│   ├── main/
│   │   ├── index.ts            # 应用生命周期、窗口和 IPC
│   │   └── services/           # Python 子进程管理、CSV 导出
│   ├── preload/                # 隔离的桌面 API
│   ├── shared/                 # 共享类型、通信约定和 CSV 序列化
│   └── renderer/
│       ├── index.html          # React 挂载入口
│       └── src/
│           ├── components/     # 设备、参数、云图及设置组件
│           ├── dialogs/        # 日志及急停确认弹窗
│           ├── domain/         # 界面领域类型与设备名称
│           ├── graphics/       # 原始阵列的固定范围色彩映射与绘制
│           ├── hooks/          # 控制端订阅、独立阵列订阅与主题偏好
│           ├── pages/          # 首页和设置页
│           └── styles/         # 基础、布局、主题及功能样式
├── scripts/                    # 开发辅助脚本
├── tests/                      # 轻量检查与桌面冒烟检查
├── index.html                  # 保留的独立 HTML 原型，仅用于对照
├── electron.vite.config.ts     # Electron / Vite 构建配置
└── electron-builder.yml        # 安装包配置
```

开发时修改 `src/renderer/` 下的 React 代码。根目录 `index.html` 不参与应用构建，仍可作为静态原型单独查看。

## 开发约定

- UI 采用 React 声明式事件和状态渲染；组件内不通过 `innerHTML` 拼接界面。
- 设备状态与操作约束放在 Python 控制层，界面禁用状态不能代替后端校验。
- 新增设备命令时，同步调整共享类型、IPC 白名单、Python 请求处理及界面调用。
- Node.js／文件系统能力保留在主进程，通过 preload 暴露明确用途的接口。
- stdout 仅传输控制协议消息，Python 运行日志写入文件，异常输出由主进程收集。
- 设备动作超时后不自动重试；先确认设备状态，避免重复执行。
- 退出、休眠和控制端通信中断时执行停止流程；重启控制端后不自动恢复试验。

## 数据与配置

默认控制数据根目录为 Electron `userData` 下的 `simulation/`，也可用 `LAB_DATA_DIR` 指定：

```text
simulation/
├── config/controller.json       # 试验配置
├── data/experiments.sqlite3     # 试验、采样数据及操作日志
└── logs/
    ├── controller.log           # Python 运行日志，按大小轮转
    └── desktop-controller.log   # 控制进程异常输出
```

主题偏好独立保存于 Electron `userData/ui.json`，界面同时缓存所选配色。具体数据、配置和日志路径可在「设置 → 数据与日志」中查看并打开。

当前默认试验配置：

| 配置 | 默认值 | 约束 |
| --- | --- | --- |
| 默认夹爪气压 | 0.35 MPa | 模拟范围 0～0.6 MPa |
| 采样间隔 | 100 ms | 100～5000 ms 的整数，同时影响参数刷新与记录频率 |
| 试验记录前缀 | `EXP` | 1～24 位英文字母、数字、短横线或下划线 |
| 默认记录库 | 当前记录库 | 当前／归档两个逻辑分类 |

修改试验配置前须停止试验和全部执行机构。配置保存后立即生效，初始化也使用已保存的默认气压。

试验数据不会因页面刷新、初始化或程序重启而删除。设置页显示所选记录库最近 50 次试验，可按记录导出 CSV。归档记录库是独立逻辑分类，不会自动搬移或归档记录。

CSV 采用 UTF-8 BOM 编码，包含时间、六项基础参数以及派生的抓取接触面积、抓取力。导出时先固定记录数量，再分页读取，避免导出过程中新增采样改变结果。

## 阵列采集与云图链路

详细计划与实施结果见 [阵列采集与云图改造实施计划](docs/阵列采集与云图改造实施计划.md)。

```text
Python 25Hz 模拟源
  → 64 行二进制包（每行 136 字节）
  → 增量拆包 / CRC / 点位重排 / 64 行拼帧
  → 最新完整帧缓存
  → 最多 10Hz pressure.frame 事件
  → Canvas 读取最新 4096 点阵列
```

- 云图已不再由前端公式生成。按压／抓取模式由 Python 确认后切换，置零产生全零模拟阵列，急停暂停阵列并清空画面。
- 解析器支持半包、粘包、噪声、帧内行乱序与帧号 `255 → 0`。重复行不重复计数，残帧在 500ms 超时或新帧到来时丢弃，数据源变更时重置解析缓存。
- 模拟采集默认 25Hz，事件发布和 Canvas 绘制上限各为 10Hz，独立于试验标量采样间隔。未发送阵列可被新完整帧覆盖，不排队播放旧画面。
- Canvas 固定按模拟原始范围 0～4095 映射颜色，色标显示相对强度百分比，不表示电压或实际压力。超过 1 秒无新帧或控制端离线时，淡化最后画面并显示非实时提示。
- 只在内存保留最新阵列，不向 SQLite 或 CSV 添加阵列数据；现有标量记录和导出格式不变。

**协议边界**：模拟 CRC 为 CCITT-FALSE，覆盖包内 CRC 前的字节，结果高字节在前。这只是内部模拟约定，不代表采集卡实际 CRC。当前未开放真实 USB 输入；需要厂家确认驱动／接口、CRC、有符号编码、标定参数和两种模式的数据来源后，才能接入真实采集。原始 16 位数据不擅自转换为压力，也不用于计算真实面积或力。

## 构建与打包

### 构建应用

```sh
pnpm build
```

构建输出位于：

```text
out/
├── main/index.js
├── preload/index.cjs
└── renderer/
```

可直接预览构建结果：

```sh
pnpm preview
```

### 生成安装包

在目标操作系统上执行：

```sh
pnpm package
```

`pnpm package` 会先执行类型检查和应用构建，再调用 electron-builder。当前配置的目标为：

| 平台 | 打包目标 |
| --- | --- |
| Windows | NSIS 安装程序 |
| macOS | DMG |
| Linux | AppImage |

安装包输出目录为 `dist/installers/`。如需明确指定目标和架构，可先构建，再执行相应命令：

```sh
pnpm build

# Windows x64
pnpm exec electron-builder --win nsis --x64

# macOS Apple Silicon
pnpm exec electron-builder --mac dmg --arm64

# macOS Intel
pnpm exec electron-builder --mac dmg --x64

# Linux x64
pnpm exec electron-builder --linux AppImage --x64
```

以上命令按各自目标平台使用，建议在目标系统上原生构建。打包配置会包含编译产物及后端资源。正式分发前，还需在目标机器确认启动、数据目录权限、导出和退出行为；签名、公证及自动更新尚未配置。

## 当前边界

- 仅提供模拟设备，不发送真实硬件控制指令。
- 云图和抓取相关参数属于模拟展示，不作为实际测量结果。
- 尚未实现 PLC／串口／TCP 硬件通信、传感器标定及真实设备安全联锁。
- 尚未接入远程数据库或服务器。
- 已提供基础构建与打包配置，不能据此视为已完成各平台安装包和现场设备验收。

## Git 提交规范

使用 Conventional Commits，描述采用中文，例如：

```text
feat: 增加试验记录管理
fix: 修复主题恢复异常
docs: 更新开发与打包说明
refactor: 拆分设备控制组件
```

依赖、构建产物、安装包、检查输出及 Python 缓存不纳入版本管理。
