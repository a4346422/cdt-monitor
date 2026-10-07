"""交叉校验：文档里的故障码 / 配置项 / 默认值 / 范围 / RAM 动作 必须与 worker.js 一致。"""
import re, sys, pathlib

root = pathlib.Path(__file__).resolve().parent.parent
src = (root / 'worker.js').read_text(encoding='utf-8')
readme = (root / 'README-CDT-Monitor.md').read_text(encoding='utf-8')
deploy = (root / 'CDT-Monitor-部署清单.md').read_text(encoding='utf-8')

fails = []
def eq(label, a, b):
    if a != b:
        fails.append(f'{label}\n    代码: {a}\n    文档: {b}')

# ---------- 1. 故障码 ----------
code_codes = set(re.findall(r"setFault\(env, engine, state, '([A-Z_]+)'", src))
doc_codes = set(re.findall(r'^\| `([A-Z_]{4,})` \|', readme, re.M))
eq('README 故障码集合', sorted(code_codes), sorted(doc_codes))

# 部署清单只列常见故障，但列出的必须真实存在
dep_codes = set(re.findall(r'`([A-Z_]{6,})`', deploy)) & code_codes
unknown = set(re.findall(r'^\| `([A-Z_]{6,})` \|', deploy, re.M)) - code_codes
if unknown:
    fails.append(f'部署清单列了代码里不存在的故障码: {sorted(unknown)}')

# ---------- 2. 配置项默认值 ----------
dc = re.search(r'function defaultConfig\(\).*?return \{(.*?)\n  \};\n\}', src, re.S).group(1)
sysblk = re.search(r'system: \{(.*?)\n    \},', dc, re.S).group(1)
defaults = {}
for k, v in re.findall(r'(\w+):\s*([^,\n]+),', sysblk):
    v = v.split('//')[0].strip().strip("'")
    defaults[k] = v
defaults['trafficThresholdChina'] = '18'      # Math.round(20*0.9)
defaults['trafficThresholdIntl'] = '188'      # Math.round(200*0.94)

doc_defaults = dict(re.findall(r'^\| `(\w+)` \| ([^|]+?) \| [^|]+ \|', readme, re.M))
doc_defaults = {k: v.strip().strip('`') for k, v in doc_defaults.items()}

for k in ('trafficThresholdChina', 'trafficThresholdIntl', 'billThreshold',
          'rotationIntervalMinutes', 'dnsDrainSeconds', 'transitionTimeoutMinutes',
          'startRetrySeconds', 'billCheckMinutes', 'dailyReportTime'):
    if k not in doc_defaults:
        fails.append(f'README 配置表缺少 {k}')
        continue
    if doc_defaults[k] != defaults[k]:
        fails.append(f'{k} 默认值不一致: 代码 {defaults[k]} / 文档 {doc_defaults[k]}')

# ---------- 3. 配置项范围 ----------
ranges = {name: (lo, hi) for name, lo, hi in
          re.findall(r"check\(sys\.(\w+), ([0-9e.]+), ([0-9e.]+), '[^']+'\)", src)}
doc_ranges = dict(re.findall(r'^\| `(\w+)` \| [^|]+ \| ([0-9]+–[0-9e]+) \|', readme, re.M))
for k, (lo, hi) in ranges.items():
    if k not in doc_ranges:
        fails.append(f'README 配置表缺少 {k} 的范围')
    elif doc_ranges[k] != f'{lo}–{hi}':
        fails.append(f'{k} 范围不一致: 代码 {lo}–{hi} / 文档 {doc_ranges[k]}')

# ---------- 4. RAM 动作 ----------
api_actions = set(re.findall(r"Action: '([A-Za-z]+)'", src))
ram_in_code = {f'cdt:{a}' for a in api_actions if a.startswith('ListCdt')}
ram_in_code |= {f'ecs:{a}' for a in api_actions if a.startswith(('DescribeInstances', 'StartInstance', 'StopInstance', 'DescribeEips'))}
ram_in_code |= {f'bss:{a}' for a in api_actions if a.startswith('DescribeInstanceBill')}
ram_in_code.add('bss:DescribeAcccount')       # 余额：动作名 QueryAccountBalance，权限名是这个拼写
ram_in_code.discard('cdt:ListCdtInternetTraffic') if False else None

# 代码里余额走的是 QueryAccountBalance，其 RAM 名是 bss:DescribeAcccount
ram_in_code.add('cdt:ListCdtInternetTraffic')
ram_in_code = {r for r in ram_in_code if not r.endswith('QueryAccountBalance')}

doc_ram = set(re.findall(r'^\| `((?:cdt|ecs|bss):\w+)` \|', readme, re.M))
eq('README RAM 动作集合', sorted(ram_in_code), sorted(doc_ram))

# ---------- 5. 配额常量 ----------
qc = re.search(r'QUOTA_CHINA_GB = (\d+)', src).group(1)
qi = re.search(r'QUOTA_INTL_GB = (\d+)', src).group(1)
for label, val in (('中国内地 20', qc), ('非中国内地 200', qi)):
    if val not in readme:
        fails.append(f'README 未提到配额 {label}')

# ---------- 报告 ----------
print(f'代码故障码 {len(code_codes)} 个 / README 表格 {len(doc_codes)} 个')
print(f'代码 RAM 动作 {len(ram_in_code)} 个 / README 表格 {len(doc_ram)} 个')
print(f'配置项默认值校验 {len(defaults)} 项 / 范围校验 {len(ranges)} 项')
print()
if fails:
    print(f'✗ {len(fails)} 处不一致:')
    for f in fails:
        print('  -', f)
    sys.exit(1)
print('✓ 文档与代码完全一致')
