#!/usr/bin/env python3
"""화면(web/) 수정 후 실행: build 번호를 올리고 version.json 파일 목록을 갱신한다.
사용: python3 scripts/bump.py "한 줄 변경 설명"   (APK 쪽도 바꿨으면 --apk)"""
import json, os, re, sys
root = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
web = os.path.join(root, 'web')
vp = os.path.join(web, 'version.json')
v = json.load(open(vp, encoding='utf-8'))
v['build'] = int(v.get('build', 0)) + 1
args = [a for a in sys.argv[1:] if not a.startswith('--')]
v['note'] = args[0] if args else ''
files = []
for d, _, fs in os.walk(web):
    for f in fs:
        rel = os.path.relpath(os.path.join(d, f), web).replace(os.sep, '/')
        if rel != 'version.json':
            files.append(rel)
v['files'] = sorted(files)
idx = os.path.join(web, 'index.html')
s = open(idx, encoding='utf-8').read()
s = re.sub(r'window.__BUILD__=\d+', f'window.__BUILD__={v["build"]}', s)
open(idx, 'w', encoding='utf-8').write(s)
if '--apk' in sys.argv:
    mp = os.path.join(root, 'android', 'AndroidManifest.xml')
    m = open(mp, encoding='utf-8').read()
    code = int(re.search(r'versionCode="(\d+)"', m).group(1)) + 1
    name = re.search(r'versionName="([^"]+)"', m).group(1)
    parts = name.split('.'); parts[-1] = str(int(parts[-1]) + 1); name = '.'.join(parts)
    m = re.sub(r'versionCode="\d+"', f'versionCode="{code}"', m)
    m = re.sub(r'versionName="[^"]+"', f'versionName="{name}"', m)
    open(mp, 'w', encoding='utf-8').write(m)
    v['apk'] = {'versionCode': code, 'versionName': name, 'note': v['note'],
                'url': 'https://github.com/qkaTlehdrnf/travel-agent/releases/latest/download/travel-agent.apk'}
json.dump(v, open(vp, 'w', encoding='utf-8'), ensure_ascii=False, indent=1)
print('build', v['build'], 'apk', v.get('apk', {}).get('versionCode'))
