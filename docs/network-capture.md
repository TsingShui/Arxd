# eCapture + tshark 网络工具

通过现有 Shell / CodeMode / 受托管进程使用原始工具，不增加抓包编排层：

- **eCapture 2.9.0 Android ARM64**：上游原始静态 ELF，通过 `ecapture` 启动。
- **tshark 4.6.9**：原始 Termux 包，用于离线解析 PCAP/PCAPNG。
- **iproute2 7.3.0 / tc**：原始 Termux 网络工具。

使用前先查 `ecapture --help`、`ecapture tls --help`、`tshark --help`，再按实际
目标、接口、TLS 库/版本和过滤条件选择参数。环境页面可查看实际工具版本。

实时采集通过现有 `process_start` 的 `identity: root` 托管；基础工具准备和
离线 tshark 分析不需要 root。App 不自动启动采集，不替工具配置过滤条件、
预算、输出或清理；这些由所用命令和受托管进程的配置决定。

产物可保存到 `$ARXD_WORKSPACE`，离线解析使用普通 App 身份，例如：

```sh
tshark -n -r "$ARXD_WORKSPACE/traffic.pcapng"
```

抓包可能包含凭据和 TLS 会话密钥，默认保留本机。运行状态、退出码和文件大小
不能证明捕获或解密成功；结论应关联实际帧/流。停止后检查实际进程和网络状态，
不全局删除其他工具的 TC/BPF 配置，不为适配抓包关闭设备安全保护。

`scripts/fetch-ecapture.py` 核对固定上游归档和 ELF 字节；上游未发布签名或
attestation，不称为签名来源验证。Termux 包仍由原始仓库密钥和签名快照验证。
Full/Lite 都保留 eCapture 原始字节、LICENSE 和元数据。

正常准备只做版本检查和本地 DNS PCAP 解析，不运行实时抓包。APK 构建、静态
检查或帮助输出都不是 Android/eBPF、TLS 适配或真实设备清理验证。
