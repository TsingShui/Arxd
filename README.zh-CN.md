<p align="right"><a href="README.md">English</a> | 简体中文</p>

<p align="center">
  <img src="assets/readme-icon-light.svg" alt="Arxd" width="112" />
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

## 安装

[下载 APK](https://github.com/TsingShui/Arxd/releases/download/release-beta-0.1.0/arxd-lite-0.1.0-arm64-v8a.apk) · [版本说明与校验和](https://github.com/TsingShui/Arxd/releases/tag/release-beta-0.1.0)

在 Android ARM64 设备上下载并打开 APK 安装。

## 版本与文档

- [Releases](https://github.com/TsingShui/Arxd/releases)
- [构建与发布](docs/release.md)
- [JSON 模型配置](docs/model-config.md)
- [ADB 授权](docs/adb-authorization.md)
- [虚拟屏幕启动 App](docs/virtual-display.md)
- [架构设计](docs/design/arxd-design.md)
- [安全说明](SECURITY.md)

## MCP Support

连接命令行或 HTTP MCP 服务，管理服务配置，并浏览或搜索可用工具。已连接的工具可在对话中供 Agent 使用。

## CodeMode

<p align="center">
  <img src="assets/showcase/codemode.png" alt="CodeMode running a JavaScript calculation" width="360" />
</p>

一次真实的 CodeMode 调用：执行 JavaScript 并返回 `42`。

## Local Model Qwen

<p align="center">
  <img src="assets/showcase/local-model-qwen.png" alt="Qwen local GGUF model replies to Hello" width="360" />
</p>

端侧 GGUF 模型 · Qwen3.5-2B-Q4_K_M · “Hello”

## Reverse

<p align="center">
  <img src="assets/showcase/reverse.png" alt="Reverse analysis showing a startup chain" width="360" />
</p>

来自设备最新截图的逆向分析界面。

## 开源许可

Arxd 采用 [Apache-2.0](LICENSE) 许可。第三方组件说明见 [NOTICE](NOTICE)。
