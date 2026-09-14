# Expand the compact transcript bundle (transcripts_compact.json + queue texts) back into app/transcripts/lessonN.json.
# Used to ship transcripts over a text-only channel; output is byte-identical to the compiler's output.
# Usage: python3 expand.py <compact.json> <queue.json|texts.json> <outdir>
import json, sys, os
SPEAKER = {'N': 'narrator', 'F': 'thai-f', 'M': 'thai-m'}
def r3(ms): return round(ms / 1000, 3)
def expand(tc, queue, outdir):
    toks = tc['tokens']
    for n in sorted(tc['lessons'], key=int):
        L = tc['lessons'][n]; events = []; t0 = 0
        for i, (qi, sd, dur, words) in enumerate(L['events']):
            q = queue[qi]; s = t0 + sd; t0 = s; e = s + dur
            ev = {'i': i, 'v': SPEAKER[q['v']], 's': 0 if s == 0 else r3(s), 'e': r3(e), 'text': q['t']}
            ws = []; prev = s
            if q['v'] == 'N':
                for tok, (wsd, wd) in zip(q['t'].split(' '), words):
                    if wsd < 0: ws.append({'t': tok}); continue
                    a = prev + wsd; b = a + wd; prev = b
                    ws.append({'t': tok, 's': r3(a), 'e': r3(b)})
            else:
                for (ti, wsd, wd) in words:
                    th, rom = toks[ti]
                    w = {'t': th, 'r': rom}
                    if wsd >= 0:
                        a = prev + wsd; b = a + wd; prev = b; w['s'] = r3(a); w['e'] = r3(b)
                    ws.append(w)
            ev['w'] = ws; events.append(ev)
        out = {'id': f'lesson{n}', 'version': 1, 'duration': L['duration'], 'sections': L['sections'], 'events': events}
        with open(os.path.join(outdir, f'lesson{n}.json'), 'w', encoding='utf-8') as f:
            json.dump(out, f, ensure_ascii=False, separators=(',', ':'))
if __name__ == '__main__':
    tc = json.load(open(sys.argv[1])); queue = json.load(open(sys.argv[2])); os.makedirs(sys.argv[3], exist_ok=True)
    expand(tc, queue, sys.argv[3])
