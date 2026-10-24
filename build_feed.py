#!/usr/bin/env python3
"""Builds site/feed.json (+ site/media/*.mp4 for 9GAG videos) for the Offline Feed PWA."""
import json, os, re, sys, time, html, urllib.request, urllib.parse, concurrent.futures as cf
from xml.etree import ElementTree as ET

OUT = sys.argv[1] if len(sys.argv) > 1 else 'site'
MEDIA = os.path.join(OUT, 'media'); os.makedirs(MEDIA, exist_ok=True)
UA = 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1'
NINE_TYPES = [('hot', 35), ('trending', 28), ('fresh', 18)]   # pages of 10
SUBS = ['memes', 'funny', 'me_irl', 'wholesomememes', 'AnimalsBeingDerps', 'BeAmazed',
        'interestingasfuck', 'mildlyinteresting', 'Unexpected', 'MadeMeSmile', 'technicallythetruth']
PER_SUB = 100
VID_MAX = 5_500_000          # per video bytes
VID_BUDGET = 750_000_000     # all rehosted videos
GIF_MAX = 8_000_000
log = lambda *a: print(*a, flush=True)
report = {}

def get(url, binary=False, timeout=40, tries=3):
    for i in range(tries):
        try:
            req = urllib.request.Request(url, headers={'User-Agent': UA, 'Accept': '*/*'})
            with urllib.request.urlopen(req, timeout=timeout) as r:
                b = r.read()
                return b if binary else b.decode('utf-8', 'replace')
        except Exception as e:
            err = e
            code = getattr(e, 'code', 0)
            time.sleep((25 * (i + 1)) if code == 429 else 1.5 * (i + 1))
    raise err

def wsrv(u, w=720, anim=False):
    q = {'url': u, 'w': str(w), 'we': '1'}
    if anim: q.update({'n': '-1', 'output': 'webp', 'q': '70'})
    else: q.update({'output': 'jpg', 'q': '78'})
    return 'https://wsrv.nl/?' + urllib.parse.urlencode(q)

posts, seen = [], set()

# ---------- 9GAG ----------
def nine():
    for typ, pages in NINE_TYPES:
        cursor, n = '', 0
        for _ in range(pages):
            url = f'https://9gag.com/v1/group-posts/group/default/type/{typ}' + (f'?{cursor}' if cursor else '')
            try: d = json.loads(get(url))['data']
            except Exception as e: log('9gag', typ, 'ERR', e); break
            for p in d.get('posts', []):
                if p.get('nsfw') or p['id'] in seen: continue
                im = p.get('images', {})
                tc = p.get('topComment') or {}
                ctext = tc.get('text') or tc.get('mediaText') or ''
                base = dict(id='9g_' + p['id'], src='9gag', sec=typ, title=html.unescape(p.get('title', '')),
                            link=p.get('url', '').replace('http:', 'https:'), score=p.get('upVoteCount', 0),
                            comments=p.get('commentsCount', 0),
                            top=(ctext[:300] if ctext else ''), topBy=((tc.get('author') or {}).get('username') or ''))
                if p['type'] == 'Photo' and 'image700' in im:
                    i7 = im['image700']
                    base.update(kind='image', url=wsrv(i7['url']), w=i7['width'], h=i7['height'])
                elif p['type'] == 'Animated' and 'image460sv' in im:
                    v = im['image460sv']
                    base.update(kind='video', orig=v['url'], w=v['width'], h=v['height'],
                                audio=bool(v.get('hasAudio')), dur=v.get('duration', 0),
                                poster=wsrv(im['image460']['url'], 480))
                else: continue
                seen.add(p['id']); posts.append(base); n += 1
            cursor = d.get('nextCursor')
            if not cursor: break
            time.sleep(0.4)
        log('9gag', typ, n); report[f'9gag/{typ}'] = n

# ---------- Reddit (RSS; JSON API blocks datacenter IPs) ----------
A = '{http://www.w3.org/2005/Atom}'
IMG_RE = re.compile(r'href="(https://(?:i\.redd\.it|i\.imgur\.com)/[A-Za-z0-9_\-]+\.(?:jpe?g|png|gif|webp))"', re.I)
def reddit():
    for sub in SUBS:
        n = 0
        for listing in ('hot/.rss?limit=100', 'top/.rss?t=week&limit=100'):
            if n >= PER_SUB: break
            try: xml = get(f'https://www.reddit.com/r/{sub}/{listing}', tries=4)
            except Exception as e: log('reddit', sub, listing, 'ERR', e); continue
            try: root = ET.fromstring(xml)
            except Exception as e: log('reddit', sub, 'parse ERR', e); continue
            for en in root.findall(A + 'entry'):
                if n >= PER_SUB: break
                rid = (en.findtext(A + 'id') or '')
                content = html.unescape(en.findtext(A + 'content') or '')
                if not rid or rid in seen or 'nsfw' in content.lower(): continue
                m = IMG_RE.search(content)
                if not m: continue
                u = m.group(1); gif = u.lower().endswith('.gif')
                link = en.find(A + 'link'); link = link.get('href') if link is not None else ''
                seen.add(rid); n += 1
                posts.append(dict(id='rd_' + rid, src='r/' + sub, title=html.unescape(en.findtext(A + 'title') or ''),
                                  link=link, kind='gif' if gif else 'image',
                                  url=wsrv(u, 480 if gif else 720, anim=gif)))
            time.sleep(7)
        log('reddit', sub, n); report['r/' + sub] = n

prev = []
try: prev = json.load(open(os.path.join(OUT, 'feed.json')))['posts']
except Exception: pass
nine(); reddit()
for p in prev:   # source failed or came back short this run -> keep its previous posts
    k = p['src'] if p['src'] != '9gag' else '9gag/' + p.get('sec', '')
    if report.get(k, 0) < 15 and p['id'][3:] not in seen:
        seen.add(p['id'][3:]); q = dict(p)
        if q['kind'] == 'video': q['orig'] = None
        posts.append(q)

# ---------- fetch / warm media, record sizes ----------
vid_total = 0
def fetch(p):
    try:
        if p['kind'] == 'video':
            fn = p['id'] + '.mp4'; path = os.path.join(MEDIA, fn)
            if not os.path.exists(path):
                if not p.get('orig'): return None
                b = get(p['orig'], binary=True, timeout=60)
                if len(b) > VID_MAX: return None
                open(path, 'wb').write(b)
            p['url'] = 'media/' + fn; p['size'] = os.path.getsize(path)
            try: p['psize'] = len(get(p['poster'], binary=True))
            except Exception: p.pop('poster', None)
        else:
            b = get(p['url'], binary=True, timeout=90)
            if len(b) < 200 or (p['kind'] == 'gif' and len(b) > GIF_MAX): return None
            p['size'] = len(b)
        return p
    except Exception as e:
        return None

with cf.ThreadPoolExecutor(8) as ex:
    res = list(ex.map(fetch, posts))
final = []
for p in res:
    if not p: continue
    if p['kind'] == 'video':
        if vid_total + p['size'] > VID_BUDGET: os.remove(os.path.join(MEDIA, p['id'] + '.mp4')); continue
        vid_total += p['size']
    p.pop('orig', None); final.append(p)
keep = {p['id'] + '.mp4' for p in final if p['kind'] == 'video'}
for f in os.listdir(MEDIA):
    if f not in keep: os.remove(os.path.join(MEDIA, f))
counts = {}
for p in final: counts[p['src']] = counts.get(p['src'], 0) + 1
total = sum(p.get('size', 0) + p.get('psize', 0) for p in final)
json.dump({'generated': int(time.time()), 'counts': counts, 'bytes': total, 'posts': final},
          open(os.path.join(OUT, 'feed.json'), 'w'), ensure_ascii=False, separators=(',', ':'))
log('FINAL', len(final), 'posts', round(total / 1e6), 'MB', counts)
