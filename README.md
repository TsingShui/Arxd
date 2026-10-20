<p align="center">
  <img src="assets/icon.png" alt="Arxd" width="112" />
</p>

<h1 align="center">Arxd</h1>

Arxd 是一个开源的 Android 端侧 Agent，为 **RxD（Rust x Decompiler，暂未开源）** 打造。

基于 **Pi-Durable、Termux、RxD** 三个核心构建，支持以下能力：

1. **MCP**：连接外部工具与服务。
2. **Skills**：通过技能扩展 Agent 的能力与工作流。
3. **CodeMode**：用代码编排工具调用。
4. **Shell Execute**：使用 Node.js、Python、Git 等 Termux 环境提供的能力。
5. **自定义模型配置**：支持 API Key、Account 账号授权，以及兼容的 GGUF 端侧大模型。
6. **逆向工程（Coming Soon）**：由 RxD 提供核心分析能力，逐步覆盖更多逆向工程场景。

> 当前优先发布 **Lite** 版本，暂不内置 RxD 分析引擎。GGUF 模型支持取决于模型架构、模板及设备资源。

## 版本与文档

- [Releases](https://github.com/TsingShui/Arxd/releases)
- [构建与发布](docs/release.md)
- [架构设计](docs/design/arxd-design.md)
- [安全说明](SECURITY.md)

## 开源许可

Arxd 采用 [Apache-2.0](LICENSE) 许可。第三方组件说明见 [NOTICE](NOTICE)。RxD 引擎暂未开源，不包含在 Arxd 的开源范围内。
