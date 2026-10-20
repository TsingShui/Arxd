# Security policy

Use GitHub private vulnerability reporting for `TsingShui/Arxd`. Do not open a
public issue for an undisclosed vulnerability.

Include the affected commit or APK version, a minimal reproduction, and the
observed impact. Never include credentials, private conversation data, or files
you are not authorized to share.

Arxd treats analyzed files and model output as untrusted input. Parsers are not
run; the managed `shell` tool can run commands the Agent requests, and it is not
an OS security sandbox. Reports about path traversal, credential exposure,
unsafe native-library loading, unexpected execution, or resource exhaustion are
in scope. On-device model inference is also not a network sandbox.
