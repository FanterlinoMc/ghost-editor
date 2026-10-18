"""vcheck.py voice-only.mp4 mix.mp4: voice vs everything-else in the speech band (300 Hz-4 kHz), per 0.25 s.

Ported unchanged from Ahmed's phantasic engine/core (origin/main). Needs ffmpeg on PATH and numpy.
"""
import subprocess, sys, numpy as np
def rd(p):
    r = subprocess.run(['ffmpeg', '-v', 'error', '-i', p, '-ac', '1', '-ar', '16000', '-af', 'highpass=f=300,lowpass=f=4000',
                        '-f', 'f32le', '-'], capture_output=True).stdout
    return np.frombuffer(r, np.float32)
v, m = rd(sys.argv[1]), rd(sys.argv[2]); n = min(len(v), len(m)); s = 4000
row, bad = [], []
for i in range(0, n - s, s):
    a, b = m[i:i + s], v[i:i + s]
    vr = np.sqrt((b ** 2).mean())
    if 20 * np.log10(vr + 1e-9) < -45: continue                    # no speech in this window
    d = a - b * (np.dot(a, b) / (np.dot(b, b) + 1e-9))
    r = 20 * np.log10(vr / (np.sqrt((d ** 2).mean()) + 1e-9))
    row.append(f"{i/16000:.2f}:{r:+.0f}")
    if r < 6: bad.append(f"{i/16000:.2f}")
print(' '.join(row)); print('speech windows under +6 dB:', bad or 'none')
