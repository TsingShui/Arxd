# Trusted Android-only offline acceptance fixture. Never executes imported input.
set -eu
export UV_PYTHON_DOWNLOADS=never UV_OFFLINE=1
export npm_config_offline=true npm_config_audit=false npm_config_fund=false
base="$(mktemp -d "$TMPDIR/arxd-toolchain.XXXXXX")"
trap 'rm -rf "$base"' EXIT
export ARXD_TOOLCHAIN_FIXTURE="$base"
for tool in uv uvx python node npm npx git; do command -v "$tool"; done
uv --version
uvx --version
python --version
node --version
npm --version
npx --version
git --version
python - <<'PY'
import os, pathlib, zipfile
base = pathlib.Path(os.environ['ARXD_TOOLCHAIN_FIXTURE'])
with zipfile.ZipFile(base / 'arxd_fixture-1.0-py3-none-any.whl', 'w') as wheel:
    wheel.writestr('arxd_fixture.py', 'def main():\n import subprocess,sys\n assert subprocess.check_output([sys.executable,"-c","print(6*7)"],text=True).strip()=="42"\n print("arxd-python-fixture:42")\n')
    wheel.writestr('arxd_fixture-1.0.dist-info/METADATA', 'Metadata-Version: 2.1\nName: arxd-fixture\nVersion: 1.0\n')
    wheel.writestr('arxd_fixture-1.0.dist-info/WHEEL', 'Wheel-Version: 1.0\nGenerator: arxd-trusted-fixture\nRoot-Is-Purelib: true\nTag: py3-none-any\n')
    wheel.writestr('arxd_fixture-1.0.dist-info/entry_points.txt', '[console_scripts]\narxd-python-fixture = arxd_fixture:main\n')
    wheel.writestr('arxd_fixture-1.0.dist-info/RECORD', '')
PY
uv venv --offline --python "$PREFIX/bin/python" "$base/venv"
uv pip install --offline --no-index --python "$base/venv/bin/python" "$base/arxd_fixture-1.0-py3-none-any.whl"
test "$("$base/venv/bin/arxd-python-fixture")" = 'arxd-python-fixture:42'
test "$(uvx --offline --no-index --python "$PREFIX/bin/python" --from "$base/arxd_fixture-1.0-py3-none-any.whl" arxd-python-fixture)" = 'arxd-python-fixture:42'
node - <<'JS'
const fs = require('node:fs');
const cp = require('node:child_process');
const assert = require('node:assert/strict');
const path = process.env.ARXD_TOOLCHAIN_FIXTURE + '/node-fixture';
fs.mkdirSync(path);
fs.writeFileSync(path + '/package.json', JSON.stringify({name:'arxd-node-fixture',version:'1.0.0',bin:{'arxd-node-fixture':'cli.js'}}));
fs.writeFileSync(path + '/cli.js', '#!/usr/bin/env node\nconst cp=require("node:child_process");const assert=require("node:assert/strict");assert.equal(cp.execFileSync(process.execPath,["-e","process.stdout.write(String(6*7))"],{encoding:"utf8"}),"42");assert.equal(cp.execFileSync("python",["-c","print(7*8)"],{encoding:"utf8"}).trim(),"56");console.log("arxd-node-fixture:42");\n');
fs.chmodSync(path + '/cli.js', 0o755);
assert.equal(cp.execFileSync(process.execPath,['-e','process.stdout.write(String(8*8))'],{env:{},encoding:'utf8'}),'64');
assert.equal(cp.execSync('node -e "process.stdout.write(String(6*7))"',{encoding:'utf8'}),'42');
JS
(cd "$base/node-fixture" && npm pack --offline --ignore-scripts --pack-destination "$base" >/dev/null)
npm install --offline --ignore-scripts --prefix "$base/npm-local" "$base/arxd-node-fixture-1.0.0.tgz" >/dev/null
test "$("$base/npm-local/node_modules/.bin/arxd-node-fixture")" = 'arxd-node-fixture:42'
test "$(npx --offline --yes --prefix "$base/npm-local" arxd-node-fixture)" = 'arxd-node-fixture:42'
python - <<'PY'
import json, os, subprocess, sys
assert os.getuid() >= 10000
assert subprocess.check_output([sys.executable, '-c', 'print(8*8)'], env={}, text=True).strip() == '64'
assert subprocess.check_output('python -c "print(6*7)"', shell=True, text=True).strip() == '42'
print(json.dumps({'probe':'offline-toolchain','uid':os.getuid(),'python':sys.version,'node':subprocess.check_output(['node','--version'],text=True).strip(),'uv':subprocess.check_output(['uv','--version'],text=True).strip(),'npm':subprocess.check_output(['npm','--version'],text=True).strip(),'git':subprocess.check_output(['git','--version'],text=True).strip(),'venv':True,'localWheel':True,'uvx':True,'localNpm':True,'npx':True,'emptyEnvironmentChildren':True,'shellChildren':True,'nodePythonChild':True}))
PY
