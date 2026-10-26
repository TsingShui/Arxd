# Split-screen analysis / 分屏辅助分析

入口：**对话侧栏 → 分屏辅助分析**，或 **设置 → 工具 → 分屏辅助分析**。

选择一个可启动的已安装 App，点击 **在 Arxd 旁打开 App**。Arxd 使用普通
App 身份，从前台 Activity 调用 Android 的公开相邻启动机制：

- `FLAG_ACTIVITY_LAUNCH_ADJACENT | FLAG_ACTIVITY_NEW_TASK`
- Android 12L / API 32+ 可从全屏请求进入分屏。
- 不需要 Root、ADB 或“显示在其他应用上层”权限。
- 系统决定窗口布局；可能复用目标 App 的已有任务。不强制停止、不清数据、
  不注入私有窗口模式，也不保证创建第二个 App 实例。

这是 **best-effort 请求**，不是任意 App 的强制分屏接口。目标 App 的可调整
窗口能力、已有任务和 OEM 行为可能影响结果；系统也可能普通打开目标 App。
页面提供系统“最近任务 → App 图标 → 分屏”的手动兜底指引。

## 状态的含义

Native 返回“已请求启动”和 **Arxd 自己**的 `isInMultiWindowMode`。
这不是目标 App 在另一侧的独立证明，因此页面明确要求用户确认两边内容，
不会仅因 `startActivity` 返回就声称分屏成功。设备验证还须通过外部任务状态
和截图检查两边实际位置。

分屏后可点 **返回对话继续分析**。退出此页面不结束另一个 App，也不清理系统
正常任务；和实验副屏的独占、销毁式会话不同。

## 分屏不等于自动读屏

当前入口只安排窗口，便于用户一边使用 App、一边在 Arxd 对话中分析。
**不会自动读取、点击、截图、上传另一 App 的画面，也尚未接入 Agent
自动观察/操作闭环。** 已有 APK/rxd 分析流程保持不变。

后续单 App 画面输入可以通过用户明确授权的 MediaProjection，或受控 ADB
截图来实现；输入转发需要单独实现。不能把分屏成功当作这些能力已经获得授权。

## 实验副屏

原 Virtual Display 位于 **设置 → 工具 → 实验功能**，默认关闭。
Native 也检查开关，直接打开旧路由不会绕过实验准入。关闭开关会取消/停止
副屏；实验设置使用 App 私有持久存储，不恢复活跃副屏或 ADB 连接。

参见 [Virtual Display](virtual-display.md)。

## Code and validation

- `modules/rxd/android/src/main/java/expo/modules/arxdrxd/windows/`：
  公共相邻启动和共享 launcher catalog；不依赖 ADB。
- `modules/rxd/windows.ts`：独立原生 Interface。
- `src/ui/SplitScreenScreen.tsx`：选择、状态、手动指引和返回对话。
- `src/ui/ExperimentsScreen.tsx`：实验开关与实验入口。
- `scripts/verify-split-screen.py`：只操作隔离 Arxd 包及许可测试 fixture 的真机验证。

官方参考：
- https://developer.android.com/develop/adaptive-apps/guides/support-multi-window-mode
- https://developer.android.com/media/grow/media-projection

验证结果与截图放 root `target/split-screen/`，不提交设备证据或 APK。
USB 设备连接不等于应用内无线 ADB 已连接；分屏测试不要求修改无线调试状态。
